import { BehaviorSubject, map } from 'rxjs';

import { Box, Column, LazySheet, percent, Row, Text, type SheetRange, type UiElement, type UiKeyboardEvent, type UiNode, type UiPointerEvent, type UiVirtualSheet } from 'gesso-core';
import { Icon } from 'gesso-components';
import { createComponent, fanOut, FocusService, internalState, type ComponentContext, type Inputs } from 'gesso-framework';

import { Workbench, type ResultSort, type ResultView } from './Contract';
import { LayoutMemory } from './LayoutMemory';
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
  /** The cell the keyboard is on, as it moves; null when nothing is selected. */
  readonly onFocusCell?: (at: { row: number; column: number } | null) => void;
  /** Enter, or a double click: show this cell's value in full. */
  readonly onOpenCell?: (at: { row: number; column: number }) => void;
}

/** The wash over a selected range. Translucent, so the row stripes show through it. */
const RANGE_WASH = 'rgba(66, 133, 244, 0.16)';

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

/** Where a selection started and where it has been extended to; the keyboard is on `focus`. */
interface Selection {
  readonly anchor: Selected;
  readonly focus: Selected;
}

function bounds(selection: Selection): { top: number; bottom: number; left: number; right: number } {
  return {
    top: Math.min(selection.anchor.row, selection.focus.row),
    bottom: Math.max(selection.anchor.row, selection.focus.row),
    left: Math.min(selection.anchor.column, selection.focus.column),
    right: Math.max(selection.anchor.column, selection.focus.column)
  };
}

export function ResultGrid(inputs: Inputs<ResultGridProps>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const focus = ctx.inject(FocusService);
  const result = inputs.result.value;
  const columns = result.columns;
  const columnCount = columns.length;
  const gutterWidth = Math.max(56, String(result.rowCount).length * 8 + 24);

  // A column a person sized before keeps that size in the next result
  // that has it; see LayoutMemory.
  const layout = ctx.inject(LayoutMemory);
  const startWidths = columns.map(column => layout.widthOf(column.name) ?? column.width);
  const widths = startWidths.map(width => new BehaviorSubject(width));
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

  const selection = new BehaviorSubject<Selection | null>(null);
  const chosen = fanOut(
    selection,
    (held, key) => (held !== null && keyOf(held.focus.row, held.focus.column) === key ? 'focusRing' : 'transparent'),
    {
      initial: 'transparent',
      changed: (next, previous) => [
        ...(next === null ? [] : [keyOf(next.focus.row, next.focus.column)]),
        ...(previous === null || previous === undefined ? [] : [keyOf(previous.focus.row, previous.focus.column)])
      ],
      label: 'result selection'
    }
  );
  /**
   * The wash over a range. Every live cell is asked on a change, which is
   * a screenful, and a cell outside both the old range and the new one
   * reads the same as before and is not pushed.
   */
  const ranged = fanOut(
    selection,
    (held, _key, datum: Datum) => {
      if (held === null || (held.anchor.row === held.focus.row && held.anchor.column === held.focus.column)) {
        return 'transparent';
      }
      const box = bounds(held);
      return datum.row >= box.top && datum.row <= box.bottom && datum.column >= box.left && datum.column <= box.right
        ? RANGE_WASH
        : 'transparent';
    },
    { initial: 'transparent', label: 'result range' }
  );

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
        backgroundColor: ranged.for(key, datum),
        role: 'cell',
        onPointerDown: (event: UiPointerEvent) => select({ row, column }, event.modifiers.shift === true),
        // A drag across cells extends the range, as it does in any grid.
        onPointerMove: (event: UiPointerEvent) => {
          if (event.buttons === 1 && dragging) {
            extend({ row, column });
          }
        },
        onDoubleClick: () => inputs.onOpenCell.value?.({ row, column })
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
        ranged.release(key);
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
      onPanEnd: (event: UiPointerEvent) => {
        event.stopPropagation();
        layout.rememberWidth(columns[column].name, widths[column].value);
      },
      onDoubleClick: () => {
        resize(column, columns[column].width);
        layout.rememberWidth(columns[column].name, columns[column].width);
      }
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
      columnWidth: startWidths,
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
    ranged.close();
  });

  // ------------------------------------------------------------------ selection and keys

  let dragging = false;
  const select = (at: Selected, extending = false): void => {
    const held = selection.value;
    selection.next(extending && held !== null ? { anchor: held.anchor, focus: at } : { anchor: at, focus: at });
    dragging = true;
    if (gridNode !== null) {
      focus.focus(gridNode);
    }
  };
  const extend = (at: Selected): void => {
    const held = selection.value;
    if (held !== null && (held.focus.row !== at.row || held.focus.column !== at.column)) {
      selection.next({ anchor: held.anchor, focus: at });
    }
  };
  ctx.effect(selection, held => inputs.onFocusCell.value?.(held === null ? null : held.focus));

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

  /**
   * The keys of a grid. Arrows, Page Up and Down, Home and End move the
   * cell; with Shift they extend the range from where it started. Ctrl or
   * ⌘ with A selects everything, with C copies the range as tab-separated
   * text, and with Shift and C copies it with the column names first.
   * Enter opens the value panel, and Escape collapses the range.
   */
  const onKey = (event: UiKeyboardEvent): void => {
    dragging = false;
    const held = selection.value ?? { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } };
    const at = held.focus;
    const page = Math.max(1, Math.floor(viewport.value.height / ROW_HEIGHT) - 2);
    const primary = event.modifiers.ctrl === true || event.modifiers.meta === true;
    const shift = event.modifiers.shift === true;
    const moves: Record<string, Selected> = {
      ArrowDown: { row: at.row + 1, column: at.column },
      ArrowUp: { row: at.row - 1, column: at.column },
      ArrowRight: { row: at.row, column: at.column + 1 },
      ArrowLeft: { row: at.row, column: at.column - 1 },
      PageDown: { row: at.row + page, column: at.column },
      PageUp: { row: at.row - page, column: at.column },
      Home: primary ? { row: 0, column: 0 } : { row: at.row, column: 0 },
      End: primary ? { row: result.rowCount - 1, column: columnCount - 1 } : { row: at.row, column: columnCount - 1 }
    };
    const moved = moves[event.key];
    const handled = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (moved !== undefined) {
      handled();
      const next = {
        row: Math.max(0, Math.min(result.rowCount - 1, moved.row)),
        column: Math.max(0, Math.min(columnCount - 1, moved.column))
      };
      selection.next(shift ? { anchor: held.anchor, focus: next } : { anchor: next, focus: next });
      bringIntoView(next);
      return;
    }
    const key = event.key.toLowerCase();
    if (primary && key === 'a') {
      handled();
      selection.next({ anchor: { row: 0, column: 0 }, focus: { row: result.rowCount - 1, column: columnCount - 1 } });
      return;
    }
    if (primary && key === 'c' && selection.value !== null) {
      handled();
      const box = bounds(selection.value);
      workbench.send.copy({
        id: result.id,
        order: order(),
        firstRow: box.top,
        lastRow: box.bottom,
        firstColumn: box.left,
        lastColumn: box.right,
        headers: shift
      });
      return;
    }
    if (event.key === 'Enter' && selection.value !== null) {
      handled();
      inputs.onOpenCell.value?.(selection.value.focus);
      return;
    }
    if (event.key === 'Escape' && selection.value !== null) {
      handled();
      selection.next({ anchor: selection.value.focus, focus: selection.value.focus });
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
