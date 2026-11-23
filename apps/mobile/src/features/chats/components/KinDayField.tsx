import { kinDatesMonth, kinShiftMonth } from "@t3tools/client-runtime/kin/kinDates";
import {
  KIN_WORK_NEW_COPY,
  kinWorkDueChoices,
  kinWorkDueLabel,
} from "@t3tools/client-runtime/kin/kinWork";
import { useState } from "react";
import { View } from "react-native";

import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import { ListRow } from "../../../components/ui/ListRow";
import { KinMonthGrid } from "./KinMonthGrid";
import { useKinTextGrows } from "./kinTextGrows";

const NO_NAMES = new Map<string, string>();

/**
 * A day, or none: the row says which, and a tap unfolds the usual days and a month to pick any
 * other from. Days are calendar days in `zone`, the company's. Meant for inside a `ListSection`.
 */
export function KinDayField(props: {
  readonly label: string;
  readonly icon?: AppSymbolName;
  /** What the row says in place of the day, such as a due time a day can't show. */
  readonly detail?: string;
  readonly day: string | null;
  readonly zone: string | null;
  readonly now: Date;
  /** What no day is called; null when a day is required. */
  readonly none?: string | null;
  readonly hint?: string | null;
  readonly disabled?: boolean;
  readonly onPick: (day: string | null) => void;
}) {
  const { day, now, zone } = props;
  const none = props.none === undefined ? KIN_WORK_NEW_COPY.noDue : props.none;
  const [open, setOpen] = useState(false);
  const grows = useKinTextGrows();
  const choices = kinWorkDueChoices(now, zone);
  const [month, setMonth] = useState((day ?? choices[0]!.day).slice(0, 7));
  const grid = kinDatesMonth(
    month,
    [],
    { people: NO_NAMES, agents: NO_NAMES, me: null, zone },
    now,
  );
  const pick = (next: string | null) => {
    props.onPick(next);
    setOpen(false);
  };
  return (
    <>
      <ListRow
        label={props.label}
        {...(props.icon === undefined ? {} : { icon: props.icon })}
        detail={
          props.detail ?? (day === null ? (none ?? undefined) : kinWorkDueLabel(day, now, zone))
        }
        disabled={props.disabled}
        onPress={() => setOpen(!open)}
      />
      {props.hint == null ? null : (
        <Text textRole="footnote" className="bg-grouped-card px-4 pb-3 text-foreground-muted">
          {props.hint}
        </Text>
      )}
      {!open ? null : (
        <View className="gap-3 bg-grouped-card px-2 py-3">
          <View className="flex-row flex-wrap gap-2 px-2">
            {none === null ? null : (
              <Chip
                wrap={grows}
                label={none}
                selected={day === null}
                disabled={props.disabled}
                onPress={() => pick(null)}
              />
            )}
            {choices.map((choice) => (
              <Chip
                wrap={grows}
                key={choice.day}
                label={choice.label}
                selected={day === choice.day}
                disabled={props.disabled}
                onPress={() => pick(choice.day)}
              />
            ))}
          </View>
          <KinMonthGrid
            label={grid.label}
            weeks={grid.weeks}
            selected={day}
            disabled={props.disabled}
            onPick={pick}
            onShift={(by) => setMonth(kinShiftMonth(month, by))}
          />
        </View>
      )}
    </>
  );
}
