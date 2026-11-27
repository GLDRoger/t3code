import { KIN_WEEKDAYS, type KinMonthCell } from "@t3tools/client-runtime/kin/kinDates";
import { Pressable, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";
import { useKinTextGrows } from "./kinTextGrows";

/** Cap cell text scaling so 7 columns stay readable without clipping digits or splitting letters. */
const GRID_MAX_FONT_SCALE = 1.3;

/** A month as whole weeks: every day can be tapped, and a day with something on it says so. */
export function KinMonthGrid(props: {
  readonly label: string;
  readonly weeks: ReadonlyArray<ReadonlyArray<KinMonthCell>>;
  readonly selected: string | null;
  readonly disabled?: boolean;
  readonly onPick: (day: string) => void;
  readonly onShift: (by: number) => void;
}) {
  const { width, fontScale } = useWindowDimensions();
  const grows = useKinTextGrows();
  const shortWeekdays = fontScale > 1.15 || width < 360;
  const singleLetterWeekdays = width < 320;
  const weekdayText = (weekday: string) =>
    singleLetterWeekdays ? weekday.slice(0, 1) : shortWeekdays ? weekday.slice(0, 2) : weekday;
  const previousButton = (
    <Button
      tone="secondary"
      size="compact"
      icon="chevron.left"
      label="Earlier"
      accessibilityLabel="Previous month"
      onPress={() => props.onShift(-1)}
    />
  );
  const nextButton = (
    <Button
      tone="secondary"
      size="compact"
      icon="chevron.right"
      label="Later"
      accessibilityLabel="Next month"
      onPress={() => props.onShift(1)}
    />
  );
  const monthLabel = (
    <Text
      textRole="body"
      accessibilityRole="header"
      accessibilityLiveRegion="polite"
      className={cn("font-t3-medium text-foreground", !grows && "min-w-0 shrink text-center")}
    >
      {props.label}
    </Text>
  );
  return (
    <View className="gap-2">
      {grows ? (
        <View className="gap-2 px-2">
          {monthLabel}
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            {previousButton}
            {nextButton}
          </View>
        </View>
      ) : (
        <View className="flex-row items-center justify-between gap-2 px-2">
          {previousButton}
          {monthLabel}
          {nextButton}
        </View>
      )}
      <View className="flex-row">
        {KIN_WEEKDAYS.map((weekday) => (
          <View key={weekday} className="flex-1 items-center py-1">
            <Text
              textRole="footnote"
              numberOfLines={1}
              maxFontSizeMultiplier={GRID_MAX_FONT_SCALE}
              accessibilityLabel={weekday}
              className="text-foreground-muted"
            >
              {weekdayText(weekday)}
            </Text>
          </View>
        ))}
      </View>
      {props.weeks.map((week) => (
        <View key={week[0]?.day} className="flex-row">
          {week.map((cell) => {
            const selected = cell.day === props.selected;
            const late = cell.rows.some((row) => row.late);
            return (
              <Pressable
                key={cell.day}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={[
                  cell.day,
                  cell.today ? "Today" : null,
                  cell.entries.length === 0
                    ? null
                    : cell.entries.length === 1
                      ? "1 entry"
                      : `${cell.entries.length} entries`,
                ]
                  .filter((part) => part !== null)
                  .join(", ")}
                disabled={props.disabled}
                onPress={() => props.onPick(cell.day)}
                className={cn(
                  "flex-1 items-center justify-center gap-0.5 py-0.5 active:opacity-60",
                  grows ? "min-h-13" : "h-12",
                )}
              >
                <View
                  className={cn(
                    "items-center justify-center rounded-full",
                    grows ? "h-10 w-10" : "h-9 w-9",
                    selected && "bg-prominent-action",
                    !selected && cell.today && "border-2 border-primary-text",
                  )}
                >
                  <Text
                    textRole="body"
                    numberOfLines={1}
                    maxFontSizeMultiplier={GRID_MAX_FONT_SCALE}
                    className={cn(
                      "tabular-nums",
                      selected
                        ? "font-t3-medium text-prominent-action-foreground"
                        : cell.today
                          ? "font-t3-bold text-primary-text"
                          : cell.inMonth
                            ? "text-foreground"
                            : "text-foreground-muted opacity-50",
                    )}
                  >
                    {cell.number}
                  </Text>
                </View>
                <View
                  className={cn(
                    "h-1 w-1 rounded-full",
                    cell.entries.length === 0
                      ? "bg-transparent"
                      : late
                        ? "bg-danger-foreground"
                        : "bg-foreground-muted",
                  )}
                />
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
