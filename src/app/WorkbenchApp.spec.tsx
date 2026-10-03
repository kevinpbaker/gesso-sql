import { describe, expect, it } from 'vitest';
import 'gesso-testing/matchers';

import { flush, mount } from './harness';
import { WorkbenchApp } from './WorkbenchApp';

describe('WorkbenchApp', () => {
  it('previews a table from the schema and draws its rows', async () => {
    const { ui, dispose } = await mount(WorkbenchApp, { rows: 200_000, width: 800, height: 600 });
    ui.fireEvent.click(ui.getByRole('treeitem', { name: /^trips/ }));
    ui.frame();
    ui.fireEvent.click(ui.getByRole('button', { name: 'Preview' }));
    await flush(ui, 30);
    expect(ui.getByText(/^200,000 rows · 11 columns/)).toBeDefined();
    expect(ui.getAllByRole('cell', { name: 'CMT' }).length).toBeGreaterThan(0);
    dispose();
  });
});

describe('opening a file', () => {
  it('sends its bytes across the channel and makes a table of them', async () => {
    const { Workbench } = await import('./Contract');
    function Opener(_inputs: unknown, ctx: import('gesso-framework').ComponentContext) {
      const workbench = ctx.channel(Workbench);
      ctx.onMount(() => workbench.send.open({ name: 'cities.csv', bytes: new TextEncoder().encode('city,visits\nLisbon,3\nOslo,5\n') }));
      return <box />;
    }
    const { ui, service, dispose } = await mount(Opener as never);
    await flush(ui, 20);
    expect(service.schema$.value.find(table => table.name === 'cities')?.rows).toBe(2);
    dispose();
  });
});
