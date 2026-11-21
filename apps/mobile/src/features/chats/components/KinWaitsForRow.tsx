import type { KinWaitingRowView } from "@t3tools/client-runtime/kin/kinScreenState";
import { useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { RowPressable } from "../../../components/ui/RowPressable";

/**
 * Something that waits on someone else, to look at only: a tap opens what it asks, its answers
 * as words and whose it is. It has no answer buttons; the host refuses any answer from here.
 */
export function KinWaitsForRow(props: {
  readonly row: KinWaitingRowView;
  readonly detail: ReadonlyArray<string>;
  readonly when: string;
}) {
  const { row } = props;
  const [open, setOpen] = useState(false);
  const label = `${row.label} · ${row.chatTitle}`;
  return (
    <View className="bg-grouped-card">
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={[label, row.text, row.waitsFor].filter(Boolean).join(", ")}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="bg-grouped-card"
      >
        <ListRowLayout
          icon="eye"
          label={label}
          {...(row.text === null ? {} : { description: row.text })}
          detail={props.when}
          meta={
            row.waitsFor === null ? undefined : (
              <Text textRole="footnote" className="text-foreground-muted">
                {row.waitsFor}
              </Text>
            )
          }
          accessory={
            <SymbolView
              name={open ? "chevron.up" : "chevron.down"}
              size={13}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          }
        />
      </RowPressable>
      {open ? (
        <View className="gap-1 px-4 pb-3">
          {props.detail.map((line) => (
            <Text key={line} textRole="footnote" className="text-foreground-secondary">
              {line}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
