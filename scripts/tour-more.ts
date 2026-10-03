/**
 * The rest of the tour: keyboard selection, a resized column, history,
 * and the sample at ten million rows.
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
  const preview = await driver.find('Preview');
  await driver.click(preview.x, preview.y);
  await driver.find(/^5,000,000 rows/, 30_000);
  await sleep(800);

  // Choose a cell, walk it with the keyboard, then End to the last row.
  const cell = await driver.find('CMT');
  await driver.click(cell.x, cell.y);
  await driver.key('ArrowDown', 40);
  await driver.key('ArrowRight', 39);
  await sleep(300);
  await shot('10-selected');
  await driver.key('End', 35, process.platform === 'darwin' ? 4 : 2);
  await sleep(1500);
  await shot('11-last-row');

  // Drag the payment column's grip wider: it is on screen at the far end.
  const grip = await driver.find('Resize payment');
  await driver.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y }, driver.page);
  await driver.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', buttons: 1, clickCount: 1 }, driver.page);
  for (let step = 1; step <= 10; step++) {
    await driver.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x + step * 12, y: grip.y, buttons: 1 }, driver.page);
    await sleep(16);
  }
  await driver.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x + 120, y: grip.y, button: 'left', buttons: 0, clickCount: 1 }, driver.page);
  await sleep(400);
  await shot('12-resized');

  // History: the preview is there; run it again from the list.
  const history = await driver.find('History');
  await driver.click(history.x, history.y);
  await sleep(500);
  await shot('13-history');
  const again = await driver.find(/^Run again: SELECT \* FROM trips/);
  await driver.click(again.x, again.y);
  await sleep(1500);

  // Ten million.
  const size = await driver.find(/^10,000,000 trips|^5,000,000 trips/);
  console.log('sample select at', JSON.stringify(size));
} catch (error) {
  await shot('error');
  throw error;
} finally {
  console.log(driver.logs.filter(line => !line.includes('[vite]')).join('\n'));
  driver.close();
}
