import {
  kinChartHeight,
  kinChartLayout,
  type KinChartTone,
  type KinChartView,
} from "@t3tools/client-runtime/kin/kinChart";
import { memo, useState } from "react";
import { View } from "react-native";
import { Circle, G, Line, Path, Rect, Svg, Text as SvgText } from "react-native-svg";
import { withUniwind } from "uniwind";

import { AppText as Text } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import { cn } from "../../../lib/cn";

const AXIS_FONT_SIZE = 11;
// A generous glyph width for DM Sans at the axis size: symbols such as % and ₹ run wide.
const AXIS_CHAR_WIDTH = 6.9;
// A value column in the table: the widest value at the footnote size, plus its gap.
const CELL_CHAR_WIDTH = 7.6;
const CELL_GAP = 16;
const LABEL_MIN_WIDTH = 84;

// `colorClassName` sets each shape's `color`, which `currentColor` draws with, so a chart follows
// light, dark and custom themes like any other themed view.
const ThemedLine = withUniwind(Line);
const ThemedRect = withUniwind(Rect);
const ThemedPath = withUniwind(Path);
const ThemedCircle = withUniwind(Circle);
const ThemedText = withUniwind(SvgText);

const TONES: Record<
  KinChartTone,
  { readonly color: string; readonly swatch: string; readonly opacity: number }
> = {
  one: { color: "accent-primary", swatch: "bg-primary", opacity: 1 },
  two: { color: "accent-warning-foreground", swatch: "bg-warning-foreground", opacity: 1 },
  three: { color: "accent-foreground", swatch: "bg-foreground", opacity: 0.5 },
  four: { color: "accent-primary", swatch: "bg-primary", opacity: 0.45 },
  previous: { color: "accent-foreground-muted", swatch: "bg-foreground-muted", opacity: 0.55 },
};

function KinChartPlot(props: { readonly view: KinChartView; readonly width: number }) {
  const { view, width } = props;
  const height = kinChartHeight(width);
  const layout = kinChartLayout(view, { width, height, charWidth: AXIS_CHAR_WIDTH });
  const axisText = {
    fontSize: AXIS_FONT_SIZE,
    fontFamily: "DMSans-Regular",
    fill: "currentColor",
    colorClassName: "accent-foreground-muted",
  };
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={view.summary}>
      <Svg width={width} height={height} accessible={false}>
        {layout.yTicks.map((tick) => (
          <G key={tick.value}>
            <ThemedLine
              x1={layout.plot.left}
              x2={layout.plot.right}
              y1={tick.y}
              y2={tick.y}
              stroke="currentColor"
              colorClassName="accent-border"
              strokeWidth={1}
            />
            <ThemedText
              {...axisText}
              x={layout.plot.left - 6}
              y={tick.y + AXIS_FONT_SIZE / 3}
              textAnchor="end"
            >
              {tick.label}
            </ThemedText>
          </G>
        ))}
        {layout.bars.map((bar) => (
          <ThemedRect
            key={bar.key}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            rx={bar.radius}
            fill="currentColor"
            colorClassName={TONES[bar.tone].color}
            opacity={TONES[bar.tone].opacity}
          />
        ))}
        {layout.zeroY === null ? null : (
          <ThemedLine
            x1={layout.plot.left}
            x2={layout.plot.right}
            y1={layout.zeroY}
            y2={layout.zeroY}
            stroke="currentColor"
            colorClassName="accent-foreground-muted"
            strokeWidth={1}
          />
        )}
        {layout.lines.map((line) => (
          <G key={line.key} opacity={TONES[line.tone].opacity}>
            <ThemedPath
              d={line.path}
              fill="none"
              stroke="currentColor"
              colorClassName={TONES[line.tone].color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={line.tone === "previous" ? [4, 4] : undefined}
            />
            {line.dots.map((dot) => (
              <ThemedCircle
                key={dot.key}
                cx={dot.x}
                cy={dot.y}
                r={2.5}
                fill="currentColor"
                colorClassName={TONES[line.tone].color}
              />
            ))}
          </G>
        ))}
        {layout.xTicks.map((tick) => (
          <ThemedText
            {...axisText}
            key={tick.key}
            x={tick.x}
            y={height - 5}
            textAnchor={tick.anchor}
          >
            {tick.label}
          </ThemedText>
        ))}
      </Svg>
    </View>
  );
}

