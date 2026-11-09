import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { RelativeTime } from "../../../components/RelativeTime";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { RowPressable } from "../../../components/ui/RowPressable";
import { cn } from "../../../lib/cn";
import type { KinChatRowView } from "../state/kinScreenState";
import { KinAvatar } from "./KinAvatar";

const ROW_CLASS_NAME = "min-h-[72px] flex-row items-center gap-3 px-4 py-3";

/** One chat. Unread shows as a number and a bolder title, never as a highlight (DESIGN 8.1). */
export function KinChatRow(props: {
  readonly view: KinChatRowView;
  readonly accessibilityLabel: string;
  /** Unset in static previews. */
  readonly onPress?: () => void;
}) {
  const { view } = props;
  const unread = view.unread > 0;
  const content = (
    <>
      <KinAvatar kind={view.avatar.kind} initials={view.avatar.initials} />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text
            textRole="body"
            numberOfLines={1}
            className={cn(
              "min-w-0 flex-1 text-foreground",
              unread ? "font-t3-bold" : "font-t3-medium",
            )}
          >
            {view.title}
          </Text>
          {view.sentAt === null ? null : (
            <Text textRole="caption" className="text-foreground-muted">
              <RelativeTime timestamp={view.sentAt} />
            </Text>
          )}
        </View>
        <View className="flex-row items-center gap-2">
          <Text
            textRole="footnote"
            numberOfLines={2}
            className={cn("min-w-0 flex-1", unread ? "text-foreground" : "text-foreground-muted")}
          >
            {view.author === null ? null : (
              <Text className="font-t3-medium">{`${view.author}: `}</Text>
            )}
            {view.preview}
          </Text>
          {unread ? (
            <View className="min-w-5 items-center rounded-full bg-subtle-strong px-1.5 py-0.5">
              <Text textRole="caption" className="font-t3-bold text-foreground">
                {view.unread}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </>
  );
  if (props.onPress === undefined) {
    return (
      <View accessible accessibilityLabel={props.accessibilityLabel} className={ROW_CLASS_NAME}>
        {content}
      </View>
    );
  }
  return (
    <KinPressableRow
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint="Opens the chat"
      onPress={props.onPress}
    >
      {content}
    </KinPressableRow>
  );
}

function KinPressableRow(props: {
  readonly accessibilityLabel: string;
  readonly accessibilityHint: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const ripple = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      onPress={props.onPress}
      android_ripple={{ color: ripple.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className={ROW_CLASS_NAME}
    >
      {props.children}
    </RowPressable>
  );
}

/** "Ask anything. It goes to the right team." In phase 1 it opens the lead's direct chat. */
export function KinAskRow(props: { readonly onPress?: () => void }) {
  const content = (
    <View className="flex-row items-center gap-3 rounded-full border border-border px-4 py-3">
      <SymbolView
        name="bubble.left"
        size={16}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-muted">
        Ask anything. It goes to the right team.
      </Text>
    </View>
  );
  return (
    <View className="px-4 pb-6 pt-4">
      {props.onPress === undefined ? (
        <View accessible accessibilityLabel="Ask anything. It goes to the right team.">
          {content}
        </View>
      ) : (
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel="Ask anything. It goes to the right team."
          accessibilityHint="Opens your chat with the lead"
          onPress={props.onPress}
          className="rounded-full"
        >
          {content}
        </RowPressable>
      )}
    </View>
  );
}

/** Six static placeholder rows while the first inbox loads. No shimmer, so nothing repaints. */
export function KinChatRowSkeletons() {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel="Loading chats">
      {Array.from({ length: 6 }, (_, index) => (
        <View
          key={index}
          importantForAccessibility="no-hide-descendants"
          className={ROW_CLASS_NAME}
        >
          <View
            className={cn(
              "size-10 bg-subtle-strong",
              index === 0 ? "rounded-[12px]" : "rounded-full",
            )}
          />
          <View className="flex-1 gap-2">
            <View
              className="h-3.5 rounded bg-subtle-strong"
              style={{ width: index % 2 ? "45%" : "60%" }}
            />
            <View
              className="h-3 rounded bg-subtle-strong"
              style={{ width: index % 3 ? "80%" : "70%" }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}
