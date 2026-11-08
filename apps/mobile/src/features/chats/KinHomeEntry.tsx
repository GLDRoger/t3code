import { useNavigation } from "@react-navigation/native";
import { use } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { usePaneRole } from "../../components/ui/Pane";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  getThreadListV2RowAppearance,
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
} from "../threads/thread-list-v2-row-appearance";

import { selectKinInboxView } from "./state/kinInboxModel";
import { kinHomeSubtitle } from "./state/kinScreenState";
import { useKinInbox } from "./state/useKinInbox";

/** Home's Kin row, first in the thread list. Renders nothing unless an environment hosts Kin. */
export function KinHomeEntry() {
  const navigation = useNavigation();
  const sidebarPane = usePaneRole() === "sidebar" && use(NativePrimaryColumnContext) !== null;
  const appearance = getThreadListV2RowAppearance(
    useAppearancePreferences().themeVariables,
    sidebarPane,
    false,
  );
  const { host, state } = useKinInbox();
  if (host._tag !== "host") return null;

  const view = state._tag === "ready" ? selectKinInboxView(state.inbox.value) : null;
  const waitingCount = view?.waitingCount ?? 0;
  const unreadCount = view?.unreadCount ?? 0;
  const subtitle = kinHomeSubtitle(state, view);

  const content = (
    <View className="flex-row items-center gap-3">
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={18}
        tintColorClassName={appearance.mutedIconTintClassName}
        type="monochrome"
      />
      <View className="flex-1">
        <Text className={cn("text-base font-t3-medium", appearance.foregroundClassName)}>Kin</Text>
        {subtitle === null ? null : (
          <Text
            numberOfLines={1}
            className={cn(
              "mt-0.5 text-xs",
              waitingCount > 0
                ? "font-t3-bold text-primary"
                : appearance.tertiaryForegroundClassName,
            )}
          >
            {subtitle}
          </Text>
        )}
      </View>
      {unreadCount > 0 ? (
        <View className="min-w-5 items-center rounded-full bg-primary px-1.5 py-0.5">
          <Text className="text-2xs font-t3-bold text-primary-foreground">{unreadCount}</Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={appearance.swipeContainerStyle}>
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={["Kin", subtitle, unreadCount > 0 ? `${unreadCount} unread` : null]
          .filter(Boolean)
          .join(". ")}
        accessibilityHint="Opens your Kin chats"
        className={appearance.className}
        interactionClassName={appearance.interactionClassName}
        interactionOpacity={appearance.interactionOpacity}
        onPress={() => navigation.navigate("KinChats")}
        style={appearance.cardStyle}
      >
        {sidebarPane ? (
          content
        ) : (
          <View>
            <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{content}</View>
            {THREAD_LIST_V2_ROW_DIVIDERS ? <View className="ml-5 h-px bg-border-subtle" /> : null}
          </View>
        )}
      </RowPressable>
    </View>
  );
}
