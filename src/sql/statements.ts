import { tokenize, type Token } from './tokenize';

/**
 * Where one statement ends and the next begins.
 *
 * A script holds several statements, and Run means the one the caret is
 * in, as it does in every SQL tool people already use: write a few
 * queries in one buffer and run them one at a time. The splitting is on
 * semicolons the tokenizer saw as semicolons, so one inside a string or
 * a comment stays where it is.
 */
export interface Statement {
  /** Where the statement's text starts, past any leading space and comments. */
  readonly start: number;
  /** Where it ends, before its semicolon and any trailing space. */
  readonly end: number;
  readonly text: string;
}

export function splitStatements(text: string): Statement[] {
  const statements: Statement[] = [];
  let pending: Token[] = [];

  const close = (): void => {
    const meaningful = pending.filter(token => token.kind !== 'whitespace' && token.kind !== 'comment');
    if (meaningful.length > 0) {
      // Leading comments are kept: a comment above a query describes
      // it, and a statement's text is what history shows.
      const first = pending.find(token => token.kind !== 'whitespace') ?? meaningful[0];
      const last = meaningful[meaningful.length - 1];
      statements.push({ start: first.start, end: last.end, text: text.slice(first.start, last.end) });
    }
    pending = [];
  };

  for (const token of tokenize(text)) {
    if (token.kind === 'semicolon') {
      close();
      continue;
    }
    pending.push(token);
  }
  close();
  return statements;
}

/**
 * The statement the caret is in, or the nearest one before it.
 *
 * A caret just after a semicolon, or on a blank line below a query, is
 * still "on" that query, so it is the last statement starting at or
 * before the caret that wins, and the first one when the caret is above
 * everything.
 */
export function statementAt(text: string, caret: number): Statement | null {
  const statements = splitStatements(text);
  if (statements.length === 0) {
    return null;
  }
  let chosen = statements[0];
  for (const statement of statements) {
    if (statement.start <= caret) {
      chosen = statement;
    }
  }
  return chosen;
}

/**
 * What a statement is, as far as running it goes.
 *
 * - `rows`: a query. The workbench materialises it into a temporary
 *   table, so the grid can page and sort without running it again.
 * - `wrapped`: `DESCRIBE`, `SHOW` and `SUMMARIZE` produce rows too, and
 *   DuckDB accepts them as a subquery, so they are materialised the
 *   same way from inside `SELECT * FROM (...)`.
 * - `explain`: a plan, which is text to read rather than rows to page.
 * - `other`: everything else, run as written.
 */
export type StatementKind = 'rows' | 'wrapped' | 'explain' | 'other';

export function classify(sql: string): StatementKind {
  const first = tokenize(sql).find(token => token.kind !== 'whitespace' && token.kind !== 'comment');
  if (first === undefined) {
    return 'other';
  }
  const word = first.text.toUpperCase();
  if (['SELECT', 'WITH', 'FROM', 'VALUES', 'TABLE', 'PIVOT', 'UNPIVOT'].includes(word) || first.text === '(') {
    return 'rows';
  }
  if (word === 'DESCRIBE' || word === 'SHOW' || word === 'SUMMARIZE') {
    return 'wrapped';
  }
  if (word === 'EXPLAIN') {
    return 'explain';
  }
  return 'other';
}

/**
 * Where in a statement DuckDB says an error is, as an offset into it.
 *
 * DuckDB ends an error with the line it failed on and a caret under the
 * place: `LINE 3: WHERE fare > ...` and then `^` below. That line is
 * the statement as DuckDB saw it, so `prefix` is how many characters
 * the workbench put in front of the person's text on its first line,
 * and is taken back off. DuckDB shortens a long line with `...`, and
 * then the column is no longer a column of the text; the answer then is
 * -1, which is "somewhere in this statement".
 */
export function errorOffset(message: string, sql: string, prefix: number): number {
  const structured = structuredError(message);
  if (structured !== null && structured.position !== null) {
    const at = structured.position - prefix;
    return at >= 0 && at <= sql.length ? at : -1;
  }
  const lines = (structured?.message ?? message).split('\n');
  for (let index = 0; index < lines.length - 1; index++) {
    const match = /^LINE (\d+): (.*)$/.exec(lines[index]);
    if (match === null) {
      continue;
    }
    const caret = lines[index + 1].indexOf('^');
    if (caret === -1 || match[2].startsWith('...')) {
      return -1;
    }
    const line = Number(match[1]) - 1;
    let column = caret - `LINE ${match[1]}: `.length;
    if (line === 0) {
      column -= prefix;
    }
    const lineStarts = [0];
    for (let at = 0; at < sql.length; at++) {
      if (sql[at] === '\n') {
        lineStarts.push(at + 1);
      }
    }
    if (line >= lineStarts.length || column < 0) {
      return -1;
    }
    return Math.min(sql.length, lineStarts[line] + column);
  }
  return -1;
}

/** The message without DuckDB's `LINE n:` coda, which the editor shows by pointing instead. */
export function errorSummary(message: string): string {
  const structured = structuredError(message);
  const text = structured === null ? message : `${structured.type} Error: ${structured.message}`;
  const at = text.search(/\n\s*LINE \d+:/);
  return (at === -1 ? text : text.slice(0, at)).trim();
}

/**
 * DuckDB-WASM's errors, which arrive as JSON.
 *
 * The browser build reports an error as an object rather than as the
 * sentence the native library prints: its kind, its message, and, for
 * a parse error, `position`, the character offset into the statement
 * DuckDB was given. Null for a message that is not one of those.
 */
function structuredError(message: string): { type: string; message: string; position: number | null } | null {
  if (!message.trimStart().startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(message) as { exception_type?: unknown; exception_message?: unknown; position?: unknown };
    if (typeof parsed.exception_message !== 'string') {
      return null;
    }
    const position = Number(parsed.position);
    return {
      type: typeof parsed.exception_type === 'string' ? parsed.exception_type : 'Database',
      message: parsed.exception_message,
      position: parsed.position === undefined || !Number.isFinite(position) ? null : position
    };
  } catch {
    return null;
  }
}
