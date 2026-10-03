/**
 * The second round: a range copied to the clipboard, a value read in
 * full, the editor's comment, format and run-all keys, and the layout
 * read back after a reload.
 */
import { Driver, sleep } from './lib/drive.ts';

const out = process.argv[2] ?? '/tmp';
const url = process.argv[3] ?? 'http://localhost:5193/';
const driver = await Driver.open(url);
const shot = async (name: string) => driver.screenshot(`${out}/${name}.png`);
const META = process.platform === 'darwin' ? 4 : 2;
const SHIFT = 8;
try {
  await driver.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: new URL(url).origin });
  await driver.find(/^Generated .* trips/, 60_000);
  const editor = await driver.find('SQL editor');
  const replace = async (sql: string) => {
    await driver.click(editor.x, editor.y);
    await driver.key('a', 65, META);
    await driver.type(sql);
  };

  // Format, then comment the first line, then run the whole script.
  await replace('select vendor, count(*) as trips from trips group by all order by 2 desc;\nselect {\'zone\': zone, \'borough\': borough} as place, zone_id from zones order by zone_id');
  await driver.key('a', 65, META);
  await driver.key('F', 70, META | SHIFT);
  await sleep(300);
  // To the top, comment the first line, look, and uncomment it again.
  await driver.key('ArrowUp', 38, META);
  await driver.key('/', 191, META);
  await sleep(200);
  await shot('30-formatted');
  await driver.key('/', 191, META);
  await sleep(200);
  await driver.key('Enter', 13, META | SHIFT);
  await driver.find(/^40 rows · 2 columns/, 20_000);
  console.log('status:', (await driver.find(/^Ran \d statements/, 5000).catch(() => null))?.label ?? 'none');

  // A range, copied with its column names.
  const cell = await driver.find('Manhattan', 10_000).catch(async () => driver.find(/^\{/));
  await driver.click(cell.x, cell.y);
  await driver.key('ArrowRight', 39, SHIFT);
  await driver.key('ArrowDown', 40, SHIFT);
  await driver.key('ArrowDown', 40, SHIFT);
  await sleep(300);
  await shot('31-range');
  await driver.key('c', 67, META | SHIFT);
  await sleep(600);
  console.log('clipboard:', JSON.stringify(await driver.evaluate<string>('navigator.clipboard.readText()').catch(e => `unreadable: ${e}`)));

  // A nested value in full.
  await driver.key('Escape', 27);
  await driver.key('ArrowLeft', 37);
  await driver.key('Enter', 13);
  await driver.find('Cell value', 10_000);
  await sleep(600);
  await shot('32-value');

  // Move the dividers and the side tab, then reload.
  const divider = await driver.find('Resize the editor');
  await driver.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: divider.x, y: divider.y }, driver.page);
  await driver.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: divider.x, y: divider.y, button: 'left', buttons: 1, clickCount: 1 }, driver.page);
  for (let step = 1; step <= 8; step++) {
    await driver.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: divider.x, y: divider.y - step * 15, buttons: 1 }, driver.page);
    await sleep(16);
  }
  await driver.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: divider.x, y: divider.y - 120, button: 'left', buttons: 0, clickCount: 1 }, driver.page);
  const history = await driver.find('History');
  await driver.click(history.x, history.y);
  await sleep(1200);
  const before = await driver.find('Resize the editor');
  await driver.send('Page.reload', {}, driver.page);
  await driver.find(/^Generated .* trips/, 60_000);
  await sleep(800);
  const after = await driver.find('Resize the editor');
  console.log('divider y before and after reload:', Math.round(before.y), Math.round(after.y));
  console.log('history tab open after reload:', (await driver.find(/^Run again:/, 3000).catch(() => null)) !== null);
  await shot('33-reloaded');
} catch (error) {
  await shot('error');
  throw error;
} finally {
  console.log(driver.logs.filter(line => /error|EXCEPTION/i.test(line) && !line.includes('[vite]')).join('\n'));
  driver.close();
}
