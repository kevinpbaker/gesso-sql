import { map, type Observable } from 'rxjs';

import { IndexedDbStorage, persisted, type PersistedState } from 'gesso-framework';

/**
 * Where the person left things: the dividers, the side panel's tab, and
 * how wide they made each column.
 *
 * View state, so it stays on the render thread, in a service; and worth
 * keeping across a reload, so it is `persisted` to IndexedDB, which a
 * worker can reach. One small record, written a moment after the last
 * change. Column widths are kept by column name, since a query run again
 * tomorrow has a new result but the same columns, and only the last few
 * hundred names are remembered.
 */
export interface Layout {
  readonly sideSplit: number;
  readonly editorSplit: number;
  readonly sideTab: 'schema' | 'history';
  readonly widths: Readonly<Record<string, number>>;
}

export const DEFAULT_LAYOUT: Layout = { sideSplit: 0.2, editorSplit: 0.42, sideTab: 'schema', widths: {} };

const REMEMBERED_WIDTHS = 300;

export function reviveLayout(raw: unknown): Layout | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Partial<Layout>;
  const fraction = (value: unknown, fallback: number): number =>
    typeof value === 'number' && value > 0 && value < 1 ? value : fallback;
  const widths: Record<string, number> = {};
  if (record.widths !== null && typeof record.widths === 'object') {
    for (const [name, width] of Object.entries(record.widths)) {
      if (typeof width === 'number' && width > 0) {
        widths[name] = width;
      }
    }
  }
  return {
    sideSplit: fraction(record.sideSplit, DEFAULT_LAYOUT.sideSplit),
    editorSplit: fraction(record.editorSplit, DEFAULT_LAYOUT.editorSplit),
    sideTab: record.sideTab === 'history' ? 'history' : 'schema',
    widths
  };
}

export class LayoutMemory {
  readonly state: PersistedState<Layout> = persisted(new IndexedDbStorage({ database: 'gesso-sql' }), 'layout', {
    initial: DEFAULT_LAYOUT,
    revive: reviveLayout,
    label: 'layout'
  });

  /** One field of the layout, as it changes. */
  pick<K extends keyof Layout>(key: K): Observable<Layout[K]> {
    return this.state.value.pipe(map(layout => layout[key]));
  }

  update(patch: Partial<Omit<Layout, 'widths'>>): void {
    this.state.set({ ...this.state.current, ...patch });
  }

  widthOf(column: string): number | undefined {
    return this.state.current.widths[column];
  }

  rememberWidth(column: string, width: number): void {
    const widths = { ...this.state.current.widths };
    delete widths[column];
    widths[column] = width;
    // The most recent last; the oldest go first when there are too many.
    const names = Object.keys(widths);
    for (const name of names.slice(0, Math.max(0, names.length - REMEMBERED_WIDTHS))) {
      delete widths[name];
    }
    this.state.set({ ...this.state.current, widths });
  }
}
