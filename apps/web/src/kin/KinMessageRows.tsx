import {
  kinBodyMarkdown,
  kinMessageLabel,
  kinPlainText,
  type KinFeedRow,
} from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinMessageSummary } from "@t3tools/client-runtime/kin/kinAttachments";
import { kinCardDraws } from "@t3tools/client-runtime/kin/kinCardPresentation";
import type { KinOutboxEntry } from "@t3tools/client-runtime/kin/kinOutbox";
import { KIN_REACTION_NAMES, type KinReactionChip } from "@t3tools/client-runtime/kin/kinReactions";
import { kinAuthorAvatar } from "@t3tools/client-runtime/kin/kinGroups";
import {
  kinAgentAvatar,
  kinSentences,
  type KinAvatarView,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { KinAvatar } from "./KinAvatar";
import {
  KIN_REACTION_EMOJI,
  type EnvironmentId,
  type KinPersonId,
  type KinReactionEmoji,
  type KinWidget,
} from "@t3tools/contracts";
import { SmilePlusIcon } from "lucide-react";

import ChatMarkdown from "../components/ChatMarkdown";
import { WorkGroupHeader } from "../components/chat/TimelineWorkGroupRows";
import { Button } from "../components/ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { cn } from "../lib/utils";
import { KinCard } from "./KinCards";
import { KinMessageAttachments } from "./KinMessageAttachments";

type MessageRow = Extract<KinFeedRow, { readonly type: "message" }>;
type DraftRow = Extract<KinFeedRow, { readonly type: "draft" }>;
type FoldRow = Extract<KinFeedRow, { readonly type: "fold" }>;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export const formatKinMessageTime = (iso: string) => timeFormat.format(new Date(iso));
const formatTime = formatKinMessageTime;

const ROW = "mx-auto flex w-full max-w-3xl flex-col gap-1 px-4";
// Tight inside one author's run, a clear step between authors.
const rowSpacing = (continues: boolean) => (continues ? "pt-0.5" : "pt-3");
// The viewer's message in the thread's user bubble; everyone else's on a quieter surface.
const BUBBLE =
  "min-w-0 max-w-[85%] rounded-2xl bg-message px-3.5 py-2 text-sm text-message-foreground";
// Dark accent is a 4% hover wash that vanishes on the black canvas, so dark takes the raised tone.
const OTHER_BUBBLE =
  "min-w-0 max-w-[85%] rounded-2xl bg-accent px-3.5 py-2 text-sm text-foreground dark:bg-card";

/** Who and when, over the first bubble of a group. The bubble's own label reads both aloud. */
function HeadLine(props: { readonly label: string; readonly avatar?: KinAvatarView | null }) {
  return (
    <p
      aria-hidden
      className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground tabular-nums"
    >
      {props.avatar == null ? null : <KinAvatar avatar={props.avatar} size="xs" />}
      {props.label}
    </p>
  );
}

function KinBody(props: { readonly markdown: string; readonly environmentId: EnvironmentId }) {
  return (
    <ChatMarkdown
      text={kinBodyMarkdown(props.markdown)}
      cwd={undefined}
      environmentId={props.environmentId}
      lineBreaks
    />
  );
}

/** One message: the viewer's own sit right, others left; `head` names who and when over a group. */
export function KinMessageRow(props: {
  readonly row: MessageRow;
  readonly head: string | null;
  /** A direct chat names nobody over a bubble, so it draws no author's face either. */
  readonly direct: boolean;
  readonly widget: KinWidget | undefined;
  readonly environmentId: EnvironmentId;
  readonly viewerPersonId: KinPersonId | null;
  readonly reactions: ReadonlyArray<KinReactionChip>;
  /** Toggles the viewer's reaction; null where they can't react, such as a privileged card. */
  readonly onReact: ((emoji: KinReactionEmoji) => void) | null;
  readonly previewKey: string;
}) {
  const { row, onReact } = props;
  const { message } = row;
  const deleted = message.status === "deleted";
  const suggested = message.status === "suggested";
  const hasBody = !deleted && message.body.trim().length > 0;
  const hasCard =
    !deleted &&
    message.widgetId !== null &&
    kinCardDraws(props.widget, props.environmentId, hasBody);
  const attachments = deleted ? [] : (message.attachments ?? []);
  // Files alone need no bubble; a deleted or edited message still says so in one.
  const hasBubble =
    hasBody ||
    suggested ||
    message.editedAt !== null ||
    (!hasCard && (deleted || attachments.length === 0));
  const mine = new Set(props.reactions.flatMap((chip) => (chip.mine ? [chip.emoji] : [])));
  const canReact = onReact !== null && !deleted;

  return (
    <div
      className={cn(
        ROW,
        rowSpacing(row.continues),
        "group/kin-message",
        row.own ? "items-end" : "items-start",
      )}
    >
      {props.head === null ? null : (
        <HeadLine
          label={props.head}
          avatar={
            row.showAuthor && !props.direct && message.author._tag !== "system"
              ? kinAuthorAvatar(message.author)
              : null
          }
        />
      )}
      {attachments.length === 0 ? null : (
        <div
          role={hasBubble ? undefined : "article"}
          aria-label={hasBubble ? undefined : kinMessageLabel(row, formatTime(message.createdAt))}
        >
          <KinMessageAttachments
            environmentId={props.environmentId}
            attachments={attachments}
            previewKey={props.previewKey}
          />
        </div>
      )}
      <div className={cn("flex w-full items-center gap-1", row.own && "flex-row-reverse")}>
        {hasBubble ? (
          <div
            role="article"
            aria-label={kinMessageLabel(row, formatTime(message.createdAt))}
            className={row.own ? BUBBLE : OTHER_BUBBLE}
          >
            {hasBody ? (
              <KinBody markdown={message.body} environmentId={props.environmentId} />
            ) : deleted ? (
              <p className="italic text-muted-foreground">Message deleted</p>
            ) : null}
            {suggested || message.editedAt !== null ? (
              <p className="pt-0.5 text-xs text-muted-foreground">
                {suggested ? "Suggestion, not sent yet" : "Edited"}
              </p>
            ) : null}
          </div>
        ) : null}
        {canReact && (hasBubble || !hasCard) ? (
          <KinReactMenu mine={mine} onReact={onReact} />
        ) : null}
      </div>
      {hasCard ? (
        <div className="flex w-full items-start gap-1">
          <div className="min-w-0 max-w-[85%] flex-1">
            <KinCard
              widget={props.widget}
              environmentId={props.environmentId}
              viewerPersonId={props.viewerPersonId}
            />
          </div>
          {canReact && !hasBubble ? <KinReactMenu mine={mine} onReact={onReact} /> : null}
        </div>
      ) : null}
      {props.reactions.length > 0 ? (
        <div className={cn("flex flex-wrap gap-1 px-1", row.own && "justify-end")}>
          {props.reactions.map((chip) => (
            <Button
              key={chip.emoji}
              size="micro"
              variant={chip.mine ? "secondary" : "outline"}
              aria-pressed={chip.mine}
              aria-label={
                onReact === null
                  ? chip.label
                  : `${chip.label}. ${chip.mine ? "Remove your reaction" : "Add yours"}`
              }
              disabled={onReact === null}
              onClick={() => onReact?.(chip.emoji)}
            >
              {chip.emoji} {chip.count}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function KinReactMenu(props: {
  readonly mine: ReadonlySet<KinReactionEmoji>;
  readonly onReact: (emoji: KinReactionEmoji) => void;
}) {
  return (
    <span className="opacity-0 group-hover/kin-message:opacity-100 focus-within:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
      <Menu>
        <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label="React" />}>
          <SmilePlusIcon />
        </MenuTrigger>
        <MenuPopup align="start">
          {KIN_REACTION_EMOJI.map((emoji) => (
            <MenuCheckboxItem
              key={emoji}
              checked={props.mine.has(emoji)}
              onCheckedChange={() => props.onReact(emoji)}
            >
              {emoji} {KIN_REACTION_NAMES[emoji]}
            </MenuCheckboxItem>
          ))}
        </MenuPopup>
      </Menu>
    </span>
  );
}

/** A reply still streaming, laid out as its message will be so nothing moves when it lands. */
export function KinDraftRow(props: {
  readonly row: DraftRow;
  readonly environmentId: EnvironmentId;
  /** A direct chat has one lead, so its reply needs no name. */
  readonly direct: boolean;
}) {
  const { row } = props;
  return (
    <div className={cn(ROW, rowSpacing(row.continues), "items-start")}>
      {row.showAuthor && !props.direct ? (
        <HeadLine label={row.authorLabel} avatar={kinAgentAvatar(row.draft.agentId)} />
      ) : null}
      <div
        role="article"
        aria-label={kinSentences([
          `${row.authorLabel}, agent`,
          kinPlainText(row.draft.text),
          "Still writing",
        ])}
        className={OTHER_BUBBLE}
      >
        <KinBody markdown={row.draft.text} environmentId={props.environmentId} />
      </div>
    </div>
  );
}

/** A line from Kin itself, such as a reply that failed: muted, centred, never a bubble. */
export function KinSystemRow(props: {
  readonly body: string;
  /** Sends the owner's unanswered message again; null shows the line alone. */
  readonly onRetry: (() => void) | null;
}) {
  return (
    <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-8 py-1">
      <p className="text-center text-xs text-muted-foreground">{props.body}</p>
      {props.onRetry === null ? null : (
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function KinDayRow(props: { readonly label: string }) {
  return (
    <p
      role="separator"
      className="mx-auto max-w-3xl px-4 pt-4 text-center text-xs font-medium text-muted-foreground"
    >
      {props.label}
    </p>
  );
}

const joinNames = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "Agents")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

// The decision is markdown; the fold line shows its first line as plain text.
const firstLine = (markdown: string) =>
  markdown
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.replace(/[*_`#>]/g, "")
    .trim() ?? "";

/** Folded agent talk, as T3's work-group row: who talked, what they settled, how much. */
export function KinFoldRow(props: { readonly row: FoldRow; readonly onToggle: () => void }) {
  const { row } = props;
  const decision = row.decision === null ? null : firstLine(row.decision);
  const label = [`${joinNames(row.authors)} talked it over`, decision, `${row.count} messages`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-1">
      <WorkGroupHeader
        label={label}
        iconName="message-circle"
        expanded={row.expanded}
        onToggle={props.onToggle}
      />
    </div>
  );
}

/** The viewer's message before the host has it: sending, waiting for a connection, or refused. */
export function KinPendingRow(props: {
  readonly entry: KinOutboxEntry;
  readonly connected: boolean;
  readonly environmentId: EnvironmentId;
  readonly previewKey: string;
  /** The row above is the viewer's own bubble. */
  readonly continues: boolean;
  /** Puts the body back in the composer and drops the refused send. */
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
  const label = kinSentences([`You: ${kinPlainText(kinMessageSummary(entry))}`, status]);
  return (
    <div className={cn(ROW, rowSpacing(props.continues), "items-end")}>
      {attachments.length === 0 ? null : (
        <div
          role={hasBody ? undefined : "article"}
          aria-label={hasBody ? undefined : label}
          className={cn(!failed && "opacity-70")}
        >
          <KinMessageAttachments
            environmentId={props.environmentId}
            attachments={attachments}
            previewKey={props.previewKey}
          />
        </div>
      )}
      {hasBody ? (
        <div
          role="article"
          aria-label={label}
          className={cn(BUBBLE, "whitespace-pre-wrap", !failed && "opacity-70")}
        >
          {entry.body}
        </div>
      ) : null}
      <div className="flex items-center gap-1 px-1">
        <span
          role={failed ? "alert" : undefined}
          className={cn(
            "text-xs",
            failed ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {status}
        </span>
        {failed ? (
          <>
            {hasBody ? (
              <Button size="micro" variant="ghost" onClick={props.onEdit}>
                Edit
              </Button>
            ) : null}
            <Button size="micro" variant="ghost-destructive" onClick={props.onDiscard}>
              Delete
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
