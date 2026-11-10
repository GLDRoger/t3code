import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { GlassSurface } from "../../../components/ui/GlassSurface";
import { kinSentences, type KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { KinAvatar, type KinAvatarStatus } from "./KinAvatar";

const STATUS_LABELS: Record<KinAvatarStatus, string> = { online: "Online", working: "Working" };

/**
 * The chat's title in the glass bar: who the chat is with, whether it's live, and open tasks.
 * Kin has no chat info screen yet, so it reads as a heading rather than a button.
 */
export function KinChatTitlePill(props: {
  readonly title: string;
  readonly avatar: KinAvatarView;
  readonly status: KinAvatarStatus | null;
  /** Open tasks, such as "2 open tasks"; null hides the second line. */
  readonly detail: string | null;
  readonly maxWidth: number;
}) {
  return (
    <GlassSurface
      accessible
      accessibilityRole="header"
      accessibilityLabel={kinSentences([
        props.title,
        props.status === null ? null : STATUS_LABELS[props.status],
        props.detail,
      ])}
      className="flex-row items-center gap-2 py-1.5 pr-4 pl-1.5"
      style={{ borderRadius: 999, maxWidth: props.maxWidth }}
    >
      <KinAvatar avatar={props.avatar} size="small" status={props.status} />
      <View className="shrink">
        <Text
          textRole="body"
          maxFontSizeMultiplier={1.5}
          numberOfLines={1}
          className="font-t3-bold text-foreground"
        >
          {props.title}
        </Text>
        {props.detail === null ? null : (
          <Text
            textRole="micro"
            maxFontSizeMultiplier={1.5}
            numberOfLines={1}
            className="text-foreground-muted"
          >
            {props.detail}
          </Text>
        )}
      </View>
    </GlassSurface>
  );
}
