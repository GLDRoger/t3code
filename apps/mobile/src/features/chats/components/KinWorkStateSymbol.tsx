import type { KinRecordState } from "@t3tools/contracts";

import { View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";

const STATE: Record<KinRecordState, { readonly name: AppSymbolName; readonly tint: string }> = {
  open: { name: "circle", tint: "accent-icon-muted" },
  doing: { name: "ellipsis.circle", tint: "accent-primary" },
  waiting: { name: "clock", tint: "accent-warning-foreground" },
  done: { name: "checkmark.circle.fill", tint: "accent-icon-muted" },
  dropped: { name: "circle.dashed", tint: "accent-icon-muted" },
};

/** Where a task stands, at a glance. The words beside it say the same, so it is decoration. */
export function KinWorkStateSymbol(props: { readonly state: KinRecordState }) {
  const { name, tint } = STATE[props.state];
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SymbolView name={name} size={20} tintColorClassName={tint} type="monochrome" />
    </View>
  );
}
