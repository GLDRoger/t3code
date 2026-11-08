import type { EnvironmentId, KinWidget } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import {
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../../native/SelectableMarkdownText";
import type { KinFeedRow } from "../state/kinChatFeed";
import { KinWidgetView } from "../widgets/KinWidgetView";

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
  const plain = deleted ? "Message deleted" : message.body;
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
