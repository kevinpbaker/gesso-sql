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
