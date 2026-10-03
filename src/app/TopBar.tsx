import { combineLatest, distinctUntilChanged, map } from 'rxjs';

import { Button, Icon, Select, Spinner, tooltip, type SelectOption } from 'gesso-components';
import { internalState, ShellService, type ComponentContext, type Inputs } from 'gesso-framework';

import { SAMPLE_SIZES } from '../data/sample';
import { Workbench } from './Contract';
import { formatCount, formatMs } from './format';
import { ICONS } from './icons';
import type { Session } from './session';

/**
 * The toolbar: Run (or Cancel), Open, the sample's size, and how long
 * the running statement has been going.
 *
 * The timer ticks here, in the render worker, ten times a second. While
 * DuckDB is busy for ten seconds in its own worker, that number keeps
 * counting smoothly and the grid under it keeps scrolling, which is the
 * claim this application exists to make visible.
 */
export interface TopBarProps {
  readonly session: Session;
}

const FILE_TYPES = [
  { description: 'Data files', mediaType: 'text/csv', extensions: ['.csv', '.tsv', '.txt', '.parquet', '.json', '.ndjson', '.jsonl'] }
];

const SIZE_OPTIONS: readonly SelectOption[] = SAMPLE_SIZES.map(rows => ({ value: String(rows), label: `${formatCount(rows)} trips` }));

export function TopBar(inputs: Inputs<TopBarProps>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const shell = ctx.inject(ShellService);
  const session = inputs.session.value;
  const run = workbench.view.run;
  const busy = run.pipe(
    map(state => state.phase === 'running' || state.phase === 'starting'),
    distinctUntilChanged()
  );
  const running = run.pipe(
    map(state => state.phase === 'running'),
    distinctUntilChanged()
  );

  // The elapsed time of the statement in flight, measured on this thread.
  const elapsed = internalState(0);
  let startedAt = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  ctx.effect(running, on => {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
    if (on) {
      startedAt = performance.now();
      elapsed.value = 0;
      ticker = setInterval(() => (elapsed.value = performance.now() - startedAt), 100);
    }
  });
  ctx.onUnmount(() => {
    if (ticker !== null) {
      clearInterval(ticker);
    }
  });

  const size = internalState(String(SAMPLE_SIZES[1]));
  const schemaTrips = workbench.view.schema.pipe(map(tables => tables.find(table => table.name === 'trips')?.rows ?? -1));
  ctx.effect(schemaTrips, rows => {
    if (SAMPLE_SIZES.includes(rows)) {
      size.value = String(rows);
    }
  });

  const openFile = (): void => {
    void shell.openFiles({ accept: FILE_TYPES, multiple: true }).then(result => {
      if (result.outcome !== 'ok') {
        return;
      }
      for (const file of result.files) {
        workbench.send.open({ name: file.name, bytes: new Uint8Array(file.bytes) });
      }
    });
  };

  // Made once, in the body: a tooltip registers a lifecycle hook, which
  // only the component function itself may do.
  const cancelTip = tooltip(ctx, { text: 'Interrupt the running statement', placement: 'bottom' });
  const runTip = tooltip(ctx, { text: 'Run the statement under the caret (Ctrl+Enter)', placement: 'bottom' });
  const openTip = tooltip(ctx, { text: 'Load CSV, Parquet or JSON as a table (Ctrl+O)', placement: 'bottom' });

  const runButton = running.pipe(
    map(on => [
      on ? (
        <Button
          key="cancel"
          tone="danger"
          variant="filled"
          label="Cancel"
          onClick={() => workbench.send.cancel()}
          rootModifiers={[cancelTip]}>
          <row gap={6} y="center">
            <Icon {...ICONS.stop} size={14} color="controlBackground" />
            <text text="Cancel" fontSize={13} fontWeight={600} color="controlBackground" selectable={false} />
          </row>
        </Button>
      ) : (
        <Button
          key="run"
          tone="accent"
          variant="filled"
          label="Run"
          disabled={busy}
          onClick={() => {
            session.runCurrent();
            session.focusEditor();
          }}
          rootModifiers={[runTip]}>
          <row gap={6} y="center">
            <Icon {...ICONS.run} size={14} color="controlBackground" />
            <text text="Run" fontSize={13} fontWeight={600} color="controlBackground" selectable={false} />
          </row>
        </Button>
      )
    ])
  );

  /**
   * What is happening, built once per phase and bound inside, so the ten
   * ticks a second change one string rather than rebuild the spinner.
   *
   * There is no percentage. DuckDB-WASM reports progress only to a
   * statement run in one call, and the statements here are run in steps
   * so that Cancel can interrupt them; Cancel is worth more.
   */
  const runningText = elapsed.pipe(map(ms => `Running · ${formatMs(ms)}`));
  const activity = run.pipe(
    map(state => state.phase),
    distinctUntilChanged(),
    map(phase => {
      if (phase === 'running') {
        return [
          <Spinner key="spin" size={16} label="Running" />,
          <text key="time" text={runningText} fontSize={12} color="text" fontFamily="ui-monospace, Menlo, monospace" selectable={false} />
        ];
      }
      if (phase === 'starting') {
        return [
          <Spinner key="spin" size={16} label="Starting" />,
          <text key="message" text={run.pipe(map(state => state.message))} fontSize={12} color="textMuted" selectable={false} />
        ];
      }
      return [];
    })
  );

  return (
    <row height={52} flexShrink={0} paddingX={14} gap={12} y="center" backgroundColor="surface" borderColor="border" borderWidth={1}>
      <row gap={8} y="center" paddingRight={8}>
        <box width={26} height={26} borderRadius={7} backgroundColor="primary" x="center" y="center">
          <Icon {...ICONS.database} size={16} color="controlBackground" />
        </box>
        <column>
          <text text="Gesso SQL" fontSize={14} fontWeight={700} color="text" selectable={false} />
          <text
            text={workbench.view.engine.pipe(map(engine => (engine.version === '' ? 'DuckDB' : `DuckDB ${engine.version}`)))}
            fontSize={10}
            color="textMuted"
            selectable={false}
          />
        </column>
      </row>
      {runButton}
      <Button variant="outlined" label="Open file" onClick={openFile} rootModifiers={[openTip]}>
        <row gap={6} y="center">
          <Icon {...ICONS.open} size={14} />
          <text text="Open file" fontSize={13} selectable={false} />
        </row>
      </Button>
      <row gap={8} y="center">
        {activity}
      </row>
      <box flex={1} />
      <text text="Sample" fontSize={12} color="textMuted" selectable={false} />
      <Select
        label=""
        options={SIZE_OPTIONS}
        value={size}
        disabled={busy}
        width={160}
        onChange={next => {
          size.value = next;
          workbench.send.sample(Number(next));
        }}
      />
    </row>
  );
}
