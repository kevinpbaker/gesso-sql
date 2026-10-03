import { format } from 'sql-formatter';

/**
 * The editor's two text commands, as functions from text to text.
 *
 * Each returns the stretch to replace and what to put there, rather than
 * the whole new text, so the editor applies it as one edit through the
 * field's own model and Undo takes it back in one step.
 */
export interface Edit {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** Where the selection goes afterwards. */
  readonly selectFrom: number;
  readonly selectTo: number;
}

/**
 * Comments or uncomments the lines the selection touches, with `-- `.
 *
 * If every line with anything on it is already a comment, they all lose
 * their marker; otherwise every such line gains one, at the indent of
 * the least indented, so a block keeps its shape. Blank lines are left
 * alone either way. A selection ending at the very start of a line does
 * not take that line in, as in every other editor.
 */
export function toggleComment(text: string, start: number, end: number): Edit {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let stop = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nextBreak = text.indexOf('\n', stop);
  stop = nextBreak === -1 ? text.length : nextBreak;
  const lines = text.slice(lineStart, stop).split('\n');
  const filled = lines.filter(line => line.trim() !== '');
  const commented = filled.length > 0 && filled.every(line => /^\s*--/.test(line));
  let replaced: string[];
  if (commented) {
    replaced = lines.map(line => line.replace(/^(\s*)-- ?/, '$1'));
  } else {
    const indent = Math.min(...filled.map(line => line.length - line.trimStart().length));
    replaced = lines.map(line => (line.trim() === '' ? line : `${line.slice(0, indent)}-- ${line.slice(indent)}`));
  }
  const replacement = replaced.join('\n');
  const delta = replacement.length - (stop - lineStart);
  const collapsed = start === end;
  return {
    from: lineStart,
    to: stop,
    text: replacement,
    // A caret stays on its line, nudged by the marker; a selection grows
    // or shrinks to cover the same lines.
    selectFrom: collapsed ? Math.max(lineStart, start + (commented ? -Math.min(3, start - lineStart) : 3)) : lineStart,
    selectTo: collapsed ? Math.max(lineStart, start + (commented ? -Math.min(3, start - lineStart) : 3)) : stop + delta
  };
}

/**
 * Lays SQL out: keywords in capitals, one clause to a line, the body of
 * each clause indented. The selection if there is one, or else the whole
 * script. Null when the formatter cannot read the SQL, in which case the
 * text is left as it was.
 */
export function formatSql(text: string, start: number, end: number): Edit | null {
  const from = start === end ? 0 : start;
  const to = start === end ? text.length : end;
  try {
    const formatted = format(text.slice(from, to), { language: 'duckdb', keywordCase: 'upper', linesBetweenQueries: 1 });
    const trailing = to === text.length && text.endsWith('\n') && !formatted.endsWith('\n') ? '\n' : '';
    const replacement = `${formatted}${trailing}`;
    return { from, to, text: replacement, selectFrom: from, selectTo: from + replacement.length };
  } catch {
    return null;
  }
}
