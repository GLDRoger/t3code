import {
  KIN_REACTION_EMOJI,
  type EnvironmentId,
  type KinAttachment,
  type KinPersonId,
  type KinReactionEmoji,
  type KinWidget,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import type { FilePreviewSource } from "../../../components/ui/FilePreviewModal";
import { Chip } from "../../../components/ui/Chip";
import * as Dialog from "../../../components/ui/Dialog";
import * as Haptics from "expo-haptics";

import { cn } from "../../../lib/cn";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
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
} from "@t3tools/client-runtime/kin/kinChatFeed";
import type { KinOutboxEntry } from "@t3tools/client-runtime/kin/kinOutbox";
import {
  KIN_PICKER_REACTIONS,
  KIN_REACTION_NAMES,
  type KinReactionChip,
} from "@t3tools/client-runtime/kin/kinReactions";
import { kinSentences } from "@t3tools/client-runtime/kin/kinScreenState";
import { kinMessageSummary } from "@t3tools/client-runtime/kin/kinAttachments";
import { MessageAttachmentList } from "../../threads/ThreadFeed";
import { KinWidgetView } from "../widgets/KinWidgetView";

type MessageRow = Extract<KinFeedRow, { readonly type: "message" }>;
type SystemRow = Extract<KinFeedRow, { readonly type: "system" }>;
type DayRow = Extract<KinFeedRow, { readonly type: "day" }>;
type DraftRow = Extract<KinFeedRow, { readonly type: "draft" }>;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const formatTime = (iso: string) => timeFormat.format(new Date(iso));

// The thread feed's shapes: its user bubble, and agent text straight on the screen.
const OWN_BUBBLE_CLASS_NAME = "max-w-[85%] rounded-[20px] bg-user-bubble px-4 py-2.5";
const OTHER_MESSAGE_CLASS_NAME = "w-full px-1 py-1";

const renderImageAsText: MarkdownImageRenderer = (image) => (
  <Text textRole="body" className="italic text-foreground-muted">
    {kinImageText(image)}
  </Text>
);

const NO_PLAYBACK = () => undefined;

