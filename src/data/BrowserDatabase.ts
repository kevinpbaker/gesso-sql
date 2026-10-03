import * as duckdb from '@duckdb/duckdb-wasm';
import { Table } from 'apache-arrow';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';

import { rowsOf } from './arrowRows';
import type { Database, Lane, Rows } from './Database';

/**
 * DuckDB-WASM, in a worker of its own, opened from the application
 * worker.
 *
 * So there are four threads, not three. The shell forwards input; the
 * render worker draws; the application worker holds the workbench's
 * state and answers the grid; and DuckDB's worker runs the SQL. A query
 * that takes ten seconds occupies the fourth, and the third is still
 * free to say "that query is still running" and to hand the grid rows
 * it already has.
 *
 * Every statement is `send`, not `query`. `send` is the path DuckDB-WASM
 * can interrupt: it polls a pending query in steps and checks for a
 * cancel between them, where `query` runs to the end in one call. The
 * same steps are what let the second connection's page reads through
 * while the first is busy; see `Lane`.
 */
export async function openBrowserDatabase(): Promise<Database> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker }
  });
  if (bundle.mainWorker === null) {
    throw new Error('DuckDB chose a bundle with no worker.');
  }
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  await db.open({ query: { castBigIntToDouble: false, castDecimalToDouble: false } });
  const connection = await db.connect();
  const reader = await db.connect();
  const lanes: Record<Lane, duckdb.AsyncDuckDBConnection> = { run: connection, read: reader };
  const version = String(rowsOf(await connection.query('SELECT version() AS v')).rows[0][0]);
  const name = bundle.mainModule === ehWasm ? 'eh' : bundle.mainModule === mvpWasm ? 'mvp' : 'coi';

  return {
    version,
    bundle: name,
    async query(sql: string, lane: Lane = 'run'): Promise<Rows> {
      const stream = await lanes[lane].send(sql, true);
      const batches = [];
      for await (const batch of stream) {
        batches.push(batch);
      }
      return rowsOf(new Table(stream.schema, batches));
    },
    async cancel(): Promise<void> {
      await connection.cancelSent();
    },
    async registerFile(file: string, bytes: Uint8Array): Promise<void> {
      await db.registerFileBuffer(file, bytes);
    },
    async copyToCsv(select: string): Promise<string> {
      // DuckDB-WASM writes to a buffer it was told about, not to a disk.
      const file = `export-${Date.now()}.csv`;
      await db.registerEmptyFileBuffer(file);
      try {
        await connection.query(`COPY (${select}\n) TO '${file}' (HEADER)`);
        return new TextDecoder().decode(await db.copyFileToBuffer(file));
      } finally {
        await db.dropFile(file);
      }
    }
  };
}
