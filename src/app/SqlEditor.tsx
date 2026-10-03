import { BehaviorSubject, combineLatest, distinctUntilChanged, map } from 'rxjs';

import { editorFor, percent, type UiKeyboardEvent, type UiNode, type UiSelectionChangeEvent, type UiTextChangeEvent } from 'gesso-core';
import { EditingService, FocusService, internalState, type ComponentContext, type Inputs } from 'gesso-framework';

import { complete, type Completion, type CompletionResult } from '../sql/complete';
import { editorSpans } from '../sql/highlight';
import { Workbench } from './Contract';
import type { Session } from './session';

/**
 * The SQL editor: one `editabletext`, with what makes it a code editor.
 *
 * Highlighting is `spans`, rebuilt from the tokenizer on every edit, with
 * a wash behind the statement the caret is in, which is what Run will
 * run. Line numbers are a second text node that follows the field's
 * scroll in the same layout pass (`scrollWith`), so the two never drift
 * by a frame. Completion is a list hung at the caret, from
 * `EditingService.caretRectOf`, because only the engine knows where the
 * caret was laid out.
 *
 * The caret, IME composition, undo, the clipboard and selection are the
 * field's own and none of them are written here.
 */
export interface SqlEditorProps {
  readonly session: Session;
}

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT_SIZE = 13;
const LINE_HEIGHT = 20;
const PADDING = 10;
const GUTTER = 48;
const VISIBLE_ITEMS = 9;

interface Open {
  readonly result: CompletionResult;
  readonly index: number;
}

const KIND_MARK: Record<Completion['kind'], { readonly letter: string; readonly color: string }> = {
  column: { letter: 'c', color: '#1593b5' },
  table: { letter: 't', color: '#2f9e5f' },
  function: { letter: 'ƒ', color: '#d0782a' },
  keyword: { letter: 'k', color: '#6b5cf0' }
};

