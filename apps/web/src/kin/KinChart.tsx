import type {
  KinChartMark,
  KinChartTone,
  KinChartView,
} from "@t3tools/client-runtime/kin/kinChart";
import {
  kinChartHeight,
  kinChartLayout,
  type KinChartLayout,
  type KinChartText,
} from "@t3tools/client-runtime/kin/kinChartLayout";
import { useLayoutEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";

// Series take the product's own colours, so a chart follows the theme like the rest of the app.
const COLORS: Record<KinChartTone["color"], string> = {
  accent: "text-primary",
  amber: "text-warning",
  green: "text-success",
  purple: "text-fuchsia-600 dark:text-fuchsia-300",
  grey: "text-muted-foreground",
  red: "text-destructive",
};
const SOFT = 0.45;
const strength = (tone: KinChartTone) => (tone.soft ? SOFT : 1);
// A generous glyph width for the axis text (`text-3xs`): symbols such as % and ₹ run wide.
const AXIS_CHAR_WIDTH = 6.4;
const AXIS_FONT_SIZE = 10;
const AXIS_TEXT = "fill-muted-foreground text-3xs tabular-nums";
const VALUE_TEXT = "fill-foreground text-3xs font-medium tabular-nums";

function useMeasuredWidth() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the plot's DOM width before paint and remeasures through a ResizeObserver
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.getBoundingClientRect().width));
    measure();
    return observeResize(element, measure);
  }, [element]);
  return [setElement, width] as const;
}

function Texts(props: { readonly texts: ReadonlyArray<KinChartText> }) {
  return props.texts.map((text) => (
    <text
      key={text.key}
      x={text.x}
      y={text.y}
      textAnchor={text.anchor}
      className={text.strong ? VALUE_TEXT : AXIS_TEXT}
    >
      {text.text}
    </text>
  ));
}

