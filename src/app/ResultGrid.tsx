import { BehaviorSubject, map } from 'rxjs';

import { Box, Column, LazySheet, percent, Row, Text, type SheetRange, type UiElement, type UiKeyboardEvent, type UiNode, type UiPointerEvent, type UiVirtualSheet } from 'gesso-core';
import { Icon } from 'gesso-components';
import { createComponent, fanOut, FocusService, internalState, ShellService, type ComponentContext, type Inputs } from 'gesso-framework';

import { Workbench, type ResultSort, type ResultView } from './Contract';
import { ICONS } from './icons';

/**
 * The result, as a grid of any size.
 *
 * The rows are not here. The application worker holds the result as a
 * table inside DuckDB; this grid tells it which rows are on screen, plus
 * a band either side, and it answers with those rows as strings. A
 * scroll to row seven million is arithmetic on this side and one page
 * read on the other, and the frame never waits for either.
 *
 * Built once per result and thrown away with it, because the columns
 * are the window's track list and a different result has different
 * ones. A sort of the same result keeps the grid and its scroll offset:
 * the `order` moves on, the window empties, and the cells say "waiting"
 * until the sorted rows arrive.
 *
 * Every cell's text, colour and selection are pushed into it by three
 * `fanOut` registries rather than piped off the channel per cell — the
 * lesson gesso-sheets measured three times before it was a library
 * function.
 */
export interface ResultGridProps {
  readonly result: ResultView;
  /** Opens a column's profile. */
  readonly onProfile: (column: number) => void;
}

export const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 42;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** Rows asked for beyond each edge of the screen, so a scroll lands on rows already there. */
const BAND = 80;
const PENDING = '';
const NULL_TEXT = 'NULL';
const STRIPE = 'rgba(128, 128, 128, 0.06)';

interface Datum {
  readonly row: number;
  readonly column: number;
}

interface Selected {
  readonly row: number;
  readonly column: number;
}

