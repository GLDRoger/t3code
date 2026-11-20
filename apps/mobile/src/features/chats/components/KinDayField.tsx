import { kinDatesMonth, kinShiftMonth } from "@t3tools/client-runtime/kin/kinDates";
import {
  KIN_WORK_NEW_COPY,
  kinWorkDayOf,
  kinWorkDueChoices,
  kinWorkDueLabel,
  type KinWorkNames,
} from "@t3tools/client-runtime/kin/kinWork";
import { useState } from "react";
import { View } from "react-native";

import { Chip } from "../../../components/ui/Chip";
import { ListRow } from "../../../components/ui/ListRow";
import { KinMonthGrid } from "./KinMonthGrid";

/**
 * A day, or none: the row says which, and a tap unfolds the usual days and a month to pick any
 * other from. Meant for inside a `ListSection`.
 */
export function KinDayField(props: {
  readonly label: string;
  readonly day: string | null;
  readonly names: KinWorkNames;
  readonly now: Date;
  readonly disabled?: boolean;
  readonly onPick: (day: string | null) => void;
}) {
  const { day, now } = props;
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState((day ?? kinWorkDayOf(now)).slice(0, 7));
  const grid = kinDatesMonth(month, [], props.names, now);
  const pick = (next: string | null) => {
    props.onPick(next);
    setOpen(false);
  };
  return (
    <>
      <ListRow
        label={props.label}
        detail={day === null ? KIN_WORK_NEW_COPY.noDue : kinWorkDueLabel(day, now)}
        disabled={props.disabled}
        onPress={() => setOpen(!open)}
      />
      {!open ? null : (
        <View className="gap-3 bg-grouped-card px-2 py-3">
          <View className="flex-row flex-wrap gap-2 px-2">
            <Chip
              label={KIN_WORK_NEW_COPY.noDue}
              selected={day === null}
              disabled={props.disabled}
              onPress={() => pick(null)}
            />
            {kinWorkDueChoices(now).map((choice) => (
              <Chip
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
