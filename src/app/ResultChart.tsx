import { combineLatest, distinctUntilChanged, map } from 'rxjs';

import { percent, type PaintBox, type PaintSurface, type UiPaint } from 'gesso-core';
import { Select, type SelectOption } from 'gesso-components';
import { internalState, type ComponentContext, type Inputs } from 'gesso-framework';

import { Workbench, type ChartSeries, type ResultView } from './Contract';

/**
 * The result, as a chart.
 *
 * One label column and one value column, chosen from the result: a small
 * result is drawn row by row, as a query that already grouped its data
 * expects, and a large one is summed by label and its biggest groups
 * kept. The aggregation is SQL in the application worker; what arrives
 * here is at most a few hundred points.
 *
 * Drawn with `paint`, the engine's drawing surface: bars, axes and
 * labels on one node, cached as a picture until the series or the size
 * changes. The colours are palette names, so the chart follows the
 * light and dark themes without knowing there are two.
 */
export interface ResultChartProps {
  readonly result: ResultView;
}

export function ResultChart(inputs: Inputs<ResultChartProps>, ctx: ComponentContext) {
  const workbench = ctx.channel(Workbench);
  const result = inputs.result.value;
  const columns = result.columns;

  const firstOf = (test: (index: number) => boolean, otherwise: number): number => {
    const found = columns.findIndex((_, index) => test(index));
    return found === -1 ? otherwise : found;
  };
  const numeric = (index: number): boolean => columns[index].kind === 'number';
  const defaultLabel = firstOf(index => !numeric(index), 0);
  const label = internalState(defaultLabel);
  const value = internalState(firstOf(index => numeric(index) && index !== defaultLabel, -1));

  ctx.effect(combineLatest([label, value]).pipe(distinctUntilChanged((a, b) => a[0] === b[0] && a[1] === b[1])), ([l, v]) => {
    if (v >= 0) {
      workbench.send.chart({ id: result.id, label: l, value: v });
    }
  });

  const labelOptions: SelectOption[] = columns.map((column, index) => ({ value: String(index), label: column.name }));
  const valueOptions: SelectOption[] = columns
    .map((column, index) => ({ value: String(index), label: column.name, disabled: column.kind !== 'number' }))
    .filter(option => !option.disabled);

  const series = workbench.view.chart.pipe(map(chart => (chart.id === result.id ? chart : null)));
  const kind = combineLatest([series, label]).pipe(
    // A line for time, or for more points than bars can be told apart
    // at; bars for categories, which includes an hour or a year written
    // as a number.
    map(([chart, l]) => (chart !== null && (columns[l]?.kind === 'time' || chart.points.length > 40) ? 'line' : 'bar'))
  );

  const caption = series.pipe(
    map(chart => {
      if (chart === null) {
        return valueOptions.length === 0 ? 'This result has no numeric column to chart.' : 'Charting…';
      }
      const kept = chart.groups > chart.points.length;
      return kept
        ? `${chart.value} by ${chart.label}: the ${chart.points.length} largest of ${chart.groups.toLocaleString('en-US')} groups`
        : `${chart.value} by ${chart.label}`;
    })
  );

  return (
    <column flex={1} minHeight={0} width={percent(100)} padding={16} gap={12}>
      <row gap={16} y="end">
        <Select label="Label" options={labelOptions} value={label.pipe(map(String))} onChange={next => (label.value = Number(next))} width={200} />
        {valueOptions.length === 0 ? (
          <box />
        ) : (
          <Select label="Value" options={valueOptions} value={value.pipe(map(String))} onChange={next => (value.value = Number(next))} width={200} />
        )}
        <text text={caption} flex={1} minWidth={0} fontSize={12} color="textMuted" textWrap="none" maxLines={1} textOverflow="ellipsis" />
      </row>
      <paint
        flex={1}
        minHeight={0}
        width={percent(100)}
        role="image"
        label={caption}
        paint={combineLatest([series, kind]).pipe(map(([chart, shape]) => painter(chart, shape)))}
      />
    </column>
  );
}

const AXIS = 'textMuted';
const GRID = 'border';
const BAR = 'primary';

