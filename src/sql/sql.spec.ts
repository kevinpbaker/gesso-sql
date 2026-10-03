import { describe, expect, it } from 'vitest';

import { complete, tablesIn, type SchemaTable } from './complete';
import { sqlSpans, SYNTAX } from './highlight';
import { classify, errorOffset, errorSummary, splitStatements, statementAt } from './statements';
import { tokenize } from './tokenize';

const AWKWARD = [
  '',
  'SELECT 1',
  "SELECT 'it''s; not -- a comment' AS x; SELECT 2",
  'SELECT $$ dollar ; quoted $$, $tag$ x $tag$',
  'SELECT "quoted ""name""" FROM t /* block ; */ WHERE a >= 1_000.5e3',
  "SELECT 'unterminated",
  '-- only a comment',
  'SELECT a::INTEGER, b->>\'x\', [1, 2][1] FROM t WHERE c <> $1',
  'SELECT ünïcödé, 🦆 FROM t'
];

describe('tokenize', () => {
  it('puts every character in exactly one token, in order', () => {
    for (const text of AWKWARD) {
      const tokens = tokenize(text);
      expect(tokens.map(token => token.text).join('')).toBe(text);
      let at = 0;
      for (const token of tokens) {
        expect(token.start).toBe(at);
        at = token.end;
      }
    }
  });

  it('knows a semicolon in a string from one between statements', () => {
    const kinds = tokenize("SELECT 'a;b'; SELECT 2").map(token => token.kind);
    expect(kinds.filter(kind => kind === 'semicolon')).toHaveLength(1);
  });

  it('does not take a keyword inside a comment or a string for a keyword', () => {
    const tokens = tokenize("-- SELECT\n'FROM'");
    expect(tokens.map(token => token.kind)).toEqual(['comment', 'whitespace', 'string']);
  });
});

describe('statements', () => {
  const script = "SELECT 1;\n\n-- the second\nSELECT ';' AS semi;\nSELECT 3";

  it('splits on the semicolons the tokenizer saw, and keeps a leading comment', () => {
    expect(splitStatements(script).map(statement => statement.text)).toEqual([
      'SELECT 1',
      "-- the second\nSELECT ';' AS semi",
      'SELECT 3'
    ]);
  });

  it('finds the statement under the caret, and the one above a blank line', () => {
    expect(statementAt(script, 3)?.text).toBe('SELECT 1');
    expect(statementAt(script, script.indexOf('semi'))?.text).toContain("SELECT ';'");
    expect(statementAt(script, script.length)?.text).toBe('SELECT 3');
    // Just past a semicolon is still that statement.
    expect(statementAt(script, script.indexOf(';') + 1)?.text).toBe('SELECT 1');
    expect(statementAt('  ', 0)).toBeNull();
  });

  it('classifies statements by how they are run', () => {
    expect(classify('-- note\nselect 1')).toBe('rows');
    expect(classify('FROM trips')).toBe('rows');
    expect(classify('with x as (select 1) select * from x')).toBe('rows');
    expect(classify('SUMMARIZE trips')).toBe('wrapped');
    expect(classify('explain select 1')).toBe('explain');
    expect(classify('CREATE TABLE a (x INT)')).toBe('other');
  });

  it("reads where DuckDB's caret points, net of the prefix the workbench added", () => {
    const sql = 'SELECT a\nFROM nope';
    const message = 'Catalog Error: Table with name nope does not exist!\n\nLINE 2: FROM nope\n             ^';
    expect(errorOffset(message, sql, 0)).toBe(sql.indexOf('nope'));
    const first = 'Parser Error: syntax error at or near "selec"\n\nLINE 1: PREFIX selec 1\n               ^';
    expect(errorOffset(first, 'selec 1', 'PREFIX '.length)).toBe(0);
    expect(errorOffset('LINE 1: ...long\n   ^', 'x', 0)).toBe(-1);
    expect(errorSummary(message)).toBe('Catalog Error: Table with name nope does not exist!');
  });

  it("reads DuckDB-WASM's JSON errors, whose position is a character offset", () => {
    const prefix = 'CREATE OR REPLACE TEMP TABLE __result_1 AS ';
    const sql = 'SELECT hour\nFROM tripsGROUP BY 1';
    const position = prefix.length + sql.indexOf('BY');
    const message = JSON.stringify({
      exception_type: 'Parser',
      exception_message: `syntax error at or near "BY"\n\nLINE 2: FROM tripsGROUP BY 1\n                       ^`,
      error_subtype: 'SYNTAX_ERROR',
      position: String(position)
    });
    expect(errorOffset(message, sql, prefix.length)).toBe(sql.indexOf('BY'));
    expect(errorSummary(message)).toBe('Parser Error: syntax error at or near "BY"');
    expect(errorSummary(JSON.stringify({ exception_type: 'Catalog', exception_message: 'Table with name nope does not exist!' }))).toBe(
      'Catalog Error: Table with name nope does not exist!'
    );
  });
});

