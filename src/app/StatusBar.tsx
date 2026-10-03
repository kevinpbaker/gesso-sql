import { combineLatest, map } from 'rxjs';

import { type ComponentContext, type Inputs } from 'gesso-framework';

import { Workbench } from './Contract';
import type { Session } from './session';

/**
 * The line along the bottom: what the workbench last said, where the
 * caret is, and which DuckDB build is running.
 *
 * It owns nothing and takes no focus. The caret position is read from
 * the session on this thread, so it moves with the caret in the same
 * frame; the rest arrives over the channel.
 */
export function StatusBar(inputs: Inputs<{ session: Session }>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const session = inputs.session.value;

  const message = workbench.view.run.pipe(
    map(run => {
      if (run.phase === 'failed') {
        return run.error.split('\n')[0];
      }
      if (run.message !== '') {
        return run.message;
      }
      return run.phase === 'running' ? 'Running…' : 'Ready';
    })
  );
  const tone = workbench.view.run.pipe(map(run => (run.phase === 'failed' ? 'danger' : 'textMuted')));

  const caret = combineLatest([session.text, session.selection]).pipe(
    map(([text, selection]) => {
      const before = text.slice(0, selection.start);
      const line = before.split('\n').length;
      const column = selection.start - before.lastIndexOf('\n');
      const selected = selection.end - selection.start;
      return `Ln ${line}, Col ${column}${selected > 0 ? ` (${selected} selected)` : ''}`;
    })
  );

  const engine = workbench.view.engine.pipe(
    map(engine => (engine.version === '' ? '' : `DuckDB ${engine.version} · ${engine.bundle} build · in its own worker`))
  );

  return (
    <row height={26} flexShrink={0} paddingX={12} gap={16} y="center" backgroundColor="surface" borderColor="border" borderWidth={1}>
      <text text={message} flex={1} minWidth={0} fontSize={11} color={tone} textWrap="none" maxLines={1} textOverflow="ellipsis" live="polite" />
      <text text={caret} fontSize={11} color="textMuted" selectable={false} />
      <text text={engine} fontSize={11} color="textMuted" selectable={false} />
    </row>
  );
}