export function ResultGrid(inputs: Inputs<ResultGridProps>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const shell = ctx.inject(ShellService);
  const focus = ctx.inject(FocusService);
  const result = inputs.result.value;
  const columns = result.columns;
  const columnCount = columns.length;
  const gutterWidth = Math.max(56, String(result.rowCount).length * 8 + 24);

  const widths = columns.map(column => new BehaviorSubject(column.width));
  const keyOf = (row: number, column: number): number => row * columnCount + column;

  /** The order the window must belong to; anything else is stale and drawn as waiting. */
  const order = (): number => workbench.view.result.value.order;

  const texts = fanOut(
    workbench.view.window,
    (window, _key, datum: Datum) => {
      if (window.id !== result.id || window.order !== order()) {
        return PENDING;
      }
      const row = window.rows[datum.row];
      if (row === undefined) {
        return PENDING;
      }
      const value = row[datum.column];
      return value === null ? NULL_TEXT : value;
    },
    { initial: PENDING, label: 'result cells' }
  );
  const tones = fanOut(
    workbench.view.window,
    (window, _key, datum: Datum) => {
      const row = window.id === result.id ? window.rows[datum.row] : undefined;
      return row === undefined || row[datum.column] === null ? 'textMuted' : 'text';
    },
    { initial: 'textMuted', label: 'result tones' }
  );

  const selection = new BehaviorSubject<Selected | null>(null);
  const chosen = fanOut(selection, (held, key) => (held !== null && keyOf(held.row, held.column) === key ? 'focusRing' : 'transparent'), {
    initial: 'transparent',
    changed: (next, previous) => [
      ...(next === null ? [] : [keyOf(next.row, next.column)]),
      ...(previous === null || previous === undefined ? [] : [keyOf(previous.row, previous.column)])
    ],
    label: 'result selection'
  });

  // ------------------------------------------------------------------ cells

  /** Elements by cell, so a row rebuilt by a scroll reuses every cell it already had. */
  const cells = new Map<number, UiElement>();
  let mounted: SheetRange = { firstRow: 0, lastRow: -1, firstColumn: 0, lastColumn: -1 };

  const cell = (row: number, column: number): UiElement => {
    const key = keyOf(row, column);
    const existing = cells.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const datum = { row, column };
    const numeric = columns[column].kind === 'number';
    const element = Box(
      {
        key: column,
        width: widths[column],
        height: ROW_HEIGHT,
        flexShrink: 0,
        paddingX: 8,
        x: numeric ? 'end' : 'start',
        y: 'center',
        borderColor: chosen.for(key),
        borderWidth: 2,
        role: 'cell',
        onPointerDown: () => select({ row, column })
      },
      Text({
        text: texts.for(key, datum),
        color: tones.for(key, datum),
        fontFamily: MONO,
        fontSize: 12,
        textWrap: 'none',
        maxLines: 1,
        textOverflow: 'ellipsis',
        selectable: false
      })
    );
    cells.set(key, element);
    return element;
  };

  /** Lets go of every cell the window no longer holds. */
  const release = (range: SheetRange): void => {
    for (const [key, _] of cells) {
      const row = Math.floor(key / columnCount);
      const column = key % columnCount;
      if (row < range.firstRow || row > range.lastRow || column < range.firstColumn || column > range.lastColumn) {
        cells.delete(key);
        texts.release(key);
        tones.release(key);
        chosen.release(key);
      }
    }
  };

  const gutter = (row: number): UiElement =>
    Box(
      {
        key: 'gutter',
        width: gutterWidth,
        height: ROW_HEIGHT,
        flexShrink: 0,
        paddingX: 8,
        x: 'end',
        y: 'center',
        position: 'sticky',
        left: 0,
        zIndex: 1,
        backgroundColor: 'surface',
        role: 'rowheader',
        label: String(row + 1)
      },
      Text({ text: (row + 1).toLocaleString('en-US'), color: 'textMuted', fontFamily: MONO, fontSize: 11, textWrap: 'none', selectable: false })
    );

  const renderRow = (row: number, firstColumn: number, lastColumn: number): UiElement => {
    const line: UiElement[] = [gutter(row)];
    for (let column = firstColumn; column <= lastColumn; column++) {
      line.push(cell(row, column));
    }
    return Row({ role: 'row', posInSet: row + 1, setSize: result.rowCount, backgroundColor: row % 2 === 1 ? STRIPE : undefined }, ...line);
  };

  // ------------------------------------------------------------------ header

  const sortOf = workbench.view.result.pipe(map(view => (view.id === result.id ? view.sort : null)));

  const cycleSort = (column: number): void => {
    const current = workbench.view.result.value.sort;
    const next: ResultSort | null =
      current === null || current.column !== column
        ? { column, direction: 'ascending' }
        : current.direction === 'ascending'
          ? { column, direction: 'descending' }
          : null;
    workbench.send.sort({ id: result.id, sort: next });
  };

  /** A column's grip: drag it to resize, double-click to fit the column back to its values. */
  const grip = (column: number): UiElement => {
    let startX = 0;
    let startWidth = 0;
    // Inside the header's own right edge rather than straddling it: the
    // next header is painted after this one, so the half of a grip that
    // reached into it was under it, and a press on the line went to the
    // neighbour's sort button.
    return Box({
      key: 'grip',
      position: 'absolute',
      right: 0,
      top: 0,
      width: 8,
      height: HEADER_HEIGHT,
      zIndex: 2,
      cursor: 'col-resize',
      role: 'separator',
      label: `Resize ${columns[column].name}`,
      onPanStart: (event: UiPointerEvent) => {
        startX = event.x;
        startWidth = widths[column].value;
        event.stopPropagation();
      },
      onPanMove: (event: UiPointerEvent) => {
        event.stopPropagation();
        resize(column, Math.max(48, Math.round(startWidth + event.x - startX)));
      },
      onPanEnd: (event: UiPointerEvent) => event.stopPropagation(),
      onDoubleClick: () => resize(column, columns[column].width)
    });
  };

  const resize = (column: number, width: number): void => {
    widths[column].next(width);
    sheet.setColumnWidths(widths.map(each => each.value));
  };

  const columnHeader = (column: number): UiElement => {
    const info = columns[column];
    const numeric = info.kind === 'number';
    const arrow = sortOf.pipe(
      map(sort => (sort === null || sort.column !== column ? '' : sort.direction === 'ascending' ? '▲' : '▼'))
    );
    return Box(
      {
        key: column,
        width: widths[column],
        height: HEADER_HEIGHT,
        flexShrink: 0,
        position: 'relative',
        backgroundColor: 'surface',
        borderColor: 'border',
        borderWidth: 1,
        role: 'columnheader',
        label: info.name,
        description: sortOf.pipe(
          map(sort => (sort === null || sort.column !== column ? '' : `sorted ${sort.direction}`))
        )
      },
      Row(
        { width: percent(100), height: percent(100), paddingX: 8, gap: 4, y: 'center' },
        Column(
          {
            flex: 1,
            minWidth: 0,
            height: percent(100),
            y: 'center',
            x: numeric ? 'end' : 'start',
            cursor: 'pointer',
            role: 'button',
            label: `Sort by ${info.name}`,
            onClick: () => cycleSort(column)
          },
          Text({ text: info.name, fontSize: 12, fontWeight: 600, color: 'text', textWrap: 'none', maxLines: 1, textOverflow: 'ellipsis', selectable: false }),
          Text({ text: info.type, fontSize: 10, color: 'textMuted', textWrap: 'none', maxLines: 1, textOverflow: 'ellipsis', selectable: false })
        ),
        Text({ text: arrow, fontSize: 9, color: 'primary', selectable: false }),
        Box(
          {
            width: 20,
            height: 20,
            x: 'center',
            y: 'center',
            borderRadius: 4,
            cursor: 'pointer',
            role: 'button',
            label: `Profile ${info.name}`,
            onClick: () => inputs.onProfile.value(column)
          },
          createComponent(Icon, { ...ICONS.chart, size: 13, color: 'textMuted' })
        )
      ),
      grip(column)
    );
  };

  const renderHeader = (firstColumn: number, lastColumn: number): UiElement => {
    const line: UiElement[] = [
      Box({
        key: 'corner',
        width: gutterWidth,
        height: HEADER_HEIGHT,
        flexShrink: 0,
        position: 'sticky',
        left: 0,
        zIndex: 3,
        backgroundColor: 'surface',
        borderColor: 'border',
        borderWidth: 1
      })
    ];
    for (let column = firstColumn; column <= lastColumn; column++) {
      line.push(columnHeader(column));
    }
    return Row({ role: 'row', position: 'sticky', top: 0, zIndex: 2 }, ...line);
  };

  // ------------------------------------------------------------------ the window

  const scrollX = internalState(0);
  const scrollY = internalState(0);
  const viewport = ctx.bounds('result grid');
  let gridNode: UiNode | null = null;
  let sheetWindow: UiVirtualSheet | undefined;

  const grid = LazySheet(
    {
      flex: 1,
      minHeight: 0,
      width: percent(100),
      rowCount: result.rowCount,
      columnCount,
      rowHeight: ROW_HEIGHT,
      columnWidth: columns.map(column => column.width),
      gutterWidth,
      headerHeight: HEADER_HEIGHT,
      rowOverscan: 6,
      columnOverscan: 2,
      header: renderHeader,
      scrollX,
      scrollY,
      focusable: true,
      role: 'grid',
      label: `Result: ${result.rowCount.toLocaleString('en-US')} rows`,
      modifiers: [viewport.modifier],
      ref: (node: UiNode | null) => (gridNode = node),
      onKeyDown: (event: UiKeyboardEvent) => onKey(event),
      sheetRef: found => (sheetWindow = found)
    },
    renderRow
  );
  if (sheetWindow === undefined) {
    throw new Error('LazySheet did not hand back its window.');
  }
  const sheet = sheetWindow;

  /**
   * Asks for the rows on screen and a band around them, whenever either
   * the window or the order moves. The application worker keeps only
   * the latest request, so a fling sends many and costs one.
   */
  const request = (range: SheetRange): void => {
    if (range.lastRow < range.firstRow) {
      return;
    }
    workbench.send.fetch({
      id: result.id,
      order: order(),
      first: Math.max(0, range.firstRow - BAND),
      last: Math.min(result.rowCount - 1, range.lastRow + BAND)
    });
  };
  ctx.effect(sheet.range$, range => {
    mounted = range;
    release(range);
    request(range);
  });
  let lastOrder = order();
  ctx.effect(workbench.view.result, view => {
    if (view.id === result.id && view.order !== lastOrder) {
      lastOrder = view.order;
      request(mounted);
    }
  });
  ctx.onUnmount(() => {
    texts.close();
    tones.close();
    chosen.close();
  });

  // ------------------------------------------------------------------ selection and keys

  const select = (at: Selected): void => {
    selection.next(at);
    if (gridNode !== null) {
      focus.focus(gridNode);
    }
  };

  const bringIntoView = (at: Selected): void => {
    const view = viewport.value;
    if (view.width === 0 || view.height === 0) {
      return;
    }
    const top = HEADER_HEIGHT + at.row * ROW_HEIGHT;
    const left = gutterWidth + sheet.offsetOf(at.column);
    scrollY.value = bring(scrollY.value, top, ROW_HEIGHT, view.height, HEADER_HEIGHT);
    scrollX.value = bring(scrollX.value, left, sheet.widthOf(at.column), view.width, gutterWidth);
  };

  const onKey = (event: UiKeyboardEvent): void => {
    const held = selection.value ?? { row: 0, column: 0 };
    const page = Math.max(1, Math.floor(viewport.value.height / ROW_HEIGHT) - 2);
    const primary = event.modifiers.ctrl === true || event.modifiers.meta === true;
    const moves: Record<string, Selected> = {
      ArrowDown: { row: held.row + 1, column: held.column },
      ArrowUp: { row: held.row - 1, column: held.column },
      ArrowRight: { row: held.row, column: held.column + 1 },
      ArrowLeft: { row: held.row, column: held.column - 1 },
      PageDown: { row: held.row + page, column: held.column },
      PageUp: { row: held.row - page, column: held.column },
      Home: primary ? { row: 0, column: 0 } : { row: held.row, column: 0 },
      End: primary ? { row: result.rowCount - 1, column: columnCount - 1 } : { row: held.row, column: columnCount - 1 }
    };
    const moved = moves[event.key];
    if (moved !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      const next = {
        row: Math.max(0, Math.min(result.rowCount - 1, moved.row)),
        column: Math.max(0, Math.min(columnCount - 1, moved.column))
      };
      selection.next(next);
      bringIntoView(next);
      return;
    }
    if (primary && event.key.toLowerCase() === 'c' && selection.value !== null) {
      event.preventDefault();
      const at = selection.value;
      const value = workbench.view.window.value.rows[at.row]?.[at.column];
      if (value !== undefined) {
        shell.copyText(value === null ? '' : value);
      }
    }
  };

  return grid;
}

function bring(offset: number, start: number, extent: number, viewport: number, lead: number): number {
  if (start < offset + lead) {
    return Math.max(0, start - lead);
  }
  if (start + extent > offset + viewport) {
    return start + extent - viewport;
  }
  return offset;
}
