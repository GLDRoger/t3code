import {
  kinBodyMarkdown,
  kinMessageLabel,
  kinPlainText,
  type KinFeedRow,
  type KinNoticeOpen,
  KIN_CHAT_COPY,
} from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinMessageSummary } from "@t3tools/client-runtime/kin/kinAttachments";
import { kinTurnReceiptLine } from "@t3tools/client-runtime/kin/kinTurnReceipt";
import { kinCardDraws, KIN_CARD_COPY } from "@t3tools/client-runtime/kin/kinCardPresentation";
import {
  kinDraftMarkdown,
  kinMessageLayout,
  kinPageHead,
} from "@t3tools/client-runtime/kin/kinMessagePage";
import { kinDocRefLabel } from "@t3tools/client-runtime/kin/kinDocs";
import {
  KIN_OUTBOX_STATUS,
  kinPendingStatus,
  type KinOutboxEntry,
} from "@t3tools/client-runtime/kin/kinOutbox";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_REACTION_NAMES, type KinReactionChip } from "@t3tools/client-runtime/kin/kinReactions";
import { kinAuthorAvatar } from "@t3tools/client-runtime/kin/kinGroups";
import {
  kinAgentAvatar,
  kinSentences,
  type KinAvatarView,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { KinAvatar } from "./KinAvatar";
import { kinOutbox } from "./kinOutbox";
import { openKinProfile } from "./KinProfileSheet";
import {
  kinPageShape,
  KIN_REACTION_EMOJI,
  KinOrgId,
  type EnvironmentId,
  type KinMessageRef,
  type KinPersonId,
  type KinReactionEmoji,
  type KinWidget,
  kinWhenFormat,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FileTextIcon, MessagesSquareIcon, ReplyIcon, SmilePlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { FoldedMessageHeader } from "../components/chat/TimelineUserMessageRow";
import { WorkGroupHeader } from "../components/chat/TimelineWorkGroupRows";
import { Button } from "../components/ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { cn } from "../lib/utils";
import { KinCard } from "./KinCards";
import { KinCardGroup } from "./KinCardGroup";
import { KinMessageAttachments } from "./KinMessageAttachments";
import { KinLinkedMarkdown, KinMessagePage } from "./KinMessagePage";
import { KinTurnReceipt } from "./KinTurnReceipt";

type MessageRow = Extract<KinFeedRow, { readonly type: "message" }>;
type DraftRow = Extract<KinFeedRow, { readonly type: "draft" }>;
type FoldRow = Extract<KinFeedRow, { readonly type: "fold" }>;
type RelayRow = Extract<KinFeedRow, { readonly type: "relay" }>;

const timeFormat = kinWhenFormat("time");
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
function HeadLine(props: {
  readonly label: string;
  readonly avatar?: KinAvatarView | null;
  /** A person's name opens their profile. */
  readonly onOpen?: (() => void) | undefined;
}) {
  const content = (
    <>
      {props.avatar == null ? null : <KinAvatar avatar={props.avatar} size="xs" />}
      {props.label}
    </>
  );
  const line = "flex items-center gap-1.5 px-1 text-xs text-muted-foreground tabular-nums";
  if (props.onOpen === undefined)
    return (
      <p aria-hidden className={line}>
        {content}
      </p>
    );
  return (
    <button
      type="button"
      onClick={props.onOpen}
      aria-label="Open profile"
      className={cn(
        line,
        "rounded-md outline-none ring-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset",
      )}
    >
      {content}
    </button>
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

/** What a message is about, by name: "Launch plan › Pricing". */
export function KinDocRefMark(props: { readonly label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground">
      <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{props.label}</span>
    </span>
  );
}

/** The doc sections a message points at; each opens the doc there. */
function KinDocRefs(props: {
  readonly refs: ReadonlyArray<KinMessageRef>;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
}) {
  return (
    <div className="flex max-w-[85%] flex-wrap gap-1">
      {props.refs.map((ref) => {
        const label = kinDocRefLabel(ref);
        return (
          <Link
            key={`${ref.key}:${ref.section ?? ""}`}
            to="/kin/$environmentId/$orgId/docs"
            params={{ environmentId: props.environmentId, orgId: props.orgId }}
            search={{ doc: ref.key, ...(ref.section === null ? {} : { section: ref.section }) }}
            aria-label={`Open ${label}`}
            className="min-w-0 rounded-md outline-none ring-ring hover:opacity-80 focus-visible:ring-2 focus-visible:ring-inset"
          >
            <KinDocRefMark label={label} />
          </Link>
        );
      })}
    </div>
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
  readonly orgId: string;
  readonly viewerPersonId: KinPersonId | null;
  /** The card's agent by name when it is retired, so its reminders and schedules read as on hold. */
  readonly heldFor: string | null;
  readonly reactions: ReadonlyArray<KinReactionChip>;
  /** Toggles the viewer's reaction; null where they can't react, such as a privileged card. */
  readonly onReact: ((emoji: KinReactionEmoji) => void) | null;
  readonly previewKey: string;
  /** The reader's first name, for a brief's greeting. */
  readonly firstName?: string | null;
  readonly connected: boolean;
  /** The cards this row leads, drawn as one (`kinGroupCardRows`); `widget` is the first's. */
  readonly group?: {
    readonly question: KinWidget | undefined;
    readonly tasks: ReadonlyArray<KinWidget | undefined>;
  };
}) {
  const { row, onReact } = props;
  const { message } = row;
  const { author } = message;
  const deleted = message.status === "deleted";
  const suggested = message.status === "suggested";
  const hasBody = !deleted && message.body.trim().length > 0;
  const hasCard =
    !deleted &&
    message.widgetId !== null &&
    kinCardDraws(props.widget, props.environmentId, hasBody);
  const attachments = deleted ? [] : (message.attachments ?? []);
  const refs = deleted ? [] : (message.refs ?? []);
  // Files alone need no bubble; a deleted or edited message still says so in one.
  const hasBubble =
    hasBody ||
    suggested ||
    message.editedAt !== null ||
    (!hasCard && (deleted || attachments.length === 0));
  const mine = new Set(props.reactions.flatMap((chip) => (chip.mine ? [chip.emoji] : [])));
  const canReact = onReact !== null && !deleted;
  const layout = row.own || !hasBody ? "bubble" : kinMessageLayout(message);
  const label = kinMessageLabel(row, formatTime(message.createdAt));
  const receipt = deleted ? null : kinTurnReceiptLine(message.turnChanges);
  // A page's card is its foot, across the page's width.
  const onPage = hasBubble && layout !== "bubble";
  const card =
    props.group === undefined ? (
      <KinCard
        widget={props.widget}
        environmentId={props.environmentId}
        orgId={props.orgId}
        viewerPersonId={props.viewerPersonId}
        heldFor={props.heldFor}
      />
    ) : (
      <KinCardGroup
        question={props.group.question}
        tasks={props.group.tasks}
        environmentId={props.environmentId}
        viewerPersonId={props.viewerPersonId}
      />
    );

  return (
    <div
      className={cn(
        ROW,
        // A page starts a new block even inside one author's run.
        layout === "bubble" ? rowSpacing(row.continues) : "pt-5",
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
          onOpen={
            author._tag === "human" && !row.own
              ? () =>
                  openKinProfile({
                    environmentId: props.environmentId,
                    orgId: KinOrgId.make(props.orgId),
                    personId: author.personId,
                  })
              : undefined
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
            clientMessageId={message.clientMessageId}
          />
        </div>
      )}
      {refs.length === 0 ? null : (
        <KinDocRefs refs={refs} environmentId={props.environmentId} orgId={props.orgId} />
      )}
      <div className={cn("flex w-full items-center gap-1", row.own && "flex-row-reverse")}>
        {onPage ? (
          <div className="min-w-0 flex-1">
            <KinMessagePage
              environmentId={props.environmentId}
              orgId={props.orgId}
              body={message.body}
              links={message.links}
              embeds={message.embeds}
              label={label}
              head={kinPageHead(message, props.firstName ?? null)}
              foot={hasCard ? card : null}
            />
            {message.editedAt !== null ? (
              <p className="pt-0.5 text-xs text-muted-foreground">Edited</p>
            ) : null}
          </div>
        ) : hasBubble ? (
          <div role="article" aria-label={label} className={row.own ? BUBBLE : OTHER_BUBBLE}>
            {hasBody ? (
              <KinLinkedMarkdown
                markdown={message.body}
                links={message.links}
                environmentId={props.environmentId}
                orgId={props.orgId}
              />
            ) : deleted ? (
              <p className="italic text-muted-foreground">Message deleted</p>
            ) : null}
            {suggested || message.editedAt !== null ? (
              <p className="pt-0.5 text-xs text-muted-foreground">
                {suggested ? KIN_CHAT_COPY.suggestion : "Edited"}
              </p>
            ) : null}
          </div>
        ) : null}
        {canReact && (hasBubble || !hasCard) ? (
          <KinReactMenu mine={mine} onReact={onReact} />
        ) : null}
      </div>
      {hasCard && !onPage ? (
        <div className="flex w-full items-start gap-1">
          <div className="min-w-0 max-w-[85%] flex-1">{card}</div>
          {canReact && !hasBubble ? <KinReactMenu mine={mine} onReact={onReact} /> : null}
        </div>
      ) : null}
      {receipt === null ? null : (
        <KinTurnReceipt
          line={receipt}
          turnChanges={message.turnChanges}
          links={message.links}
          environmentId={props.environmentId}
          orgId={props.orgId}
          connected={props.connected}
        />
      )}
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
  readonly orgId: string;
  /** A direct chat has one lead, so its reply needs no name. */
  readonly direct: boolean;
}) {
  const { row } = props;
  const text = kinDraftMarkdown(row.draft.text);
  const label = kinSentences([`${row.authorLabel}, agent`, kinPlainText(text), "Still writing"]);
  return (
    <div className={cn(ROW, rowSpacing(row.continues), "items-start")}>
      {row.showAuthor && !props.direct ? (
        <HeadLine label={row.authorLabel} avatar={kinAgentAvatar(row.draft.agentId)} />
      ) : null}
      {kinPageShape(text) === "page" || text !== row.draft.text ? (
        <KinMessagePage
          environmentId={props.environmentId}
          orgId={props.orgId}
          body={text}
          links={undefined}
          embeds={undefined}
          label={label}
          head={null}
        />
      ) : (
        <div role="article" aria-label={label} className={OTHER_BUBBLE}>
          <KinBody markdown={text} environmentId={props.environmentId} />
        </div>
      )}
    </div>
  );
}

/** A line from Kin itself, such as a reply that failed: muted, centred, never a bubble. */
export function KinSystemRow(props: {
  readonly body: string;
  /** Sends the owner's unanswered message again; null shows the line alone. */
  readonly onRetry: (() => void) | null;
  /** The task or project the notice names, opened in Tasks; null for none. */
  readonly open?: {
    readonly target: KinNoticeOpen;
    readonly environmentId: EnvironmentId;
    readonly orgId: string;
  } | null;
}) {
  const open = props.open ?? null;
  return (
    <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-2 px-8 py-1">
      <p className="text-center text-xs text-muted-foreground">{props.body}</p>
      {open === null ? null : (
        <Button
          size="xs"
          variant="outline"
          render={
            <Link
              to="/kin/$environmentId/$orgId/tasks"
              params={{ environmentId: open.environmentId, orgId: open.orgId }}
              search={
                open.target.kind === "project"
                  ? { project: open.target.key }
                  : { task: open.target.key }
              }
            />
          }
        >
          {open.target.label}
        </Button>
      )}
      {props.onRetry === null ? null : (
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * One agent's words in another's chat. What it asked sits on the viewer's side and the answer on
 * the other, each folded to its first line as T3 folds a message from another thread; a
 * Team-room outcome keeps its way to the discussion in view, folded or not.
 */
export function KinRelayRow(props: {
  readonly row: RelayRow;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly teamRoomId: string | null;
}) {
  const { row } = props;
  const [expanded, setExpanded] = useState(false);
  const time = formatTime(row.message.createdAt);
  // A person's words an agent passed on: the header T3 gives a message from another thread,
  // naming whose words they are and who brought them; the words themselves stay open.
  if (row.personLabel !== undefined) {
    const words = row.text ?? row.message.body;
    return (
      <div className={cn(ROW, "pt-3", "items-start")}>
        <div
          role="article"
          aria-label={`Sent by ${row.personLabel}, via ${row.agentLabel}, ${time}: ${kinPlainText(words)}`}
          className="min-w-0 max-w-[85%] rounded-2xl bg-accent text-sm text-foreground dark:bg-card"
        >
          <p
            aria-hidden
            className="flex flex-wrap items-center gap-x-1.5 px-3.5 pt-2 text-xs text-muted-foreground"
          >
            <MessagesSquareIcon className="size-3.5 shrink-0" />
            <span className="font-medium text-foreground">Sent by {row.personLabel}</span>
            <span>
              via {row.agentLabel} · <span className="tabular-nums">{time}</span>
            </span>
          </p>
          <div className="px-3.5 pb-2 pt-1">
            <KinBody markdown={words} environmentId={props.environmentId} />
          </div>
        </div>
      </div>
    );
  }
  const body = row.message.body;
  const seeHow =
    row.discussionId === null || props.teamRoomId === null ? null : (
      <Link
        to="/kin/$environmentId/$orgId/$chatId"
        params={{
          environmentId: props.environmentId,
          orgId: props.orgId,
          chatId: props.teamRoomId,
        }}
        className="self-start rounded-sm text-xs text-foreground underline underline-offset-2 outline-none ring-ring hover:text-primary focus-visible:ring-2 focus-visible:ring-inset"
      >
        {KIN_CARD_COPY.seeHow}
      </Link>
    );
  // A Team-room outcome is its decision line, then "Done: …" quieter under it.
  const [line, ...rest] = body.split("\n");
  const done = row.discussionId === null ? "" : rest.join("\n").trim();
  const words =
    row.discussionId === null ? (
      <KinBody markdown={body} environmentId={props.environmentId} />
    ) : (
      <>
        <KinBody markdown={line ?? ""} environmentId={props.environmentId} />
        {done === "" ? null : <p className="text-xs text-muted-foreground">{done}</p>}
      </>
    );
  const sent = row.relay === "sent_by";
  const label = sent ? `Sent by ${row.agentLabel}` : `${row.agentLabel} replied`;
  // Folded as T3 folds a message from another thread: the whole of it is in the chat it came from.
  if (row.summary !== null)
    return (
      <div className={cn(ROW, "pt-3", sent ? "items-end" : "items-start")}>
        <div
          role="article"
          aria-label={`${label}, ${time}: ${kinPlainText(body)}`}
          className={cn(
            "flex min-w-0 max-w-[85%] flex-col rounded-2xl text-sm",
            sent ? "bg-message text-message-foreground" : "border border-border",
            expanded && "w-full",
          )}
        >
          <FoldedMessageHeader
            icon={sent ? MessagesSquareIcon : ReplyIcon}
            label={label}
            summary={row.summary}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
          {expanded ? (
            <div className="flex max-h-96 flex-col gap-1 overflow-auto px-3 pb-3">{words}</div>
          ) : null}
          {seeHow === null ? null : <div className="flex px-3 pb-2">{seeHow}</div>}
        </div>
      </div>
    );
  // Held open: a reply holding a card, a figure, or a question to answer.
  return (
    <div className={cn(ROW, "pt-3", "items-start")}>
      <div
        role="article"
        aria-label={`${label}, ${time}: ${kinPlainText(body)}`}
        className="flex min-w-0 max-w-[85%] flex-col gap-1 rounded-2xl border border-border px-3.5 py-2 text-sm"
      >
        <p aria-hidden className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ReplyIcon className="size-3.5 shrink-0" />
          {label}
          <span className="tabular-nums">· {time}</span>
        </p>
        {row.discussionId === null && kinPageShape(body) === "page" ? (
          // Its figures draw in place, as they do in the chat it came from.
          <KinMessagePage
            environmentId={props.environmentId}
            orgId={props.orgId}
            body={body}
            links={undefined}
            embeds={undefined}
            label={label}
            head={null}
          />
        ) : (
          words
        )}
        {seeHow}
      </div>
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
  readonly orgId: string;
  readonly previewKey: string;
  /** The row above is the viewer's own bubble. */
  readonly continues: boolean;
  /** Puts the body back in the composer and drops the refused send. */
  readonly onEdit: () => void;
  readonly onDiscard: () => void;
}) {
  const { entry } = props;
  const failed = entry.state === "failed";
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const pending = kinPendingStatus(entry, props.connected, now);
  const status = pending.text;
  const stuck = pending.kind === "stuck";
  const turnsIn = pending.kind === "failed" || stuck ? null : (pending.stuckInMs ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one repaint when a wait turns into "Not sent yet"
  useEffect(() => {
    if (turnsIn === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), turnsIn);
    return () => window.clearTimeout(timer);
  }, [turnsIn]);
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
            clientMessageId={entry.clientMessageId}
            unposted
          />
        </div>
      )}
      {entry.refs === undefined ? null : (
        <KinDocRefs refs={entry.refs} environmentId={props.environmentId} orgId={props.orgId} />
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
          role={failed || stuck ? "alert" : undefined}
          className={cn(
            "text-xs",
            failed ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {status}
        </span>
        {stuck ? (
          <>
            {hasBody ? (
              <Button
                size="micro"
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard.writeText(entry.body).then(() => setCopied(true))
                }
              >
                {copied ? KIN_OUTBOX_STATUS.copied : KIN_OUTBOX_STATUS.copy}
              </Button>
            ) : null}
            <Button
              size="micro"
              variant="ghost"
              onClick={() => void kinOutbox.deliver(props.environmentId)}
            >
              {KIN_RETRY}
            </Button>
          </>
        ) : null}
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