/** Hoisted, so the property registry sees the same `draw` and compares the inputs. */
const draw = (surface: PaintSurface, box: PaintBox, chart: ChartSeries | null, shape: 'bar' | 'line'): void => {
  if (chart === null || chart.points.length === 0) {
    return;
  }
  const points = chart.points;
  const left = 64;
  const right = 16;
  const top = 12;
  const bottom = shape === 'bar' ? 92 : 40;
  const width = Math.max(1, box.width - left - right);
  const height = Math.max(1, box.height - top - bottom);
  const max = Math.max(0, ...points.map(point => point.value));
  const min = Math.min(0, ...points.map(point => point.value));
  const { step, top: ceiling, bottom: floor } = niceScale(min, max);
  const y = (value: number): number => top + height - ((value - floor) / (ceiling - floor || 1)) * height;

  // Gridlines and the axis labels on them.
  surface.lineWidth(1);
  for (let tick = floor; tick <= ceiling + step / 2; tick += step) {
    const at = Math.round(y(tick)) + 0.5;
    surface.beginPath();
    surface.moveTo(left, at);
    surface.lineTo(left + width, at);
    surface.strokeColor(GRID);
    surface.stroke();
    surface.fillColor(AXIS);
    surface.text(compact(tick), left - 8, at + 4, { fontSize: 11, align: 'right' });
  }

  if (shape === 'bar') {
    const slot = width / points.length;
    const bar = Math.max(1, Math.min(48, slot * 0.72));
    surface.fillColor(BAR);
    points.forEach((point, index) => {
      const x = left + slot * index + (slot - bar) / 2;
      const from = y(Math.max(0, point.value));
      const to = y(Math.min(0, point.value));
      surface.beginPath();
      surface.roundRect(x, from, bar, Math.max(1, to - from), Math.min(3, bar / 4));
      surface.fill();
    });
    // Labels under the bars, rotated so long names stay readable.
    surface.fillColor(AXIS);
    points.forEach((point, index) => {
      const x = left + slot * index + slot / 2;
      surface.save();
      surface.translate(x + 4, top + height + 10);
      surface.rotate(-Math.PI / 4);
      surface.text(clip(point.label, 14), 0, 0, { fontSize: 11, align: 'right' });
      surface.restore();
    });
    return;
  }

  // A line, with its area washed underneath.
  const x = (index: number): number => left + (points.length === 1 ? width / 2 : (index / (points.length - 1)) * width);
  surface.beginPath();
  points.forEach((point, index) => (index === 0 ? surface.moveTo(x(index), y(point.value)) : surface.lineTo(x(index), y(point.value))));
  surface.lineTo(x(points.length - 1), y(Math.max(0, floor)));
  surface.lineTo(x(0), y(Math.max(0, floor)));
  surface.closePath();
  // Alpha is state like the colour, so the wash is drawn inside a save
  // and everything after it is drawn opaque again.
  surface.save();
  surface.alpha(0.12);
  surface.fillColor(BAR);
  surface.fill();
  surface.restore();
  surface.beginPath();
  points.forEach((point, index) => (index === 0 ? surface.moveTo(x(index), y(point.value)) : surface.lineTo(x(index), y(point.value))));
  surface.strokeColor(BAR);
  surface.lineWidth(2);
  surface.lineJoin('round');
  surface.stroke();
  // A handful of labels along the bottom, evenly spread.
  surface.fillColor(AXIS);
  const labels = Math.min(points.length, Math.max(2, Math.floor(width / 90)));
  for (let index = 0; index < labels; index++) {
    const at = Math.round((index / Math.max(1, labels - 1)) * (points.length - 1));
    surface.text(clip(points[at].label, 16), x(at), top + height + 18, {
      fontSize: 11,
      align: index === 0 ? 'left' : index === labels - 1 ? 'right' : 'center'
    });
  }
};

function painter(chart: ChartSeries | null, shape: 'bar' | 'line'): UiPaint {
  return { draw: (surface, box) => draw(surface, box, chart, shape), inputs: [chart, shape] };
}

/** Round gridline steps: 1, 2 or 5 times a power of ten. */
export function niceScale(min: number, max: number): { step: number; bottom: number; top: number } {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / 5;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map(factor => factor * power).find(candidate => candidate >= raw) ?? 10 * power;
  return { step, bottom: Math.floor(min / step) * step, top: Math.ceil(max / step) * step };
}

export function compact(value: number): string {
  const size = Math.abs(value);
  if (size >= 1e9) {
    return `${trim(value / 1e9)}B`;
  }
  if (size >= 1e6) {
    return `${trim(value / 1e6)}M`;
  }
  if (size >= 1e3) {
    return `${trim(value / 1e3)}k`;
  }
  return trim(value);
}

function trim(value: number): string {
  return String(Number(value.toFixed(2)));
}

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