/** A message's files, drawn by the thread feed's own attachment views at a bubble's width. */
function KinAttachments(props: {
  readonly attachments: ReadonlyArray<KinAttachment>;
  readonly environmentId: EnvironmentId;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  return (
    <View className="w-[280px] max-w-full">
      <MessageAttachmentList
        attachments={props.attachments}
        environmentId={props.environmentId}
        onPressPreview={props.onPressPreview}
        onPlaybackStart={NO_PLAYBACK}
      />
    </View>
  );
}

/** One message, as in a thread: the viewer's own in the user bubble, everyone else's as plain text. */
export function KinMessageBubble(props: {
  readonly row: MessageRow;
  /** `useMarkdownPreviewStyles().nativeTextStyle`, read once by the screen. */
  readonly markdownStyle: NativeMarkdownTextStyle;
  /** The same, recoloured for text on the user bubble. */
  readonly ownMarkdownStyle: NativeMarkdownTextStyle;
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
  /** Opens the long-press sheet; null where it would offer nothing. */
  readonly onOpenActions: (() => void) | null;
  /** A direct chat has one other author, so it shows no author lines. */
  readonly direct: boolean;
  /** Opens an attached image or PDF full screen. */
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const { row, onReact, onOpenActions } = props;
  const { message } = row;
  const deleted = message.status === "deleted";
  const suggested = message.status === "suggested";
  const hasBody = !deleted && message.body.trim().length > 0;
  // The bubble reads as one element, so its links are reachable as VoiceOver actions.
  const links = hasBody ? kinMessageLinks(message.body) : [];
  const hasCard = !deleted && message.widgetId !== null;
  const attachments = deleted ? [] : (message.attachments ?? []);
  // Files alone need no empty bubble under them.
  const hasBubble =
    (!hasCard && attachments.length === 0) || hasBody || suggested || message.editedAt !== null;
  const mine = new Set(props.reactions.flatMap((chip) => (chip.mine ? [chip.emoji] : [])));
  // The sheet's actions, reachable without the long press.
  const sheetActions = [
    ...(onReact === null || deleted
      ? []
      : KIN_PICKER_REACTIONS.map((emoji) => ({
          name: `react-${emoji}`,
          label: `${mine.has(emoji) ? "Remove" : "React"} ${KIN_REACTION_NAMES[emoji]}`,
        }))),
    ...(hasBody ? [{ name: "copy", label: "Copy" }] : []),
  ];

  const bubble = hasBubble ? (
    <View
      accessible
      accessibilityLabel={kinMessageLabel(row, formatTime(message.createdAt))}
      accessibilityActions={[
        ...links.map((link, index) => ({ name: `link-${index}`, label: `Open ${link.label}` })),
        ...sheetActions,
      ]}
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        if (name === "copy") {
          copyTextWithHaptic(message.body, { target: "kin-message" });
          return;
        }
        if (name.startsWith("react-")) {
          const emoji = KIN_REACTION_EMOJI.find((candidate) => name === `react-${candidate}`);
          if (emoji !== undefined) onReact?.(emoji);
          return;
        }
        const link = links[Number(name.slice("link-".length))];
        if (link !== undefined) props.onLinkPress(link.href);
      }}
      className={cn("gap-1", row.own ? OWN_BUBBLE_CLASS_NAME : OTHER_MESSAGE_CLASS_NAME)}
    >
      {hasBody ? (
        <SelectableMarkdownText
          markdown={kinBodyMarkdown(message.body)}
          textStyle={row.own ? props.ownMarkdownStyle : props.markdownStyle}
          // A long press opens the sheet, whose Select text offers selection instead.
          selectable={onOpenActions === null}
          preserveSoftBreaks
          onLinkPress={props.onLinkPress}
          renderImage={renderImageAsText}
          resolveImageSource={kinImageSource}
        />
      ) : deleted ? (
        <Text
          textRole="body"
          className={cn(
            "italic",
            row.own ? "text-user-bubble-foreground-muted" : "text-foreground-muted",
          )}
        >
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
  ) : null;

  return (
    <View className={cn("gap-1 px-4 pb-2", row.own ? "items-end" : "items-start")}>
      {row.showAuthor && !props.direct ? (
        <Text
          textRole="caption"
          className="px-1 pt-2 font-t3-medium text-foreground-muted"
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          {row.authorLabel}
        </Text>
      ) : null}
      {attachments.length > 0 ? (
        <KinAttachments
          attachments={attachments}
          environmentId={props.environmentId}
          onPressPreview={props.onPressPreview}
        />
      ) : null}
      {bubble === null ? null : onOpenActions === null ? (
        bubble
      ) : (
        // The bubble inside stays the VoiceOver element; this only takes the long press.
        <Pressable
          accessible={false}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onOpenActions();
          }}
          className={cn("w-full", row.own ? "items-end" : "items-start")}
        >
          {bubble}
        </Pressable>
      )}
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
    </View>
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
  readonly direct: boolean;
}) {
  const { row } = props;
  return (
    <View className="items-start gap-1 px-4 pb-2">
      {row.showAuthor && !props.direct ? (
        <Text
          textRole="caption"
          className="px-1 pt-2 font-t3-medium text-foreground-muted"
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          {row.authorLabel}
        </Text>
      ) : null}
      <View
        accessible
        accessibilityLabel={kinSentences([
          `${row.authorLabel}, agent`,
          kinPlainText(row.draft.text),
          "Still writing",
        ])}
        className={cn("gap-1", OTHER_MESSAGE_CLASS_NAME)}
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

/** Kin's own bookkeeping from an older host, kept out of the way: one small centred line. */
export function KinQuietLine(props: { readonly text: string }) {
  return (
    <View className="items-center px-8 py-1.5">
      <Text textRole="caption" numberOfLines={1} className="text-center text-foreground-muted">
        {props.text}
      </Text>
    </View>
  );
}

/** A line from Kin itself, such as a member joining. */
export function KinSystemLine(props: {
  readonly row: SystemRow;
  /** Sends the owner's unanswered message again; null shows the line alone. */
  readonly onRetry: (() => void) | null;
}) {
  return (
    <View className="items-center gap-2 px-8 py-2">
      <Text textRole="caption" className="text-center text-foreground-muted">
        {props.row.text}
      </Text>
      {props.onRetry === null ? null : (
        <Chip
          label="Retry"
          size="small"
          icon="arrow.clockwise"
          accessibilityLabel="Retry. Sends your last message again."
          onPress={props.onRetry}
        />
      )}
    </View>
  );
}

/** The owner's message before the host has it: sending, waiting for a connection, or refused. */
export function KinPendingBubble(props: {
  readonly entry: KinOutboxEntry;
  readonly environmentId: EnvironmentId;
  readonly onPressPreview: (source: FilePreviewSource) => void;
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
  const attachments = entry.attachments ?? [];
  const hasBody = entry.body.trim().length > 0;
  const remove = () =>
    Dialog.confirm({
      title: "Delete this message?",
      message: "It was never sent.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: props.onDiscard,
    });
  return (
    <View className="items-end gap-1 px-4 pb-2">
      {attachments.length > 0 ? (
        <View className={failed ? undefined : "opacity-70"}>
          <KinAttachments
            attachments={attachments}
            environmentId={props.environmentId}
            onPressPreview={props.onPressPreview}
          />
        </View>
      ) : null}
      {hasBody ? (
        <Pressable
          disabled={!failed}
          onPress={props.onEdit}
          onLongPress={failed ? remove : undefined}
          accessibilityRole={failed ? "button" : undefined}
          accessibilityLabel={kinSentences([`You: ${kinPlainText(entry.body)}`, status])}
          accessibilityHint={failed ? "Edit it in the message box." : undefined}
          className={cn(OWN_BUBBLE_CLASS_NAME, !failed && "opacity-70")}
        >
          <Text textRole="body" className="text-user-bubble-foreground">
            {entry.body}
          </Text>
        </Pressable>
      ) : null}
      {/* The text bubble reads the status aloud; files alone leave that to this line. */}
      <View
        className="flex-row items-center gap-2 px-1"
        accessible={!hasBody}
        accessibilityLabel={
          hasBody ? undefined : kinSentences([`You: ${kinMessageSummary(entry)}`, status])
        }
        importantForAccessibility={hasBody ? "no-hide-descendants" : "yes"}
        accessibilityElementsHidden={hasBody}
      >
        <Text
          textRole="caption"
          className={failed ? "text-danger-foreground" : "text-foreground-muted"}
        >
          {status}
        </Text>
        {failed && hasBody ? (
          <Pressable onPress={props.onEdit} hitSlop={12}>
            <Text textRole="caption" className="font-t3-medium text-foreground">
              Edit
            </Text>
          </Pressable>
        ) : null}
        {failed && !hasBody ? (
          <Pressable onPress={remove} hitSlop={12}>
            <Text textRole="caption" className="font-t3-medium text-foreground">
              Delete
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** A centred time divider: "Today 12:55 PM". */
export function KinDayLine(props: { readonly row: DayRow }) {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={props.row.label}
      className="items-center px-8 pb-2 pt-5"
    >
      <Text textRole="caption" className="text-foreground-muted">
        {props.row.label}
      </Text>
    </View>
  );
}
