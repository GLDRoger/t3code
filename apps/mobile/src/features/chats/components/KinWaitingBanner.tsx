import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { MOBILE_SHAPE } from "../../../lib/designTokens";
import type { KinWaitingBannerView } from "../state/kinScreenState";

/** The one highlighted thing in the chat list. Not rendered when nothing waits. */
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
      className="min-h-16 flex-row items-center gap-3 border-continuous bg-primary px-4 py-3 active:opacity-80"
      style={{
        borderRadius:
          Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios,
      }}
    >
      <View className="min-w-0 flex-1">
        <Text textRole="body" className="font-t3-bold text-primary-foreground">
          Waiting on you
        </Text>
        <Text textRole="footnote" numberOfLines={2} className="mt-0.5 text-primary-foreground">
          {props.view.summary}
        </Text>
      </View>
      <View className="min-w-7 items-center rounded-full bg-primary-foreground px-2 py-0.5">
        <Text textRole="footnote" className="font-t3-bold text-primary">
          {props.view.count}
        </Text>
      </View>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-primary-foreground"
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}
