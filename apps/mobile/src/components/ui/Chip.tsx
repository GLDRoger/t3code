import { GlassView } from "expo-glass-effect";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { withUniwind } from "uniwind";

import { cn } from "../../lib/cn";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { AppText } from "./AppText";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

const ChipGlass = withUniwind(GlassView, {
  style: { fromClassName: "className" },
  tintColor: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
});

export type ChipTone = "default" | "success" | "warning" | "danger" | "secondary";

const CHIP_TONE_CLASSES: Record<
  Exclude<ChipTone, "default">,
  { readonly bg: string; readonly text: string; readonly icon: string }
> = {
  success: {
    bg: "bg-adaptive-emerald-500-a12-a16",
    text: "text-adaptive-emerald-700-300",
    icon: "accent-adaptive-emerald-700-300",
  },
  warning: {
    bg: "bg-warning",
    text: "text-warning-foreground",
    icon: "accent-warning-foreground",
  },
  danger: {
    bg: "bg-danger",
    text: "text-danger-foreground",
    icon: "accent-danger-foreground",
  },
  secondary: {
    bg: "bg-adaptive-neutral-500-a10-a16",
    text: "text-adaptive-zinc-600-300",
    icon: "accent-adaptive-zinc-600-300",
  },
};

export function Chip(props: {
  readonly label: string;
  readonly selected?: boolean;
  readonly tone?: ChipTone;
  readonly icon?: AppSymbolName;
  /** Drawn before the label in place of an icon, such as a person's picture. */
  readonly leading?: ReactNode;
  readonly trailingIcon?: AppSymbolName;
  readonly size?: "small" | "default";
  readonly glass?: boolean;
  readonly colorScheme?: "light" | "dark";
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  /** Lets a long label wrap instead of cutting at the chip's width, as at large text. */
  readonly wrap?: boolean;
}) {
  const small = props.size === "small";
  const tone = props.tone && props.tone !== "default" ? CHIP_TONE_CLASSES[props.tone] : null;
  const layout = cn(
    "flex-row items-center gap-1.5 rounded-2xl px-3",
    small ? "py-1" : "min-h-8 py-1.5",
  );
  const iconColor = props.selected
    ? "accent-primary-foreground"
    : (tone?.icon ?? "accent-icon-muted");
  const content = (
    <>
      {props.leading}
      {props.icon ? (
        <SymbolView name={props.icon} size={15} tintColorClassName={iconColor} />
      ) : null}
      <AppText
        textRole={small ? "caption" : "footnote"}
        numberOfLines={small || props.wrap ? undefined : 1}
        className={cn(
          "shrink",
          !small && !props.wrap && "max-w-[180px]",
          (!small || tone !== null) && "font-t3-medium",
          props.selected ? "text-primary-foreground" : (tone?.text ?? "text-foreground-muted"),
        )}
      >
        {props.label}
      </AppText>
      {props.trailingIcon ? (
        <SymbolView name={props.trailingIcon} size={11} tintColorClassName={iconColor} />
      ) : null}
    </>
  );
  const body =
    props.glass && NATIVE_LIQUID_GLASS_SUPPORTED ? (
      <ChipGlass
        isInteractive
        colorScheme={props.colorScheme}
        tintColorClassName={props.selected ? "accent-primary" : undefined}
        className={layout}
      >
        {content}
      </ChipGlass>
    ) : (
      <View
        className={cn(
          layout,
          props.selected ? "bg-primary" : (tone?.bg ?? (small ? "bg-grouped-card" : "bg-subtle")),
        )}
      >
        {content}
      </View>
    );
  return props.onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ selected: props.selected, disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={6}
      className={props.disabled ? "opacity-45" : "active:opacity-70"}
    >
      {body}
    </Pressable>
  ) : (
    body
  );
}
