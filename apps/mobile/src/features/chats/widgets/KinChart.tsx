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
import { memo, useState } from "react";
import { ScrollView, View } from "react-native";
import { Circle, G, Path, Rect, Svg, Text as SvgText } from "react-native-svg";
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
const ThemedRect = withUniwind(Rect);
const ThemedPath = withUniwind(Path);
const ThemedCircle = withUniwind(Circle);
const ThemedText = withUniwind(SvgText);

const COLORS: Record<KinChartTone["color"], { readonly color: string; readonly swatch: string }> = {
  accent: { color: "accent-primary", swatch: "bg-primary" },
  amber: { color: "accent-warning-foreground", swatch: "bg-warning-foreground" },
  green: { color: "accent-adaptive-emerald-600-400", swatch: "bg-adaptive-emerald-600-400" },
  purple: { color: "accent-adaptive-fuchsia-600-300", swatch: "bg-adaptive-fuchsia-600-300" },
  grey: { color: "accent-foreground-muted", swatch: "bg-foreground-muted" },
  red: { color: "accent-danger-foreground", swatch: "bg-danger-foreground" },
};
const SOFT = 0.45;
const strength = (tone: KinChartTone) => (tone.soft ? SOFT : 1);

function Texts(props: { readonly texts: ReadonlyArray<KinChartText> }) {
  return props.texts.map((text) => (
    <ThemedText
      key={text.key}
      x={text.x}
      y={text.y}
      textAnchor={text.anchor}
      fontSize={AXIS_FONT_SIZE}
      fontFamily={text.strong ? "DMSans-Medium" : "DMSans-Regular"}
      fill="currentColor"
      colorClassName={text.strong ? "accent-foreground" : "accent-foreground-muted"}
    >
      {text.text}
    </ThemedText>
  ));
}

