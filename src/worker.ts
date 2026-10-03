/**
 * The render worker: everything the person sees.
 *
 * A component cannot cross `postMessage`, so the root and the routes are
 * named here. `useChannel(Workbench)` with no worker named resolves to
 * the application worker the shell spawned, so nothing in this thread
 * learns where the rows come from.
 */
import { renderRoot } from 'gesso-framework';

import { Workbench } from './app/Contract';
import { LayoutMemory } from './app/LayoutMemory';
import { AppRoot, ROUTES, WORKBENCH } from './app/Routes';

renderRoot(AppRoot).useChannel(Workbench).useService(LayoutMemory).useRoutes({ routes: ROUTES, notFound: WORKBENCH });
