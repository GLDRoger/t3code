import type { KinReactionEmoji } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, Text as SystemText, useWindowDimensions, View } from "react-native";

import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Sheet } from "../../../components/ui/Sheet";
import { cn } from "../../../lib/cn";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import {
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../../native/SelectableMarkdownText";
import { kinBodyMarkdown, kinImageSource } from "@t3tools/client-runtime/kin/kinChatFeed";
import { KIN_PICKER_REACTIONS, KIN_REACTION_NAMES } from "@t3tools/client-runtime/kin/kinReactions";

const PER_ROW = 6;
const ROWS = [KIN_PICKER_REACTIONS.slice(0, PER_ROW), KIN_PICKER_REACTIONS.slice(PER_ROW)];

/**
 * A message's long-press sheet: reactions on top, then Copy and Select text. Reply and mark as
 * unread are left out until Kin can do them: the lead never reads `replyTo`, and read state only
 * moves forward.
 */
export function KinMessageSheet(props: {
  readonly body: string;
  readonly markdownStyle: NativeMarkdownTextStyle;
  /** The viewer's own reactions on this message, shown selected. */
  readonly mine: ReadonlySet<KinReactionEmoji>;
  /** Null where the viewer can't react here, such as a guest or a privileged card. */
  readonly onReact: ((emoji: KinReactionEmoji) => void) | null;
  readonly onClose: () => void;
}) {
  const [selecting, setSelecting] = useState(false);
  // An explicit height, so the sheet measures the text rather than its own current size.
  const [textHeight, setTextHeight] = useState(0);
  const { height } = useWindowDimensions();
  const { onReact, onClose } = props;
  const hasBody = props.body.trim().length > 0;
  return (
    <Sheet variant="plain" title="Message actions" onClose={onClose}>
      {selecting ? (
        <ScrollView
          style={{ height: Math.min(textHeight, height * 0.7), flexGrow: 0 }}
          onContentSizeChange={(_, contentHeight) => setTextHeight(Math.ceil(contentHeight))}
          contentContainerClassName="px-5 pt-6 pb-10"
          accessibilityLabel="Message text"
        >
          <SelectableMarkdownText
            markdown={kinBodyMarkdown(props.body)}
            textStyle={props.markdownStyle}
            preserveSoftBreaks
            resolveImageSource={kinImageSource}
          />
        </ScrollView>
      ) : (
        <View className="gap-4 px-4 pt-7 pb-10">
          {onReact === null ? null : (
            <View className="gap-3" accessibilityRole="toolbar" accessibilityLabel="Reactions">
              {ROWS.map((row) => (
                <View key={row[0]} className="flex-row justify-between">
                  {Array.from({ length: PER_ROW }, (_, column) => {
                    const emoji = row[column];
                    if (emoji === undefined) return <View key={column} className="size-13" />;
                    const selected = props.mine.has(emoji);
                    return (
                      <Pressable
                        key={emoji}
                        accessibilityRole="button"
                        accessibilityLabel={`${selected ? "Remove" : "React"} ${KIN_REACTION_NAMES[emoji]}`}
                        accessibilityState={{ selected }}
                        onPress={() => {
                          onReact(emoji);
                          onClose();
                        }}
                        className={cn(
                          "size-13 items-center justify-center rounded-full active:opacity-70",
                          selected ? "border-2 border-primary bg-primary/15" : "bg-subtle-strong",
                        )}
                      >
                        <SystemText style={{ fontSize: 26 }} allowFontScaling={false}>
                          {emoji}
                        </SystemText>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
          )}
          {hasBody ? (
            <ListSection>
              <ListActionRow
                icon="doc.on.doc"
                label="Copy"
                onPress={() => {
                  copyTextWithHaptic(props.body, { target: "kin-message" });
                  onClose();
                }}
              />
              <View className="border-t border-border-subtle">
                <ListActionRow
                  icon="text.alignleft"
                  label="Select text"
                  onPress={() => setSelecting(true)}
                />
              </View>
            </ListSection>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}