function Shapes(props: { readonly layout: KinChartLayout }) {
  const { layout } = props;
  return (
    <>
      {layout.rules.map((rule) =>
        rule.strong ? null : (
          <path
            key={rule.key}
            d={rule.path}
            fill="none"
            stroke="currentColor"
            className="text-border"
          />
        ),
      )}
      {layout.areas.map((area) => (
        <path
          key={area.key}
          d={area.path}
          fill="currentColor"
          fillOpacity={area.opacity * strength(area.tone)}
          className={COLORS[area.tone.color]}
        >
          {area.title === null ? null : <title>{area.title}</title>}
        </path>
      ))}
      {layout.bars.map((bar) => (
        <rect
          key={bar.key}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          rx={bar.radius}
          fill="currentColor"
          fillOpacity={strength(bar.tone)}
          className={COLORS[bar.tone.color]}
        >
          <title>{bar.title}</title>
        </rect>
      ))}
      {layout.rules.map((rule) =>
        rule.strong ? (
          <path
            key={rule.key}
            d={rule.path}
            fill="none"
            stroke="currentColor"
            strokeDasharray={rule.dashed ? "5 4" : undefined}
            className="text-muted-foreground"
          />
        ) : null,
      )}
      {layout.lines.map((line) => (
        <g key={line.key} className={COLORS[line.tone.color]} opacity={strength(line.tone)}>
          {line.path === "" ? null : (
            <path
              d={line.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={line.dashed ? "4 4" : undefined}
            />
          )}
          {line.dots.map((dot) => (
            <circle key={dot.key} cx={dot.x} cy={dot.y} r={dot.r} fill="currentColor">
              <title>{dot.title}</title>
            </circle>
          ))}
        </g>
      ))}
      <Texts texts={layout.texts} />
    </>
  );
}

function KinChartPlot(props: { readonly view: KinChartView; readonly width: number }) {
  const { view, width } = props;
  const layout = kinChartLayout(view, {
    width,
    charWidth: AXIS_CHAR_WIDTH,
    fontSize: AXIS_FONT_SIZE,
  });
  const scrolls = layout.axis.width + layout.width > width;
  return (
    <div
      role="img"
      aria-label={view.summary}
      className="flex max-w-full"
      style={{ height: layout.height }}
    >
      {layout.axis.width === 0 ? null : (
        <svg
          aria-hidden
          width={layout.axis.width}
          height={layout.height}
          viewBox={`0 0 ${layout.axis.width} ${layout.height}`}
          className="block shrink-0"
        >
          <Texts texts={layout.axis.texts} />
        </svg>
      )}
      <div
        // A chart wider than its card scrolls sideways; dates open on the latest.
        ref={(element) => {
          if (element !== null && layout.startAtEnd) element.scrollLeft = element.scrollWidth;
        }}
        tabIndex={scrolls ? 0 : undefined}
        className={cn("min-w-0", scrolls && "overflow-x-auto overscroll-x-contain")}
      >
        <svg
          aria-hidden
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block"
        >
          <Shapes layout={layout} />
        </svg>
      </div>
    </div>
  );
}

const MARKS: Record<KinChartMark, string> = {
  box: "size-2 rounded-xs bg-current",
  dot: "size-2 rounded-full bg-current",
  line: "h-0.5 w-3 rounded-full bg-current",
  dashed: "w-3 border-t-2 border-dashed border-current",
};

function KinChartLegend(props: { readonly view: KinChartView }) {
  const { view } = props;
  if (view.legend.length === 0) return null;
  return (
    <ul
      className={
        view.legendAsList
          ? "flex min-w-48 flex-1 flex-col gap-1"
          : "flex w-full flex-wrap gap-x-3 gap-y-1"
      }
    >
      {view.legend.map((item) => (
        <li key={item.key} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn("shrink-0", COLORS[item.tone.color], MARKS[item.mark])}
            style={{ opacity: strength(item.tone) }}
          />
          <span className="truncate text-xs text-muted-foreground">{item.name}</span>
          {item.detail === null ? null : (
            <span className="ml-auto pl-3 text-xs whitespace-nowrap text-foreground tabular-nums">
              {item.detail}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function KinChartFigure(props: { readonly view: KinChartView }) {
  const { view } = props;
  const [measure, width] = useMeasuredWidth();
  return (
    <div ref={measure} className="flex w-full flex-col gap-1">
      {view.scatter === null ? null : (
        <p className="text-3xs text-muted-foreground">{view.scatter.yName}</p>
      )}
      {width === 0 ? (
        <div style={{ height: kinChartHeight(0) }} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <KinChartPlot view={view} width={width} />
          <KinChartLegend view={view} />
        </div>
      )}
      {view.scatter === null ? null : (
        <p className="text-right text-3xs text-muted-foreground">{view.scatter.xName}</p>
      )}
    </div>
  );
}

function KinChartTable(props: { readonly view: KinChartView }) {
  const { view } = props;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs tabular-nums">
        <caption className="sr-only">{view.title}</caption>
        <thead>
          <tr className="border-b border-border">
            <td />
            {view.table.columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="py-1.5 pl-4 text-right font-medium whitespace-nowrap text-muted-foreground"
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.table.rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-0">
              <th scope="row" className="py-1.5 text-left font-normal text-foreground">
                {row.label}
              </th>
              {row.cells.map((cell, index) => (
                <td
                  key={view.table.columns[index]!.key}
                  className="py-1.5 pl-4 text-right whitespace-nowrap text-foreground"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A chart with its title, key and a table of the same numbers. It has no frame of its own, so it
 * sits in a chat card or on a page alike; build `view` with `kinChartView` from a chart spec.
 */
export function KinChart(props: { readonly view: KinChartView }) {
  const { view } = props;
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="flex flex-col gap-0.5">
        <p className="font-medium text-foreground">{view.title}</p>
        {view.caption === null ? null : (
          <p className="text-xs text-muted-foreground">{view.caption}</p>
        )}
      </figcaption>
      {asTable ? <KinChartTable view={view} /> : <KinChartFigure view={view} />}
      <div className="flex">
        <Button size="xs" variant="outline" onClick={() => setAsTable(!asTable)}>
          {asTable ? "Show chart" : "Show as table"}
        </Button>
      </div>
    </figure>
  );
}
