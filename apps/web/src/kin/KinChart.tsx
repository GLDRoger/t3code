import {
  kinChartHeight,
  kinChartLayout,
  type KinChartTone,
  type KinChartView,
} from "@t3tools/client-runtime/kin/kinChart";
import { useLayoutEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";

// Series take the product's own colours, so a chart follows the theme like the rest of the app.
const TONES: Record<KinChartTone, string> = {
  one: "text-primary",
  two: "text-warning",
  three: "text-foreground/50",
  four: "text-primary/45",
  previous: "text-muted-foreground/55",
};
// A generous glyph width for the axis text (`text-3xs`): symbols such as % and ₹ run wide.
const AXIS_CHAR_WIDTH = 6.4;
const AXIS_TEXT = "fill-muted-foreground text-3xs tabular-nums";

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

function KinChartPlot(props: { readonly view: KinChartView }) {
  const { view } = props;
  const [measure, width] = useMeasuredWidth();
  const height = kinChartHeight(width);
  const layout =
    width === 0 ? null : kinChartLayout(view, { width, height, charWidth: AXIS_CHAR_WIDTH });
  return (
    <div ref={measure} className="w-full" style={{ height }}>
      {layout === null ? null : (
        <svg
          role="img"
          aria-label={view.summary}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block"
        >
          {layout.yTicks.map((tick) => (
            <g key={tick.value}>
              <line
                x1={layout.plot.left}
                x2={layout.plot.right}
                y1={tick.y}
                y2={tick.y}
                stroke="currentColor"
                className="text-border"
              />
              <text
                x={layout.plot.left - 6}
                y={tick.y}
                textAnchor="end"
                dominantBaseline="middle"
                className={AXIS_TEXT}
              >
                {tick.label}
              </text>
            </g>
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
              className={TONES[bar.tone]}
            >
              <title>{bar.title}</title>
            </rect>
          ))}
          {layout.zeroY === null ? null : (
            <line
              x1={layout.plot.left}
              x2={layout.plot.right}
              y1={layout.zeroY}
              y2={layout.zeroY}
              stroke="currentColor"
              className="text-muted-foreground"
            />
          )}
          {layout.lines.map((line) => (
            <g key={line.key} className={TONES[line.tone]}>
              <path
                d={line.path}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={line.tone === "previous" ? "4 4" : undefined}
              />
              {line.dots.map((dot) => (
                <circle key={dot.key} cx={dot.x} cy={dot.y} r={2.5} fill="currentColor">
                  <title>{dot.title}</title>
                </circle>
              ))}
            </g>
          ))}
          {layout.xTicks.map((tick) => (
            <text
              key={tick.key}
              x={tick.x}
              y={height - 5}
              textAnchor={tick.anchor}
              className={AXIS_TEXT}
            >
              {tick.label}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

function KinChartLegend(props: { readonly view: KinChartView }) {
  const { view } = props;
  if (view.legend.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {view.legend.map((item) => (
        <li key={item.key} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "shrink-0",
              TONES[item.tone],
              view.kind !== "line"
                ? "size-2 rounded-xs bg-current"
                : item.tone === "previous"
                  ? "w-3 border-t-2 border-dashed border-current"
                  : "h-0.5 w-3 rounded-full bg-current",
            )}
          />
          <span className="truncate text-xs text-muted-foreground">{item.name}</span>
        </li>
      ))}
    </ul>
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
                key={column}
                scope="col"
                className="py-1.5 pl-4 text-right font-medium whitespace-nowrap text-muted-foreground"
              >
                {column}
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
                  key={view.table.columns[index]}
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
      {asTable ? (
        <KinChartTable view={view} />
      ) : (
        <>
          <KinChartPlot view={view} />
          <KinChartLegend view={view} />
        </>
      )}
      <div className="flex">
        <Button size="xs" variant="outline" onClick={() => setAsTable(!asTable)}>
          {asTable ? "Show chart" : "Show as table"}
        </Button>
      </div>
    </figure>
  );
}
