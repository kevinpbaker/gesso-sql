import type { Saved, WorkbenchStore } from './WorkbenchService';

/**
 * The editor's text and the history, in the origin private file system.
 *
 * One small JSON file, written whole. A sync access handle rather than
 * a writable stream, because the sync handle exists in every browser's
 * dedicated workers and the stream does not exist in Safari's; and this
 * is a dedicated worker, which is the one place the sync handle is
 * allowed.
 *
 * The data itself is not saved: a table loaded from a file lives as long
 * as the tab. Saving gigabytes of it on every change would be the wrong
 * default for a workbench, where the source file is still on the disk
 * it came from.
 */
const FILE = 'workbench.json';

interface SyncAccess {
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}

export class OpfsStore implements WorkbenchStore {
  async load(): Promise<Saved | null> {
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(FILE);
      const text = await (await handle.getFile()).text();
      const parsed = JSON.parse(text) as Partial<Saved>;
      return { draft: typeof parsed.draft === 'string' ? parsed.draft : '', history: Array.isArray(parsed.history) ? parsed.history : [] };
    } catch {
      return null;
    }
  }

  async save(saved: Saved): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(FILE, { create: true });
    // Declared by the WebWorker lib, which this project does not load beside DOM.
    const access = await (handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccess> }).createSyncAccessHandle();
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(saved));
      access.truncate(0);
      access.write(bytes, { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
  }
}

export class MemoryStore implements WorkbenchStore {
  saved: Saved | null;

  constructor(initial: Saved | null = null) {
    this.saved = initial;
  }

  async load(): Promise<Saved | null> {
    return this.saved;
  }

  async save(saved: Saved): Promise<void> {
    this.saved = saved;
  }
}
