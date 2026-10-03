import { map } from 'rxjs';

import { percent } from 'gesso-core';
import { Icon, Spinner } from 'gesso-components';
import { type ComponentContext, type Inputs } from 'gesso-framework';

import { Workbench, type ColumnProfile } from './Contract';
import { formatCount } from './format';
import { ICONS } from './icons';
import { MONO } from './SqlEditor';

/**
 * One column, summarised: nulls, distinct values, range, mean and the
 * most common values with a bar for each.
 *
 * Opened from a column header's chart button. The numbers are two
 * aggregate queries over the whole result, run in DuckDB, so a profile
 * of ten million rows arrives as a dozen values.
 */
export interface ProfilePanelProps {
  readonly onClose: () => void;
}

export function ProfilePanel(inputs: Inputs<ProfilePanelProps>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const body = workbench.view.profile.pipe(map(profile => (profile === null ? [loading()] : [details(profile)])));
  const title = workbench.view.profile.pipe(map(profile => profile?.name ?? 'Profiling…'));

  return (
    <column
      width={300}
      flexShrink={0}
      height={percent(100)}
      backgroundColor="surface"
      borderColor="border"
      borderWidth={1}
      role="region"
      label="Column profile">
      <row height={40} paddingX={12} gap={8} y="center" borderColor="border" borderWidth={0}>
        <Icon {...ICONS.chart} size={14} color="textMuted" />
        <text text={title} flex={1} minWidth={0} fontSize={13} fontWeight={600} color="text" textWrap="none" maxLines={1} textOverflow="ellipsis" />
        <box
          width={24}
          height={24}
          x="center"
          y="center"
          borderRadius={4}
          cursor="pointer"
          role="button"
          label="Close profile"
          onClick={() => inputs.onClose.value()}>
          <Icon {...ICONS.close} size={14} color="textMuted" />
        </box>
      </row>
      <scrollview flex={1} minHeight={0} paddingX={12} paddingBottom={12}>
        {body}
      </scrollview>
    </column>
  );
}

function loading() {
  return (
    <row key="loading" gap={8} y="center" paddingY={12}>
      <Spinner size={14} label="Profiling" />
      <text text="Reading every row…" fontSize={12} color="textMuted" />
    </row>
  );
}

function details(profile: ColumnProfile) {
  const fact = (name: string, value: string) => (
    <row key={name} gap={8} paddingY={3}>
      <text text={name} width={84} fontSize={12} color="textMuted" />
      <text text={value === '' ? '—' : value} flex={1} minWidth={0} fontFamily={MONO} fontSize={12} color="text" textWrap="none" maxLines={1} textOverflow="ellipsis" selectable={true} />
    </row>
  );
  const most = Math.max(1, ...profile.top.map(entry => entry.count));
  return (
    <column key={`${profile.id}:${profile.column}`} gap={2} paddingTop={4}>
      {fact('Type', profile.type)}
      {fact('Nulls', formatCount(profile.nulls))}
      {fact('Distinct', `≈ ${formatCount(profile.distinct)}`)}
      {fact('Min', profile.min)}
      {fact('Max', profile.max)}
      {profile.mean === '' ? <box key="no-mean" /> : fact('Mean', profile.mean)}
      <text key="top-title" text="Most common" fontSize={12} fontWeight={600} color="text" paddingTop={12} paddingBottom={6} />
      {profile.top.map((entry, index) => (
        <column key={`top-${index}`} gap={3} paddingBottom={6}>
          <row gap={8}>
            <text text={entry.value} flex={1} minWidth={0} fontFamily={MONO} fontSize={12} color="text" textWrap="none" maxLines={1} textOverflow="ellipsis" />
            <text text={formatCount(entry.count)} fontSize={11} color="textMuted" />
          </row>
          <box height={4} width={percent(100)} borderRadius={2} backgroundColor="controlBackground">
            <box height={4} width={percent((entry.count / most) * 100)} borderRadius={2} backgroundColor="primary" />
          </box>
        </column>
      ))}
    </column>
  );
}
