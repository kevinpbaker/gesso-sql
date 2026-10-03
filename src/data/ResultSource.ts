import { quoteIdentifier } from '../sql/complete';
import type { ResultColumn, ResultSort } from '../app/Contract';
import type { Database } from './Database';

/**
 * Where results live: an in-memory database of their own, attached
 * beside the person's. A temporary table would be visible only to the
 * connection that wrote it, and results are written on the `run`
 * connection and read on the `read` one; a database of their own also
 * keeps them out of the schema the sidebar shows.
 */
export const RESULTS = 'gesso_results';

/**
 * A statement's rows, held where they can be paged and sorted.
 *
 * A statement that returns rows is run once, into a temporary table,
 * and the grid pages through that table by `rowid`. Paging never runs
 * the query again, which is what makes a scroll to row seven million
 * cost a few milliseconds whatever the query was; and a sort is one
 * more table, written once, rather than an `ORDER BY` on every page.
 *
 * What the materialisation costs is memory: a `SELECT *` over a table
 * of ten million rows is a second copy of it. The service keeps one
 * result at a time and drops the last one's tables before writing the
 * next one's, which bounds that at one copy and one sorted copy.
 */
export interface ResultSource {
  readonly rowCount: number;
  readonly columns: readonly ResultColumn[];
  /** Display strings for `count` rows from `first`, in the current order. */
  page(first: number, count: number): Promise<(string | null)[][]>;
  /** A block of rows and columns in full, uncut; for the clipboard and the value panel. */
  block(first: number, count: number, firstColumn: number, lastColumn: number, limit: number): Promise<(string | null)[][]>;
  sort(sort: ResultSort | null): Promise<void>;
  /** A relation the result can be queried as, for the chart and the profile; null when it has none. */
  readonly relation: string | null;
  dispose(): Promise<void>;
}

/** How long a value the grid is sent may be. The grid draws one line, so the rest would never be seen. */
export const DISPLAY_LIMIT = 400;

export class TableSource implements ResultSource {
  private sortedTable: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly table: string,
    readonly rowCount: number,
    readonly columns: readonly ResultColumn[]
  ) {}

  get relation(): string {
    return this.sortedTable ?? this.table;
  }

  async page(first: number, count: number): Promise<(string | null)[][]> {
    if (this.columns.length === 0 || count <= 0) {
      return [];
    }
    const list = this.columns.map(column => `left(${quoteIdentifier(column.name)}::VARCHAR, ${DISPLAY_LIMIT})`).join(', ');
    const rows = await this.db.query(
      `SELECT ${list} FROM ${this.relation} WHERE rowid >= ${first} AND rowid < ${first + count} ORDER BY rowid`,
      'read'
    );
    return rows.rows.map(row => row.map(value => (value === null ? null : String(value))));
  }

  async block(first: number, count: number, firstColumn: number, lastColumn: number, limit: number): Promise<(string | null)[][]> {
    // Nested values as JSON, which is what a person pasting them or
    // reading them in the value panel wants, rather than DuckDB's own
    // `{'a': 1}` spelling of a struct.
    const list = this.columns
      .slice(firstColumn, lastColumn + 1)
      .map(column => `left(${column.kind === 'nested' ? `to_json(${quoteIdentifier(column.name)})` : quoteIdentifier(column.name)}::VARCHAR, ${limit})`)
      .join(', ');
    const rows = await this.db.query(
      `SELECT ${list} FROM ${this.relation} WHERE rowid >= ${first} AND rowid < ${first + count} ORDER BY rowid`,
      'read'
    );
    return rows.rows.map(row => row.map(value => (value === null ? null : String(value))));
  }

  async sort(sort: ResultSort | null): Promise<void> {
    const previous = this.sortedTable;
    this.sortedTable = null;
    if (previous !== null) {
      await this.db.query(`DROP TABLE IF EXISTS ${previous}`, 'read');
    }
    if (sort === null) {
      return;
    }
    const column = this.columns[sort.column];
    const target = `${this.table}_sorted`;
    // Nulls last both ways, as a person reading a sorted column expects:
    // a descending sort is "the biggest first", not "the missing first".
    await this.db.query(
      `CREATE OR REPLACE TABLE ${target} AS SELECT * FROM ${this.table} ORDER BY ${quoteIdentifier(column.name)} ${
        sort.direction === 'ascending' ? 'ASC' : 'DESC'
      } NULLS LAST`,
      'read'
    );
    this.sortedTable = target;
  }

  async dispose(): Promise<void> {
    if (this.sortedTable !== null) {
      await this.db.query(`DROP TABLE IF EXISTS ${this.sortedTable}`, 'read');
    }
    await this.db.query(`DROP TABLE IF EXISTS ${this.table}`, 'read');
  }
}

/**
 * Rows that cannot sit in a table: what `EXPLAIN`, `PRAGMA` and `CALL`
 * return. Small by nature, so held as they came and sorted in place.
 */
export class MemorySource implements ResultSource {
  private order: (string | null)[][];
  readonly relation = null;

  constructor(
    readonly columns: readonly ResultColumn[],
    private readonly rows: (string | null)[][]
  ) {
    this.order = rows;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  async page(first: number, count: number): Promise<(string | null)[][]> {
    return this.order.slice(first, first + count);
  }

  async block(first: number, count: number, firstColumn: number, lastColumn: number): Promise<(string | null)[][]> {
    return this.order.slice(first, first + count).map(row => row.slice(firstColumn, lastColumn + 1));
  }

  async sort(sort: ResultSort | null): Promise<void> {
    if (sort === null) {
      this.order = this.rows;
      return;
    }
    const numeric = this.columns[sort.column]?.kind === 'number';
    const sign = sort.direction === 'ascending' ? 1 : -1;
    this.order = [...this.rows].sort((a, b) => {
      const left = a[sort.column];
      const right = b[sort.column];
      if (left === null || right === null) {
        return left === right ? 0 : left === null ? 1 : -1;
      }
      return sign * (numeric ? Number(left) - Number(right) : left.localeCompare(right));
    });
  }

  async dispose(): Promise<void> {}
}
