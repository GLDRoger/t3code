import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { cn } from "../../../lib/cn";
import {
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../../native/SelectableMarkdownText";
import type { KinFeedRow } from "../state/kinChatFeed";
import type { KinOutboxEntry } from "../state/kinOutbox";

type MessageRow = Extract<KinFeedRow, { readonly type: "message" }>;
type SystemRow = Extract<KinFeedRow, { readonly type: "system" }>;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const formatTime = (iso: string) => timeFormat.format(new Date(iso));

function bubbleLabel(row: MessageRow, text: string): string {
  const who = row.own ? "You" : `${row.authorLabel}, ${row.authorKind}`;
  const edited = row.message.editedAt === null ? "" : " Edited.";
  return `${who}: ${text}. ${formatTime(row.message.createdAt)}.${edited}`;
}

/** One message. The owner's own sit right on the user bubble; others sit left under an author line. */
export function KinMessageBubble(props: {
  readonly row: MessageRow;
  /** `useMarkdownPreviewStyles().nativeTextStyle`, read once by the screen. */
  readonly markdownStyle: NativeMarkdownTextStyle;
  readonly onLinkPress: (href: string) => void;
}) {
  const { row } = props;
  const { message } = row;
  const deleted = message.status === "deleted";
  const suggested = message.status === "suggested";
  const hasBody = !deleted && message.body.trim().length > 0;
  const plain = deleted ? "Message deleted" : message.body;

  return (
    <View className={cn("gap-1 px-4 pb-1.5", row.own ? "items-end" : "items-start")}>
      {row.showAuthor ? (
        <Text
          textRole="caption"
          className="px-1 pt-2 font-t3-medium text-foreground-muted"
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          {row.authorLabel} · {formatTime(message.createdAt)}
        </Text>
      ) : null}
      <View
        accessible
        accessibilityLabel={bubbleLabel(row, plain)}
        className={cn(
          "max-w-[85%] gap-1 rounded-[20px] px-3.5 py-2.5",
          row.own ? "bg-user-bubble" : "bg-card-alt",
          suggested && "border border-dashed border-border",
        )}
      >
        {hasBody ? (
          <SelectableMarkdownText
            markdown={message.body}
            textStyle={props.markdownStyle}
            preserveSoftBreaks
            onLinkPress={props.onLinkPress}
          />
        ) : deleted ? (
          <Text textRole="body" className="italic text-foreground-muted">
            Message deleted
          </Text>
        ) : null}
        {message.widgetId !== null ? (
          // MOB-6 replaces this with the native card for the widget.
          <Text textRole="footnote" className="text-foreground-muted">
            This card needs a newer version of Kin.
          </Text>
        ) : null}
        {suggested || message.editedAt !== null ? (
          <Text
            textRole="caption"
            className={row.own ? "text-user-bubble-foreground-muted" : "text-foreground-muted"}
          >
            {suggested ? "Suggestion, not sent yet" : "Edited"}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** A line from Kin itself, such as a member joining. */
export function KinSystemLine(props: { readonly row: SystemRow }) {
  return (
    <View className="items-center px-8 py-2">
      <Text textRole="caption" className="text-center text-foreground-muted">
        {props.row.message.body}
      </Text>
    </View>
  );
}

/** The owner's message before the host has it: sending, waiting for a connection, or refused. */
export function KinPendingBubble(props: {
  readonly entry: KinOutboxEntry;
  readonly connected: boolean;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
}) {
  const { entry } = props;
  const failed = entry.state === "failed";
  const status = failed
    ? "Not sent. Tap to retry"
    : props.connected || entry.state === "sending"
      ? "Sending…"
      : "Waiting for connection";
  return (
    <View className="items-end gap-1 px-4 pb-1.5">
      <Pressable
        disabled={!failed}
        onPress={props.onRetry}
        onLongPress={
          failed
            ? () =>
                Dialog.confirm({
                  title: "Delete this message?",
                  message: "It was never sent.",
                  confirmText: "Delete",
                  destructive: true,
                  onConfirm: props.onDiscard,
                })
            : undefined
        }
        accessibilityRole={failed ? "button" : undefined}
        accessibilityLabel={`You: ${entry.body}. ${status}.`}
        accessibilityHint={failed ? (entry.error ?? undefined) : undefined}
        className={cn(
          "max-w-[85%] rounded-[20px] bg-user-bubble px-3.5 py-2.5",
          !failed && "opacity-70",
        )}
      >
        <Text textRole="body" className="text-user-bubble-foreground">
          {entry.body}
        </Text>
      </Pressable>
      <Text
        textRole="caption"
        importantForAccessibility="no"
        accessibilityElementsHidden
        className={cn("px-1", failed ? "text-danger-foreground" : "text-foreground-muted")}
      >
        {status}
      </Text>
    </View>
  );
}
