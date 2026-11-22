import {
  kinPageShape,
  KIN_REACTION_EMOJI,
  type EnvironmentId,
  type KinAttachment,
  type KinPersonId,
  type KinReactionEmoji,
  type KinWidget,
  kinWhenFormat,
} from "@t3tools/contracts";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import type { FilePreviewSource } from "../../../components/ui/FilePreviewModal";
import { FilePreviewGallery } from "../../../components/ui/FilePreviewGallery";
import { Button } from "../../../components/ui/Button";
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
  type KinNoticeOpen,
  KIN_CHAT_COPY,
} from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_OUTBOX_STATUS,
  kinOutboxRetractable,
  kinPendingStatus,
  type KinOutboxEntry,
} from "@t3tools/client-runtime/kin/kinOutbox";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import * as Clipboard from "expo-clipboard";
import {
  KIN_REACTION_COPY,
  KIN_PICKER_REACTIONS,
  KIN_REACTION_NAMES,
  type KinReactionChip,
} from "@t3tools/client-runtime/kin/kinReactions";
import {
  kinAgentAvatar,
  kinSentences,
  type KinAvatarView,
  kinTableWiderThan,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { kinAuthorAvatar } from "@t3tools/client-runtime/kin/kinGroups";
import { kinMessageSummary } from "@t3tools/client-runtime/kin/kinAttachments";
import { kinTurnReceiptOpen, kinTurnReceiptLine } from "@t3tools/client-runtime/kin/kinTurnReceipt";
import { kinReplyButtons, type KinReplyButton } from "@t3tools/client-runtime/kin/kinReplyButtons";
import { kinCardDraws, KIN_CARD_COPY } from "@t3tools/client-runtime/kin/kinCardPresentation";
import {
  kinDraftMarkdown,
  kinMessageCopyText,
  kinMessageLayout,
  kinPageHead,
} from "@t3tools/client-runtime/kin/kinMessagePage";
import { AgentMessageFoldHeader, MessageAttachmentList } from "../../threads/ThreadFeed";
import { attachmentImageGallery } from "../../threads/messageImageGallery";
import { useResolveClassNames } from "uniwind";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { useViewabilityAmount } from "@legendapp/list/react-native";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { kinOutbox } from "../state/kinOutboxDelivery";
import { KinVisualInView } from "../widgets/KinVisual";
import { KinWidgetView } from "../widgets/KinWidgetView";
import { KinCardGroup } from "../widgets/KinCardGroup";
import { KinAvatar } from "./KinAvatar";
import { kinLines, useKinTextGrows } from "./kinTextGrows";
import { KinDocRefs } from "./KinDocRefs";
import { KinLinkedText, KinMessagePage, useKinOpenTarget } from "./KinMessagePage";

type MessageRow = Extract<KinFeedRow, { readonly type: "message" }>;
type SystemRow = Extract<KinFeedRow, { readonly type: "system" }>;
type DayRow = Extract<KinFeedRow, { readonly type: "day" }>;
type DraftRow = Extract<KinFeedRow, { readonly type: "draft" }>;
type RelayRow = Extract<KinFeedRow, { readonly type: "relay" }>;

const timeFormat = kinWhenFormat("time");
const formatTime = (iso: string) => timeFormat.format(new Date(iso));

// The viewer's message in the thread feed's user bubble; everyone else's on a quieter surface.
// The width cap sits on the wrapper, so the long-press target is exactly the bubble.
const OWN_WIDTH_CLASS_NAME = "max-w-[85%]";
const OTHER_WIDTH_CLASS_NAME = "max-w-[88%]";
const OWN_BUBBLE_CLASS_NAME = "rounded-[20px] bg-user-bubble px-4 py-2.5";
const OTHER_BUBBLE_CLASS_NAME = "rounded-[20px] bg-grouped-card px-4 py-2.5";
// Tight inside one author's run, a clear step between authors.
const rowSpacing = (continues: boolean) => (continues ? "pt-0.5" : "pt-3");

const renderImageAsText: MarkdownImageRenderer = (image) => (
  <Text textRole="body" className="italic text-foreground-muted">
    {kinImageText(image)}
  </Text>
);

const NO_PLAYBACK = () => undefined;
// A reply still being written has no links yet.
const NO_TARGET = () => undefined;

/** A message's files, drawn by the thread feed's own attachment views at a bubble's width. */
export function KinAttachments(props: {
  readonly attachments: ReadonlyArray<KinAttachment>;
  readonly environmentId: EnvironmentId;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly unposted?: boolean;
}) {
  return (
    <View className="w-[280px] max-w-full">
      <FilePreviewGallery
        value={
          props.unposted === true
            ? []
            : attachmentImageGallery(props.attachments, props.environmentId)
        }
      >
        <MessageAttachmentList
          {...(props.unposted === true ? { unposted: true } : {})}
          attachments={props.attachments}
          environmentId={props.environmentId}
          onPressPreview={props.onPressPreview}
          onPlaybackStart={NO_PLAYBACK}
        />
      </FilePreviewGallery>
    </View>
  );
}

/** Who wrote the messages under it, in a chat with more than one other author. */
function KinAuthorLine(props: {
  readonly label: string;
  readonly avatar: KinAvatarView;
  readonly onPress?: (() => void) | undefined;
}) {
  const line = (
    <>
      <KinAvatar avatar={props.avatar} size="mini" />
      <Text textRole="caption" className="font-t3-medium text-foreground-muted">
        {props.label}
      </Text>
    </>
  );
  return props.onPress === undefined ? (
    <View
      className="flex-row items-center gap-1.5 px-1"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {line}
    </View>
  ) : (
    <Pressable
      className="flex-row items-center gap-1.5 px-1"
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, profile`}
      hitSlop={8}
      onPress={props.onPress}
    >
      {line}
    </Pressable>
  );
}

/** One message: the viewer's own in the user bubble on the right, everyone else's in a bubble on the left. */
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
  /** The card's agent by name when it is retired. */
  readonly heldFor?: string | null;
  /** The viewer may only read this chat: its cards offer nothing that writes in it. */
  readonly readOnly?: boolean;
  /** The chat's agents by id, for a doc card's "by Growth". */
  readonly agentNames?: ReadonlyMap<string, string>;
  readonly reactions: ReadonlyArray<KinReactionChip>;
  /** Toggles the viewer's reaction; null where they can't react, such as a privileged card. */
  readonly onReact: ((emoji: KinReactionEmoji) => void) | null;
  /** Opens the long-press sheet; null where it would offer nothing. */
  readonly onOpenActions: (() => void) | null;
  /** A direct chat has one other author, so it shows no author lines. */
  readonly direct: boolean;
  /** Opens an attached image or PDF full screen. */
  readonly onPressPreview: (source: FilePreviewSource) => void;
  /** Opens a teammate's profile from their name. */
  readonly onOpenPerson?: (personId: KinPersonId) => void;
  /** The reader's first name, for a brief's greeting. */
  readonly firstName?: string | null;
  /** Opens the sheet of what this reply's turn changed. */
  readonly onOpenReceipt: () => void;
  /** The cards this row leads, drawn as one (`kinGroupCardRows`); `widget` is the first's. */
  readonly group?: {
    readonly question: KinWidget | undefined;
    readonly tasks: ReadonlyArray<KinWidget | undefined>;
  };
}) {
  const { row, onReact, onOpenActions } = props;
  const onOpenTarget = useKinOpenTarget(props.environmentId, row.message.orgId);
  const { message } = row;
  const deleted = message.status === "deleted";
  const suggested = message.status === "suggested";
  const hasBody = !deleted && message.body.trim().length > 0;
  const window = useWindowDimensions();
  // A wide table scrolls sideways in the bubble; its bar shows only mid-swipe, so a line says so.
  // Width in body characters: the bubble's share of the screen less its padding, ~0.55em each.
  const wideTable =
    hasBody &&
    kinTableWiderThan(message.body, (window.width * 0.88 - 64) / (17 * window.fontScale * 0.55));
  // The bubble reads as one element, so its links are reachable as VoiceOver actions.
  const links = hasBody ? kinMessageLinks(message.body) : [];
  const inApp = hasBody ? (message.links ?? []) : [];
  const layout = row.own || !hasBody ? "bubble" : kinMessageLayout(message);
  const hasCard =
    !deleted &&
    message.widgetId !== null &&
    kinCardDraws(props.widget, props.environmentId, hasBody);
  const attachments = deleted ? [] : (message.attachments ?? []);
  const refs = deleted ? [] : (message.refs ?? []);
  // Files alone need no empty bubble under them.
  const hasBubble =
    (!hasCard && attachments.length === 0) || hasBody || suggested || message.editedAt !== null;
  const mine = new Set(props.reactions.flatMap((chip) => (chip.mine ? [chip.emoji] : [])));
  const receipt = deleted ? null : kinTurnReceiptLine(message.turnChanges);
  const grows = useKinTextGrows();
  const buttons = kinReplyButtons(message);
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

  // A page's card is its foot, across the page's width.
  const longPress =
    onOpenActions === null
      ? {}
      : {
          onLongPress: () => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onOpenActions();
          },
        };
  const card =
    props.group === undefined ? (
      <KinWidgetView
        widget={props.widget}
        environmentId={props.environmentId}
        viewerPersonId={props.viewerPersonId}
        onOpenLink={props.onLinkPress}
        heldFor={props.heldFor ?? null}
        readOnly={props.readOnly === true}
        {...(props.agentNames === undefined ? {} : { agentNames: props.agentNames })}
        {...longPress}
      />
    ) : (
      <KinCardGroup
        question={props.group.question}
        tasks={props.group.tasks}
        environmentId={props.environmentId}
        viewerPersonId={props.viewerPersonId}
        onOpenLink={props.onLinkPress}
        {...longPress}
      />
    );
  const page =
    hasBubble && layout !== "bubble" ? (
      <View className="w-full gap-1">
        <KinMessagePage
          body={message.body}
          links={message.links}
          embeds={message.embeds}
          where={{ environmentId: props.environmentId, orgId: message.orgId }}
          textStyle={props.markdownStyle}
          onLinkPress={props.onLinkPress}
          onOpenTarget={onOpenTarget}
          head={kinPageHead(message, props.firstName ?? null)}
          foot={hasCard ? card : null}
          // As in a bubble: the long press opens the sheet, not the system's text menu too.
          selectable={onOpenActions === null}
        />
        {wideTable ? (
          <Text textRole="caption" className="text-foreground-muted">
            Swipe the table sideways to see all of it
          </Text>
        ) : null}
        {message.editedAt !== null ? (
          <Text textRole="caption" className="text-foreground-muted">
            Edited
          </Text>
        ) : null}
      </View>
    ) : null;
  const bubble =
    hasBubble && page === null ? (
      <View
        accessible
        accessibilityLabel={kinMessageLabel(row, formatTime(message.createdAt))}
        accessibilityActions={[
          ...inApp.map((link, index) => ({ name: `kin-${index}`, label: `Open ${link.text}` })),
          ...links.map((link, index) => ({ name: `link-${index}`, label: `Open ${link.label}` })),
          ...sheetActions,
        ]}
        onAccessibilityAction={(event) => {
          const name = event.nativeEvent.actionName;
          if (name === "copy") {
            copyTextWithHaptic(kinMessageCopyText(message), { target: "kin-message" });
            return;
          }
          if (name.startsWith("react-")) {
            const emoji = KIN_REACTION_EMOJI.find((candidate) => name === `react-${candidate}`);
            if (emoji !== undefined) onReact?.(emoji);
            return;
          }
          if (name.startsWith("kin-")) {
            const target = inApp[Number(name.slice("kin-".length))];
            if (target !== undefined) onOpenTarget(target.to);
            return;
          }
          const link = links[Number(name.slice("link-".length))];
          if (link !== undefined) props.onLinkPress(link.href);
        }}
        className={cn("gap-1", row.own ? OWN_BUBBLE_CLASS_NAME : OTHER_BUBBLE_CLASS_NAME)}
      >
        {hasBody ? (
          <KinLinkedText
            markdown={message.body}
            links={message.links}
            textStyle={row.own ? props.ownMarkdownStyle : props.markdownStyle}
            // A long press opens the sheet, whose Select text offers selection instead.
            selectable={onOpenActions === null}
            onLinkPress={props.onLinkPress}
            onOpenTarget={onOpenTarget}
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
        {wideTable ? (
          <Text
            textRole="caption"
            className={row.own ? "text-user-bubble-foreground-muted" : "text-foreground-muted"}
          >
            Swipe the table sideways to see all of it
          </Text>
        ) : null}
        {suggested || message.editedAt !== null ? (
          <Text
            textRole="caption"
            className={row.own ? "text-user-bubble-foreground-muted" : "text-foreground-muted"}
          >
            {suggested ? KIN_CHAT_COPY.suggestion : "Edited"}
          </Text>
        ) : null}
      </View>
    ) : null;

  const pressablePage =
    page === null ? null : onOpenActions === null ? (
      page
    ) : (
      // The page's own headings and text stay VoiceOver's, in order; this only takes the long press.
      <Pressable
        accessible={false}
        onLongPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onOpenActions();
        }}
        className="w-full"
      >
        {page}
      </Pressable>
    );
  const framed = message.embeds?.some((embed) => embed._tag === "visual") === true;
  return (
    <View
      className={cn(
        "gap-1 px-4",
        // A page starts a new block even inside one author's run.
        layout === "bubble" ? rowSpacing(row.continues) : "pt-5",
        row.own ? "items-end" : "items-start",
      )}
    >
      {row.showAuthor && !props.direct && message.author._tag !== "system" ? (
        <KinAuthorLine
          label={row.authorLabel}
          avatar={kinAuthorAvatar(message.author)}
          onPress={
            message.author._tag === "human" && props.onOpenPerson !== undefined
              ? () =>
                  message.author._tag === "human" && props.onOpenPerson?.(message.author.personId)
              : undefined
          }
        />
      ) : null}
      {attachments.length > 0 ? (
        <KinAttachments
          attachments={attachments}
          environmentId={props.environmentId}
          onPressPreview={props.onPressPreview}
        />
      ) : null}
      {refs.length === 0 ? null : (
        <KinDocRefs
          refs={refs}
          environmentId={props.environmentId}
          orgId={message.orgId}
          own={row.own}
        />
      )}
      {page === null ? null : framed ? (
        <KinFramesInView>{pressablePage}</KinFramesInView>
      ) : (
        pressablePage
      )}
      {bubble === null ? null : onOpenActions === null ? (
        <View className={row.own ? OWN_WIDTH_CLASS_NAME : OTHER_WIDTH_CLASS_NAME}>{bubble}</View>
      ) : (
        // The bubble inside stays the VoiceOver element; this only takes the long press.
        <Pressable
          accessible={false}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onOpenActions();
          }}
          className={cn(
            "active:opacity-60",
            row.own ? OWN_WIDTH_CLASS_NAME : OTHER_WIDTH_CLASS_NAME,
          )}
        >
          {bubble}
        </Pressable>
      )}
      {hasCard && page === null ? <View className="w-[85%]">{card}</View> : null}
      {buttons.length === 0 ? null : (
        <KinReplyButtons buttons={buttons} onOpenTarget={onOpenTarget} />
      )}
      {receipt === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={kinTurnReceiptOpen(receipt)}
          hitSlop={8}
          onPress={props.onOpenReceipt}
          className="max-w-full px-1 active:opacity-60"
        >
          <Text
            textRole="caption"
            numberOfLines={kinLines(1, grows)}
            className="text-foreground-muted"
          >
            {receipt}
          </Text>
        </Pressable>
      )}
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
                  : `${chip.label}. ${chip.mine ? KIN_REACTION_COPY.remove : KIN_REACTION_COPY.add}`
              }
              onPress={onReact === null ? undefined : () => onReact(chip.emoji)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Up to three buttons under an agent's reply, each opening what it named; they wrap, never cut. */
function KinReplyButtons(props: {
  readonly buttons: ReadonlyArray<KinReplyButton>;
  readonly onOpenTarget: ReturnType<typeof useKinOpenTarget>;
}) {
  return (
    <View className="max-w-full flex-row flex-wrap gap-2 px-1 pt-1">
      {props.buttons.map((button) => (
        <Button
          key={button.id}
          label={button.label}
          tone="outline"
          {...(button.note === null ? {} : { accessibilityHint: button.note })}
          onPress={() => props.onOpenTarget(button.to)}
        />
      ))}
    </View>
  );
}

/** Tells a page's frames whether its row is on screen, so only those load a WebView. */
function KinFramesInView(props: { readonly children: ReactNode }) {
  const [inView, setInView] = useState(false);
  useViewabilityAmount(useCallback((token) => setInView(token.sizeVisible > 0), []));
  return <KinVisualInView value={inView}>{props.children}</KinVisualInView>;
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
  const text = kinDraftMarkdown(row.draft.text);
  const page = kinPageShape(text) === "page" || text !== row.draft.text;
  return (
    <View className={cn("items-start gap-1 px-4", rowSpacing(row.continues))}>
      {row.showAuthor && !props.direct ? (
        <KinAuthorLine label={row.authorLabel} avatar={kinAgentAvatar(row.draft.agentId)} />
      ) : null}
      <View
        accessible
        accessibilityLabel={kinSentences([
          `${row.authorLabel}, agent`,
          kinPlainText(text),
          "Still writing",
        ])}
        className={page ? "w-full" : cn("gap-1", OTHER_WIDTH_CLASS_NAME, OTHER_BUBBLE_CLASS_NAME)}
      >
        {page ? (
          <KinMessagePage
            body={text}
            links={undefined}
            embeds={undefined}
            where={null}
            textStyle={props.markdownStyle}
            onLinkPress={props.onLinkPress}
            onOpenTarget={NO_TARGET}
            head={null}
          />
        ) : (
          <SelectableMarkdownText
            markdown={kinBodyMarkdown(text)}
            textStyle={props.markdownStyle}
            preserveSoftBreaks
            onLinkPress={props.onLinkPress}
            renderImage={renderImageAsText}
            resolveImageSource={kinImageSource}
          />
        )}
      </View>
    </View>
  );
}

/** A line from Kin itself, such as a reply that failed. */
export function KinSystemLine(props: {
  readonly row: SystemRow;
  /** Sends the owner's unanswered message again; null shows the line alone. */
  readonly onRetry: (() => void) | null;
  /** Opens the task or project the line names, when it names one. */
  readonly onOpen: (open: KinNoticeOpen) => void;
  /** Opens the Team-room discussion the line names; null when there is no room to open. */
  readonly onOpenDiscussion: ((discussionId: string) => void) | null;
}) {
  const { open, discussionId } = props.row;
  const onOpenDiscussion = props.onOpenDiscussion;
  return (
    <View className="items-center gap-2 px-8 py-2">
      <Text textRole="caption" className="text-center text-foreground-muted">
        {props.row.text}
      </Text>
      {open === null ? null : (
        <Chip
          label={open.label}
          size="small"
          icon={open.kind === "project" ? "folder.fill" : "checkmark.circle"}
          onPress={() => props.onOpen(open)}
        />
      )}
      {discussionId === null || onOpenDiscussion === null ? null : (
        <Chip
          label={KIN_CARD_COPY.openDiscussion}
          size="small"
          icon="bubble.left.and.bubble.right"
          onPress={() => onOpenDiscussion(discussionId)}
        />
      )}
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

/**
 * One agent's words in another's chat. What it asked sits on the viewer's side and the answer on
 * the other, each folded to its first line as the thread feed folds a message from another
 * thread; a Team-room outcome keeps its way to the discussion in view, folded or not.
 */
export function KinRelayBubble(props: {
  readonly row: RelayRow;
  readonly environmentId: EnvironmentId;
  readonly markdownStyle: NativeMarkdownTextStyle;
  readonly onLinkPress: (href: string) => void;
  /** Opens the Team room; null when there is none to open. */
  readonly onOpenDiscussion: (() => void) | null;
}) {
  const { row } = props;
  const [expanded, setExpanded] = useState(false);
  const iconSubtleColor =
    StyleSheet.flatten(useResolveClassNames("text-icon-subtle"))?.color ?? "gray";
  const time = formatTime(row.message.createdAt);
  const text = kinPlainText(row.message.body);
  // A person's words an agent passed on: whose they are and who brought them, the words open.
  if (row.personLabel !== undefined) {
    const words = kinPlainText(row.text ?? row.message.body);
    return (
      <View className="items-start px-4 pt-3">
        <View
          accessible
          accessibilityLabel={`Sent by ${row.personLabel}, via ${row.agentLabel}, ${time}: ${words}`}
          className={cn(OTHER_WIDTH_CLASS_NAME, OTHER_BUBBLE_CLASS_NAME, "gap-1")}
        >
          <View className="flex-row flex-wrap items-center gap-1.5">
            <SymbolView
              name="bubble.left.and.bubble.right"
              size={12}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
            <Text textRole="caption" className="text-foreground">
              Sent by {row.personLabel}
            </Text>
            <Text textRole="caption" className="text-foreground-muted">
              via {row.agentLabel} · {time}
            </Text>
          </View>
          <Text textRole="body" selectable className="text-foreground">
            {words}
          </Text>
        </View>
      </View>
    );
  }
  const body = row.message.body;
  const sent = row.relay === "sent_by";
  const label = sent ? `Sent by ${row.agentLabel}` : `${row.agentLabel} replied`;
  // A Team-room outcome is its decision line, then "Done: …"; split before plain text joins them.
  const [line = "", ...rest] = body.split("\n");
  const done = row.discussionId === null ? "" : kinPlainText(rest.join("\n")).trim();
  const markdown = (source: string) => (
    <SelectableMarkdownText
      markdown={kinBodyMarkdown(source)}
      textStyle={props.markdownStyle}
      preserveSoftBreaks
      onLinkPress={props.onLinkPress}
      renderImage={renderImageAsText}
      resolveImageSource={kinImageSource}
    />
  );
  const words = sent ? (
    <Text textRole="body" selectable className="text-user-bubble-foreground">
      {text}
    </Text>
  ) : row.discussionId === null ? (
    markdown(body)
  ) : (
    <>
      {markdown(line)}
      {done === "" ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {done}
        </Text>
      )}
    </>
  );
  const seeHow =
    row.discussionId === null || props.onOpenDiscussion === null ? null : (
      <Pressable
        accessibilityRole="link"
        hitSlop={8}
        className="min-h-8 justify-center self-start"
        onPress={props.onOpenDiscussion}
      >
        <Text textRole="footnote" className="text-foreground-muted underline">
          {KIN_CARD_COPY.seeHow}
        </Text>
      </Pressable>
    );
  // Folded as the thread feed folds a message from another thread: all of it is in its own chat.
  if (row.summary !== null)
    return (
      <View className={cn("px-4 pt-3", sent ? "items-end" : "items-start")}>
        <View
          className={cn(
            sent ? OWN_WIDTH_CLASS_NAME : OTHER_WIDTH_CLASS_NAME,
            "min-w-0 rounded-[20px]",
            sent ? "bg-user-bubble" : "border border-separator",
            expanded && "w-[85%]",
          )}
        >
          <AgentMessageFoldHeader
            environmentId={props.environmentId}
            label={label}
            summary={row.summary}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
            iconSubtleColor={iconSubtleColor}
            reply={!sent}
          />
          {expanded ? <View className="gap-1 px-3.5 pb-2.5">{words}</View> : null}
          {seeHow === null ? null : <View className="px-3.5 pb-1.5">{seeHow}</View>}
        </View>
      </View>
    );
  // Held open: a reply holding a card, a figure, or a question to answer.
  return (
    <View className="items-start px-4 pt-3">
      <View
        className={cn(
          OTHER_WIDTH_CLASS_NAME,
          "gap-1 rounded-[20px] border border-separator px-4 py-2.5",
        )}
      >
        {/* One element for the words, so the link below stays its own for VoiceOver. */}
        <View accessible accessibilityLabel={`${label}, ${time}: ${text}`} className="gap-1">
          <View className="flex-row items-center gap-1.5">
            <SymbolView
              name="arrow.uturn.backward"
              size={12}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
            <Text textRole="caption" className="text-foreground-muted">
              {label} · {time}
            </Text>
          </View>
          {row.discussionId === null && kinPageShape(body) === "page" ? (
            // Its figures draw in place, as they do in the chat it came from.
            <KinMessagePage
              body={body}
              links={undefined}
              embeds={undefined}
              where={null}
              textStyle={props.markdownStyle}
              onLinkPress={props.onLinkPress}
              onOpenTarget={NO_TARGET}
              head={null}
            />
          ) : (
            words
          )}
        </View>
        {seeHow}
      </View>
    </View>
  );
}

/** The owner's message before the host has it: sending, waiting for a connection, or refused. */
export function KinPendingBubble(props: {
  readonly entry: KinOutboxEntry;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly connected: boolean;
  /** The row above is the viewer's own bubble. */
  readonly continues: boolean;
  /** Puts the body back in the draft and drops the unsent message. */
  readonly onEdit: () => void;
  readonly onDiscard: () => void;
}) {
  const { entry } = props;
  const failed = entry.state === "failed";
  const [now, setNow] = useState(() => Date.now());
  const pending = kinPendingStatus(entry, props.connected, now);
  const stuck = pending.kind === "stuck";
  const queued = pending.kind === "waiting" || stuck;
  const status = pending.text;
  const turnsIn = pending.kind === "failed" || stuck ? null : (pending.stuckInMs ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one repaint when a wait turns into "Not sent yet"
  useEffect(() => {
    if (turnsIn === null) return;
    const timer = setTimeout(() => setNow(Date.now()), turnsIn);
    return () => clearTimeout(timer);
  }, [turnsIn]);
  const attachments = entry.attachments ?? [];
  const refs = entry.refs ?? [];
  // Only while it reads as refused or waiting: a "Sending…" bubble is on its way.
  const editable = (failed || queued) && kinOutboxRetractable(entry);
  // Edit keeps only the text, so a message with files or doc references is only deleted.
  const canEdit = editable && attachments.length === 0 && refs.length === 0;
  const hasBody = entry.body.trim().length > 0;
  const remove = () =>
    Dialog.confirm({
      title: "Delete this message?",
      message: failed ? "It was never sent." : "It hasn't been sent yet.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: props.onDiscard,
    });
  return (
    <View className={cn("items-end gap-1 px-4", rowSpacing(props.continues))}>
      {attachments.length > 0 ? (
        <View className={failed ? undefined : "opacity-70"}>
          <KinAttachments
            attachments={attachments}
            environmentId={props.environmentId}
            onPressPreview={props.onPressPreview}
            unposted
          />
        </View>
      ) : null}
      {refs.length === 0 ? null : (
        <KinDocRefs refs={refs} environmentId={props.environmentId} orgId={props.orgId} own />
      )}
      {hasBody ? (
        <Pressable
          disabled={!editable}
          onPress={canEdit ? props.onEdit : remove}
          onLongPress={editable ? remove : undefined}
          accessibilityRole={editable ? "button" : undefined}
          accessibilityLabel={kinSentences([`You: ${kinPlainText(entry.body)}`, status])}
          accessibilityHint={
            canEdit
              ? "Edit it in the message box. Touch and hold to delete it."
              : editable
                ? "Deletes it."
                : undefined
          }
          accessibilityActions={editable ? [{ name: "delete", label: "Delete" }] : undefined}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "delete") remove();
          }}
          className={cn(OWN_WIDTH_CLASS_NAME, OWN_BUBBLE_CLASS_NAME, !failed && "opacity-70")}
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
        {stuck && hasBody ? (
          <Pressable onPress={() => void Clipboard.setStringAsync(entry.body)} hitSlop={12}>
            <Text textRole="caption" className="font-t3-medium text-foreground">
              {KIN_OUTBOX_STATUS.copy}
            </Text>
          </Pressable>
        ) : null}
        {stuck ? (
          <Pressable onPress={() => void kinOutbox.deliver(props.environmentId)} hitSlop={12}>
            <Text textRole="caption" className="font-t3-medium text-foreground">
              {KIN_RETRY}
            </Text>
          </Pressable>
        ) : null}
        {hasBody && canEdit ? (
          <Pressable onPress={props.onEdit} hitSlop={12}>
            <Text textRole="caption" className="font-t3-medium text-foreground">
              Edit
            </Text>
          </Pressable>
        ) : null}
        {editable && !(hasBody && canEdit) ? (
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
      className="items-center px-8 pt-5"
    >
      <Text textRole="caption" className="text-foreground-muted">
        {props.row.label}
      </Text>
    </View>
  );
}
