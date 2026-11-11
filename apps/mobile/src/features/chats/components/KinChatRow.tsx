import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { RelativeTime } from "../../../components/RelativeTime";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { RowPressable } from "../../../components/ui/RowPressable";
import { cn } from "../../../lib/cn";
import { KIN_RETIRED_LABEL } from "@t3tools/client-runtime/kin/kinAgentRetire";
import type { KinChatListRow } from "@t3tools/client-runtime/kin/kinChatListRows";
import { KinAvatar } from "./KinAvatar";

// The thread list row's insets (`THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME`).
const ROW_CLASS_NAME = "min-h-16 flex-row items-center gap-3 px-5 py-2.5";

/**
 * One chat, as in any messenger: who, the last line, when, and on the right what wants a look.
 * While the lead works, the last line gives way to "Working…".
 */
export function KinChatRow(props: {
  readonly row: KinChatListRow;
  readonly accessibilityLabel: string;
  /** Unset in static previews. */
  readonly onPress?: () => void;
}) {
  const { row } = props;
  const { view } = row;
  const unread = view.unread > 0;
  const content = (
    <>
      <KinAvatar avatar={view.avatar} />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text
            textRole="body"
            numberOfLines={1}
            className={cn(
              "min-w-0 flex-1",
              row.retired ? "text-foreground-muted" : "text-foreground",
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
          {row.retired ? (
            // A retired agent's chat is kept to read; its last line would look like a live one.
            <Text
              textRole="footnote"
              numberOfLines={1}
              className="min-w-0 flex-1 text-foreground-muted"
            >
              {KIN_RETIRED_LABEL}
            </Text>
          ) : row.working ? (
            <Text
              textRole="footnote"
              numberOfLines={1}
              className="min-w-0 flex-1 font-t3-medium text-primary"
            >
              Working…
            </Text>
          ) : (
            <Text
              textRole="footnote"
              numberOfLines={2}
              className={cn("min-w-0 flex-1", unread ? "text-foreground" : "text-foreground-muted")}
            >
              {row.author === null ? null : `${row.author}: `}
              {row.preview}
            </Text>
          )}
          {view.muted ? (
            <SymbolView
              name="bell.slash"
              size={13}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          ) : null}
          {row.needsYou ? (
            <Text textRole="caption" className="font-t3-bold text-warning-foreground">
              Needs you
            </Text>
          ) : null}
          {unread ? (
            <View className="min-w-5 items-center rounded-full bg-primary px-1.5 py-0.5">
              <Text textRole="caption" className="font-t3-bold text-primary-foreground">
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
          <View className="size-10 rounded-[12px] bg-subtle-strong" />
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
