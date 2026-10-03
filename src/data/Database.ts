/**
 * What the workbench needs from a SQL engine, and nothing more.
 *
 * Two implementations: DuckDB-WASM in its own worker, for the browser,
 * and DuckDB-WASM's blocking build in node, for the specs. Everything
 * above this interface is the same code in both, so the specs exercise
 * real SQL against a real DuckDB rather than a stub that agrees with
 * whatever the service expected.
 *
 * Values come back as plain JavaScript: strings, numbers, booleans and
 * null. A 64-bit integer that fits a double is a number and one that
 * does not is a string, because a `bigint` would have to be converted
 * before it crossed to the render worker anyway, and doing it here
 * means nothing above has to remember.
 */
export type Value = string | number | boolean | null;

/**
 * Which connection a statement goes to.
 *
 * `run` is the person's statements, one at a time, and the one Cancel
 * interrupts. `read` is everything the screen asks for while it looks
 * at a result: pages, sorts, the chart, the profile, the schema.
 *
 * Two connections because DuckDB-WASM runs a statement in steps and
 * answers other messages between them, so a page read on the second
 * connection is served while a ten-second query grinds on the first.
 * On one connection the page would wait for the query, and the grid
 * would scroll into rows that never arrive until it finished.
 */
export type Lane = 'run' | 'read';

export interface Rows {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Value[])[];
}

export interface Database {
  /** DuckDB's version string, as `SELECT version()` gives it. */
  readonly version: string;
  /** Which build is running: `eh`, `mvp`, `coi`, or `node` in the specs. */
  readonly bundle: string;
  query(sql: string, lane?: Lane): Promise<Rows>;
  /**
   * Interrupts the statement in flight on the `run` lane, if there is one.
   *
   * The statement's `query` then rejects, with a message that
   * `isCancellation` recognises.
   */
  cancel(): Promise<void>;
  /** Makes bytes readable by name, as `read_csv('name')` and friends expect. */
  registerFile(name: string, bytes: Uint8Array): Promise<void>;
  /** A query's whole result as CSV text, with a header row, as DuckDB's `COPY` writes it. */
  copyToCsv(select: string): Promise<string>;
}

export function isCancellation(error: unknown): boolean {
  return /interrupt|cancel/i.test(messageOf(error));
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * One statement at a time, in the order they were asked for.
 *
 * DuckDB-WASM runs on one thread, and a connection with two statements
 * in flight answers neither correctly. Everything that touches the
 * database goes through here, so a page fetched while a long query runs
 * waits for it rather than tangling with it.
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /** How many tasks are queued or running. */
  get depth(): number {
    return this.pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => this.pending--,
      () => this.pending--
    );
    return result;
  }
}
