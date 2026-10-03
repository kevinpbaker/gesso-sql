import { createChannelRegistry, createComponent, ServiceRegistry, type ComponentType } from 'gesso-framework';

import { LayoutMemory } from './LayoutMemory';
import { renderTest, type Rendered } from 'gesso-testing';

import { openNodeDatabase } from '../data/NodeDatabase';
import { MemoryStore } from '../data/OpfsStore';
import { workbenchChannel } from '../data/workbenchChannel';
import { WorkbenchService } from '../data/WorkbenchService';

/**
 * The screen over the real thing: a `WorkbenchService` on the blocking
 * build of DuckDB, served to the components through a channel exactly
 * as the application worker serves it, in node, with no browser.
 */
export interface Mounted {
  readonly ui: Rendered;
  readonly service: WorkbenchService;
  /** Runs SQL through the service and lets the patches reach the screen. */
  run(sql: string): Promise<void>;
  dispose(): void;
}

/**
 * Lets every message in flight land: a command crosses a real port to
 * the service, the service answers on its own clock, and its patches
 * cross back. `settle` covers one round of that; a handful covers a
 * command, a query and the page fetch the query's grid then asks for.
 */
export async function flush(ui: Rendered, rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    await ui.settle();
  }
}

export async function mount(component: ComponentType, options: { rows?: number; width?: number; height?: number } = {}): Promise<Mounted> {
  const service = new WorkbenchService({ open: openNodeDatabase, store: new MemoryStore(), sampleRows: options.rows ?? 5_000, pageSize: 64 });
  await service.start();
  const channels = createChannelRegistry([workbenchChannel(service) as never]);
  const services = new ServiceRegistry();
  services.register(LayoutMemory);
  const ui = renderTest(createComponent(component, {}), {
    width: options.width ?? 1200,
    height: options.height ?? 800,
    channels: channels.registry,
    services
  });
  await flush(ui);
  return {
    ui,
    service,
    async run(sql: string) {
      await service.run({ sql, at: -1 });
      await flush(ui);
    },
    dispose: () => channels.dispose()
  };
}
