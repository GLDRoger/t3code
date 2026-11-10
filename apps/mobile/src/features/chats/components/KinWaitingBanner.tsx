import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import type { KinWaitingBannerView } from "@t3tools/client-runtime/kin/kinScreenState";

/** What waits on the viewer, as the list's first row. Not rendered when nothing waits. */
export function KinWaitingBanner(props: {
  readonly view: KinWaitingBannerView;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.view.accessibilityLabel}
      accessibilityHint="Opens Waiting on you"
      onPress={props.onPress}
      className="min-h-16 flex-row items-center gap-3 px-5 py-2.5 active:opacity-60"
    >
      <View className="size-10 items-center justify-center">
        <SymbolView
          name="exclamationmark.shield"
          size={22}
          tintColorClassName="accent-warning-foreground"
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="body" className="font-t3-medium text-foreground">
          Waiting on you
        </Text>
        <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
          {props.view.summary}
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
