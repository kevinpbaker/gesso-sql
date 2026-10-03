import { BehaviorSubject } from 'rxjs';

import {
  NO_CHART,
  NO_RESULT,
  NO_WINDOW,
  STARTING,
  type ChartSeries,
  type ColumnProfile,
  type Download,
  type EngineInfo,
  type HistoryEntry,
  type Notice,
  type ResultColumn,
  type ResultSort,
  type ResultView,
  type ResultWindow,
  type RunState,
  type SchemaTableView,
  type WindowRequest
} from '../app/Contract';
import { quoteIdentifier } from '../sql/complete';
import { classify, errorOffset, errorSummary, splitStatements } from '../sql/statements';
import { kindOf, widthOf } from './columns';
import { isCancellation, messageOf, Serial, type Database, type Value } from './Database';
import { MemorySource, RESULTS, TableSource, type ResultSource } from './ResultSource';
import { DEFAULT_SAMPLE_ROWS, sampleStatements, WELCOME } from './sample';

/**
 * The workbench, behind the barrier.
 *
 * Plain RxJS over a `Database`, with no framework import, so every line
 * of it runs in node against the blocking build of the same DuckDB. One
 * subject per view key, one method per command, and `workbenchChannel`
 * joins them to the contract.
 *
 * Everything that touches the database goes through one `Serial`, so a
 * page the grid asks for while a long query runs waits behind it instead
 * of tangling with it on the same connection. Pages already fetched are
 * cached, which is what keeps the last result scrollable while the next
 * one is being computed.
 */

export interface Saved {
  readonly draft: string;
  readonly history: readonly HistoryEntry[];
}

export interface WorkbenchStore {
  load(): Promise<Saved | null>;
  save(saved: Saved): Promise<void>;
}

export interface WorkbenchOptions {
  readonly open: () => Promise<Database>;
  readonly store: WorkbenchStore;
  readonly sampleRows?: number;
  /** Wall-clock milliseconds; replaced in the specs. */
  readonly now?: () => number;
  readonly pageSize?: number;
}

/** How many statements history keeps. */
export const HISTORY_LIMIT = 200;
/** The largest result Export will write. Larger is a query with a LIMIT, or a COPY of your own. */
export const EXPORT_LIMIT = 1_000_000;
/** How many pages of the current result are kept. */
const CACHED_PAGES = 96;
/** A result this small is charted row by row rather than aggregated. */
const CHART_ROWS = 500;
const CHART_GROUPS = 30;

export class WorkbenchService {
  readonly run$ = new BehaviorSubject<RunState>(STARTING);
  readonly result$ = new BehaviorSubject<ResultView>(NO_RESULT);
  readonly window$ = new BehaviorSubject<ResultWindow>(NO_WINDOW);
  readonly schema$ = new BehaviorSubject<readonly SchemaTableView[]>([]);
  readonly history$ = new BehaviorSubject<readonly HistoryEntry[]>([]);
  readonly draft$ = new BehaviorSubject<string | null>(null);
  readonly engine$ = new BehaviorSubject<EngineInfo>({ version: '', bundle: '' });
  readonly chart$ = new BehaviorSubject<ChartSeries>(NO_CHART);
  readonly profile$ = new BehaviorSubject<ColumnProfile | null>(null);
  readonly download$ = new BehaviorSubject<Download | null>(null);
  readonly notice$ = new BehaviorSubject<Notice | null>(null);

