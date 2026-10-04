import { describe, expect, it } from 'vitest';
import 'gesso-testing/matchers';

import { mount } from './harness';
import { ResultsPanel } from './ResultsPanel';

describe('ResultsPanel', () => {
  it('draws the rows of a result the application worker pages to it', async () => {
    const { ui, run, dispose } = await mount(ResultsPanel);
    await run('SELECT trip_id, payment FROM trips ORDER BY trip_id');
    expect(ui.getByText(/^5,000 rows · 2 columns/)).toBeDefined();
    expect(ui.getAllByRole('cell', { name: '17' }).length).toBeGreaterThan(0);
    expect(ui.getAllByText('card').length).toBeGreaterThan(0);
    dispose();
  });

  it('draws the rows of the next result too', async () => {
    const { ui, run, dispose } = await mount(ResultsPanel);
    await run('SELECT 1 AS one');
    expect(ui.getAllByRole('cell', { name: '1' }).length).toBeGreaterThan(0);
    await run('SELECT trip_id * 10 AS tens FROM trips ORDER BY 1');
    expect(ui.getAllByRole('cell', { name: '170' }).length).toBeGreaterThan(0);
    dispose();
  });
});

describe('ResultsPanel, narrower than its result', () => {
  it('draws the cells of a result wider than the screen', async () => {
    const { ui, run, dispose } = await mount(ResultsPanel, { width: 600, height: 500 });
    await run('SELECT * FROM trips ORDER BY trip_id');
    expect(ui.getAllByRole('cell', { name: 'CMT' }).length).toBeGreaterThan(0);
    dispose();
  });
});

describe('ResultsPanel, the keyboard in the grid', () => {
  it('selects a range with Shift, copies it, and shows a cell in full with Enter', async () => {
    const { ShellService } = await import('gesso-framework');
    const { ui, run, dispose } = await mount(ResultsPanel, { width: 900, height: 500 });
    const { flush } = await import('./harness');
    const copied: string[] = [];
    ui.runtime.services.get(ShellService).copyText = async (text: string) => {
      copied.push(text);
      return true;
    };
    await run("SELECT * FROM (VALUES (1, 'one'), (2, 'two'), (3, 'three')) t(n, word)");

    // Pressed where it is, through the hit tester, as a pointer would.
    const first = ui.getLayout(ui.getAllByRole('cell', { name: '1' })[0]);
    ui.fireEvent.pointerDown(first.x + 4, first.y + 4);
    ui.fireEvent.pointerUp(first.x + 4, first.y + 4);
    ui.frame();
    ui.fireEvent.press('ArrowRight', { shift: true });
    ui.fireEvent.press('ArrowDown', { shift: true });
    ui.fireEvent.press('c', { meta: true });
    await flush(ui);
    expect(copied).toEqual(['1\tone\n2\ttwo']);

    ui.fireEvent.press('c', { meta: true, shift: true });
    await flush(ui);
    expect(copied[1]).toBe('n\tword\n1\tone\n2\ttwo');

    ui.fireEvent.press('Enter');
    await flush(ui);
    expect(ui.getByRole('region', { name: 'Cell value' })).toBeDefined();
    expect(ui.getAllByText('two').length).toBeGreaterThan(1);
    dispose();
  });

  it('keeps an export the browser refused to save, and saves it on the next press', async () => {
    const { ShellService } = await import('gesso-framework');
    const { ui, run, dispose } = await mount(ResultsPanel, { width: 900, height: 500 });
    const { flush } = await import('./harness');
    const shell = ui.runtime.services.get(ShellService);
    const attempts: string[] = [];
    let refuse = true;
    shell.saveFile = async options => {
      attempts.push(options.name);
      const outcome = refuse ? 'denied' : 'ok';
      return { outcome, files: [], saved: refuse ? null : { name: options.name, handle: null, via: 'download' }, recent: [], error: null };
    };
    await run('SELECT 1 AS one');
    ui.fireEvent.click(ui.getByRole('button', { name: 'Export CSV' }));
    await flush(ui);
    const save = ui.getByRole('button', { name: /^Save result-\d+\.csv$/ });
    refuse = false;
    ui.fireEvent.click(save);
    await flush(ui);
    expect(attempts).toHaveLength(2);
    expect(ui.getByRole('button', { name: 'Export CSV' })).toBeDefined();
    dispose();
  });
});
