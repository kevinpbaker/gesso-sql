import { BehaviorSubject, combineLatest, distinctUntilChanged, map, type Observable } from 'rxjs';

import { internalState, type ComponentContext, type InternalState } from 'gesso-framework';

import { statementAt, type Statement } from '../sql/statements';
import type { Range } from '../sql/highlight';
import { Workbench } from './Contract';

/**
 * The editor's half of the workbench, shared by the parts of the screen
 * that act on it.
 *
 * The Run button in the toolbar and Ctrl+Enter in the editor are the
 * same command, so both need the text, the caret and the rule for which
 * statement the caret means. Those live here, on this thread: a caret
 * that round-tripped to the application worker would lag the typing it
 * follows, and nothing over there cares where the caret is until a
 * statement is actually sent.
 */
export interface Session {
  readonly text: InternalState<string>;
  /** The selection, as offsets: equal when nothing is selected. */
  readonly selection: InternalState<Range>;
  /** The statement Run would run, or null for an empty editor. */
  readonly active: Observable<Range | null>;
  /** Where the last error points, in the editor's text, until the text changes. */
  readonly error: Observable<Range | null>;
  /** Runs the selection if there is one, or the statement under the caret. */
  runCurrent(): void;
  /** Runs every statement in the editor, in order, showing the last. */
  runAll(): void;
  /** Runs SQL that is not in the editor: a table's preview, a statement from history. */
  runSql(sql: string): void;
  /** Puts text into the editor, replacing what is there. */
  replace(text: string): void;
  /** Set by the editor once it exists, so the toolbar can hand the keyboard back to it. */
  focusEditor: () => void;
}

export function session(ctx: ComponentContext): Session {
  const workbench = ctx.channel(Workbench);
  const text = internalState('');
  const selection = internalState<Range>({ start: 0, end: 0 });
  /** Where in the editor the statement last sent started; -1 when it was not from the editor. */
  let sentAt = -1;
  /** The text as it was when that statement was sent, so an edit afterwards clears the mark. */
  const sentText = new BehaviorSubject<string | null>(null);

  const current = (): Statement | null => {
    const held = selection.value;
    if (held.end > held.start) {
      return { start: held.start, end: held.end, text: text.value.slice(held.start, held.end) };
    }
    return statementAt(text.value, held.start);
  };

  const active = combineLatest([text, selection]).pipe(
    map(([value, held]) => {
      if (held.end > held.start) {
        return { start: held.start, end: held.end };
      }
      const statement = statementAt(value, held.start);
      return statement === null ? null : { start: statement.start, end: statement.end };
    }),
    distinctUntilChanged((a, b) => a?.start === b?.start && a?.end === b?.end)
  );

  const error = combineLatest([workbench.view.run, text, sentText]).pipe(
    map(([run, value, sent]) => {
      if (run.phase !== 'failed' || run.errorAt < 0 || sentAt < 0 || sent !== value) {
        return null;
      }
      const at = sentAt + run.errorAt;
      // The token at the offset: as far as the next space or bracket.
      let end = at;
      while (end < value.length && !/[\s,()]/.test(value[end])) {
        end++;
      }
      return { start: at, end: Math.max(end, at + 1) };
    }),
    distinctUntilChanged((a, b) => a?.start === b?.start && a?.end === b?.end)
  );

  const send = (sql: string, at: number): void => {
    const phase = workbench.view.run.value.phase;
    if (phase === 'running' || phase === 'starting') {
      return;
    }
    // The application worker trims what it is sent, and its error
    // offsets count from the first character it kept.
    sentAt = at < 0 ? at : at + (sql.length - sql.trimStart().length);
    sentText.next(at < 0 ? null : text.value);
    workbench.send.run({ sql, at });
  };

  // The text is the application worker's to keep, so it is sent there a
  // moment after typing stops rather than on every key.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let loaded = false;
  ctx.effect(text, value => {
    if (!loaded) {
      return;
    }
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => workbench.send.saveDraft(value), 500);
  });
  // The first draft to arrive is where the editor starts; later ones are
  // the echo of what was typed here and are not applied back.
  ctx.effect(workbench.view.draft, draft => {
    if (!loaded && draft !== null) {
      loaded = true;
      text.value = draft;
    }
  });

  const handle: Session = {
    text,
    selection,
    active,
    error,
    runCurrent: () => {
      const statement = current();
      if (statement !== null && statement.text.trim() !== '') {
        send(statement.text, statement.start);
      }
    },
    runAll: () => {
      if (text.value.trim() !== '') {
        send(text.value, 0);
      }
    },
    runSql: (sql: string) => send(sql, -1),
    replace: (value: string) => {
      text.value = value;
    },
    focusEditor: () => undefined
  };
  return handle;
}
