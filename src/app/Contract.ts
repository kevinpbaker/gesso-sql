import { channel } from 'gesso-framework';

/**
 * The barrier between the workbench and the database.
 *
 * The only module both workers import. It holds names, shapes and the
 * value each key has before anything has been sent, and no code: the
 * database, its connection and every query live in the application
 * worker, and the render worker has never seen a row it was not sent.
 *
 * Keys are cut by why they change. A scroll changes `window` and
 * nothing else; a run changes `run`, then `result`, then `window`; a
 * file dropped in changes `schema`. Each one is diffed on its own, so a
 * scroll costs one small patch rather than a resend of the result's
 * description.
 */

/** How a column's values are drawn: numbers right-aligned, nulls muted, and so on. */
export type ColumnKind = 'number' | 'text' | 'time' | 'boolean' | 'nested' | 'other';

export interface ResultColumn {
  readonly name: string;
  /** DuckDB's own name for the type: `BIGINT`, `VARCHAR`, `TIMESTAMP`. */
  readonly type: string;
  readonly kind: ColumnKind;
  /** A width that fits the column's values, from a sample of them. */
  readonly width: number;
}

export interface ResultSort {
  /** A column's index in `columns`. */
  readonly column: number;
  readonly direction: 'ascending' | 'descending';
}

/**
 * What the last statement produced.
 *
 * `id` is new for every run. `order` is new for every sort of the same
 * result, which is what tells the grid that the rows it holds are stale
 * without throwing the grid away.
 */
export interface ResultView {
  readonly id: number;
  readonly order: number;
  readonly sql: string;
  readonly columns: readonly ResultColumn[];
  readonly rowCount: number;
  /** How long the statement took, in the database, in milliseconds. */
  readonly elapsedMs: number;
  readonly sort: ResultSort | null;
  /** True while a sort is being written. */
  readonly sorting: boolean;
  /** For a statement without rows: what it did, as a sentence. */
  readonly note: string;
}

export const NO_RESULT: ResultView = {
  id: 0,
  order: 0,
  sql: '',
  columns: [],
  rowCount: 0,
  elapsedMs: 0,
  sort: null,
  sorting: false,
  note: ''
};

/**
 * The rows the grid has asked for, as display strings, by row index.
 *
 * Keyed by index rather than held as an array from `first`, because a
 * scroll of ten rows would otherwise shift every element of the array
 * and the differ would resend all of them. Keyed, a scroll is ten keys
 * set and ten deleted.
 *
 * `null` is SQL's NULL, which the grid draws differently from an empty
 * string. A row with no key is one that has not been asked for or has
 * not been answered yet.
 */
export interface ResultWindow {
  readonly id: number;
  readonly order: number;
  readonly rows: Readonly<Record<string, readonly (string | null)[]>>;
}

export const NO_WINDOW: ResultWindow = { id: 0, order: 0, rows: {} };

/** Which rows the grid is showing, plus the band it wants ready around them. */
export interface WindowRequest {
  readonly id: number;
  readonly order: number;
  readonly first: number;
  readonly last: number;
}

export type RunPhase = 'starting' | 'ready' | 'running' | 'failed';

export interface RunState {
  readonly phase: RunPhase;
  /** The statement running, or the one that failed. */
  readonly sql: string;
  /** What the database said went wrong. */
  readonly error: string;
  /** Where in the editor's text the failing statement starts, so the editor can point at it. */
  readonly errorAt: number;
  /** A line about what is going on: loading the engine, generating the sample. */
  readonly message: string;
}

export const STARTING: RunState = { phase: 'starting', sql: '', error: '', errorAt: -1, message: 'Starting DuckDB…' };

export interface SchemaColumnView {
  readonly name: string;
  readonly type: string;
}

export interface SchemaTableView {
  readonly name: string;
  readonly kind: 'table' | 'view';
  readonly rows: number;
  readonly columns: readonly SchemaColumnView[];
}

export interface HistoryEntry {
  readonly id: number;
  readonly sql: string;
  /** When it ran, as epoch milliseconds. */
  readonly at: number;
  readonly elapsedMs: number;
  readonly rows: number;
  /** The error, or empty for a statement that succeeded. */
  readonly error: string;
}

