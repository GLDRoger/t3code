import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";

/** A row above the chats that opens a page of its own, such as Waiting on you. */
export function KinListBanner(props: {
  readonly title: string;
  readonly summary: string;
  readonly symbol: AppSymbolName;
  readonly tone?: "default" | "warning";
  readonly accessibilityLabel: string;
  readonly accessibilityHint: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      onPress={props.onPress}
      className="min-h-16 flex-row items-center gap-3 px-5 py-2.5 active:opacity-60"
    >
      <View className="size-10 items-center justify-center">
        <SymbolView
          name={props.symbol}
          size={22}
          tintColorClassName={
            props.tone === "warning" ? "accent-warning-foreground" : "accent-icon"
          }
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="body" className="font-t3-medium text-foreground">
          {props.title}
        </Text>
        <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
          {props.summary}
        </Text>
      </View>
      <SymbolView
        name="chevron.right"
        size={13}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    </Pressable>
  );
}