export function SqlEditor(inputs: Inputs<SqlEditorProps>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const editing = ctx.inject(EditingService);
  const focus = ctx.inject(FocusService);
  const session = inputs.session.value;
  const field = new BehaviorSubject<UiNode | null>(null);

  const spans = combineLatest([session.text, session.active, session.error]).pipe(
    map(([text, active, error]) => editorSpans(text, active, error))
  );
  const lineNumbers = session.text.pipe(
    map(text => {
      let lines = 1;
      for (let at = 0; at < text.length; at++) {
        if (text.charCodeAt(at) === 10) {
          lines++;
        }
      }
      return lines;
    }),
    distinctUntilChanged(),
    map(lines => Array.from({ length: lines }, (_, index) => String(index + 1)).join('\n'))
  );

  // ------------------------------------------------------------------ completion

  const open = internalState<Open | null>(null);
  const at = internalState({ x: 0, y: 0 });

  const close = (): void => {
    if (open.value !== null) {
      open.value = null;
    }
  };

  const place = (): void => {
    // The caret is laid out in the frame after the edit that moved it,
    // so it is asked for then rather than now.
    setTimeout(() => {
      const node = field.value;
      const rect = node === null ? null : editing.caretRectOf(node);
      if (rect !== null) {
        at.value = { x: GUTTER + rect.x, y: rect.y + rect.height + 4 };
      }
    }, 0);
  };

  const suggest = (explicit: boolean): void => {
    const held = session.selection.value;
    if (held.end !== held.start) {
      close();
      return;
    }
    const text = session.text.value;
    const result = complete(text, held.start, workbench.view.schema.value);
    const typed = result !== null && (result.to > result.from || text[result.from - 1] === '.');
    if (result === null || (!explicit && !typed)) {
      close();
      return;
    }
    open.value = { result, index: 0 };
    place();
  };

  const accept = (item: Completion): void => {
    const node = field.value;
    const state = open.value;
    if (node === null || state === null) {
      return;
    }
    const model = editorFor(node);
    model.replaceRange(state.result.from, state.result.to, item.text);
    session.text.value = model.text;
    close();
  };

  // ------------------------------------------------------------------ keys

  const onKeyDown = (event: UiKeyboardEvent): void => {
    const primary = event.modifiers.ctrl === true || event.modifiers.meta === true;
    const state = open.value;
    if (state !== null) {
      const count = state.result.items.length;
      const step = (by: number): void => {
        open.value = { ...state, index: (state.index + by + count) % count };
      };
      const handled: Record<string, () => void> = {
        ArrowDown: () => step(1),
        ArrowUp: () => step(-1),
        PageDown: () => step(VISIBLE_ITEMS),
        PageUp: () => step(-VISIBLE_ITEMS),
        Enter: () => accept(state.result.items[state.index]),
        Tab: () => accept(state.result.items[state.index]),
        Escape: close
      };
      const run = primary ? undefined : handled[event.key];
      if (run !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        run();
        return;
      }
    }
    if (primary && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      close();
      session.runCurrent();
      return;
    }
    if (event.modifiers.ctrl === true && event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      suggest(true);
      return;
    }
    // Tab indents, as it does in any editor of code; Shift+Tab still
    // leaves, so the field is never a keyboard trap.
    if (event.key === 'Tab' && !primary && event.modifiers.shift !== true && event.modifiers.alt !== true) {
      const node = field.value;
      if (node !== null) {
        event.preventDefault();
        event.stopPropagation();
        const model = editorFor(node);
        model.insertText('  ');
        session.text.value = model.text;
      }
    }
  };

  const onInput = (event: UiTextChangeEvent): void => {
    session.text.value = event.value;
  };

  const onSelectionChange = (event: UiSelectionChangeEvent): void => {
    session.selection.value = { start: event.start, end: event.end };
    const text = event.value;
    const before = text[event.focus - 1] ?? '';
    // Typing a word, or a dot after a table's alias, opens the list;
    // anything else closes it. A caret moved by a click or an arrow
    // outside the word being completed closes it too.
    if (event.collapsed && /[A-Za-z0-9_.]/.test(before)) {
      const state = open.value;
      if (state === null || event.focus !== state.result.to) {
        suggest(false);
      }
    } else {
      close();
    }
  };

  // ------------------------------------------------------------------ the list

  const items = open.pipe(
    map(state => {
      if (state === null) {
        return [];
      }
      const first = Math.max(0, Math.min(state.index - VISIBLE_ITEMS + 1, state.result.items.length - VISIBLE_ITEMS));
      return state.result.items.slice(first, first + VISIBLE_ITEMS).map((item, offset) => {
        const index = first + offset;
        const chosen = index === state.index;
        const mark = KIND_MARK[item.kind];
        return (
          <row
            key={`${item.kind}:${item.text}`}
            height={24}
            paddingX={8}
            gap={8}
            y="center"
            borderRadius={4}
            backgroundColor={chosen ? 'selectionBackground' : undefined}
            cursor="pointer"
            role="option"
            label={item.text}
            states={chosen ? ['selected'] : []}
            onPointerDown={() => {
              accept(item);
              const node = field.value;
              if (node !== null) {
                queueMicrotask(() => focus.focus(node));
              }
            }}>
            <text text={mark.letter} width={12} fontSize={11} fontWeight={700} color={mark.color} selectable={false} />
            <text text={item.text} flex={1} minWidth={0} fontFamily={MONO} fontSize={12} color={chosen ? 'selectionForeground' : 'text'} textWrap="none" maxLines={1} textOverflow="ellipsis" selectable={false} />
            <text text={item.detail} fontSize={11} color="textMuted" textWrap="none" maxLines={1} selectable={false} />
          </row>
        );
      });
    })
  );

  const popup = open.pipe(
    map(state =>
      state === null
        ? []
        : [
            <column
              key="completion"
              position="absolute"
              left={at.pipe(map(point => point.x))}
              top={at.pipe(map(point => point.y))}
              width={340}
              padding={4}
              zIndex={10}
              lift={true}
              backgroundColor="surface"
              borderColor="border"
              borderWidth={1}
              borderRadius={6}
              boxShadows={[{ offsetX: 0, offsetY: 6, blurRadius: 18, spreadRadius: 0, color: { r: 0, g: 0, b: 0, a: 0.18 } }]}
              role="listbox"
              label="Suggestions">
              {items}
            </column>
          ]
    )
  );

  return (
    <row width={percent(100)} height={percent(100)} position="relative" backgroundColor="background">
      <box
        width={GUTTER}
        height={percent(100)}
        flexShrink={0}
        overflow="hidden"
        scrollWith={field}
        scrollWithAxis="y"
        backgroundColor="surface"
        borderColor="border"
        borderWidth={0}>
        <text
          text={lineNumbers}
          width={percent(100)}
          paddingTop={PADDING}
          paddingBottom={PADDING}
          paddingRight={10}
          fontFamily={MONO}
          fontSize={12}
          lineHeight={LINE_HEIGHT}
          textAlign="end"
          color="textMuted"
          selectable={false}
        />
      </box>
      <editabletext
        value={session.text}
        spans={spans}
        multiline={true}
        textWrap="none"
        flex={1}
        minWidth={0}
        height={percent(100)}
        padding={PADDING}
        fontFamily={MONO}
        fontSize={FONT_SIZE}
        lineHeight={LINE_HEIGHT}
        color="text"
        caretColor="primary"
        placeholder="Write SQL here. Ctrl+Enter runs the statement under the caret."
        role="textbox"
        label="SQL editor"
        ref={(node: UiNode | null) => {
          field.next(node);
          if (node !== null) {
            session.focusEditor = () => focus.focus(node);
          }
        }}
        onInput={onInput}
        onSelectionChange={onSelectionChange}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      {popup}
    </row>
  );
}
