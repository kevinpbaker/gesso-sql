/**
 * The application worker: the workbench's state, and DuckDB's owner.
 *
 * `gesso-vite-plugin` finds this file by name and writes the
 * `appLogicWorker` construction into `createApp`, so `main.ts` names
 * neither worker.
 *
 * `serveChannels` is called synchronously, before any await, or the
 * render worker's handshake is missed. Starting DuckDB happens after,
 * and the screen says "Starting DuckDB…" for as long as that takes,
 * because that is the `run` key's initial value in the contract.
 */
import { serveChannels } from 'gesso-framework';

import { openBrowserDatabase } from './data/BrowserDatabase';
import { OpfsStore } from './data/OpfsStore';
import { workbenchChannel } from './data/workbenchChannel';
import { WorkbenchService } from './data/WorkbenchService';

const service = new WorkbenchService({ open: openBrowserDatabase, store: new OpfsStore() });

serveChannels([workbenchChannel(service)]);

void service.start();
