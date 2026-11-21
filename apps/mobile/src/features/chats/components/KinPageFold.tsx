import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { RowPressable } from "../../../components/ui/RowPressable";

/** A page's folded part: one heading row with its count, opening whole sections under it. */
export function KinPageFold(props: {
  readonly title: string;
  readonly summary: string | null;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-5">
      <ListSection>
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={[props.title, props.summary]
            .filter((part) => part !== null)
            .join(". ")}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          className="bg-grouped-card"
        >
          <ListRowLayout
            label={props.title}
            {...(props.summary === null ? {} : { description: props.summary })}
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
      </ListSection>
      {open ? props.children : null}
    </View>
  );
}
