import { statementAt } from './statements';
import { KEYWORDS, tokenize, type Token } from './tokenize';

/**
 * What to offer at the caret.
 *
 * Context first, then the prefix. After `FROM` or `JOIN` it is tables;
 * after `alias.` it is that table's columns; anywhere else it is the
 * columns of the tables this statement already names, then functions,
 * then keywords, then the remaining tables. The prefix narrows each
 * group and a match at the start of a word beats one in the middle.
 *
 * Plain functions over plain data, so all of it is specified in node
 * and the editor only has to draw the list.
 */

export interface SchemaColumn {
  readonly name: string;
  readonly type: string;
}

export interface SchemaTable {
  readonly name: string;
  readonly columns: readonly SchemaColumn[];
}

export type CompletionKind = 'column' | 'table' | 'function' | 'keyword';

export interface Completion {
  /** What is inserted. */
  readonly text: string;
  /** What is shown beside it: a column's type, a table's column count. */
  readonly detail: string;
  readonly kind: CompletionKind;
}

export interface CompletionResult {
  /** Where the word being replaced starts. */
  readonly from: number;
  /** Where it ends, which is the caret. */
  readonly to: number;
  readonly items: readonly Completion[];
}

/** Functions worth offering by name. DuckDB has hundreds; these are the ones people reach for. */
export const FUNCTIONS: readonly string[] = [
  'abs', 'any_value', 'approx_count_distinct', 'approx_quantile', 'arg_max', 'arg_min', 'array_agg', 'avg', 'bool_and',
  'bool_or', 'ceil', 'coalesce', 'concat', 'concat_ws', 'contains', 'corr', 'count', 'count_star', 'current_date',
  'date_diff', 'date_part', 'date_trunc', 'datediff', 'dayname', 'dense_rank', 'epoch', 'epoch_ms', 'exp', 'extract',
  'first', 'first_value', 'floor', 'generate_series', 'greatest', 'hash', 'histogram', 'ifnull', 'lag', 'last',
  'last_value', 'lead', 'least', 'left', 'length', 'list', 'list_value', 'ln', 'log', 'lower', 'lpad', 'ltrim', 'make_date',
  'max', 'max_by', 'md5', 'median', 'min', 'min_by', 'mode', 'monthname', 'now', 'nth_value', 'ntile', 'nullif',
  'percent_rank', 'pow', 'quantile_cont', 'quantile_disc', 'random', 'range', 'rank', 'read_csv', 'read_json',
  'read_parquet', 'regexp_extract', 'regexp_matches', 'regexp_replace', 'repeat', 'replace', 'reverse', 'right', 'round',
  'row_number', 'rpad', 'rtrim', 'split_part', 'sqrt', 'starts_with', 'stddev', 'stddev_samp', 'strftime', 'string_agg',
  'strptime', 'substr', 'substring', 'sum', 'time_bucket', 'to_timestamp', 'today', 'trim', 'trunc', 'typeof', 'unnest',
  'upper', 'uuid', 'var_samp', 'variance', 'year'
];

/** Words after which a table name comes next. */
const TABLE_CONTEXT = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'DESCRIBE', 'SUMMARIZE']);

const LIMIT = 50;

