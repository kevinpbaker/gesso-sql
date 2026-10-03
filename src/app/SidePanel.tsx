import { combineLatest, map } from 'rxjs';

import { percent } from 'gesso-core';
import { Button, Icon, Tabs, Tree, type TabDefinition, type TreeNode } from 'gesso-components';
import { internalState, type ComponentContext, type Inputs } from 'gesso-framework';

import { needsQuotes, quoteIdentifier } from '../sql/complete';
import { Workbench, type HistoryEntry, type SchemaTableView } from './Contract';
import { ago, formatCount, formatMs } from './format';
import { ICONS } from './icons';
import type { Session } from './session';
import { MONO } from './SqlEditor';

/**
 * The left-hand column: what is in the database, and what has been run.
 *
 * The schema is a `Tree`, one branch per table with its columns as
 * leaves, so it windows like any other tree and is announced as one.
 * Enter on a table, or Preview, runs `SELECT * FROM` it without touching
 * the editor. History is every statement run, newest first, with how
 * long it took and how many rows it made; pressing one runs it again.
 */
export interface SidePanelProps {
  readonly session: Session;
}

const TABS: readonly TabDefinition[] = [
  { value: 'schema', label: 'Schema' },
  { value: 'history', label: 'History' }
];

export function SidePanel(inputs: Inputs<SidePanelProps>, ctx: ComponentContext) {
  const tab = internalState('schema');
  const body = tab.pipe(
    map(value => [value === 'history' ? <HistoryList key="history" session={inputs.session.value} /> : <SchemaTree key="schema" session={inputs.session.value} />])
  );
  return (
    <column width={percent(100)} height={percent(100)} backgroundColor="surface">
      <Tabs tabs={TABS} value={tab} onChange={next => (tab.value = next)} label="Side panel" flex={1} minHeight={0}>
        <column flex={1} minHeight={0} width={percent(100)}>
          {body}
        </column>
      </Tabs>
    </column>
  );
}

function tableName(name: string): string {
  return needsQuotes(name) ? quoteIdentifier(name) : name;
}

function SchemaTree(inputs: Inputs<{ session: Session }>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const selected = internalState<string | null>(null);
  const expanded = internalState<readonly string[]>([]);

  const nodes = workbench.view.schema.pipe(map(tables => tables.map(treeNodeOf)));
  const selectedTable = combineLatest([selected, workbench.view.schema]).pipe(
    map(([key, tables]) => tables.find(table => key !== null && (key === `t:${table.name}` || key.startsWith(`c:${table.name}:`))) ?? null)
  );

  const preview = (table: SchemaTableView | null): void => {
    if (table !== null) {
      inputs.session.value.runSql(`SELECT * FROM ${tableName(table.name)}`);
    }
  };

  const footer = selectedTable.pipe(
    map(table => {
      if (table === null) {
        return [<text key="hint" text="Choose a table to preview it." fontSize={11} color="textMuted" />];
      }
      return [
        <text key="name" text={table.name} flex={1} minWidth={0} fontFamily={MONO} fontSize={12} color="text" textWrap="none" maxLines={1} textOverflow="ellipsis" />,
        <Button key="preview" size="small" variant="tonal" label="Preview" onClick={() => preview(table)} />,
        <Button key="summarize" size="small" variant="plain" label="Summarize" onClick={() => inputs.session.value.runSql(`SUMMARIZE ${tableName(table.name)}`)} />
      ];
    })
  );

  const empty = workbench.view.schema.pipe(
    map(tables => (tables.length === 0 ? [<text key="empty" text="No tables yet." padding={12} fontSize={12} color="textMuted" />] : []))
  );

  return (
    <column flex={1} minHeight={0} width={percent(100)}>
      {empty}
      <Tree
        nodes={nodes}
        expanded={expanded}
        onExpandedChange={next => (expanded.value = next)}
        selectedKey={selected}
        onSelect={key => (selected.value = key)}
        onActivate={key => {
          const table = workbench.view.schema.value.find(entry => key === `t:${entry.name}`);
          preview(table ?? null);
        }}
        label="Tables"
        flex={1}
        minHeight={0}
      />
      <row height={40} flexShrink={0} paddingX={10} gap={6} y="center" borderColor="border" borderWidth={1}>
        {footer}
      </row>
    </column>
  );
}

function treeNodeOf(table: SchemaTableView): TreeNode {
  const size = table.kind === 'view' ? 'view' : `${formatCount(table.rows)} rows`;
  return {
    key: `t:${table.name}`,
    label: `${table.name}  ·  ${size}`,
    children: table.columns.map(column => ({ key: `c:${table.name}:${column.name}`, label: `${column.name}  ${column.type}` }))
  };
}

function HistoryList(inputs: Inputs<{ session: Session }>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  // Re-read every half minute, so "2 min ago" does not stay "just now".
  const now = internalState(Date.now());
  const timer = setInterval(() => (now.value = Date.now()), 30_000);
  ctx.onUnmount(() => clearInterval(timer));

  const rows = combineLatest([workbench.view.history, now]).pipe(
    map(([history, at]) =>
      history.length === 0
        ? [<text key="empty" text="Statements you run appear here." padding={12} fontSize={12} color="textMuted" />]
        : history.map(entry => <HistoryRow key={entry.id} entry={entry} now={at} session={inputs.session.value} />)
    )
  );

  return (
    <column flex={1} minHeight={0} width={percent(100)}>
      <scrollview flex={1} minHeight={0} width={percent(100)}>
        <column width={percent(100)}>{rows}</column>
      </scrollview>
      <row height={40} flexShrink={0} paddingX={10} gap={6} y="center" borderColor="border" borderWidth={1}>
        <text text={workbench.view.history.pipe(map(history => `${history.length} statements`))} flex={1} fontSize={11} color="textMuted" />
        <Button size="small" variant="plain" label="Clear" onClick={() => workbench.send.clearHistory()}>
          <row gap={4} y="center">
            <Icon {...ICONS.trash} size={13} />
            <text text="Clear" fontSize={12} selectable={false} />
          </row>
        </Button>
      </row>
    </column>
  );
}

function HistoryRow(inputs: Inputs<{ entry: HistoryEntry; now: number; session: Session }>, _ctx: ComponentContext) {
  const entry = inputs.entry.value;
  const failed = entry.error !== '';
  const firstLine = entry.sql.split('\n').find(line => line.trim() !== '' && !line.trim().startsWith('--')) ?? entry.sql;
  const meta = failed
    ? entry.error
    : `${formatMs(entry.elapsedMs)} · ${formatCount(entry.rows)} row${entry.rows === 1 ? '' : 's'} · ${ago(entry.at, inputs.now.value)}`;
  return (
    <column
      paddingX={12}
      paddingY={8}
      gap={3}
      width={percent(100)}
      cursor="pointer"
      role="button"
      label={`Run again: ${firstLine}`}
      borderColor="border"
      borderWidth={0}
      onClick={() => inputs.session.value.runSql(entry.sql)}>
      <text text={firstLine.trim()} fontFamily={MONO} fontSize={12} color="text" textWrap="none" maxLines={1} textOverflow="ellipsis" />
      <text text={meta} fontSize={11} color={failed ? 'danger' : 'textMuted'} textWrap="none" maxLines={1} textOverflow="ellipsis" />
    </column>
  );
}
