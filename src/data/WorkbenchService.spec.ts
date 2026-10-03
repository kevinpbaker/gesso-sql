import { firstValueFrom, filter } from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';

import { openNodeDatabase } from './NodeDatabase';
import { MemoryStore } from './OpfsStore';
import { tableNameFor, WorkbenchService } from './WorkbenchService';
import type { Database } from './Database';
import { WELCOME } from './sample';

/**
 * The workbench against a real DuckDB: the blocking WebAssembly build,
 * in node, with the same SQL the browser runs.
 */

const ROWS = 20_000;

async function started(options: { store?: MemoryStore; open?: () => Promise<Database> } = {}): Promise<WorkbenchService> {
  const service = new WorkbenchService({
    open: options.open ?? openNodeDatabase,
    store: options.store ?? new MemoryStore(),
    sampleRows: ROWS,
    pageSize: 50
  });
  await service.start();
  return service;
}

async function ran(service: WorkbenchService, sql: string): Promise<void> {
  await service.run({ sql, at: 0 });
}

/** Asks for a window and waits until it has been answered in full. */
async function windowOf(service: WorkbenchService, first: number, last: number) {
  const { id, order } = service.result$.value;
  service.fetch({ id, order, first, last });
  return firstValueFrom(
    service.window$.pipe(filter(window => window.id === id && window.order === order && window.rows[last] !== undefined))
  );
}