export function complete(text: string, caret: number, tables: readonly SchemaTable[]): CompletionResult | null {
  const tokens = tokenize(text);
  const here = tokens.find(token => token.start < caret && token.end >= caret);
  if (here !== undefined && (here.kind === 'string' || here.kind === 'comment' || here.kind === 'number')) {
    // Nothing to offer inside a literal. A comment that ends at the caret
    // is a line comment still being typed, which counts.
    return null;
  }

  // The word being typed: identifier characters up to the caret.
  let from = caret;
  while (from > 0 && /[A-Za-z0-9_]/.test(text[from - 1])) {
    from--;
  }
  const prefix = text.slice(from, caret);

  const statement = statementAt(text, caret);
  const scope = statement === null ? [] : tablesIn(statement.text, tables);

  // `alias.` or `table.`: the columns of that one table, and nothing else.
  if (from > 0 && text[from - 1] === '.') {
    let qualifierEnd = from - 1;
    let qualifierStart = qualifierEnd;
    while (qualifierStart > 0 && /[A-Za-z0-9_"]/.test(text[qualifierStart - 1])) {
      qualifierStart--;
    }
    const qualifier = unquote(text.slice(qualifierStart, qualifierEnd)).toLowerCase();
    const table =
      scope.find(entry => entry.alias === qualifier)?.table ?? tables.find(entry => entry.name.toLowerCase() === qualifier);
    if (table === undefined) {
      return null;
    }
    return offer(from, caret, prefix, rank(prefix, table.columns.map(column => ({ text: column.name, detail: column.type, kind: 'column' as const }))));
  }

  const before = previousWord(tokens, from);
  const tableItems = tables.map(table => ({
    text: needsQuotes(table.name) ? `"${table.name}"` : table.name,
    detail: `${table.columns.length} columns`,
    kind: 'table' as const
  }));

  if (before !== null && TABLE_CONTEXT.has(before)) {
    return offer(from, caret, prefix, rank(prefix, tableItems));
  }

  if (prefix.length === 0) {
    // Without a prefix, a list of every keyword would be noise; offer
    // only the columns in scope, which is what a person pausing after
    // `SELECT` or `WHERE` is usually looking for.
    const items = columnsOf(scope.map(entry => entry.table));
    return items.length === 0 ? null : { from, to: caret, items: items.slice(0, LIMIT) };
  }

  return offer(
    from,
    caret,
    prefix,
    rank(prefix, [
      ...columnsOf(scope.map(entry => entry.table)),
      ...FUNCTIONS.map(name => ({ text: name, detail: 'function', kind: 'function' as const })),
      ...KEYWORDS.map(word => ({ text: word, detail: 'keyword', kind: 'keyword' as const })),
      ...tableItems
    ])
  );
}

/**
 * The list, or nothing when there is nothing worth showing.
 *
 * A word already typed out in full offers only itself back, and a list
 * like that is in the way: Enter would accept it instead of starting the
 * next line. So a single item that is the word as typed is no list.
 */
function offer(from: number, to: number, prefix: string, items: Completion[]): CompletionResult | null {
  if (items.length === 0) {
    return null;
  }
  if (items.length === 1 && unquote(items[0].text).toLowerCase() === prefix.toLowerCase()) {
    return null;
  }
  return { from, to, items };
}

/** The tables a statement names after FROM or JOIN, with the alias each goes by. */
export function tablesIn(sql: string, tables: readonly SchemaTable[]): { alias: string; table: SchemaTable }[] {
  const meaningful = tokenize(sql).filter(token => token.kind !== 'whitespace' && token.kind !== 'comment');
  const found: { alias: string; table: SchemaTable }[] = [];
  for (let index = 0; index < meaningful.length - 1; index++) {
    const word = meaningful[index].text.toUpperCase();
    if (word !== 'FROM' && word !== 'JOIN') {
      continue;
    }
    const nameToken = meaningful[index + 1];
    if (nameToken.kind !== 'identifier' && nameToken.kind !== 'quoted') {
      continue;
    }
    const name = unquote(nameToken.text).toLowerCase();
    const table = tables.find(entry => entry.name.toLowerCase() === name);
    if (table === undefined) {
      continue;
    }
    let aliasToken = meaningful[index + 2];
    if (aliasToken?.text.toUpperCase() === 'AS') {
      aliasToken = meaningful[index + 3];
    }
    const alias =
      aliasToken !== undefined && (aliasToken.kind === 'identifier' || aliasToken.kind === 'quoted')
        ? unquote(aliasToken.text).toLowerCase()
        : name;
    found.push({ alias, table });
    if (alias !== name) {
      found.push({ alias: name, table });
    }
  }
  return found;
}

function columnsOf(tables: readonly SchemaTable[]): Completion[] {
  const seen = new Set<string>();
  const items: Completion[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      if (seen.has(column.name)) {
        continue;
      }
      seen.add(column.name);
      items.push({ text: needsQuotes(column.name) ? `"${column.name}"` : column.name, detail: column.type, kind: 'column' });
    }
  }
  return items;
}

/**
 * Narrowed to the prefix and ordered by how well each matches.
 *
 * A match at the start beats a match after an underscore, which beats
 * one anywhere else; within each, the order the groups were given in is
 * kept, so columns stay above keywords that match equally well.
 */
function rank(prefix: string, items: readonly Completion[]): Completion[] {
  if (prefix.length === 0) {
    return items.slice(0, LIMIT);
  }
  const lower = prefix.toLowerCase();
  const scored: { item: Completion; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const name = unquote(item.text).toLowerCase();
    let score: number;
    if (name.startsWith(lower)) {
      score = 0;
    } else if (name.includes(`_${lower}`)) {
      score = 1;
    } else if (lower.length >= 2 && name.includes(lower)) {
      score = 2;
    } else {
      return;
    }
    scored.push({ item, score, order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.slice(0, LIMIT).map(entry => entry.item);
}

function previousWord(tokens: readonly Token[], before: number): string | null {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (token.end > before || token.kind === 'whitespace' || token.kind === 'comment') {
      continue;
    }
    return token.kind === 'keyword' || token.kind === 'identifier' ? token.text.toUpperCase() : null;
  }
  return null;
}

function unquote(name: string): string {
  return name.startsWith('"') && name.endsWith('"') && name.length >= 2 ? name.slice(1, -1).replaceAll('""', '"') : name;
}

/** Whether a name has to be written in double quotes to be read back as itself. */
export function needsQuotes(name: string): boolean {
  return !/^[a-z_][a-z0-9_]*$/.test(name) || KEYWORDS.includes(name.toUpperCase());
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
