/**
 * The paths that cross the page's edge: a file opened through the
 * picker, a file dropped on the window, a CSV exported, and history and
 * the editor's text read back after a reload.
 */
import { Driver, sleep } from './lib/drive.ts';

const out = process.argv[2] ?? '/tmp';
const sample = process.argv[3];
const url = process.argv[4] ?? 'http://localhost:5193/';
const driver = await Driver.open(url);
const shot = async (name: string) => driver.screenshot(`${out}/${name}.png`);
const META = process.platform === 'darwin' ? 4 : 2;
try {
  await driver.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: out, eventsEnabled: true });
  const downloads: string[] = [];
  driver.on('Browser.downloadProgress', params => {
    if (params.state === 'completed') downloads.push(String(params.guid));
  });
  driver.on('Browser.downloadWillBegin', params => console.log('download begins:', params.suggestedFilename));
  driver.on('Page.fileChooserOpened', async params => {
    console.log('file chooser opened:', params.mode);
    await driver.send('DOM.enable', {}, driver.page);
    await driver.send('DOM.setFileInputFiles', { files: [sample], backendNodeId: params.backendNodeId }, driver.page).catch(e => console.log('setFileInputFiles failed', e.message));
  });
  await driver.send('Page.setInterceptFileChooserDialog', { enabled: true }, driver.page);
  await driver.find(/^Generated .* trips/, 60_000);

  // 1. Open file, through the picker.
  const open = await driver.find('Open file');
  await driver.click(open.x, open.y);
  await sleep(2500);
  await shot('20-opened');
  const opened = await driver.find(/^cities/, 5000).catch(() => null);
  console.log('table from picker:', opened?.label ?? 'none');

  // 2. Drop the same file under another name... the drag carries a path.
  const editor = await driver.find('SQL editor');
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await driver.send('Input.dispatchDragEvent', { type, x: editor.x, y: editor.y, data: { items: [], files: [sample], dragOperationsMask: 1 } }, driver.page);
  }
  await sleep(2000);
  await shot('21-dropped');
  console.log('notice after drop:', (await driver.find(/^Loaded /, 3000).catch(() => null))?.label ?? 'none');

  // 3. Export a small result.
  await driver.click(editor.x, editor.y);
  await driver.key('a', 65, META);
  await driver.type('SELECT * FROM zones');
  await driver.key('Enter', 13, META);
  await driver.find(/^40 rows/, 20_000);
  const exportButton = await driver.find('Export CSV');
  await driver.click(exportButton.x, exportButton.y);
  await sleep(3000);
  await shot('22-exported');
  console.log('downloads completed:', downloads.length);

  // 4. Reload: the history and the editor's text come back.
  await sleep(800);
  await driver.send('Page.reload', {}, driver.page);
  await driver.find(/^Generated .* trips/, 60_000);
  const history = await driver.find('History');
  await driver.click(history.x, history.y);
  await sleep(500);
  console.log('history after reload:', (await driver.find(/^Run again: SELECT \* FROM zones/, 3000).catch(() => null))?.label ?? 'none');
  const text = await driver.evaluate<string>(`document.querySelector('[aria-label="SQL editor"]')?.value ?? document.querySelector('[aria-label="SQL editor"]')?.textContent ?? ''`);
  console.log('editor after reload:', JSON.stringify(text.slice(0, 40)));
  await shot('23-reloaded');
} catch (error) {
  await shot('error');
  throw error;
} finally {
  console.log(driver.logs.filter(line => !line.includes('[vite]')).join('\n'));
  driver.close();
}
