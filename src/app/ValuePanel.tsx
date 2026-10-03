import { map } from 'rxjs';

import { percent } from 'gesso-core';
import { Button, Icon, Spinner } from 'gesso-components';
import { ShellService, type ComponentContext, type Inputs } from 'gesso-framework';

import { Workbench, type CellDetail } from './Contract';
import { formatCount } from './format';
import { ICONS } from './icons';
import { MONO } from './SqlEditor';

/**
 * One cell, in full.
 *
 * The grid draws a value on one line, cut to what the line can hold;
 * this is the rest of it, read again from the table, with a nested value
 * laid out as JSON. It follows the grid's selection while it is open, so
 * the arrow keys walk a column of long values one at a time.
 *
 * Opened with Enter on a cell or a double click on it.
 */
export interface ValuePanelProps {
  readonly onClose: () => void;
}

export function ValuePanel(inputs: Inputs<ValuePanelProps>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const shell = ctx.inject(ShellService);
  const cell = workbench.view.cell;
  const title = cell.pipe(map(detail => (detail === null ? 'Value' : detail.name)));
  const body = cell.pipe(map(detail => (detail === null ? [waiting()] : [shown(detail, text => shell.copyText(text))])));

  return (
    <column width={340} flexShrink={0} height={percent(100)} backgroundColor="surface" borderColor="border" borderWidth={1} role="region" label="Cell value">
      <row height={40} flexShrink={0} paddingX={12} gap={8} y="center">
        <Icon {...ICONS.console} size={14} color="textMuted" />
        <text text={title} flex={1} minWidth={0} fontSize={13} fontWeight={600} color="text" textWrap="none" maxLines={1} textOverflow="ellipsis" />
        <box width={24} height={24} x="center" y="center" borderRadius={4} cursor="pointer" role="button" label="Close value" onClick={() => inputs.onClose.value()}>
          <Icon {...ICONS.close} size={14} color="textMuted" />
        </box>
      </row>
      <column flex={1} minHeight={0} width={percent(100)}>
        {body}
      </column>
    </column>
  );
}

function waiting() {
  return (
    <row key="waiting" gap={8} y="center" padding={12}>
      <Spinner size={14} label="Reading the value" />
      <text text="Reading the value…" fontSize={12} color="textMuted" />
    </row>
  );
}

/** The value as it is shown: JSON laid out, anything else as it is. */
export function displayValue(detail: CellDetail): string {
  if (detail.value === null) {
    return 'NULL';
  }
  if (detail.json && !detail.cut) {
    try {
      return JSON.stringify(JSON.parse(detail.value), null, 2);
    } catch {
      return detail.value;
    }
  }
  return detail.value;
}

function shown(detail: CellDetail, copy: (text: string) => void) {
  const text = displayValue(detail);
  const facts = [
    detail.type,
    `row ${formatCount(detail.row + 1)}`,
    detail.value === null ? 'NULL' : `${formatCount(detail.value.length)} characters${detail.cut ? ', cut' : ''}`
  ].join(' · ');
  return (
    <column key={`${detail.id}:${detail.order}:${detail.row}:${detail.column}`} flex={1} minHeight={0} width={percent(100)}>
      <row paddingX={12} paddingBottom={8} gap={8} y="center">
        <text text={facts} flex={1} minWidth={0} fontSize={11} color="textMuted" textWrap="none" maxLines={1} textOverflow="ellipsis" />
        <Button size="small" variant="tonal" label="Copy" disabled={detail.value === null} onClick={() => copy(detail.value ?? '')} />
      </row>
      <scrollview flex={1} minHeight={0} width={percent(100)} paddingX={12} paddingBottom={12}>
        <text
          text={text}
          width={percent(100)}
          fontFamily={MONO}
          fontSize={12}
          lineHeight={17}
          color={detail.value === null ? 'textMuted' : 'text'}
          textWrap="char"
          selectable={true}
        />
      </scrollview>
    </column>
  );
}
