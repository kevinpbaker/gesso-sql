import { describe, expect, it } from 'vitest';

import { formatSql, toggleComment, type Edit } from './editing';

const apply = (text: string, edit: Edit): string => text.slice(0, edit.from) + edit.text + text.slice(edit.to);

describe('toggleComment', () => {
  it('comments the caret line, and uncomments it again', () => {
    const text = 'SELECT 1\nFROM t';
    const once = apply(text, toggleComment(text, 3, 3));
    expect(once).toBe('-- SELECT 1\nFROM t');
    expect(apply(once, toggleComment(once, 5, 5))).toBe(text);
  });

  it('comments a selected block at its shallowest indent, skipping blank lines', () => {
    const text = 'SELECT a,\n  b\n\n  FROM t';
    const edit = toggleComment(text, 0, text.length);
    expect(apply(text, edit)).toBe('-- SELECT a,\n--   b\n\n--   FROM t');
    expect(edit.selectFrom).toBe(0);
    expect(edit.selectTo).toBe(apply(text, edit).length);
  });

  it('leaves out a line the selection only reaches the start of', () => {
    const text = 'a\nb\nc';
    expect(apply(text, toggleComment(text, 0, 2))).toBe('-- a\nb\nc');
  });

  it('comments every line when only some are comments already', () => {
    const text = '-- a\nb';
    expect(apply(text, toggleComment(text, 0, text.length))).toBe('-- -- a\n-- b');
  });
});

describe('formatSql', () => {
  it('lays out the whole script when nothing is selected', () => {
    const text = 'select a, count(*) from trips group by all;\n';
    const edit = formatSql(text, 0, 0)!;
    expect(apply(text, edit)).toBe('SELECT\n  a,\n  count(*)\nFROM\n  trips\nGROUP BY ALL;\n');
  });

  it('lays out only the selection when there is one', () => {
    const text = '-- keep me\nselect 1 from t';
    const start = text.indexOf('select');
    expect(apply(text, formatSql(text, start, text.length)!)).toBe('-- keep me\nSELECT\n  1\nFROM\n  t');
  });

  it('leaves SQL it cannot read alone', () => {
    expect(formatSql("SELECT 'unterminated", 0, 0)).toBeNull();
  });
});
