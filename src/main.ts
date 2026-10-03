/**
 * The main thread's entire job.
 *
 * Find a host, create the app, mount. `gesso-vite-plugin` writes both
 * worker constructions from `vite.config.ts`: `worker.ts` beside this
 * file is the render worker and `AppWorker.ts` is the application
 * worker, which in turn starts DuckDB in a worker of its own. Nothing
 * that runs a query, lays out a row or draws a pixel runs here.
 *
 * Ctrl/Cmd+O and Ctrl/Cmd+S are the workbench's, not the page's: the
 * shell has to say so before the render worker has heard of the key,
 * or the browser's own dialog opens over the editor.
 */
import { proofPanel } from 'gesso-devtools';
import { createApp } from 'gesso-framework';

import { isProofPath } from './route';

const host = document.querySelector<HTMLElement>('#app');
if (host === null) {
  throw new Error('index.html has no #app element to mount into.');
}

const panel = isProofPath(location.pathname) ? proofPanel(host, { global: 'gessoSqlProof', layout: true }) : null;
const app = createApp({
  ...(panel?.options ?? {}),
  history: { mode: 'path' },
  onError: (message, stack, source) => console.error(`[gesso ${source}] ${message}`, stack),
  interceptKey: event =>
    (event.ctrlKey || event.metaKey) && !event.altKey && (event.key.toLowerCase() === 'o' || event.key.toLowerCase() === 's')
});
panel?.attach(app);
app.mount(host);
