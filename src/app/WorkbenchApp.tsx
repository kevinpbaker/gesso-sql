import { map } from 'rxjs';

import { dropTarget, EXTERNAL_FILES, percent, type UiDroppedFile } from 'gesso-core';
import { SplitPane, Toast } from 'gesso-components';
import { internalState, type ComponentContext, type Inputs } from 'gesso-framework';

import { Workbench } from './Contract';
import { ResultsPanel } from './ResultsPanel';
import { session as createSession } from './session';
import { SidePanel } from './SidePanel';
import { SqlEditor } from './SqlEditor';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';

/**
 * The screen: toolbar, schema and history on the left, the editor over
 * the result on the right, and a status line.
 *
 * Nothing here holds data. The database, every result and every row are
 * in the application worker and DuckDB's; this thread holds the editor's
 * text and caret, which panel is open and where the dividers are, and
 * sends commands. A file dropped anywhere on the window is opened as a
 * table, because a person dropping a file is aiming at the application
 * and not at a pane.
 */
export function WorkbenchApp(_inputs: Inputs<{}>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const session = createSession(ctx);

  const drop = dropTarget({
    accepts: EXTERNAL_FILES,
    onDrop: payload => {
      for (const file of payload.data as readonly UiDroppedFile[]) {
        if (file.bytes !== undefined) {
          workbench.send.open({ name: file.name, bytes: new Uint8Array(file.bytes) });
        }
      }
      return 'copy';
    },
    over: { borderColor: 'focusRing', borderWidth: 2 }
  });

  // A notice the application worker wants seen once.
  const toastOpen = internalState(false);
  let seen = workbench.view.notice.value?.serial ?? 0;
  ctx.effect(workbench.view.notice, notice => {
    if (notice !== null && notice.serial > seen) {
      seen = notice.serial;
      toastOpen.value = true;
    }
  });

  return (
    <column width={percent(100)} height={percent(100)} backgroundColor="background" borderColor="transparent" borderWidth={0} modifiers={[drop]}>
      <TopBar session={session} />
      <box flex={1} minHeight={0} width={percent(100)}>
        <SplitPane
          defaultSplit={0.2}
          min={0.12}
          max={0.45}
          label="Resize the side panel"
          first={<SidePanel session={session} />}
          second={
            <SplitPane
              direction="column"
              defaultSplit={0.42}
              min={0.15}
              max={0.85}
              label="Resize the editor"
              first={<SqlEditor session={session} />}
              second={<ResultsPanel />}
            />
          }
        />
      </box>
      <StatusBar session={session} />
      <Toast
        open={toastOpen}
        onClose={() => (toastOpen.value = false)}
        message={workbench.view.notice.pipe(map(notice => notice?.text ?? ''))}
        tone={workbench.view.notice.pipe(map(notice => notice?.tone ?? 'info'))}
        duration={6000}
      />
    </column>
  );
}
