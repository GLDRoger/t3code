import {
  KIN_REACTION_EMOJI,
  type EnvironmentId,
  type KinPersonId,
  type KinReactionEmoji,
  type KinWidget,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import * as Dialog from "../../../components/ui/Dialog";
import { Menu } from "../../../components/ui/Menu";
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
import {
  KIN_REACTION_HINT,
  KIN_REACTION_HINT_LABEL,
  KIN_REACTION_NAMES,
  type KinReactionChip,
} from "../state/kinReactions";
import { kinSentences } from "../state/kinScreenState";
import { KinWidgetView } from "../widgets/KinWidgetView";

type MessageRow = Extract<KinFeedRow, { readonly type: "message" }>;
type SystemRow = Extract<KinFeedRow, { readonly type: "system" }>;
type DayRow = Extract<KinFeedRow, { readonly type: "day" }>;
type DraftRow = Extract<KinFeedRow, { readonly type: "draft" }>;

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
  readonly viewerPersonId: KinPersonId | null;
  readonly reactions: ReadonlyArray<KinReactionChip>;
  /** Toggles the viewer's reaction; null where they can't react, such as a privileged card. */
  readonly onReact: ((emoji: KinReactionEmoji) => void) | null;
  /** "React 👍/👎 to answer" on the lead's latest message, for its owner. */
  readonly showReplyHint: boolean;
}) {
  const { row, onReact } = props;
  const { message } = row;
  const deleted = message.status === "deleted";
  const suggested = message.status === "suggested";
  const hasBody = !deleted && message.body.trim().length > 0;
  // The bubble reads as one element, so its links are reachable as VoiceOver actions.
  const links = hasBody ? kinMessageLinks(message.body) : [];
  const hasCard = !deleted && message.widgetId !== null;
  const hasBubble = !hasCard || hasBody || suggested || message.editedAt !== null;
  const mine = new Set(props.reactions.flatMap((chip) => (chip.mine ? [chip.emoji] : [])));
  const reactActions =
    onReact === null || deleted
      ? []
      : KIN_REACTION_EMOJI.map((emoji) => ({
          name: `react-${emoji}`,
          label: `${mine.has(emoji) ? "Remove" : "React"} ${KIN_REACTION_NAMES[emoji]}`,
        }));

  const content = (
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
          accessibilityActions={[
            ...links.map((link, index) => ({
              name: `link-${index}`,
              label: `Open ${link.label}`,
            })),
            ...reactActions,
          ]}
          onAccessibilityAction={(event) => {
            const name = event.nativeEvent.actionName;
            if (name.startsWith("react-")) {
              const emoji = KIN_REACTION_EMOJI.find((candidate) => name === `react-${candidate}`);
              if (emoji !== undefined) onReact?.(emoji);
              return;
            }
            const link = links[Number(name.slice("link-".length))];
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
            viewerPersonId={props.viewerPersonId}
            onOpenLink={props.onLinkPress}
          />
        </View>
      ) : null}
      {props.reactions.length > 0 ? (
        <View className={cn("flex-row flex-wrap gap-1.5 px-1", row.own && "justify-end")}>
          {props.reactions.map((chip) => (
            <Chip
              key={chip.emoji}
              size="small"
              label={`${chip.emoji} ${chip.count}`}
              selected={chip.mine}
              disabled={onReact === null}
              accessibilityLabel={
                onReact === null
                  ? chip.label
                  : `${chip.label}. ${chip.mine ? "Remove your reaction" : "Add yours"}`
              }
              onPress={onReact === null ? undefined : () => onReact(chip.emoji)}
            />
          ))}
        </View>
      ) : null}
      {props.showReplyHint ? (
        <Text
          textRole="caption"
          className="px-1 text-foreground-muted"
          accessibilityLabel={KIN_REACTION_HINT_LABEL}
        >
          {KIN_REACTION_HINT}
        </Text>
      ) : null}
    </View>
  );
  if (onReact === null || deleted) return content;
  return (
    <Menu
      title="React"
      shouldOpenOnLongPress
      actions={KIN_REACTION_EMOJI.map((emoji) => ({
        id: emoji,
        title: `${emoji}  ${KIN_REACTION_NAMES[emoji]}`,
        state: mine.has(emoji) ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const emoji = KIN_REACTION_EMOJI.find((candidate) => candidate === nativeEvent.event);
        if (emoji !== undefined) onReact(emoji);
      }}
    >
      {/* The bubble inside stays the VoiceOver element; this only takes the long press. */}
      <Pressable accessible={false}>{content}</Pressable>
    </Menu>
  );
}

/**
 * A reply still streaming, laid out exactly as its message will be: the list keeps this row's
 * key and slot when the message lands, so nothing moves or flashes.
 */
export function KinDraftBubble(props: {
  readonly row: DraftRow;
  readonly markdownStyle: NativeMarkdownTextStyle;
  readonly onLinkPress: (href: string) => void;
}) {
  const { row } = props;
  return (
    <View className="items-start gap-1 px-4 pb-1.5">
      {row.showAuthor ? (
        <Text
          textRole="caption"
          className="px-1 pt-2 font-t3-medium text-foreground-muted"
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          {row.authorLabel} · {formatTime(row.draft.startedAt)}
        </Text>
      ) : null}
      <View
        accessible
        accessibilityLabel={kinSentences([
          `${row.authorLabel}, agent`,
          kinPlainText(row.draft.text),
          "Still writing",
        ])}
        className="max-w-[85%] gap-1 rounded-[20px] bg-composer-surface px-3.5 py-2.5"
      >
        <SelectableMarkdownText
          markdown={kinBodyMarkdown(row.draft.text)}
          textStyle={props.markdownStyle}
          preserveSoftBreaks
          onLinkPress={props.onLinkPress}
          renderImage={renderImageAsText}
          resolveImageSource={kinImageSource}
        />
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
