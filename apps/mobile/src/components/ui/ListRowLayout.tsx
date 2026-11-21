import type { ReactNode } from "react";
import { Platform, useWindowDimensions, View } from "react-native";

import { cn } from "../../lib/cn";
import { AppText } from "./AppText";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

export interface ListRowContentProps {
  readonly icon?: AppSymbolName;
  /** Drawn in the icon column for marks a single symbol can't express. */
  readonly leading?: ReactNode;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  /** Rich secondary content under the description, such as scores with emphasized values. */
  readonly meta?: ReactNode;
  readonly disabled?: boolean;
  /** Where a trailing `detail` too long for the row is cut; a name reads best cut at its end. */
  readonly detailEllipsizeMode?: "middle" | "tail";
  /** Above the default text size, shrinks the label rather than break a word across lines. */
  readonly labelWholeWords?: boolean;
}

export function ListRowLayout({
  icon,
  leading,
  label,
  description,
  detail,
  meta,
  disabled,
  detailEllipsizeMode = "middle",
  labelWholeWords,
  accessory,
  tone = "default",
}: ListRowContentProps & { readonly accessory?: ReactNode; readonly tone?: "default" | "danger" }) {
  const { fontScale } = useWindowDimensions();
  const stackDetail = fontScale >= 1.5;
  // One line per word: a word wider than the row shrinks to fit instead of splitting.
  const wholeWords =
    labelWholeWords === true && fontScale > 1
      ? { numberOfLines: label.trim().split(/\s+/).length, adjustsFontSizeToFit: true }
      : {};
  return (
    <View
      className={cn(
        "min-h-14 flex-row items-center gap-3 px-4 py-3",
        description && "min-h-18",
        disabled && "opacity-45",
      )}
    >
      {icon ? (
        <View className="size-6 items-center justify-center">
          <SymbolView
            name={icon}
            size={Platform.OS === "android" ? 24 : 22}
            tintColorClassName={tone === "danger" ? "accent-danger-foreground" : "accent-icon"}
            type="monochrome"
            weight="regular"
          />
        </View>
      ) : leading ? (
        <View className="size-6 items-center justify-center">{leading}</View>
      ) : null}
      <View className="min-w-0 flex-1 gap-1">
        <AppText
          textRole="body"
          className={tone === "danger" ? "text-danger-foreground" : "text-foreground"}
          {...wholeWords}
        >
          {label}
        </AppText>
        {description ? (
          <AppText textRole="footnote" className="text-foreground-muted">
            {description}
          </AppText>
        ) : null}
        {meta}
        {detail && stackDetail ? (
          <AppText textRole="footnote" className="text-foreground-muted">
            {detail}
          </AppText>
        ) : null}
      </View>
      {detail && !stackDetail ? (
        <AppText
          textRole="footnote"
          className="max-w-[40%] shrink text-right text-foreground-muted"
          numberOfLines={1}
          ellipsizeMode={detailEllipsizeMode}
        >
          {detail}
        </AppText>
      ) : null}
      {accessory}
    </View>
  );
}
