import type { Table } from 'apache-arrow';

import type { Rows, Value } from './Database';

/**
 * An Arrow table as plain rows.
 *
 * Shared by both implementations of `Database`, since DuckDB-WASM hands
 * back Arrow from the blocking build and the worker build alike. The
 * workbench's own queries cast what they display to VARCHAR, so the
 * conversions here are for counts, sizes and the odd boolean.
 */
export function rowsOf(table: Table): Rows {
  const columns = table.schema.fields.map(field => field.name);
  const vectors = columns.map((_, index) => table.getChildAt(index));
  const rows: Value[][] = [];
  for (let row = 0; row < table.numRows; row++) {
    rows.push(vectors.map(vector => plain(vector?.get(row))));
  }
  return { columns, rows };
}

function plain(value: unknown): Value {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : String(value);
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}