function KinChartLegend(props: { readonly view: KinChartView }) {
  const { view } = props;
  if (view.legend.length === 0) return null;
  return (
    <View
      className="flex-row flex-wrap gap-x-3 gap-y-1"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {view.legend.map((item) => (
        <View key={item.key} className="shrink flex-row items-center gap-1.5">
          <View
            className={cn(
              view.kind === "line" ? "h-0.5 w-3 rounded-full" : "size-2 rounded-xs",
              TONES[item.tone].swatch,
            )}
            style={{ opacity: TONES[item.tone].opacity }}
          />
          <Text textRole="caption" numberOfLines={1} className="shrink text-foreground-muted">
            {item.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

function KinChartTable(props: { readonly view: KinChartView; readonly width: number }) {
  const { table } = props.view;
  const widths = table.columns.map((column, index) =>
    Math.ceil(
      Math.max(column.length, ...table.rows.map((row) => row.cells[index]!.length)) *
        CELL_CHAR_WIDTH +
        CELL_GAP,
    ),
  );
  // Columns that don't fit a phone are read down the screen instead of scrolled sideways.
  const sideBySide = LABEL_MIN_WIDTH + widths.reduce((sum, width) => sum + width, 0) <= props.width;
  const single = table.columns.length === 1;

  if (!sideBySide)
    return (
      <View className="gap-2">
        {table.rows.map((row) => (
          <View
            key={row.key}
            accessible
            accessibilityLabel={`${row.label}. ${row.cells
              .map((cell, index) => `${table.columns[index]}: ${cell}`)
              .join(". ")}`}
            className="gap-0.5"
          >
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              {row.label}
            </Text>
            {row.cells.map((cell, index) => (
              <View key={table.columns[index]} className="flex-row justify-between gap-3">
                <Text textRole="footnote" className="shrink text-foreground-muted">
                  {table.columns[index]}
                </Text>
                <Text textRole="footnote" className="text-foreground">
                  {cell}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    );

  return (
    <View>
      {single ? null : (
        <View
          className="flex-row border-b border-border pb-1.5"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          <View className="flex-1" />
          {table.columns.map((column, index) => (
            <Text
              key={column}
              textRole="caption"
              numberOfLines={1}
              className="text-right font-t3-medium text-foreground-muted"
              style={{ width: widths[index] }}
            >
              {column}
            </Text>
          ))}
        </View>
      )}
      {table.rows.map((row, rowIndex) => (
        <View
          key={row.key}
          accessible
          accessibilityLabel={`${row.label}. ${row.cells
            .map((cell, index) => (single ? cell : `${table.columns[index]}: ${cell}`))
            .join(". ")}`}
          className={cn(
            "flex-row items-baseline py-1.5",
            rowIndex > 0 && "border-t border-border-subtle",
          )}
        >
          <Text textRole="footnote" className="flex-1 text-foreground">
            {row.label}
          </Text>
          {row.cells.map((cell, index) => (
            <Text
              key={table.columns[index]}
              textRole="footnote"
              className="text-right text-foreground"
              style={{ width: widths[index], fontVariant: ["tabular-nums"] }}
            >
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * A chart with its title, key and a table of the same numbers. It has no frame of its own, so it
 * sits in a chat card or on a screen alike; build `view` with `kinChartView` from a chart spec.
 */
export const KinChart = memo(function KinChart(props: { readonly view: KinChartView }) {
  const { view } = props;
  const [asTable, setAsTable] = useState(false);
  const [width, setWidth] = useState(0);
  return (
    <View
      className="gap-2.5"
      onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}
    >
      <View className="gap-0.5">
        <Text
          textRole="headline"
          accessibilityRole="header"
          className="font-t3-bold text-foreground"
        >
          {view.title}
        </Text>
        {view.caption === null ? null : (
          <Text textRole="footnote" className="text-foreground-secondary">
            {view.caption}
          </Text>
        )}
      </View>
      {width === 0 ? (
        <View style={{ height: kinChartHeight(0) }} />
      ) : asTable ? (
        <KinChartTable view={view} width={width} />
      ) : (
        <>
          <KinChartPlot view={view} width={width} />
          <KinChartLegend view={view} />
        </>
      )}
      <View className="flex-row">
        <Chip
          size="small"
          label={asTable ? "Show chart" : "Show as table"}
          onPress={() => setAsTable(!asTable)}
        />
      </View>
    </View>
  );
});
