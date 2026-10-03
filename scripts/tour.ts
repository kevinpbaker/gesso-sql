/**
 * A walk through the workbench in headless Chrome, with a screenshot at
 * each stop: the preview, a sort, a profile, the chart, a heavy query
 * cancelled while the grid scrolls, an error, and completion.
 */
import { Driver, sleep } from './lib/drive.ts';

const out = process.argv[2] ?? '/tmp';
const url = process.argv[3] ?? 'http://localhost:5193/';
const driver = await Driver.open(url);
const shot = async (name: string) => driver.screenshot(`${out}/${name}.png`);
try {
  await driver.find(/^Generated .* trips/, 60_000);
  const trips = await driver.find(/^trips/);
  await driver.click(trips.x, trips.y);
  await shot('01-schema');
  const preview = await driver.find('Preview');
  await driver.click(preview.x, preview.y);
  await driver.find(/^5,000,000 rows/, 30_000);
  await sleep(800);

  // Sort by distance_miles, descending: two presses on the header.
  const fare = await driver.find('Sort by distance_miles');
  await driver.click(fare.x, fare.y);
  await driver.find(/sorted by distance_miles/, 30_000);
  await driver.click(fare.x, fare.y);
  await sleep(2500);
  await shot('02-sorted');

  // Profile the payment column.
  const profile = await driver.find('Profile vendor');
  console.log('profile button', JSON.stringify(profile));
  await driver.click(profile.x, profile.y);
  await sleep(2000);
  await shot('03a-profile');
  await driver.find('Most common', 30_000);
  await sleep(300);
  await shot('03-profile');
  const close = await driver.find('Close profile');
  await driver.click(close.x, close.y);

  // Replace the editor's text and run it.
  const META = process.platform === 'darwin' ? 4 : 2;
  const editor = await driver.find('SQL editor');
  const replace = async (sql: string) => {
    await driver.click(editor.x, editor.y);
    await driver.key('a', 65, META);
    await driver.type(sql);
    await sleep(200);
  };
  const run = async () => driver.key('Enter', 13, META);

  await replace('SELECT hour(pickup_at) AS hour, count(*) AS trips\nFROM trips\nGROUP BY 1\nORDER BY 1');
  await run();
  await driver.find(/^24 rows/, 30_000);
  const chart = await driver.find('Chart');
  await driver.click(chart.x, chart.y);
  await sleep(1500);
  await shot('04-chart');
  const grid = await driver.find('Grid');
  await driver.click(grid.x, grid.y);

  // Back to every trip, then a heavy query: scroll the old result while it runs, then cancel it.
  await replace('SELECT * FROM trips');
  await run();
  await driver.find(/^5,000,000 rows/, 30_000);
  await sleep(500);
  await replace(
    'SELECT trip_id, pickup_at, fare,\n  avg(fare) OVER (PARTITION BY pickup_zone ORDER BY pickup_at ROWS BETWEEN 1000 PRECEDING AND CURRENT ROW) AS rolling_fare\nFROM trips\nORDER BY rolling_fare DESC'
  );
  await run();
  await driver.find(/^Running/, 10_000);
  const result = await driver.find(/^Result: /);
  for (let i = 0; i < 15; i++) {
    await driver.wheel(result.x, result.y, 3000);
    await sleep(40);
  }
  await sleep(600);
  await shot('05-running');
  const cancel = await driver.find('Cancel');
  await driver.click(cancel.x, cancel.y);
  await driver.find(/^Cancelled after/, 30_000);
  await shot('06-cancelled');

  // An error, pointed at.
  await replace('SELECT trip_id, fair\nFROM trips');
  await run();
  await driver.find('The statement failed', 30_000);
  await sleep(300);
  await shot('07-error');

  // Completion.
  await replace('SELECT * FROM trips t WHERE t.pa');
  await sleep(800);
  await shot('08-completion');
  await driver.key('Escape', 27);
} catch (error) {
  await shot('error');
  throw error;
} finally {
  console.log(driver.logs.filter(line => !line.includes('[vite]')).join('\n'));
  driver.close();
}
