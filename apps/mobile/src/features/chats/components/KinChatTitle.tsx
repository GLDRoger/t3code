import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { kinSentences, type KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { KinAvatar } from "./KinAvatar";

/**
 * The chat's title in the bar: who the chat is with, and open tasks on a second line. With
 * `onPress` the avatar and name open the chat's details; without, it reads as a heading.
 */
export function KinChatTitle(props: {
  readonly title: string;
  readonly avatar: KinAvatarView;
  /** Open tasks, such as "Working on 2 tasks"; null hides the second line. */
  readonly detail: string | null;
  readonly maxWidth?: number;
  readonly onPress?: () => void;
  readonly accessibilityHint?: string;
}) {
  const label = kinSentences([props.title, props.detail]);
  const title = (
    <View
      accessible={props.onPress === undefined}
      accessibilityRole="header"
      accessibilityLabel={label}
      className="flex-row items-center gap-2"
      style={{ maxWidth: props.maxWidth }}
    >
      <KinAvatar avatar={props.avatar} size="small" />
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
    </View>
  );
  if (props.onPress === undefined) return title;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={props.accessibilityHint}
      hitSlop={8}
      onPress={props.onPress}
      className="min-h-11 justify-center active:opacity-60"
    >
      {title}
    </Pressable>
  );
}
