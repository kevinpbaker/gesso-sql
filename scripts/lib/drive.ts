/**
 * Headless Chrome, with every thread's console.
 *
 * `devtools.ts` speaks to the page; this attaches to every worker the
 * page starts as well, flattened into one socket, so a script sees what
 * the render worker, the application worker and DuckDB's worker say.
 * The accessibility mirror is the page's off-screen DOM, so a control
 * is found by its accessible name and pressed where its box is, which
 * is the path a person's click takes too.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitFor } from './devtools.ts';

export const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;

export class Driver {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, Listener[]>();
  readonly logs: string[] = [];
  private readonly socket: WebSocket;
  readonly browser: ChildProcess;

  private constructor(socket: WebSocket, browser: ChildProcess) {
    this.socket = socket;
    this.browser = browser;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          waiting?.reject(new Error(message.error.message));
        } else {
          waiting?.resolve(message.result);
        }
        return;
      }
      for (const listener of this.listeners.get(message.method ?? '') ?? []) {
        listener(message.params ?? {}, message.sessionId);
      }
    });
  }

  static async open(url: string, size: readonly [number, number] = [1400, 900], port = 9333): Promise<Driver> {
    const browser = spawn(
      CHROME,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${size[0]},${size[1]}`,
        `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gesso-sql-chrome-'))}`,
        `--remote-debugging-port=${port}`,
        'about:blank'
      ],
      { stdio: 'ignore' }
    );
    const version = await waitFor(
      'the DevTools endpoint',
      async () => (await (await fetch(`http://localhost:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string },
      20_000
    );
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not connect to Chrome')), { once: true });
    });
    const driver = new Driver(socket, browser);
    await driver.start(url);
    return driver;
  }

  page = '';

  private async start(url: string): Promise<void> {
    const describe = (params: Record<string, unknown>): string => {
      const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? [];
      return args.map(arg => (arg.value !== undefined ? String(arg.value) : (arg.description ?? ''))).join(' ');
    };
    const names = new Map<string, string>();
    this.on('Target.attachedToTarget', async params => {
      const sessionId = params.sessionId as string;
      const info = params.targetInfo as { type: string; url: string };
      names.set(sessionId, `${info.type}:${info.url.split('/').pop()?.split('?')[0] ?? ''}`);
      await this.send('Runtime.enable', {}, sessionId).catch(() => undefined);
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => undefined);
      await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
    });
    this.on('Runtime.consoleAPICalled', (params, sessionId) => {
      this.logs.push(`[${names.get(sessionId ?? '') ?? 'page'}] ${String(params.type)}: ${describe(params)}`);
    });
    this.on('Runtime.exceptionThrown', (params, sessionId) => {
      const details = params.exceptionDetails as { text: string; exception?: { description?: string } };
      this.logs.push(`[${names.get(sessionId ?? '') ?? 'page'}] EXCEPTION: ${details.exception?.description ?? details.text}`);
    });
    const { targetId } = (await this.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const { sessionId } = (await this.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    this.page = sessionId;
    names.set(sessionId, 'page');
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
  }

  on(method: string, listener: Listener): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  async evaluate<T>(expression: string, timeoutMs = 30_000): Promise<T> {
    const reply = (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, this.page, timeoutMs)) as {
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (reply.exceptionDetails !== undefined) {
      throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    }
    return reply.result.value;
  }

  /** Waits until a mirrored element with this accessible name (or text) exists, and returns its centre. */
  async find(name: string | RegExp, timeoutMs = 30_000): Promise<{ x: number; y: number; label: string }> {
    const pattern = typeof name === 'string' ? `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : name.source;
    return waitFor(
      `an element named ${String(name)}`,
      () =>
        this.evaluate<{ x: number; y: number; label: string } | undefined>(`(() => {
          const pattern = new RegExp(${JSON.stringify(pattern)});
          for (const element of document.querySelectorAll('*')) {
            const own = element.getAttribute('aria-label') ?? (element.children.length === 0 ? element.textContent : null);
            if (own === null) continue;
            const label = own;
            if (pattern.test(label.trim())) {
              const box = element.getBoundingClientRect();
              return { x: box.left + box.width / 2, y: box.top + box.height / 2, label };
            }
          }
          return undefined;
        })()`),
      timeoutMs
    );
  }

  async click(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, this.page);
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, this.page);
    }
  }

  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }, this.page);
  }

  async key(key: string, code: number, modifiers = 0): Promise<void> {
    for (const type of ['rawKeyDown', 'keyUp'] as const) {
      await this.send('Input.dispatchKeyEvent', { type, key, windowsVirtualKeyCode: code, modifiers }, this.page);
    }
  }

  /** Text, as the platform's text input delivers it: through the shell's editing proxy. */
  async type(text: string): Promise<void> {
    for (const char of text) {
      if (char === '\n') {
        await this.key('Enter', 13);
        continue;
      }
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char, unmodifiedText: char }, this.page);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char }, this.page);
    }
  }

  async screenshot(path: string): Promise<void> {
    const { data } = (await this.send('Page.captureScreenshot', { format: 'png' }, this.page)) as { data: string };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(data, 'base64'));
  }

  close(): void {
    this.socket.close();
    this.browser.kill();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