function Shapes(props: { readonly layout: KinChartLayout }) {
  const { layout } = props;
  return (
    <>
      {layout.rules.map((rule) =>
        rule.strong ? null : (
          <ThemedPath
            key={rule.key}
            d={rule.path}
            fill="none"
            stroke="currentColor"
            colorClassName="accent-border"
            strokeWidth={1}
          />
        ),
      )}
      {layout.areas.map((area) => (
        <ThemedPath
          key={area.key}
          d={area.path}
          fill="currentColor"
          colorClassName={COLORS[area.tone.color].color}
          fillOpacity={area.opacity * strength(area.tone)}
        />
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
          colorClassName={COLORS[bar.tone.color].color}
          opacity={strength(bar.tone)}
        />
      ))}
      {layout.rules.map((rule) =>
        rule.strong ? (
          <ThemedPath
            key={rule.key}
            d={rule.path}
            fill="none"
            stroke="currentColor"
            colorClassName="accent-foreground-muted"
            strokeWidth={1}
            strokeDasharray={rule.dashed ? [5, 4] : undefined}
          />
        ) : null,
      )}
      {layout.lines.map((line) => (
        <G key={line.key} opacity={strength(line.tone)}>
          {line.path === "" ? null : (
            <ThemedPath
              d={line.path}
              fill="none"
              stroke="currentColor"
              colorClassName={COLORS[line.tone.color].color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={line.dashed ? [4, 4] : undefined}
            />
          )}
          {line.dots.map((dot) => (
            <ThemedCircle
              key={dot.key}
              cx={dot.x}
              cy={dot.y}
              r={dot.r}
              fill="currentColor"
              colorClassName={COLORS[line.tone.color].color}
            />
          ))}
        </G>
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
  const room = width - layout.axis.width;
  const plot = (
    <Svg width={layout.width} height={layout.height} accessible={false}>
      <Shapes layout={layout} />
    </Svg>
  );
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={view.summary}
      className="flex-row"
    >
      {layout.axis.width === 0 ? null : (
        <Svg width={layout.axis.width} height={layout.height} accessible={false}>
          <Texts texts={layout.axis.texts} />
        </Svg>
      )}
      {layout.width <= room ? (
        plot
      ) : (
        // A chart wider than its card scrolls sideways; dates open on the latest.
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          style={{ width: room }}
          contentOffset={{ x: layout.startAtEnd ? layout.width - room : 0, y: 0 }}
        >
          {plot}
        </ScrollView>
      )}
    </View>
  );
}

const MARKS: Record<Exclude<KinChartMark, "dashed">, string> = {
  box: "size-2 rounded-xs",
  dot: "size-2 rounded-full",
  line: "h-0.5 w-3 rounded-full",
};

function KinChartLegend(props: { readonly view: KinChartView }) {
  const { view } = props;
  if (view.legend.length === 0) return null;
  return (
    <View
      className={
        view.legendAsList ? "min-w-44 flex-1 gap-1" : "w-full flex-row flex-wrap gap-x-3 gap-y-1"
      }
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {view.legend.map((item) => (
        <View key={item.key} className="shrink flex-row items-center gap-1.5">
          {item.mark === "dashed" ? (
            <View className="flex-row gap-0.5" style={{ opacity: strength(item.tone) }}>
              <View className={cn("h-0.5 w-1.5", COLORS[item.tone.color].swatch)} />
              <View className={cn("h-0.5 w-1.5", COLORS[item.tone.color].swatch)} />
            </View>
          ) : (
            <View
              className={cn(MARKS[item.mark], COLORS[item.tone.color].swatch)}
              style={{ opacity: strength(item.tone) }}
            />
          )}
          <Text textRole="caption" numberOfLines={1} className="shrink text-foreground-muted">
            {item.name}
          </Text>
          {item.detail === null ? null : (
            <Text
              textRole="caption"
              numberOfLines={1}
              className="ml-auto pl-3 text-foreground"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {item.detail}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

function KinChartFigure(props: { readonly view: KinChartView; readonly width: number }) {
  const { view, width } = props;
  return (
    <View className="gap-1">
      {view.scatter === null ? null : (
        <Text textRole="caption" className="text-foreground-muted">
          {view.scatter.yName}
        </Text>
      )}
      {view.scatter === null ? (
        <View className="flex-row flex-wrap items-center gap-x-5 gap-y-2.5">
          <KinChartPlot view={view} width={width} />
          <KinChartLegend view={view} />
        </View>
      ) : (
        <>
          <KinChartPlot view={view} width={width} />
          <Text textRole="caption" className="text-right text-foreground-muted">
            {view.scatter.xName}
          </Text>
          <KinChartLegend view={view} />
        </>
      )}
    </View>
  );
}

function KinChartTable(props: { readonly view: KinChartView; readonly width: number }) {
  const { table } = props.view;
  const widths = table.columns.map((column, index) =>
    Math.ceil(
      Math.max(column.name.length, ...table.rows.map((row) => row.cells[index]!.length)) *
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
              .map((cell, index) => `${table.columns[index]!.name}: ${cell}`)
              .join(". ")}`}
            className="gap-0.5"
          >
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              {row.label}
            </Text>
            {row.cells.map((cell, index) => (
              <View key={table.columns[index]!.key} className="flex-row justify-between gap-3">
                <Text textRole="footnote" className="shrink text-foreground-muted">
                  {table.columns[index]!.name}
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
              key={column.key}
              textRole="caption"
              numberOfLines={1}
              className="text-right font-t3-medium text-foreground-muted"
              style={{ width: widths[index] }}
            >
              {column.name}
            </Text>
          ))}
        </View>
      )}
      {table.rows.map((row, rowIndex) => (
        <View
          key={row.key}
          accessible
          accessibilityLabel={`${row.label}. ${row.cells
            .map((cell, index) => (single ? cell : `${table.columns[index]!.name}: ${cell}`))
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
              key={table.columns[index]!.key}
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
        <KinChartFigure view={view} width={width} />
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
