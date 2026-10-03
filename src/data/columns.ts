import type { ColumnKind } from '../app/Contract';

/**
 * What kind of value a DuckDB type holds, for drawing it.
 *
 * Numbers line up on the right, as they do in every tool people already
 * read numbers in; nested values are drawn as DuckDB writes them. The
 * test is on DuckDB's own type names, which `DESCRIBE` gives.
 */
export function kindOf(type: string): ColumnKind {
  const upper = type.toUpperCase();
  if (upper.endsWith('[]') || /^(STRUCT|MAP|UNION|LIST)\b/.test(upper) || /\[\d+\]$/.test(upper)) {
    return 'nested';
  }
  if (/^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)\b/.test(upper)) {
    return 'number';
  }
  if (/^(DATE|TIME|TIMESTAMP|INTERVAL)\b/.test(upper)) {
    return 'time';
  }
  if (upper === 'BOOLEAN') {
    return 'boolean';
  }
  if (upper === 'VARCHAR' || upper === 'UUID' || upper === 'BLOB' || upper === 'BIT' || upper === 'JSON' || upper.startsWith('ENUM')) {
    return 'text';
  }
  return 'other';
}

/** The width of one character of the grid's monospace face, at its size. */
export const CHARACTER_WIDTH = 7.25;
export const MIN_COLUMN_WIDTH = 72;
export const MAX_COLUMN_WIDTH = 360;
/** The cell's padding, both sides, plus the room the sort arrow takes in a header. */
const CELL_PADDING = 28;

/**
 * A width that fits a column, from its name and a sample of its values.
 *
 * Measured in characters rather than pixels: the grid draws values in
 * a monospace face, so a character count is the measurement and there
 * is no text measurer in this thread to ask anyway. The header's name
 * is drawn in the sans face, slightly narrower, which this ignores in
 * the generous direction.
 */
export function widthOf(name: string, type: string, sample: readonly (string | null)[]): number {
  let longest = Math.max(name.length, Math.min(type.length, 14));
  for (const value of sample) {
    if (value !== null && value.length > longest) {
      longest = value.length;
    }
  }
  const width = Math.ceil(longest * CHARACTER_WIDTH) + CELL_PADDING;
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width));
}