  /** The person's statements, one at a time, on the `run` connection. */
  private readonly runs = new Serial();
  /** Everything the screen reads while it looks at a result, on the `read` connection. */
  private readonly reads = new Serial();
  private readonly now: () => number;
  private readonly pageSize: number;
  private db: Database | null = null;
  private source: ResultSource | null = null;
  /** The last id handed out; a run takes the next one before it starts. */
  private lastId = 0;
  private pages = new Map<number, (string | null)[][]>();
  private wanted: WindowRequest | null = null;
  private pumping = false;
  private draft = '';
  private historyId = 0;
  private serial_ = { download: 0, notice: 0 };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: WorkbenchOptions) {
    this.now = options.now ?? (() => Date.now());
    this.pageSize = options.pageSize ?? 256;
  }

  /** Reads what was saved, opens DuckDB and generates the sample. Resolves once it is ready. */
  async start(): Promise<void> {
    const saved = await this.options.store.load().catch(() => null);
    this.draft = saved?.draft ?? WELCOME;
    this.history$.next(saved?.history ?? []);
    this.historyId = Math.max(0, ...(saved?.history ?? []).map(entry => entry.id));
    this.draft$.next(this.draft);

    try {
      this.db = await this.options.open();
    } catch (error) {
      this.run$.next({ ...STARTING, phase: 'failed', message: '', error: `DuckDB could not start: ${messageOf(error)}` });
      return;
    }
    this.engine$.next({ version: this.db.version, bundle: this.db.bundle });
    await this.db.query(`ATTACH IF NOT EXISTS ':memory:' AS ${RESULTS}`);
    await this.generate(this.options.sampleRows ?? DEFAULT_SAMPLE_ROWS);
  }

  // ---------------------------------------------------------------- running

  /**
   * Runs what the editor sent: one statement, or a selection of several.
   *
   * Several run in order, each as if it had been run on its own, and the
   * last one's result is the one shown; the first to fail stops the rest
   * and is the one pointed at. That is what a person selecting a script
   * and pressing Run expects, and what sending the whole selection to
   * DuckDB as one string would not do: it would run everything and show
   * only what the first statement made.
   */
  async run(request: { sql: string; at: number }): Promise<void> {
    const db = this.db;
    const phase = this.run$.value.phase;
    const sql = request.sql.trim();
    if (db === null || phase === 'running' || phase === 'starting' || sql === '') {
      return;
    }
    const statements = splitStatements(sql);
    if (statements.length === 0) {
      return;
    }
    this.run$.next({ phase: 'running', sql, error: '', errorAt: -1, message: '' });
    let schemaChanged = false;
    let outcome: Outcome = { ok: true, message: '' };
    const started = this.now();
    for (const statement of statements) {
      outcome = await this.runStatement(db, statement.text, statement.start);
      schemaChanged ||= outcome.schemaChanged === true;
      if (!outcome.ok || outcome.stop === true) {
        break;
      }
    }
    if (outcome.ok) {
      const message =
        outcome.message !== '' ? outcome.message : statements.length > 1 ? `Ran ${statements.length} statements in ${formatMs(this.now() - started)}.` : '';
      this.run$.next({ phase: 'ready', sql, error: '', errorAt: -1, message });
    } else {
      this.run$.next({ phase: 'failed', sql, error: outcome.message, errorAt: outcome.errorAt ?? -1, message: '' });
    }
    if (schemaChanged) {
      await this.refreshSchema();
    }
  }

  /** One statement: run, materialised, adopted and remembered. `offset` is where it sits in what was sent. */
  private async runStatement(db: Database, sql: string, offset: number): Promise<Outcome> {
    const id = ++this.lastId;
    const kind = classify(sql);
    const table = `${RESULTS}.r_${id}`;
    const prefix =
      kind === 'rows'
        ? `CREATE OR REPLACE TABLE ${table} AS `
        : kind === 'wrapped'
          ? `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM (`
          : '';
    const statement = kind === 'rows' ? `${prefix}${sql}` : kind === 'wrapped' ? `${prefix}${sql}\n)` : sql;

    const started = this.now();
    let source: ResultSource | null = null;
    let note = '';
    try {
      const rows = await this.runs.run(() => db.query(statement));
      const elapsedMs = this.now() - started;
      if (kind === 'rows' || kind === 'wrapped') {
        source = await this.tableSource(db, table);
      } else if (kind === 'explain') {
        note = rows.rows.map(row => String(row[row.length - 1] ?? '')).join('\n');
      } else {
        const changed = rows.columns.length === 1 && rows.columns[0] === 'Count';
        if (rows.columns.length === 0 || changed) {
          const count = changed ? Number(rows.rows[0]?.[0] ?? 0) : 0;
          note = changed && rows.rows.length > 0 ? `${count.toLocaleString('en-US')} row${count === 1 ? '' : 's'} changed.` : 'Done.';
        } else {
          source = memorySource(rows.columns, rows.rows);
        }
      }
      await this.adopt(id, sql, source, elapsedMs, note);
      this.remember({ sql, elapsedMs, rows: source?.rowCount ?? 0, error: '' });
      return { ok: true, message: '', schemaChanged: kind === 'other' };
    } catch (error) {
      const elapsedMs = this.now() - started;
      const message = messageOf(error);
      // A statement can fail half way and still have created something.
      const schemaChanged = kind === 'other';
      if (isCancellation(error)) {
        this.remember({ sql, elapsedMs, rows: 0, error: 'Cancelled' });
        return { ok: true, message: `Cancelled after ${formatMs(elapsedMs)}.`, schemaChanged, stop: true };
      }
      const at = errorOffset(message, sql, prefix.length);
      this.remember({ sql, elapsedMs, rows: 0, error: errorSummary(message) });
      return { ok: false, message: errorSummary(message), errorAt: at < 0 ? -1 : offset + at, schemaChanged };
    }
  }

  async cancel(): Promise<void> {
    if (this.db !== null && this.run$.value.phase === 'running') {
      await this.db.cancel();
    }
  }

  private async tableSource(db: Database, table: string): Promise<TableSource> {
    const [described, counted] = await this.runs.run(async () => [
      await db.query(`DESCRIBE ${table}`),
      await db.query(`SELECT count(*) FROM ${table}`)
    ]);
    const named = described.rows.map(row => ({ name: String(row[0]), type: String(row[1]) }));
    const rowCount = Number(counted.rows[0][0]);
    const probe = new TableSource(db, table, rowCount, named.map(column => ({ ...column, kind: kindOf(column.type), width: 0 })));
    const sample = await this.reads.run(() => probe.page(0, Math.min(rowCount, 200)));
    const columns = named.map((column, index) => ({
      ...column,
      kind: kindOf(column.type),
      width: widthOf(column.name, column.type, sample.map(row => row[index]))
    }));
    return new TableSource(db, table, rowCount, columns);
  }

  /** Makes a new result the current one, and lets go of the last. */
  private async adopt(id: number, sql: string, source: ResultSource | null, elapsedMs: number, note: string): Promise<void> {
    const previous = this.source;
    this.source = source;
    this.pages = new Map();
    this.wanted = null;
    this.profile$.next(null);
    this.chart$.next(NO_CHART);
    this.result$.next({
      id,
      order: 0,
      sql,
      columns: source?.columns ?? [],
      rowCount: source?.rowCount ?? 0,
      elapsedMs,
      sort: null,
      sorting: false,
      note
    });
    this.window$.next({ id, order: 0, rows: {} });
    if (previous !== null) {
      await this.reads.run(() => previous.dispose()).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- the window

  /**
   * The rows the grid is showing, and the band around them.
   *
   * Only the latest request matters: a scroll that has moved on has no
   * use for the rows it was asking for a moment ago. So this records the
   * request and lets one pump serve whatever is latest each time round,
   * which is what keeps a fling from queueing a hundred page fetches.
   */
  fetch(request: WindowRequest): void {
    this.wanted = request;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        const request = this.wanted;
        const source = this.source;
        const result = this.result$.value;
        if (request === null || source === null || request.id !== result.id || request.order !== result.order) {
          this.wanted = null;
          return;
        }
        const first = Math.max(0, Math.min(request.first, source.rowCount - 1));
        const last = Math.max(first, Math.min(request.last, source.rowCount - 1));
        if (source.rowCount === 0) {
          this.wanted = null;
          return;
        }
        const firstPage = Math.floor(first / this.pageSize);
        const lastPage = Math.floor(last / this.pageSize);
        const missing: number[] = [];
        for (let page = firstPage; page <= lastPage; page++) {
          if (!this.pages.has(page)) {
            missing.push(page);
          }
        }
        if (missing.length === 0) {
          this.publish(result.id, result.order, first, last);
          if (this.wanted === request) {
            this.wanted = null;
            return;
          }
          continue;
        }
        const from = missing[0];
        const to = missing[missing.length - 1];
        const pages = this.pages;
        const rows = await this.reads.run(() => source.page(from * this.pageSize, (to - from + 1) * this.pageSize));
        if (pages !== this.pages) {
          // Sorted or replaced while the page was in flight: those rows are of an order nobody is showing.
          continue;
        }
        for (let page = from; page <= to; page++) {
          const start = (page - from) * this.pageSize;
          pages.set(page, rows.slice(start, start + this.pageSize));
        }
        this.trimPages(firstPage, lastPage);
      }
    } finally {
      this.pumping = false;
    }
  }

  private publish(id: number, order: number, first: number, last: number): void {
    const rows: Record<string, (string | null)[]> = {};
    for (let row = first; row <= last; row++) {
      const page = this.pages.get(Math.floor(row / this.pageSize));
      const values = page?.[row % this.pageSize];
      if (values !== undefined) {
        rows[row] = values;
      }
    }
    this.window$.next({ id, order, rows });
  }

  /** Keeps the pages nearest the window, and forgets the rest. */
  private trimPages(firstPage: number, lastPage: number): void {
    if (this.pages.size <= CACHED_PAGES) {
      return;
    }
    const middle = (firstPage + lastPage) / 2;
    const byDistance = [...this.pages.keys()].sort((a, b) => Math.abs(b - middle) - Math.abs(a - middle));
    for (const page of byDistance.slice(0, this.pages.size - CACHED_PAGES)) {
      this.pages.delete(page);
    }
  }

  // ---------------------------------------------------------------- sorting

  async sort(request: { id: number; sort: ResultSort | null }): Promise<void> {
    const source = this.source;
    const result = this.result$.value;
    if (source === null || request.id !== result.id) {
      return;
    }
    const order = result.order + 1;
    this.pages = new Map();
    this.result$.next({ ...result, order, sort: request.sort, sorting: true });
    this.window$.next({ id: result.id, order, rows: {} });
    const started = this.now();
    try {
      await this.reads.run(() => source.sort(request.sort));
    } catch (error) {
      this.say(`Could not sort: ${errorSummary(messageOf(error))}`, 'error');
    }
    const current = this.result$.value;
    if (current.id === result.id && current.order === order) {
      this.result$.next({ ...current, sorting: false });
      if (request.sort !== null) {
        const column = source.columns[request.sort.column]?.name ?? '';
        this.say(`Sorted ${source.rowCount.toLocaleString('en-US')} rows by ${column} in ${formatMs(this.now() - started)}.`, 'info');
      }
      void this.pump();
    }
  }

  // ---------------------------------------------------------------- chart and profile

  async chart(request: { id: number; label: number; value: number }): Promise<void> {
    const source = this.source;
    const result = this.result$.value;
    if (source === null || request.id !== result.id || source.relation === null) {
      return;
    }
    const label = source.columns[request.label];
    const value = source.columns[request.value];
    if (label === undefined || value === undefined) {
      return;
    }
    const relation = source.relation;
    const l = quoteIdentifier(label.name);
    const v = quoteIdentifier(value.name);
    try {
      const series = await this.reads.run(async () => {
        if (source.rowCount <= CHART_ROWS) {
          const rows = await this.db!.query(
            `SELECT left(${l}::VARCHAR, 60), TRY_CAST(${v} AS DOUBLE) FROM ${relation} ORDER BY rowid`, 'read'
          );
          return { rows: rows.rows, groups: source.rowCount, valueLabel: value.name };
        }
        const rows = await this.db!.query(
          `SELECT left(${l}::VARCHAR, 60), sum(TRY_CAST(${v} AS DOUBLE)) FROM ${relation} GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT ${CHART_GROUPS}`, 'read'
        );
        const groups = await this.db!.query(`SELECT approx_count_distinct(${l}) FROM ${relation}`, 'read');
        return { rows: rows.rows, groups: Number(groups.rows[0][0]), valueLabel: `sum(${value.name})` };
      });
      if (this.result$.value.id !== request.id) {
        return;
      }
      this.chart$.next({
        id: result.id,
        order: result.order,
        label: label.name,
        value: series.valueLabel,
        points: series.rows.map(row => ({ label: row[0] === null ? 'NULL' : String(row[0]), value: Number(row[1] ?? 0) })),
        groups: series.groups
      });
    } catch (error) {
      this.say(`Could not chart: ${errorSummary(messageOf(error))}`, 'error');
    }
  }

  async profile(request: { id: number; column: number } | null): Promise<void> {
    const source = this.source;
    if (request === null || source === null || request.id !== this.result$.value.id || source.relation === null) {
      this.profile$.next(null);
      return;
    }
    const column = source.columns[request.column];
    if (column === undefined) {
      return;
    }
    const relation = source.relation;
    const c = quoteIdentifier(column.name);
    this.profile$.next(null);
    try {
      const profile = await this.reads.run(async () => {
        const db = this.db!;
        const comparable = column.kind !== 'nested';
        const stats = await db.query(
          `SELECT count(*) - count(${c}), approx_count_distinct(${c}), ${
            comparable ? `left(min(${c})::VARCHAR, 60), left(max(${c})::VARCHAR, 60)` : `NULL, NULL`
          }, ${column.kind === 'number' ? `round(avg(${c}), 4)::VARCHAR` : 'NULL'} FROM ${relation}`,
          'read'
        );
        const top = await db.query(
          `SELECT left(${c}::VARCHAR, 60), count(*) FROM ${relation} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`, 'read'
        );
        const row = stats.rows[0];
        return {
          id: request.id,
          column: request.column,
          name: column.name,
          type: column.type,
          nulls: Number(row[0]),
          distinct: Number(row[1]),
          min: text(row[2]),
          max: text(row[3]),
          mean: text(row[4]),
          top: top.rows.map(entry => ({ value: entry[0] === null ? 'NULL' : String(entry[0]), count: Number(entry[1]) }))
        };
      });
      if (this.result$.value.id === request.id) {
        this.profile$.next(profile);
      }
    } catch (error) {
      this.say(`Could not profile ${column.name}: ${errorSummary(messageOf(error))}`, 'error');
    }
  }

  // ---------------------------------------------------------------- files

  async open(file: { name: string; bytes: Uint8Array }): Promise<void> {
    const db = this.db;
    if (db === null) {
      return;
    }
    const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
    const reader =
      extension === 'parquet'
        ? 'read_parquet'
        : extension === 'json' || extension === 'ndjson' || extension === 'jsonl'
          ? 'read_json_auto'
          : extension === 'csv' || extension === 'tsv' || extension === 'txt'
            ? 'read_csv_auto'
            : null;
    if (reader === null) {
      this.say(`${file.name} is not a file DuckDB reads here. Try CSV, TSV, Parquet or JSON.`, 'error');
      return;
    }
    const table = tableNameFor(file.name);
    const path = `upload/${file.name}`;
    const started = this.now();
    try {
      const count = await this.runs.run(async () => {
        await db.registerFile(path, file.bytes);
        await db.query(`CREATE OR REPLACE TABLE ${quoteIdentifier(table)} AS SELECT * FROM ${reader}('${path.replaceAll("'", "''")}')`);
        const counted = await db.query(`SELECT count(*) FROM ${quoteIdentifier(table)}`);
        return Number(counted.rows[0][0]);
      });
      await this.refreshSchema();
      this.say(
        `Loaded ${file.name} as ${table}: ${count.toLocaleString('en-US')} rows in ${formatMs(this.now() - started)}.`,
        'info'
      );
    } catch (error) {
      this.say(`Could not load ${file.name}: ${errorSummary(messageOf(error))}`, 'error');
    }
  }

  async exportCsv(request: { id: number }): Promise<void> {
    const source = this.source;
    if (source === null || request.id !== this.result$.value.id || source.relation === null) {
      return;
    }
    if (source.rowCount > EXPORT_LIMIT) {
      this.say(
        `Export writes up to ${EXPORT_LIMIT.toLocaleString('en-US')} rows, and this result has ${source.rowCount.toLocaleString('en-US')}. Add a LIMIT, or narrow the query.`,
        'error'
      );
      return;
    }
    const relation = source.relation;
    try {
      const text = await this.runs.run(() => this.db!.copyToCsv(`SELECT * FROM ${relation} ORDER BY rowid`));
      this.download$.next({ serial: ++this.serial_.download, name: `result-${request.id}.csv`, text });
    } catch (error) {
      this.say(`Could not export: ${errorSummary(messageOf(error))}`, 'error');
    }
  }

  // ---------------------------------------------------------------- the sample

  async sample(rows: number): Promise<void> {
    const phase = this.run$.value.phase;
    if (this.db === null || phase === 'running' || phase === 'starting') {
      return;
    }
    await this.generate(rows);
  }

  private async generate(rows: number): Promise<void> {
    const db = this.db!;
    this.run$.next({ ...STARTING, phase: 'starting', message: `Generating ${rows.toLocaleString('en-US')} sample trips…` });
    const started = this.now();
    try {
      await this.runs.run(async () => {
        for (const statement of sampleStatements(rows)) {
          await db.query(statement);
        }
      });
      await this.refreshSchema();
      this.run$.next({
        phase: 'ready',
        sql: '',
        error: '',
        errorAt: -1,
        message: `Generated ${rows.toLocaleString('en-US')} trips in ${formatMs(this.now() - started)}.`
      });
    } catch (error) {
      this.run$.next({ ...STARTING, phase: 'failed', message: '', error: `Could not generate the sample: ${messageOf(error)}` });
    }
  }

  // ---------------------------------------------------------------- schema

  async refreshSchema(): Promise<void> {
    const db = this.db;
    if (db === null) {
      return;
    }
    const schema = await this.reads.run(async () => {
      const relations = await db.query(
        `SELECT table_name, 'table' AS kind, estimated_size FROM duckdb_tables() WHERE NOT temporary AND NOT internal AND database_name = current_database()
         UNION ALL
         SELECT view_name, 'view', NULL FROM duckdb_views() WHERE NOT temporary AND NOT internal AND database_name = current_database()
         ORDER BY 1`, 'read'
      );
      const columns = await db.query(
        `SELECT table_name, column_name, data_type FROM duckdb_columns() WHERE NOT internal AND database_name = current_database() ORDER BY table_name, column_index`, 'read'
      );
      return relations.rows.map(
        (row): SchemaTableView => ({
          name: String(row[0]),
          kind: row[1] === 'view' ? 'view' : 'table',
          rows: row[2] === null ? -1 : Number(row[2]),
          columns: columns.rows.filter(column => column[0] === row[0]).map(column => ({ name: String(column[1]), type: String(column[2]) }))
        })
      );
    });
    this.schema$.next(schema);
  }

  // ---------------------------------------------------------------- history and the draft

  saveDraft(text: string): void {
    this.draft = text;
    this.persist();
  }

  clearHistory(): void {
    this.history$.next([]);
    this.persist();
  }

  private remember(entry: Omit<HistoryEntry, 'id' | 'at'>): void {
    const next: HistoryEntry = { ...entry, id: ++this.historyId, at: this.now() };
    this.history$.next([next, ...this.history$.value].slice(0, HISTORY_LIMIT));
    this.persist();
  }

  /** Saves a moment after the last change, so a burst of typing is one write. */
  private persist(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => void this.flush(), 400);
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.options.store.save({ draft: this.draft, history: this.history$.value }).catch(() => undefined);
  }

  private say(text: string, tone: Notice['tone']): void {
    this.notice$.next({ serial: ++this.serial_.notice, text, tone });
  }
}

interface Outcome {
  readonly ok: boolean;
  /** For a failure, what went wrong; for a success, a line worth saying, or empty. */
  readonly message: string;
  readonly errorAt?: number;
  readonly schemaChanged?: boolean;
  /** Cancelled: not a failure, but nothing after it should run. */
  readonly stop?: boolean;
}

function memorySource(names: readonly string[], rows: readonly (readonly Value[])[]): MemorySource {
  const display = rows.map(row => row.map(value => (value === null ? null : String(value))));
  const columns: ResultColumn[] = names.map((name, index) => {
    const numeric = rows.length > 0 && rows.every(row => row[index] === null || typeof row[index] === 'number');
    const type = numeric ? 'DOUBLE' : 'VARCHAR';
    return { name, type, kind: kindOf(type), width: widthOf(name, type, display.slice(0, 200).map(row => row[index])) };
  });
  return new MemorySource(columns, display);
}

function text(value: Value): string {
  return value === null ? '' : String(value);
}

/** A table name from a file name: `Trips 2024.csv` is `trips_2024`. */
export function tableNameFor(file: string): string {
  const stem = file.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const name = stem === '' ? 'upload' : stem;
  return /^[0-9]/.test(name) ? `t_${name}` : name;
}

export function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}