describe('highlight', () => {
  it('tiles the text exactly, and colours what it should', () => {
    for (const text of AWKWARD.filter(text => text !== '')) {
      const spans = sqlSpans(text) ?? [];
      expect(spans.map(span => span.text).join('')).toBe(text);
    }
    const spans = sqlSpans("SELECT count(*), 'x' -- n") ?? [];
    expect(spans.find(span => span.text.startsWith('SELECT'))?.color).toBe(SYNTAX.keyword);
    expect(spans.find(span => span.text === 'count')?.color).toBe(SYNTAX.function);
    expect(spans.find(span => span.text.startsWith("'x'"))?.color).toBe(SYNTAX.string);
    expect(spans.find(span => span.text.startsWith('--'))?.color).toBe(SYNTAX.comment);
  });

  it('draws nothing special for an empty editor', () => {
    expect(sqlSpans('')).toBeUndefined();
  });
});

describe('complete', () => {
  const tables: SchemaTable[] = [
    { name: 'trips', columns: [{ name: 'trip_id', type: 'BIGINT' }, { name: 'fare', type: 'DECIMAL(10,2)' }, { name: 'pickup_zone', type: 'INTEGER' }] },
    { name: 'zones', columns: [{ name: 'zone_id', type: 'INTEGER' }, { name: 'borough', type: 'VARCHAR' }] }
  ];
  const at = (text: string) => complete(text.replace('|', ''), text.indexOf('|'), tables);

  it('offers tables after FROM and JOIN', () => {
    expect(at('SELECT * FROM tr|')?.items.map(item => item.text)).toEqual(['trips']);
    expect(at('SELECT * FROM trips JOIN |')?.items.map(item => item.kind)).toEqual(['table', 'table']);
  });

  it("offers a table's columns after its alias and a dot", () => {
    const result = at('SELECT z.| FROM trips t JOIN zones z ON true');
    expect(result?.items.map(item => item.text)).toEqual(['zone_id', 'borough']);
    expect(at('SELECT t.fa| FROM trips t')?.items.map(item => item.text)).toEqual(['fare']);
  });

  it('puts columns in scope above functions and keywords', () => {
    const items = at('SELECT f| FROM trips')?.items ?? [];
    expect(items[0]).toMatchObject({ text: 'fare', kind: 'column' });
    expect(items.some(item => item.kind === 'function')).toBe(true);
    expect(items.some(item => item.text === 'FROM')).toBe(true);
  });

  it('replaces exactly the word being typed', () => {
    const result = at('SELECT cou| FROM trips');
    expect(result).toMatchObject({ from: 7, to: 10 });
  });

  it('offers nothing inside a string, or for a word already complete', () => {
    expect(at("SELECT 'fa|")).toBeNull();
    expect(at('SELECT fare| FROM trips')).toBeNull();
    // After FROM too, where only tables are offered.
    expect(at('SELECT * FROM trips|')).toBeNull();
    expect(at('SELECT t.fare| FROM trips t')).toBeNull();
  });

  it('reads the tables a statement names, with their aliases', () => {
    expect(tablesIn('SELECT * FROM trips AS t JOIN zones ON 1=1', tables).map(entry => entry.alias)).toEqual(['t', 'trips', 'zones']);
  });
});

describe('editorSpans', () => {
  it('tiles the text with the active statement washed and the error marked', async () => {
    const { editorSpans, ACTIVE_WASH, ERROR_WASH } = await import('./highlight');
    const text = 'SELECT 1;\nSELECT nope FROM t;';
    const start = text.indexOf('SELECT nope');
    const spans = editorSpans(text, { start, end: text.length - 1 }, { start: text.indexOf('nope'), end: text.indexOf('nope') + 4 }) ?? [];
    expect(spans.map(span => span.text).join('')).toBe(text);
    expect(spans.find(span => span.text === 'nope')?.backgroundColor).toBe(ERROR_WASH);
    expect(spans.find(span => span.text.startsWith('FROM'))?.backgroundColor).toBe(ACTIVE_WASH);
    expect(spans[0].backgroundColor).toBeUndefined();
    for (const text of AWKWARD.filter(text => text !== '')) {
      expect((editorSpans(text, { start: 2, end: 5 }, null) ?? []).map(span => span.text).join('')).toBe(text);
    }
  });
});
