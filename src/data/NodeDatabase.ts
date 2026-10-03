import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rowsOf } from './arrowRows';
import type { Database, Rows } from './Database';

/** The little of the blocking build's API this uses; its own types are not reachable through the package's exports. */
interface BlockingBuild {
  createDuckDB(
    bundles: { mvp: { mainModule: string; mainWorker: string }; eh: { mainModule: string; mainWorker: string } },
    logger: unknown,
    runtime: unknown
  ): Promise<{
    instantiate(): Promise<unknown>;
    connect(): { query(sql: string): import('apache-arrow').Table };
    registerFileBuffer(name: string, bytes: Uint8Array): void;
  }>;
  VoidLogger: new () => unknown;
  NODE_RUNTIME: unknown;
}

/**
 * DuckDB-WASM's blocking build, for the specs.
 *
 * The same engine the browser runs, compiled to the same WebAssembly,
 * loaded into node. Every query is synchronous underneath and wrapped
 * in a promise on the way out, so the service above cannot tell it from
 * the worker build. Cancelling does nothing, because nothing is ever in
 * flight long enough to cancel.
 */
export async function openNodeDatabase(): Promise<Database> {
  const require = createRequire(import.meta.url);
  // The CommonJS build: its ESM twin does not resolve under vitest's node loader.
  const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs') as BlockingBuild;
  const dist = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm').replace(/duckdb-eh\.wasm$/, '');
  const db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: `${dist}duckdb-mvp.wasm`, mainWorker: '' },
      eh: { mainModule: `${dist}duckdb-eh.wasm`, mainWorker: '' }
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME
  );
  await db.instantiate();
  const connection = db.connect();
  const version = String(rowsOf(connection.query('SELECT version() AS v')).rows[0][0]);

  return {
    version,
    bundle: 'node',
    // One connection for both lanes: the blocking build finishes each
    // statement before the next can be asked for, so there is nothing
    // for a second one to overlap.
    async query(sql: string): Promise<Rows> {
      return rowsOf(connection.query(sql));
    },
    async cancel(): Promise<void> {},
    async registerFile(name: string, bytes: Uint8Array): Promise<void> {
      db.registerFileBuffer(name, bytes);
    },
    async copyToCsv(select: string): Promise<string> {
      // The node runtime writes to the real file system, so somewhere
      // that is the spec's own and is gone afterwards.
      const directory = mkdtempSync(join(tmpdir(), 'gesso-sql-'));
      const path = join(directory, 'result.csv');
      try {
        connection.query(`COPY (${select}\n) TO '${path}' (HEADER)`);
        return readFileSync(path, 'utf8');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  };
}
