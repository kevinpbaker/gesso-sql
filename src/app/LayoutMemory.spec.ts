import { describe, expect, it } from 'vitest';

import { DEFAULT_LAYOUT, reviveLayout } from './LayoutMemory';
import { displayValue } from './ValuePanel';

describe('reviveLayout', () => {
  it('reads back what was saved, and falls back field by field on anything odd', () => {
    expect(reviveLayout({ sideSplit: 0.3, editorSplit: 0.6, sideTab: 'history', widths: { fare: 120 } })).toEqual({
      sideSplit: 0.3,
      editorSplit: 0.6,
      sideTab: 'history',
      widths: { fare: 120 }
    });
    expect(reviveLayout({ sideSplit: 7, sideTab: 'nonsense', widths: { a: -1, b: 'x', c: 90 } })).toEqual({
      ...DEFAULT_LAYOUT,
      widths: { c: 90 }
    });
    expect(reviveLayout('garbage')).toBeNull();
  });
});

describe('displayValue', () => {
  const base = { id: 1, order: 0, row: 0, column: 0, name: 'v', type: 'STRUCT', cut: false };
  it('lays JSON out, and shows anything else as it came', () => {
    expect(displayValue({ ...base, value: '{"a":1}', json: true })).toBe('{\n  "a": 1\n}');
    expect(displayValue({ ...base, value: '{not json', json: true })).toBe('{not json');
    expect(displayValue({ ...base, value: null, json: false })).toBe('NULL');
  });
});
