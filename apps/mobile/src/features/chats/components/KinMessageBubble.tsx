import type { EnvironmentId, KinWidget } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { cn } from "../../../lib/cn";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type NativeMarkdownTextStyle,
} from "../../../native/SelectableMarkdownText";
import {
  kinBodyMarkdown,
  kinImageSource,
  kinImageText,
  kinMessageLabel,
  kinMessageLinks,
  kinPlainText,
  type KinFeedRow,
} from "../state/kinChatFeed";
import type { KinOutboxEntry } from "../state/kinOutbox";
import { kinSentences } from "../state/kinScreenState";
import { KinWidgetView } from "../widgets/KinWidgetView";

type MessageRow = Extract<KinFeedRow, { readonly type: "message" }>;
type SystemRow = Extract<KinFeedRow, { readonly type: "system" }>;
type DayRow = Extract<KinFeedRow, { readonly type: "day" }>;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const formatTime = (iso: string) => timeFormat.format(new Date(iso));

const renderImageAsText: MarkdownImageRenderer = (image) => (
  <Text textRole="body" className="italic text-foreground-muted">
    {kinImageText(image)}
  </Text>
);

/** One message. The owner's own sit right on the user bubble; others sit left under an author line. */
export function KinMessageBubble(props: {
  readonly row: MessageRow;
  /** `useMarkdownPreviewStyles().nativeTextStyle`, read once by the screen. */
  readonly markdownStyle: NativeMarkdownTextStyle;
  /** Gets any link the author wrote; the screen opens web links only (`kinLinkToOpen`). */
  readonly onLinkPress: (href: string) => void;
  /** The widget `row.message.widgetId` points at, if the feed holds it. */
  readonly widget: KinWidget | undefined;
  /** The environment hosting the chat. */
  readonly environmentId: EnvironmentId;
}) {
  const { row } = props;
  const { message } = row;
  const deleted = message.status === "deleted";
  const suggested = message.status === "suggested";
  const hasBody = !deleted && message.body.trim().length > 0;
  // The bubble reads as one element, so its links are reachable as VoiceOver actions.
  const links = hasBody ? kinMessageLinks(message.body) : [];
  const hasCard = !deleted && message.widgetId !== null;
  const hasBubble = !hasCard || hasBody || suggested || message.editedAt !== null;

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
      {hasBubble ? (
        <View
          accessible
          accessibilityLabel={kinMessageLabel(row, formatTime(message.createdAt))}
          accessibilityActions={links.map((link, index) => ({
            name: `link-${index}`,
            label: `Open ${link.label}`,
          }))}
          onAccessibilityAction={(event) => {
            const link = links[Number(event.nativeEvent.actionName.slice("link-".length))];
            if (link !== undefined) props.onLinkPress(link.href);
          }}
          className={cn(
            "max-w-[85%] gap-1 rounded-[20px] px-3.5 py-2.5",
            // The thread composer's surface: `card-alt` vanishes into the light screen.
            row.own ? "bg-user-bubble" : "bg-composer-surface",
            suggested && "border border-dashed border-border",
          )}
        >
          {hasBody ? (
            <SelectableMarkdownText
              markdown={kinBodyMarkdown(message.body)}
              textStyle={props.markdownStyle}
              preserveSoftBreaks
              onLinkPress={props.onLinkPress}
              renderImage={renderImageAsText}
              resolveImageSource={kinImageSource}
            />
          ) : deleted ? (
            <Text textRole="body" className="italic text-foreground-muted">
              Message deleted
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
      ) : null}
      {hasCard ? (
        <View className="w-[85%]">
          <KinWidgetView
            widget={props.widget}
            environmentId={props.environmentId}
            onOpenLink={props.onLinkPress}
          />
        </View>
      ) : null}
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
  /** Puts the body back in the draft and drops the refused send. */
  readonly onEdit: () => void;
  readonly onDiscard: () => void;
}) {
  const { entry } = props;
  const failed = entry.state === "failed";
  const status = failed
    ? `Not sent: ${entry.error ?? "refused"}`
    : props.connected || entry.state === "sending"
      ? "Sending…"
      : "Waiting for connection";
  return (
    <View className="items-end gap-1 px-4 pb-1.5">
      <Pressable
        disabled={!failed}
        onPress={props.onEdit}
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
        accessibilityLabel={kinSentences([`You: ${kinPlainText(entry.body)}`, status])}
        accessibilityHint={failed ? "Edit it in the message box." : undefined}
        className={cn(
          "max-w-[85%] rounded-[20px] bg-user-bubble px-3.5 py-2.5",
          !failed && "opacity-70",
        )}
      >
        <Text textRole="body" className="text-user-bubble-foreground">
          {entry.body}
        </Text>
      </Pressable>
      <View
        className="flex-row items-center gap-2 px-1"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <Text
          textRole="caption"
          className={failed ? "text-danger-foreground" : "text-foreground-muted"}
        >
          {status}
        </Text>
        {failed ? (
          <Pressable onPress={props.onEdit} hitSlop={12}>
            <Text textRole="caption" className="font-t3-medium text-foreground">
              Edit
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** Starts a day in the feed: "Today", "Yesterday", or its date. */
export function KinDayLine(props: { readonly row: DayRow }) {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={props.row.label}
      className="items-center px-8 pb-1 pt-4"
    >
      <Text textRole="caption" className="font-t3-medium text-foreground-muted">
        {props.row.label}
      </Text>
    </View>
  );
}
