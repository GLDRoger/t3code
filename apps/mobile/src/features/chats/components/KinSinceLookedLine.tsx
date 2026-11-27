import { useIsFocused } from "@react-navigation/native";
import type { KinSinceLookedView } from "@t3tools/client-runtime/kin/kinSinceLooked";
import { useSyncExternalStore } from "react";
import { AppState, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { kinLines, useKinTextGrows } from "./kinTextGrows";

const subscribeAppState = (onChange: () => void) => {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
};

const readAppActive = () => AppState.currentState === "active";

/** True only while this screen is focused and the app is in the foreground. */
export function useKinScreenVisible(): boolean {
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribeAppState, readAppActive, () => true);
  return focused && active;
}

/**
 * One quiet secondary-text button at the top of a task, list entry, doc or project saying what
 * changed since the person last looked. Absent when nothing qualifies.
 */
export function KinSinceLookedLine(props: {
  readonly view: KinSinceLookedView | null;
  readonly onPress: () => void;
  readonly className?: string;
}) {
  const grows = useKinTextGrows();
  const { view } = props;
  if (view === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={view.accessibilityLabel}
      hitSlop={8}
      onPress={props.onPress}
      className={cn(
        "min-h-11 flex-row items-start gap-1.5 py-1.5 active:opacity-60",
        props.className,
      )}
    >
      <View className="pt-0.5">
        <SymbolView
          name="clock"
          size={13}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </View>
      <Text
        textRole="footnote"
        numberOfLines={kinLines(2, grows)}
        className="min-w-0 flex-1 text-foreground-muted"
      >
        {view.text}
      </Text>
    </Pressable>
  );
}
