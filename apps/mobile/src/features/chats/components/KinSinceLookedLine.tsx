import { useIsFocused } from "@react-navigation/native";
import type { KinSinceLookedView } from "@t3tools/client-runtime/kin/kinSinceLooked";
import { useState, useSyncExternalStore } from "react";
import { AppState, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { useKinTextGrows } from "./kinTextGrows";

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
  const [fit, setFit] = useState<{
    readonly forText: string;
    readonly width: number;
    readonly index: number;
  }>({ forText: "", width: 0, index: 0 });
  if (view === null) return null;
  const activeIndex =
    grows || fit.forText !== view.text ? 0 : Math.min(fit.index, view.variants.length - 1);
  const shown = view.variants[activeIndex] ?? view.text;
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
        onLayout={(event) => {
          const width = Math.round(event.nativeEvent.layout.width);
          if (width <= 0) return;
          setFit((prev) => {
            if (prev.forText !== view.text) return { forText: view.text, width, index: 0 };
            if (prev.width === width) return prev;
            return { forText: view.text, width, index: prev.width === 0 ? prev.index : 0 };
          });
        }}
        onTextLayout={(event) => {
          if (grows || event.nativeEvent.lines.length <= 2) return;
          if (activeIndex >= view.variants.length - 1) return;
          const next = activeIndex + 1;
          setFit((prev) => {
            const base =
              prev.forText === view.text ? prev : { forText: view.text, width: 0, index: 0 };
            return base.index >= next ? base : { ...base, index: next };
          });
        }}
        className="min-w-0 flex-1 text-foreground-muted"
      >
        {shown}
      </Text>
    </Pressable>
  );
}
