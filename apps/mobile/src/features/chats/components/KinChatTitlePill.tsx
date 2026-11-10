import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { GlassSurface } from "../../../components/ui/GlassSurface";
import { kinSentences, type KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { KinAvatar, type KinAvatarStatus } from "./KinAvatar";

const STATUS_LABELS: Record<KinAvatarStatus, string> = { online: "Online", working: "Working" };

/**
 * The chat's title in the glass bar: who the chat is with, whether it's live, and open tasks.
 * With `onPress` it opens the lead's details; without, it reads as a heading.
 */
export function KinChatTitlePill(props: {
  readonly title: string;
  readonly avatar: KinAvatarView;
  readonly status: KinAvatarStatus | null;
  /** Open tasks, such as "2 open tasks"; null hides the second line. */
  readonly detail: string | null;
  readonly maxWidth: number;
  readonly onPress?: () => void;
}) {
  const label = kinSentences([
    props.title,
    props.status === null ? null : STATUS_LABELS[props.status],
    props.detail,
  ]);
  const pill = (
    <GlassSurface
      accessible={props.onPress === undefined}
      accessibilityRole="header"
      accessibilityLabel={label}
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
  if (props.onPress === undefined) return pill;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens this lead's details"
      hitSlop={6}
      onPress={props.onPress}
      className="active:opacity-70"
    >
      {pill}
    </Pressable>
  );
}
