import { KIN_WEEKDAYS, type KinMonthCell } from "@t3tools/client-runtime/kin/kinDates";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";

/** A month as whole weeks: every day can be tapped, and a day with something on it says so. */
export function KinMonthGrid(props: {
  readonly label: string;
  readonly weeks: ReadonlyArray<ReadonlyArray<KinMonthCell>>;
  readonly selected: string | null;
  readonly disabled?: boolean;
  readonly onPick: (day: string) => void;
  readonly onShift: (by: number) => void;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-2 px-2">
        <Button
          tone="secondary"
          size="compact"
          icon="chevron.left"
          label="Earlier"
          accessibilityLabel="Previous month"
          onPress={() => props.onShift(-1)}
        />
        <Text
          textRole="body"
          accessibilityRole="header"
          accessibilityLiveRegion="polite"
          className="font-t3-medium text-foreground"
        >
          {props.label}
        </Text>
        <Button
          tone="secondary"
          size="compact"
          icon="chevron.right"
          label="Later"
          accessibilityLabel="Next month"
          onPress={() => props.onShift(1)}
        />
      </View>
      <View className="flex-row">
        {KIN_WEEKDAYS.map((weekday) => (
          <View key={weekday} className="flex-1 items-center py-1">
            <Text textRole="footnote" className="text-foreground-muted">
              {weekday}
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
                  cell.rows.length === 0
                    ? null
                    : cell.rows.length === 1
                      ? "1 entry"
                      : `${cell.rows.length} entries`,
                ]
                  .filter((part) => part !== null)
                  .join(", ")}
                disabled={props.disabled}
                onPress={() => props.onPick(cell.day)}
                className="h-12 flex-1 items-center justify-center active:opacity-60"
              >
                <View
                  className={cn(
                    "h-9 w-9 items-center justify-center rounded-full",
                    selected && "bg-prominent-action",
                    !selected && cell.today && "border border-border",
                  )}
                >
                  <Text
                    textRole="body"
                    className={cn(
                      "tabular-nums",
                      selected
                        ? "font-t3-medium text-prominent-action-foreground"
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
                    cell.rows.length === 0
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