describe('WorkbenchService', () => {
  let service: WorkbenchService;

  beforeAll(async () => {
    service = await started();
  });

  it('starts DuckDB, generates the sample, and describes it', () => {
    expect(service.run$.value.phase).toBe('ready');
    expect(service.run$.value.message).toMatch(/^Generated 20,000 trips/);
    expect(service.engine$.value.version).toMatch(/^v1\./);
    const names = service.schema$.value.map(table => table.name);
    expect(names).toEqual(['trips', 'zones']);
    const trips = service.schema$.value.find(table => table.name === 'trips');
    expect(trips?.rows).toBe(ROWS);
    expect(trips?.columns.map(column => column.name)).toContain('fare');
  });

  it('gives the editor the welcome script the first time', () => {
    expect(service.draft$.value).toBe(WELCOME);
  });

  it('runs every query in the welcome script', async () => {
    const fresh = await started();
    const { splitStatements } = await import('../sql/statements');
    for (const statement of splitStatements(WELCOME)) {
      await ran(fresh, statement.text);
      expect(fresh.run$.value.error, statement.text).toBe('');
      expect(fresh.result$.value.rowCount, statement.text).toBeGreaterThan(0);
    }
  });

  it('materialises a query, describes its columns and pages it by row', async () => {
    await ran(service, 'SELECT trip_id, fare, payment FROM trips ORDER BY trip_id');
    const result = service.result$.value;
    expect(result.rowCount).toBe(ROWS);
    expect(result.columns.map(column => [column.name, column.type, column.kind])).toEqual([
      ['trip_id', 'BIGINT', 'number'],
      ['fare', 'DECIMAL(10,2)', 'number'],
      ['payment', 'VARCHAR', 'text']
    ]);
    expect(result.columns.every(column => column.width >= 72)).toBe(true);

    const window = await windowOf(service, 12_345, 12_400);
    expect(window.rows[12_345][0]).toBe('12346');
    expect(window.rows[12_400][0]).toBe('12401');
    // Only what was asked for crosses.
    expect(Object.keys(window.rows)).toHaveLength(56);
  });

  it('runs a selection of several statements in order, and shows the last', async () => {
    await ran(service, 'CREATE TEMP TABLE scratch AS SELECT 1 AS x; INSERT INTO scratch VALUES (2); SELECT sum(x) AS total FROM scratch');
    expect(service.run$.value).toMatchObject({ phase: 'ready', message: expect.stringMatching(/^Ran 3 statements/) });
    expect(service.result$.value.columns.map(column => column.name)).toEqual(['total']);
    const window = await windowOf(service, 0, 0);
    expect(window.rows[0][0]).toBe('3');
  });

  it('stops a selection at the first failure, and points at it in the selection', async () => {
    const sql = 'SELECT 1;\nSELECT nope FROM trips;\nSELECT 3';
    await ran(service, sql);
    expect(service.run$.value.phase).toBe('failed');
    expect(service.run$.value.errorAt).toBe(sql.indexOf('nope'));
    expect(service.history$.value[0].sql).toBe('SELECT nope FROM trips');
  });

  it('records each statement in history, newest first', async () => {
    const before = service.history$.value.length;
    await ran(service, 'SELECT 42 AS answer');
    const history = service.history$.value;
    expect(history).toHaveLength(before + 1);
    expect(history[0]).toMatchObject({ sql: 'SELECT 42 AS answer', rows: 1, error: '' });
  });

  it('sorts by writing a sorted copy, and pages the new order', async () => {
    await ran(service, 'SELECT trip_id, fare FROM trips');
    const { id } = service.result$.value;
    await service.sort({ id, sort: { column: 1, direction: 'descending' } });
    const result = service.result$.value;
    expect(result).toMatchObject({ order: 1, sorting: false, sort: { column: 1, direction: 'descending' } });
    const window = await windowOf(service, 0, 3);
    const fares = [0, 1, 2, 3].map(row => Number(window.rows[row][1]));
    expect([...fares].sort((a, b) => b - a)).toEqual(fares);

    await service.sort({ id, sort: null });
    expect(service.result$.value.order).toBe(2);
  });

  it('ignores a window asked for by a result that has since been replaced', async () => {
    await ran(service, 'SELECT 1 AS a');
    const stale = service.result$.value;
    await ran(service, 'SELECT 2 AS b');
    service.fetch({ id: stale.id, order: stale.order, first: 0, last: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.window$.value.id).toBe(service.result$.value.id);
  });

  it('runs a statement without rows, says what it did, and refreshes the schema', async () => {
    await ran(service, 'CREATE TABLE fares AS SELECT fare FROM trips LIMIT 10');
    expect(service.result$.value).toMatchObject({ rowCount: 0, note: '10 rows changed.' });
    expect(service.schema$.value.map(table => table.name)).toContain('fares');
    await ran(service, 'DROP TABLE fares');
    expect(service.schema$.value.map(table => table.name)).not.toContain('fares');
  });

  it('materialises DESCRIBE and SUMMARIZE too', async () => {
    await ran(service, 'DESCRIBE trips');
    expect(service.result$.value.columns[0].name).toBe('column_name');
    await ran(service, 'SUMMARIZE zones');
    expect(service.result$.value.rowCount).toBe(3);
  });

  it('keeps an EXPLAIN as text', async () => {
    await ran(service, 'EXPLAIN SELECT count(*) FROM trips');
    expect(service.result$.value.note).toMatch(/SEQ_SCAN|TABLE_SCAN|UNGROUPED_AGGREGATE/);
  });

  it('reports a failure, points at it, and keeps the last result', async () => {
    await ran(service, 'SELECT 7 AS kept');
    const kept = service.result$.value.id;
    await ran(service, 'SELECT nope\nFROM trips');
    expect(service.run$.value.phase).toBe('failed');
    expect(service.run$.value.error).toMatch(/nope/);
    expect(service.run$.value.error).not.toMatch(/LINE/);
    expect(service.run$.value.errorAt).toBe(7);
    expect(service.result$.value.id).toBe(kept);
    // And a failure does not wedge it.
    await ran(service, 'SELECT 1');
    expect(service.run$.value.phase).toBe('ready');
  });

  it('charts a small result row by row, and a large one by its biggest groups', async () => {
    await ran(service, 'SELECT payment, count(*) AS trips FROM trips GROUP BY 1 ORDER BY 2 DESC');
    await service.chart({ id: service.result$.value.id, label: 0, value: 1 });
    const small = service.chart$.value;
    expect(small.points[0].label).toBe('card');
    expect(small.points.reduce((sum, point) => sum + point.value, 0)).toBe(ROWS);

    await ran(service, 'SELECT payment, fare FROM trips');
    await service.chart({ id: service.result$.value.id, label: 0, value: 1 });
    const large = service.chart$.value;
    expect(large.value).toBe('sum(fare)');
    expect(large.points.length).toBeLessThanOrEqual(4);
  });

  it('profiles a column', async () => {
    await ran(service, 'SELECT payment, fare FROM trips');
    await service.profile({ id: service.result$.value.id, column: 0 });
    const profile = service.profile$.value;
    expect(profile).toMatchObject({ name: 'payment', nulls: 0 });
    expect(profile?.top[0].value).toBe('card');
    await service.profile({ id: service.result$.value.id, column: 1 });
    expect(Number(service.profile$.value?.mean)).toBeGreaterThan(3);
  });

  it('exports a result as CSV', async () => {
    await ran(service, "SELECT 1 AS a, 'x,y' AS b UNION ALL SELECT 2, NULL");
    await service.exportCsv({ id: service.result$.value.id });
    expect(service.download$.value?.text.trim().split('\n')).toEqual(['a,b', '1,"x,y"', '2,']);
  });

  it('opens a CSV dropped in as a table named after it', async () => {
    const bytes = new TextEncoder().encode('city,visits\nLisbon,3\nOslo,5\n');
    await service.open({ name: 'My Cities.csv', bytes });
    expect(service.notice$.value?.text).toMatch(/^Loaded My Cities.csv as my_cities: 2 rows/);
    expect(service.schema$.value.find(table => table.name === 'my_cities')?.columns.map(column => column.type)).toEqual([
      'VARCHAR',
      'BIGINT'
    ]);
  });

  it('turns down a file it cannot read', async () => {
    await service.open({ name: 'notes.docx', bytes: new Uint8Array([1, 2, 3]) });
    expect(service.notice$.value).toMatchObject({ tone: 'error' });
  });

  it('saves the draft and the history, and reads them back', async () => {
    const store = new MemoryStore();
    const first = await started({ store });
    first.saveDraft('SELECT 99');
    await ran(first, 'SELECT 1 AS one');
    await first.flush();
    const second = await started({ store });
    expect(second.draft$.value).toBe('SELECT 99');
    expect(second.history$.value[0].sql).toBe('SELECT 1 AS one');
  });

  it('says so when DuckDB will not start', async () => {
    const broken = await started({ open: () => Promise.reject(new Error('no wasm')) });
    expect(broken.run$.value).toMatchObject({ phase: 'failed', error: 'DuckDB could not start: no wasm' });
  });
});

describe('tableNameFor', () => {
  it('makes a file name into an identifier nobody has to quote', () => {
    expect(tableNameFor('Trips 2024.csv')).toBe('trips_2024');
    expect(tableNameFor('2024.parquet')).toBe('t_2024');
    expect(tableNameFor('.csv')).toBe('upload');
  });
});

describe('the sample', () => {
  it('has trips in every hour of the day, most in the evening', async () => {
    const service = await started();
    await ran(service, 'SELECT hour(pickup_at) AS hour, count(*) AS trips FROM trips GROUP BY 1 ORDER BY 2 DESC');
    expect(service.result$.value.rowCount).toBe(24);
    const window = await windowOf(service, 0, 23);
    expect(Number(window.rows[0][0])).toBeGreaterThanOrEqual(17);
    expect(Number(window.rows[0][0])).toBeLessThanOrEqual(21);
  });
});
