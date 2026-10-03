import { combineLatest, distinctUntilChanged, map } from 'rxjs';

import { percent } from 'gesso-core';
import { Alert, Button, Icon, SegmentedControl, Spinner } from 'gesso-components';
import { internalState, ShellService, type ComponentContext, type Inputs } from 'gesso-framework';

import { formatCount, formatMs } from './format';
import { ICONS } from './icons';
import { ProfilePanel } from './ProfilePanel';
import { ResultChart } from './ResultChart';
import { ResultGrid } from './ResultGrid';
import { Workbench, type ResultView } from './Contract';
import { MONO } from './SqlEditor';

/**
 * The bottom half: what the last statement produced.
 *
 * A strip with the result's size and timing, the Grid and Chart views,
 * and Export; under it the grid, the chart, or for a statement without
 * rows what it did. An error sits above all of that rather than in
 * place of it, so the last good result is still there to look at while
 * the query is being fixed.
 *
 * The grid and the chart are built per result and thrown away with it,
 * keyed by its id. A sort is the same result in a new order and keeps
 * both.
 */
export function ResultsPanel(_inputs: Inputs<{}>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const shell = ctx.inject(ShellService);
  const view = internalState<'grid' | 'chart'>('grid');
  const profiling = internalState<number | null>(null);

  const result = workbench.view.result;
  const byId = result.pipe(distinctUntilChanged((a, b) => a.id === b.id));
  ctx.effect(byId, () => (profiling.value = null));

  // A download the application worker built, handed to the shell to save.
  let saved = workbench.view.download.value?.serial ?? 0;
  ctx.effect(workbench.view.download, download => {
    if (download === null || download.serial <= saved) {
      return;
    }
    saved = download.serial;
    void shell.saveFile({ name: download.name, text: download.text, mediaType: 'text/csv', accept: [{ description: 'CSV', mediaType: 'text/csv', extensions: ['.csv'] }] });
  });

  const summary = result.pipe(
    map(view => {
      if (view.id === 0) {
        return 'No result yet';
      }
      if (view.columns.length === 0) {
        return `Ran in ${formatMs(view.elapsedMs)}`;
      }
      const sorted = view.sort === null ? '' : ` · sorted by ${view.columns[view.sort.column]?.name ?? ''}`;
      return `${formatCount(view.rowCount)} row${view.rowCount === 1 ? '' : 's'} · ${view.columns.length} column${view.columns.length === 1 ? '' : 's'} · ${formatMs(view.elapsedMs)}${sorted}`;
    })
  );

  const error = workbench.view.run.pipe(
    map(run => (run.phase === 'failed' ? run.error : '')),
    distinctUntilChanged(),
    map(message =>
      message === ''
        ? []
        : [
            <box key="error" paddingX={12} paddingTop={10}>
              <Alert tone="danger" title="The statement failed" message={message} live={true} />
            </box>
          ]
    )
  );

  const body = combineLatest([byId, view]).pipe(
    map(([current, showing]) => [content(current, showing, column => {
      profiling.value = column;
      workbench.send.profile({ id: current.id, column });
    })])
  );

  const profile = profiling.pipe(
    map(column =>
      column === null
        ? []
        : [
            <ProfilePanel
              key={`profile-${column}`}
              onClose={() => {
                profiling.value = null;
                workbench.send.profile(null);
              }}
            />
          ]
    )
  );

  const sorting = result.pipe(
    map(view => (view.sorting ? [<Spinner key="sorting" size={14} label="Sorting" />] : []))
  );

  const hasRows = result.pipe(map(view => view.columns.length > 0 && view.rowCount > 0));

  return (
    <column width={percent(100)} height={percent(100)} backgroundColor="background">
      <row height={40} flexShrink={0} paddingX={12} gap={10} y="center" backgroundColor="surface" borderColor="border" borderWidth={1}>
        <SegmentedControl
          size="small"
          label="Result view"
          options={[
            { value: 'grid', label: 'Grid' },
            { value: 'chart', label: 'Chart' }
          ]}
          value={view}
          onChange={next => (view.value = next === 'chart' ? 'chart' : 'grid')}
        />
        <text text={summary} fontSize={12} color="textMuted" textWrap="none" maxLines={1} textOverflow="ellipsis" flex={1} minWidth={0} live="polite" />
        {sorting}
        <Button
          size="small"
          variant="outlined"
          label="Export CSV"
          disabled={hasRows.pipe(map(has => !has))}
          onClick={() => workbench.send.exportCsv({ id: result.value.id })}>
          <row gap={6} y="center">
            <Icon {...ICONS.export} size={14} />
            <text text="Export CSV" fontSize={12} selectable={false} />
          </row>
        </Button>
      </row>
      {error}
      <row flex={1} minHeight={0} width={percent(100)}>
        <column flex={1} minWidth={0} height={percent(100)}>
          {body}
        </column>
        {profile}
      </row>
    </column>
  );
}

function content(result: ResultView, showing: 'grid' | 'chart', onProfile: (column: number) => void) {
  if (result.id === 0) {
    return (
      <column key="empty" flex={1} x="center" y="center" gap={8} padding={24}>
        <Icon {...ICONS.console} size={28} color="textMuted" />
        <text text="Run a statement to see its result here." fontSize={13} color="textMuted" />
        <text text="Ctrl+Enter (⌘+Enter on a Mac) runs the statement under the caret." fontSize={12} color="textMuted" />
      </column>
    );
  }
  if (result.columns.length === 0) {
    return (
      <scrollview key={`note-${result.id}`} flex={1} minHeight={0} width={percent(100)} padding={16}>
        <text text={result.note} fontFamily={MONO} fontSize={12} lineHeight={16} color="text" textWrap="none" selectable={true} />
      </scrollview>
    );
  }
  if (showing === 'chart') {
    return <ResultChart key={`chart-${result.id}`} result={result} />;
  }
  return <ResultGrid key={`grid-${result.id}`} result={result} onProfile={onProfile} />;
}