export interface EngineInfo {
  readonly version: string;
  /** Which of DuckDB's builds the browser was given: `eh`, `mvp` or `coi`. */
  readonly bundle: string;
}

/** A small aggregate of the current result, for the chart. */
export interface ChartSeries {
  readonly id: number;
  readonly order: number;
  readonly label: string;
  readonly value: string;
  readonly points: readonly { readonly label: string; readonly value: number }[];
  /** How many groups there were before the chart kept the largest. */
  readonly groups: number;
}

/** One cell, in full: what the grid shows cut to a line. */
export interface CellDetail {
  readonly id: number;
  readonly order: number;
  readonly row: number;
  readonly column: number;
  readonly name: string;
  readonly type: string;
  /** The value as text, or null for NULL. Nested values are JSON. */
  readonly value: string | null;
  readonly json: boolean;
  /** True when the value was longer than the panel is sent, and was cut. */
  readonly cut: boolean;
}

/** A block of cells, by row and column, inclusive. */
export interface CellRange {
  readonly id: number;
  readonly order: number;
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstColumn: number;
  readonly lastColumn: number;
}

/** Text for the clipboard, built by the application worker for a range too big to hold on screen. */
export interface ClipboardText {
  readonly serial: number;
  readonly text: string;
}

export const NO_CHART: ChartSeries = { id: 0, order: 0, label: '', value: '', points: [], groups: 0 };

/** A column's profile, for the panel that opens from its header. */
export interface ColumnProfile {
  readonly id: number;
  readonly column: number;
  readonly name: string;
  readonly type: string;
  readonly nulls: number;
  readonly distinct: number;
  readonly min: string;
  readonly max: string;
  readonly mean: string;
  /** The most common values, with how often each appears. */
  readonly top: readonly { readonly value: string; readonly count: number }[];
}

/** A file the application worker built, for the screen to hand to the shell. */
export interface Download {
  /** New for every download, so one already saved is not saved again. */
  readonly serial: number;
  readonly name: string;
  readonly text: string;
}

/** A line the workbench wants seen once: a file loaded, an export written. */
export interface Notice {
  readonly serial: number;
  readonly text: string;
  readonly tone: 'info' | 'error';
}

export interface WorkbenchView {
  readonly run: RunState;
  readonly result: ResultView;
  readonly window: ResultWindow;
  readonly schema: readonly SchemaTableView[];
  readonly history: readonly HistoryEntry[];
  /** The editor's text as last saved, for the editor to start from. Sent once it has been read back. */
  readonly draft: string | null;
  readonly engine: EngineInfo;
  readonly chart: ChartSeries;
  readonly profile: ColumnProfile | null;
  readonly download: Download | null;
  readonly notice: Notice | null;
  readonly cell: CellDetail | null;
  readonly clipboard: ClipboardText | null;
}

export interface WorkbenchCommands {
  /** Runs one statement; `at` is where it starts in the editor, for pointing at an error. */
  run(request: { sql: string; at: number }): void;
  cancel(): void;
  fetch(request: WindowRequest): void;
  sort(request: { id: number; sort: ResultSort | null }): void;
  /** A file from the desktop, opened as a table named after it. */
  open(file: { name: string; bytes: Uint8Array }): void;
  /** Regenerates the sample tables at a size, in rows. */
  sample(rows: number): void;
  saveDraft(text: string): void;
  clearHistory(): void;
  /** Aggregates the result for the chart: one label column, one value column. */
  chart(request: { id: number; label: number; value: number }): void;
  profile(request: { id: number; column: number } | null): void;
  /** Writes the whole result as CSV and asks the shell to save it. */
  exportCsv(request: { id: number }): void;
  /** Reads one cell in full, for the value panel; null closes it. */
  cell(request: { id: number; order: number; row: number; column: number } | null): void;
  /** Builds tab-separated text for a range, with the column names first if asked. */
  copy(request: CellRange & { headers: boolean }): void;
}

export const Workbench = channel<WorkbenchView, WorkbenchCommands>('workbench', {
  run: STARTING,
  result: NO_RESULT,
  window: NO_WINDOW,
  schema: [],
  history: [],
  draft: null,
  engine: { version: '', bundle: '' },
  chart: NO_CHART,
  profile: null,
  cell: null,
  clipboard: null,
  download: null,
  notice: null
});
