/**
 * Cells as tab-separated text, the way a spreadsheet pastes them.
 *
 * Shared by the grid, which copies what it already holds, and by the
 * application worker, which builds the text for a range larger than the
 * screen; both must spell a value the same way. A value holding a tab, a
 * newline or a double quote is quoted and its quotes doubled, as Excel,
 * Google Sheets and gesso-sheets all read it. NULL is an empty cell.
 */
export function tsv(rows: readonly (readonly (string | null)[])[], headers?: readonly string[]): string {
  const lines = headers === undefined ? [] : [headers.map(field).join('\t')];
  for (const row of rows) {
    lines.push(row.map(value => (value === null ? '' : field(value))).join('\t'));
  }
  return lines.join('\n');
}

function field(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
