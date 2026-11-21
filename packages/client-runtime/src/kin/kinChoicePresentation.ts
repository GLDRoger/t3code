// @effect-diagnostics globalDate:off globalTimers:off - Pure view helpers format a mail thread's date, and a held press waits on the device's timer, outside an Effect runtime.
import { kinNow } from "./kinNow.ts";
import {
  KIN_CHOICE_CARD_ACTION,
  KinChatError,
  type EnvironmentId,
  type KinConnectionSaveEdited,
  type KinConnectionSaveEditedInput,
  type KinConnectionSendEdited,
  type KinConnectionSendEditedInput,
  type KinConnectionSetSendFrom,
  type KinConnectionSetSendFromInput,
  KIN_CHOICE_CARD_TTL_MS,
  KinChoiceCardState,
  type KinPersonId,
  type KinSendCard,
  type KinSendTry,
  type KinWidget,
  type KinWidgetsActInput,
  formatKinWhen,
  kinChoiceActionNote,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { kinPersonWords } from "./kinAnswers.ts";
import { kinConnectionChange } from "./kinConnections.ts";
import {
  type KinCardNotice,
  type KinCardStatus,
  createKinCardActions,
  kinActionFailureNotice,
} from "./kinDeferralPresentation.ts";
import { formatKinTime, kinSentences } from "./kinScreenState.ts";

const KIN_CHOICE_EXPIRED_TEXT = "This question expired. Answer in the chat instead.";
const KIN_CHOICE_REPLACED_TEXT = "Replaced by a newer one.";
const kinChoiceReplacedText = (decided: { readonly name: string; readonly label: string }) =>
  `Replaced by a newer one, where ${decided.name} chose “${line(decided.label)}”.`;

export interface KinChoiceCardView {
  readonly orgId: KinWidget["orgId"];
  readonly widgetId: KinWidget["widgetId"];
  readonly revision: number;
  /** Asked for someone else: who asks, and through which agent, shown above the question. */
  readonly askedBy: string | null;
  readonly question: string;
  readonly detail: string | null;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    /** What a tap on it does, in the server's words: shown under the option. */
    readonly action: string | null;
    /** The yes or no of a yes/no pair, such as a send card's Confirm and Cancel. */
    readonly kind: "yes" | "no" | null;
  }>;
  /** A picture of what is asked about, such as a new logo: a file in the card's chat. */
  readonly image: { readonly attachmentId: string; readonly mimeType: string } | null;
  readonly answer: {
    readonly optionId: string;
    readonly label: string;
    readonly personId: KinPersonId;
  } | null;
  /** What the answer did, in the owner's words, on a card Kin asked itself. */
  readonly outcome: { readonly title: string; readonly text: string } | null;
  /** Who settled it, by name then; null from a host that doesn't say. */
  readonly decidedBy: { readonly personId: KinPersonId; readonly name: string } | null;
  /** Who undid what a default Kin took, by name then, and when; null on any other card. */
  readonly undone: {
    readonly personId: KinPersonId;
    readonly name: string;
    readonly atMs: number;
  } | null;
  /** What a send card would send, in full: shown instead of `detail`. */
  readonly send: KinSendView | null;
  /** When an unanswered card stops taking taps; the host refuses later ones. */
  readonly expiresAtMs: number;
  readonly closed: boolean;
  /** What a closed or expired card says instead of its buttons. */
  readonly closedText: string;
}

export interface KinSendView {
  /** "Email from owner@company.com", "Event in Google Calendar". */
  readonly heading: string;
  /** Labelled lines, in order: From, Account, To, Cc, Subject; or Event, Calendar, Invites. */
  readonly lines: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  /** The From and Account lines of `lines`, which an editor shows as the card does. */
  readonly from: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  /** A reply's thread as it stands, so the owner sees it is the right one. */
  readonly thread: {
    readonly subject: string;
    readonly replyingTo: string;
    readonly date: string | null;
    readonly lines: string;
  } | null;
  readonly body: string;
  /** The earlier message quoted under the body, as it goes. */
  readonly quoted: string | null;
  /** Other Froms the owner may pick before Confirm, with the one in use; empty when none. */
  readonly fromChoices: ReadonlyArray<KinSendFromChoice>;
  readonly attachments: ReadonlyArray<{ readonly name: string; readonly detail: string }>;
  /** An attached invoice says nothing about how to pay: what is missing and where to add it. */
  readonly noBank: string | null;
  /** A mail's body folds under Read the whole email on a phone, so who, what and Confirm fit. */
  readonly folds: boolean;
  /** After the tap: "Sending…", "Sent", or why it wasn't sent. */
  readonly outcome: { readonly tone: "pending" | "ok" | "error"; readonly text: string } | null;
  /** A mail's words as stored, which a person may change before it goes; null on other cards. */
  readonly edit: KinSendEditDraft | null;
  /** Who saved the words shown over the agent's draft; null while they are the agent's. */
  readonly edited: { readonly personId: KinPersonId; readonly name: string } | null;
  /**
   * On an unanswered card, that an earlier try at this mail may already have gone, and when;
   * its Confirm (`confirmId`) then needs the person's tick that they checked. Null otherwise.
   */
  readonly mayHaveGone: {
    readonly line: string;
    /** The try it is about; a tick acknowledges this one only. */
    readonly tryId: string;
    readonly at: string;
    readonly confirmId: string | null;
  } | null;
}

/** A mail card's editable words, as its form holds them: addresses comma-separated. */
export interface KinSendEditDraft {
  readonly to: string;
  readonly cc: string;
  readonly subject: string;
  readonly body: string;
}

export const KIN_SEND_EDIT_COPY = {
  edit: "Edit",
  editHint: "Change the mail's words before it goes",
  save: "Save",
  saving: "Saving…",
  send: "Send edited mail",
  sending: "Sending…",
  discard: "Discard edits",
  discarding: "Discarding…",
  closed:
    "This card closed while you were editing, so your words weren't saved. They stay here until you discard them.",
  to: "To",
  cc: "Cc",
  subject: "Subject",
  body: "Message",
  /** The body field's accessible name: the chat's own composer is "Message" too. */
  bodyName: "Mail message",
  addresses: "Separate addresses with commas.",
  attachments: "Attached files go as they are.",
  quotedLabel: "Quoted message",
  quoted: "The quoted message goes below yours as it is.",
} as const;

export const KIN_SEND_COPY = {
  noBank:
    "The company has no bank details yet, so this invoice doesn't say how to pay. Add them in Settings → Company details, then make its PDF again.",
  readAll: "Read the whole email",
  hideAll: "Hide the email",
} as const;

/** The tick a card for a mail that may already have gone needs before its Confirm. */
export const KIN_SEND_CHECKED = "I've checked the sent mail";

/** "An earlier try at this mail at 9:52 AM may already have gone…", or on another day. */
export function kinMayHaveGoneLine(at: string, now: Date = new Date()): string {
  const tried = new Date(at);
  const when =
    tried.toDateString() === now.toDateString()
      ? `at ${formatKinWhen(tried, "time")}`
      : `on ${formatKinWhen(tried, "dayTime")}`;
  return `An earlier try at this mail ${when} may already have gone. Check the account's sent mail before you confirm.`;
}

/** An open editor: the words as typed, bound to the card revision it was opened on. */
export interface KinSendEditing {
  readonly revision: number;
  /** The card's words when the editor opened: leaving with these unchanged keeps nothing. */
  readonly opened: KinSendEditDraft;
  readonly draft: KinSendEditDraft;
  /** The host's last refusal, shown under the fields. */
  readonly problem: string | null;
  /** The host refused `revision` as changed: Send waits for the card as it is now. */
  readonly stale?: true;
  /** The host acknowledged a save at `revision`: the card holds these words, whatever it shows yet. */
  readonly saved?: true;
  /** The try the host refused these typed words for, until it is ticked; the card's is its own. */
  readonly mayHaveGone?: KinSendTry;
}

export interface KinSendFromChoice {
  readonly id: string;
  /** "Billing <billing@work.example>" */
  readonly label: string;
  readonly account: string;
  readonly current: boolean;
}

const fromLabel = (address: string, name: string | null | undefined) =>
  name === null || name === undefined || name.trim() === "" ? address : `${name} <${address}>`;

const kb = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * The provider's date of a thread's last message (RFC 2822 from Gmail, ISO from Microsoft), in
 * the reader's zone; null where it gave none we can read. Nothing mailed before 1995 is real.
 */
export function kinThreadDate(raw: string | null, now: Date = kinNow()): string | null {
  if (raw === null) return null;
  const at = new Date(raw.trim());
  return Number.isNaN(at.getTime()) || at.getTime() < Date.UTC(1995, 0, 1)
    ? null
    : formatKinTime(at, now);
}

/**
 * The quote's "On <date>, <who> wrote:" line as a person reads it, in the reader's zone: the
 * provider gives the raw header date, the same one as the thread box's.
 */
/**
 * An address line in pieces that may each start a new line: after "@" and each dot of an email,
 * so a long address breaks there rather than mid-word. Joined back, it is the line unchanged.
 */
export function kinAddressPieces(value: string): ReadonlyArray<string> {
  return value
    .split(/(\s+)/u)
    .flatMap((word) => (word.includes("@") ? word.split(/(?<=[@.])(?=[^.])/u) : [word]));
}

export function kinQuotedInZone(quoted: string, raw: string | null): string {
  if (raw === null || !quoted.startsWith(`On ${raw}, `)) return quoted;
  const at = new Date(raw.trim());
  if (Number.isNaN(at.getTime()) || at.getTime() < Date.UTC(1995, 0, 1)) return quoted;
  const day = formatKinWhen(at, "dayYear");
  const time = formatKinWhen(at, "time");
  return `On ${day} at ${time}, ${quoted.slice(`On ${raw}, `.length)}`;
}

function kinSendView(send: KinSendCard, now: Date, confirmId: string | null): KinSendView {
  // Cards from before accounts carry only the account, in `from`.
  const account = send.account === undefined ? send.from : send.account;
  const legacy = send.account === undefined ? (send.from === null ? "" : ` from ${send.from}`) : "";
  const heading =
    send.action === "event"
      ? `Event in ${send.service}${legacy}`
      : send.action === "call"
        ? `${send.service}${legacy}`
        : `${send.action === "reply" ? "Reply in this thread" : "New email"}${legacy}`;
  const fromLines =
    send.account === undefined || send.from === null
      ? []
      : [
          { label: "From", value: fromLabel(send.from, send.fromName) },
          ...(account === null || account.toLowerCase() === send.from.toLowerCase()
            ? []
            : [{ label: "Account", value: account }]),
        ];
  const lines =
    send.action === "event"
      ? [
          { label: "Event", value: send.subject },
          ...(send.account === undefined || account === null
            ? []
            : [{ label: "Calendar", value: account }]),
          { label: "Invites", value: send.to.length === 0 ? "No one" : send.to.join(", ") },
        ]
      : send.action === "call"
        ? [{ label: "Tool", value: send.subject }]
        : [
            ...fromLines,
            { label: "To", value: send.to.join(", ") },
            ...(send.cc.length === 0 ? [] : [{ label: "Cc", value: send.cc.join(", ") }]),
            { label: "Subject", value: send.subject },
          ];
  const choices = send.fromChoices ?? [];
  return {
    heading,
    lines,
    from: send.action === "email" || send.action === "reply" ? fromLines : [],
    thread:
      send.thread === undefined || send.thread === null
        ? null
        : { ...send.thread, date: kinThreadDate(send.thread.date, now) },
    body: send.body,
    quoted: send.quoted == null ? null : kinQuotedInZone(send.quoted, send.thread?.date ?? null),
    fromChoices: choices.map((choice) => ({
      id: choice.id,
      label: fromLabel(choice.address, choice.name),
      account: choice.account,
      current:
        choice.address.toLowerCase() === (send.from ?? "").toLowerCase() &&
        choice.account === account,
    })),
    attachments: send.attachments.map((file) => ({
      name: file.name,
      detail: [file.label, kb(file.bytes)].filter((part) => part !== null).join(" · "),
    })),
    noBank: send.attachments.some((file) => file.bankMissing === true)
      ? KIN_SEND_COPY.noBank
      : null,
    folds: send.action === "email" || send.action === "reply",
    outcome:
      send.outcome === null
        ? null
        : send.outcome.state === "sending"
          ? { tone: "pending", text: "Sending…" }
          : send.outcome.state === "sent"
            ? { tone: "ok", text: send.action === "event" ? "Saved and invitations sent" : "Sent" }
            : // Kin's reason says what happened, including "may or may not have gone".
              { tone: "error", text: send.outcome.reason ?? "Not sent: Kin couldn't send it." },
    edit:
      send.action === "email" || send.action === "reply"
        ? {
            to: send.to.join(", "),
            cc: send.cc.join(", "),
            subject: send.subject,
            body: send.body,
          }
        : null,
    edited: send.edited ?? null,
    mayHaveGone:
      send.mayHaveGone === undefined || send.outcome !== null
        ? null
        : {
            line: kinMayHaveGoneLine(send.mayHaveGone.at, now),
            tryId: send.mayHaveGone.tryId,
            at: send.mayHaveGone.at,
            confirmId,
          },
  };
}

const decode = Schema.decodeUnknownOption(KinChoiceCardState);

const sentTitle = (send: KinSendCard) =>
  send.outcome?.state === "failed"
    ? "Not sent"
    : send.action === "event"
      ? "Event saved"
      : send.action === "call"
        ? `Done in ${send.service}`
        : send.action === "reply"
          ? "Reply sent"
          : "Email sent";
// The lead writes these, so they are shown as plain text on one line.
const line = (text: string) => text.replace(/\s+/g, " ").trim();

export function kinChoiceCardView(
  widget: KinWidget,
  now: Date = kinNow(),
): KinChoiceCardView | null {
  const state = decode(widget.state);
  if (Option.isNone(state)) return null;
  const card = state.value;
  const options = card.options.map((option) => ({
    id: option.optionId,
    label: line(option.label),
    action: option.action === undefined ? null : line(option.action.line),
    kind: option.kind ?? null,
  }));
  // The server repeats each option's action line in `detail` for older clients; shown here once.
  const note = kinChoiceActionNote(card.options);
  const noted =
    card.detail === null || note === ""
      ? card.detail
      : card.detail === note
        ? null
        : card.detail.endsWith(`\n\n${note}`)
          ? card.detail.slice(0, -note.length - 2)
          : card.detail;
  // `detail` opens with the asker's line too, for older clients; shown here once, first.
  const by = card.askedBy;
  const asked =
    noted === null || by === undefined
      ? noted
      : noted === by
        ? null
        : noted.startsWith(`${by}\n`)
          ? noted.slice(by.length + 1)
          : noted;
  // Settled, it shows only what happened: never what held while it waited.
  const own =
    asked === null ||
    card.whileOpen === undefined ||
    (card.answer === null && widget.closedAt === null) ||
    !asked.startsWith(card.whileOpen)
      ? asked
      : asked.slice(card.whileOpen.length);
  const chosen =
    card.answer === null
      ? undefined
      : options.find((option) => option.id === card.answer?.optionId);
  const send =
    card.send === undefined
      ? null
      : kinSendView(
          card.send,
          now,
          card.options.find((option) => option.kind === "yes")?.optionId ?? null,
        );
  return {
    orgId: widget.orgId,
    widgetId: widget.widgetId,
    revision: widget.revision,
    askedBy: by === undefined ? null : line(by),
    // Answered, the title says what happened, never the question it asked.
    question:
      card.answer !== null && card.outcome !== undefined
        ? line(card.outcome.title)
        : card.send?.outcome != null && card.send.outcome.state !== "sending"
          ? sentTitle(card.send)
          : line(card.question),
    outcome:
      card.answer === null || card.outcome === undefined
        ? null
        : { title: line(card.outcome.title), text: card.outcome.text.trim() },
    undone:
      card.outcome?.undone === undefined
        ? null
        : {
            personId: card.outcome.undone.personId,
            name: card.outcome.undone.name,
            atMs: Date.parse(card.outcome.undone.at),
          },
    detail: own === null || own.trim() === "" ? null : own.trim(),
    options,
    image: card.image === undefined ? null : card.image,
    send,
    answer:
      card.answer === null
        ? null
        : {
            optionId: card.answer.optionId,
            label: chosen?.label ?? card.answer.optionId,
            personId: card.answer.personId,
          },
    // Unanswered cards are never rewritten, so `updatedAt` is still the time it was posted. An
    // agent's open question takes taps until the host closes it.
    expiresAtMs:
      card.untilAnswered === true
        ? Number.POSITIVE_INFINITY
        : Date.parse(widget.updatedAt) + KIN_CHOICE_CARD_TTL_MS,
    closed: widget.closedAt !== null,
    // A question closed unanswered says what became of it ("Went with “Draft it”.").
    decidedBy: card.decidedBy ?? null,
    closedText:
      card.replaced === true
        ? card.replacedBy?.decided === undefined
          ? KIN_CHOICE_REPLACED_TEXT
          : kinChoiceReplacedText(card.replacedBy.decided)
        : card.outcome !== undefined
          ? card.outcome.text
          : KIN_CHOICE_EXPIRED_TEXT,
  };
}

export type KinChoicePhase = "open" | "answered" | "expired";

export function kinChoicePhase(view: KinChoiceCardView, nowMs: number): KinChoicePhase {
  if (view.answer !== null) return "answered";
  return view.closed || nowMs >= view.expiresAtMs ? "expired" : "open";
}

// Imperative first words an agent's option starts with, and how the outcome says them.
const DOING: Readonly<Record<string, string>> = {
  accept: "Accepting",
  add: "Adding",
  approve: "Approving",
  book: "Booking",
  cancel: "Cancelling",
  change: "Changing",
  continue: "Continuing",
  decline: "Declining",
  delete: "Deleting",
  do: "Doing",
  draft: "Drafting",
  file: "Filing",
  finish: "Finishing",
  go: "Going",
  hold: "Holding",
  keep: "Keeping",
  make: "Making",
  merge: "Merging",
  move: "Moving",
  pause: "Pausing",
  pay: "Paying",
  post: "Posting",
  proceed: "Proceeding",
  publish: "Publishing",
  push: "Pushing",
  reject: "Rejecting",
  remind: "Reminding",
  retry: "Retrying",
  run: "Running",
  schedule: "Scheduling",
  send: "Sending",
  ship: "Shipping",
  skip: "Skipping",
  start: "Starting",
  stop: "Stopping",
  try: "Trying",
  use: "Using",
  wait: "Waiting",
};

/**
 * What the chosen option means, said as a sentence: "Go ahead" is "Going ahead.", "Let me change
 * it" is "You'll change it.", and anything else is the option's own words with a full stop.
 */
export function kinChoiceOutcomeSentence(label: string, chosenByViewer: boolean): string {
  const words = line(label).replace(/[.!…]+$/u, "");
  const letMe = /^let me (.+)$/iu.exec(words);
  if (letMe !== null) return `${chosenByViewer ? "You'll" : "They'll"} ${letMe[1]}.`;
  const [first = "", ...rest] = words.split(" ");
  const head = DOING[first.toLowerCase()] ?? `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
  const said = [head, ...rest].join(" ");
  return said.endsWith("?") ? said : `${said}.`;
}

/**
 * Whether the card is answered, by the host or by this device's tap still on its way, and the
 * line that says so. A send card's own outcome ("Sent", "Not sent: …") already says it: no line.
 */
export function kinChoiceAnswered(
  view: KinChoiceCardView,
  viewerPersonId: KinPersonId | null,
  tappedLabel: string | null,
): { readonly text: string | null } | null {
  const text =
    view.outcome !== null
      ? view.outcome.text
      : view.answer !== null
        ? kinChoiceOutcomeSentence(view.answer.label, view.answer.personId === viewerPersonId)
        : tappedLabel !== null
          ? kinChoiceOutcomeSentence(tappedLabel, true)
          : null;
  if (text === null) return null;
  return { text: view.send?.outcome == null ? text : null };
}

/**
 * Who settled the card, under it: "Rhea Rao chose “Same terms”.", "Meera Shah sent it.". Null
 * while it is open, from a host that doesn't say, or for the viewer's own plain answer, which the
 * card already reads as theirs. A send's yes says "sent it" only once the host stored it sent.
 */
export function kinChoiceDecidedLine(
  view: Pick<KinChoiceCardView, "answer" | "decidedBy" | "outcome" | "send" | "options">,
  viewerPersonId: KinPersonId | null,
): string | null {
  const { answer, decidedBy } = view;
  if (answer === null || decidedBy === null) return null;
  const mine = decidedBy.personId === viewerPersonId;
  if (mine && view.outcome === null && view.send === null) return null;
  const who = mine ? "You" : decidedBy.name;
  if (view.send !== null) {
    const yes = view.options.find((option) => option.id === answer.optionId)?.kind === "yes";
    if (yes) return `${who} ${view.send.outcome?.tone === "ok" ? "sent it" : "confirmed it"}.`;
    return `${who} chose not to ${view.send.edit !== null ? "send it" : "go ahead"}.`;
  }
  return `${who} chose “${answer.label}”.`;
}

/** "Undone by you at 9:52 AM.", or by name on another day: under a taken default's note. */
export function kinChoiceUndoneLine(
  view: Pick<KinChoiceCardView, "undone">,
  viewerPersonId: KinPersonId | null,
  now: Date = kinNow(),
): string | null {
  const { undone } = view;
  if (undone === null) return null;
  const at = new Date(undone.atMs);
  const who = undone.personId === viewerPersonId ? "you" : undone.name;
  const when =
    at.toDateString() === now.toDateString()
      ? `at ${formatKinWhen(at, "time")}`
      : `on ${formatKinWhen(at, "dayTime")}`;
  return `Undone by ${who} ${when}.`;
}

/**
 * A card's spoken label. Where the group it labels hides its children from the screen reader
 * (the phone), `message` says a send card's words and the quote under them too.
 */
export function kinChoiceAccessibilityLabel(
  view: KinChoiceCardView,
  status: string | null,
  edited: string | null = null,
  spoken: { readonly message?: boolean } = {},
) {
  if (view.send !== null)
    return kinSentences([
      view.question,
      edited,
      ...view.send.lines.map((line) => `${line.label}: ${line.value}`),
      ...(spoken.message === true
        ? [view.send.body === null ? null : `Message: ${view.send.body}`, view.send.quoted]
        : []),
      ...view.send.attachments.map((file) => `Attached: ${file.name}`),
      view.send.mayHaveGone?.line ?? null,
      view.send.outcome?.text ?? null,
      status,
    ]);
  return kinSentences([
    view.outcome === null ? "Question" : null,
    view.askedBy,
    view.question,
    view.detail,
    status,
  ]);
}

/** `checkedSent`: the try the person's sent-mail tick is for (`kinSendTicked`). */
export function kinChoiceActInput(
  view: Pick<KinChoiceCardView, "widgetId" | "revision">,
  optionId: string,
  clientActionId: string,
  checkedSent: KinSendTry | null = null,
): KinWidgetsActInput {
  return {
    widgetId: view.widgetId,
    revision: view.revision,
    actionId: KIN_CHOICE_CARD_ACTION,
    value: optionId,
    clientActionId,
    ...(checkedSent === null ? {} : { checkedSent }),
  };
}

/**
 * The try a person's tick acknowledges on this card now: null once the warning names another try,
 * so a tick never carries over to a later one.
 */
export function kinSendTicked(
  view: Pick<KinChoiceCardView, "send">,
  ticked: KinSendTry | null,
): KinSendTry | null {
  const gone = view.send?.mayHaveGone ?? null;
  return gone !== null && gone.tryId === ticked?.tryId && gone.at === ticked.at ? ticked : null;
}

/** The try a card's warning names, to tick for. */
export function kinSendTry(view: Pick<KinChoiceCardView, "send">): KinSendTry | null {
  const gone = view.send?.mayHaveGone ?? null;
  return gone === null ? null : { tryId: gone.tryId, at: gone.at };
}

/**
 * The card as the tick beside an open editor reads it: the try the host refused the typed words
 * for, where it named one. The card's own warning stays about its saved words.
 */
export function kinSendEditWarned<V extends Pick<KinChoiceCardView, "send">>(
  view: V,
  editing: KinSendEditing | null,
  now: Date = new Date(),
): V {
  const gone = editing?.mayHaveGone;
  if (gone === undefined || view.send === null) return view;
  return {
    ...view,
    send: {
      ...view.send,
      mayHaveGone: {
        line: kinMayHaveGoneLine(gone.at, now),
        tryId: gone.tryId,
        at: gone.at,
        confirmId: view.send.mayHaveGone?.confirmId ?? null,
      },
    },
  };
}

/**
 * Whether a press waits for the sent-mail tick: Send edited mail (no `optionId`) or the card's
 * Confirm, on a card for a mail an earlier try at which may already have gone.
 */
export function kinSendCheckPending(
  view: Pick<KinChoiceCardView, "send">,
  ticked: KinSendTry | null,
  optionId?: string,
): boolean {
  const gone = view.send?.mayHaveGone ?? null;
  return (
    gone !== null &&
    kinSendTicked(view, ticked) === null &&
    (optionId === undefined || optionId === gone.confirmId)
  );
}

/**
 * Why a choice tap was refused. A card Kin asked for itself (a receipt, a statement's currency)
 * refuses in the owner's words, such as "The figures changed…", so those are shown as said.
 */
export function kinChoiceFailureNotice(cause: KinChatError): KinCardNotice {
  const said = cause.message.trim();
  if ((cause.reason === "conflict" || cause.reason === "widget_changed") && said !== "")
    return { kind: cause.reason === "conflict" ? "error" : "stale", text: said };
  // Kin can't send it until the person acts, such as a mail account signing in again: said as is.
  if (cause.reason === "unavailable" && kinPersonWords(said)) return { kind: "error", text: said };
  return kinActionFailureNotice(cause);
}

/** Whether the card offers Edit: an unanswered mail card the viewer may confirm, not yet sent. */
export function kinSendEditOffered(
  view: KinChoiceCardView,
  phase: KinChoicePhase,
  canConfirm: boolean,
): boolean {
  return (
    canConfirm &&
    phase === "open" &&
    view.answer === null &&
    view.send?.edit != null &&
    view.send.outcome === null
  );
}

/**
 * What the host last took from this device's editor on a card, kept while the editor is closed:
 * the revision its Save or Discard made, and the words a Save left there (`null` after Discard).
 */
export interface KinSendEditAck {
  readonly revision: number;
  readonly saved: KinSendEditDraft | null;
}

/**
 * Edit pressed: the stored words, bound to the card as it is now. Until the card's update for
 * this device's last Save or Discard arrives, bound instead to the revision that made, over the
 * words it left, so a Discard there resets the right card.
 */
export function kinSendEditStart(
  view: KinChoiceCardView,
  ack: KinSendEditAck | null = null,
): KinSendEditing | null {
  if (view.send?.edit == null) return null;
  if (ack === null || ack.revision <= view.revision)
    return {
      revision: view.revision,
      opened: view.send.edit,
      draft: view.send.edit,
      problem: null,
    };
  const words = ack.saved ?? view.send.edit;
  return {
    revision: ack.revision,
    opened: words,
    draft: words,
    problem: null,
    ...(ack.saved === null ? {} : { saved: true as const }),
  };
}

/** "Edited by you", or by name on another's card: shown on a mail card while it holds a saved edit. */
export function kinSendEditedLine(
  view: Pick<KinChoiceCardView, "send">,
  viewerPersonId: KinPersonId | null,
): string | null {
  const edited = view.send?.edited ?? null;
  if (edited === null) return null;
  return `Edited by ${edited.personId === viewerPersonId ? "you" : edited.name}`;
}

/** Whether the words differ from what the editor opened with. */
export function kinSendEditUnsaved(editing: KinSendEditing): boolean {
  const { opened, draft } = editing;
  return (
    opened.to !== draft.to ||
    opened.cc !== draft.cc ||
    opened.subject !== draft.subject ||
    opened.body !== draft.body
  );
}

/** What the editor is doing: nothing, or waiting on the host for one of its three buttons. */
export type KinSendEditBusy = "saving" | "sending" | "discarding" | null;
export interface KinSendEditButton {
  readonly label: string;
  readonly disabled: boolean;
}

/**
 * The editor's buttons, Save, Send edited mail and Discard edits, and the line above them. A card
 * that no longer takes edits (`open` false) keeps unsaved words on screen, with only Discard.
 */
export function kinSendEditControls(
  editing: KinSendEditing,
  view: Pick<KinChoiceCardView, "revision">,
  busy: KinSendEditBusy,
  open: boolean,
  /** Send waits for the sent-mail tick (`kinSendCheckPending`). */
  unchecked = false,
): {
  readonly save: KinSendEditButton;
  readonly send: KinSendEditButton;
  readonly discard: KinSendEditButton;
  readonly notice: string | null;
} {
  const takes = busy === null && open && kinSendEditBound(editing, view).ready;
  return {
    save: {
      label: busy === "saving" ? KIN_SEND_EDIT_COPY.saving : KIN_SEND_EDIT_COPY.save,
      disabled: !takes,
    },
    send: {
      label: busy === "sending" ? KIN_SEND_EDIT_COPY.sending : KIN_SEND_EDIT_COPY.send,
      disabled: !takes || unchecked,
    },
    discard: {
      label: busy === "discarding" ? KIN_SEND_EDIT_COPY.discarding : KIN_SEND_EDIT_COPY.discard,
      disabled: busy !== null,
    },
    notice: open ? null : KIN_SEND_EDIT_COPY.closed,
  };
}

/** Whether the editor stays on screen: while the card takes edits, or it holds unsaved words. */
export function kinSendEditShown(editing: KinSendEditing | null, open: boolean): boolean {
  return editing !== null && (open || kinSendEditUnsaved(editing));
}

/**
 * Leaving the chat or the app with unsaved words saves them, bound as Save is: a card that
 * changed since refuses, and one the host already said changed is left for the person to choose.
 */
export function kinSendEditLeaveSaves(
  editing: KinSendEditing | null,
  busy: KinSendEditBusy,
  open: boolean,
): editing is KinSendEditing {
  return (
    editing !== null &&
    busy === null &&
    open &&
    editing.stale !== true &&
    kinSendEditUnsaved(editing)
  );
}

const addresses = (typed: string) => typed.split(/[,;\s]+/u).filter((one) => one !== "");

/**
 * What Send carries: the card the editor opened on, until the host says that card changed. Then it
 * is dead: the editor shows the card's From again beside Send (`review`), and Send waits (`ready`)
 * for the newer card and carries the one on screen beside it, as an ordinary tap does.
 */
export function kinSendEditBound(
  editing: KinSendEditing,
  view: Pick<KinChoiceCardView, "revision">,
): { readonly revision: number; readonly ready: boolean; readonly review: boolean } {
  return editing.stale === true
    ? { revision: view.revision, ready: view.revision !== editing.revision, review: true }
    : { revision: editing.revision, ready: true, review: false };
}

/** The edited mail as the host takes it, for the card Send is bound to; the host checks it. */
export function kinSendEditInput(
  view: Pick<KinChoiceCardView, "orgId" | "widgetId" | "revision">,
  editing: KinSendEditing,
  clientActionId: string,
  checkedSent: KinSendTry | null = null,
): KinConnectionSendEditedInput {
  return {
    orgId: view.orgId,
    widgetId: view.widgetId,
    revision: kinSendEditBound(editing, view).revision,
    clientActionId,
    to: addresses(editing.draft.to),
    cc: addresses(editing.draft.cc),
    subject: editing.draft.subject,
    body: editing.draft.body,
    ...(checkedSent === null ? {} : { checkedSent }),
  };
}

/** Saved on leaving: the editor stays as it was, bound to the card that now holds the words. */
export function kinSendEditKept(editing: KinSendEditing, revision: number): KinSendEditing {
  return { revision, opened: editing.draft, draft: editing.draft, problem: null, saved: true };
}

const held = new Map<string, KinSendEditing>();
/** Which card's words a device holds: one per environment, person and card. */
export function kinSendEditHeldKey(
  environmentId: string,
  viewerPersonId: KinPersonId | null,
  widgetId: string,
): string {
  return `${environmentId}\u0000${viewerPersonId ?? ""}\u0000${widgetId}`;
}
/** Words left unsaved on a card when its editor went away, kept in memory on this device. */
export function kinSendEditHeld(key: string): KinSendEditing | null {
  return held.get(key) ?? null;
}
/** Keeps an editor's words until they are saved, sent or discarded; `null` lets them go. */
export function kinSendEditHold(key: string, editing: KinSendEditing | null): void {
  if (editing === null) held.delete(key);
  else held.set(key, editing);
}

/** The words kept on the card without sending, for the card Save is bound to. */
export function kinSendEditSaveInput(
  view: Pick<KinChoiceCardView, "orgId" | "widgetId" | "revision">,
  editing: KinSendEditing,
): KinConnectionSaveEditedInput {
  return {
    orgId: view.orgId,
    widgetId: view.widgetId,
    revision: kinSendEditBound(editing, view).revision,
    edit: {
      to: addresses(editing.draft.to),
      cc: addresses(editing.draft.cc),
      subject: editing.draft.subject,
      body: editing.draft.body,
    },
  };
}

/**
 * Discard edits on an open card holding a saved edit, as shown or as the host acknowledged a save,
 * puts the agent's draft back on it, bound as Save is; otherwise it only closes the editor.
 */
export function kinSendEditDiscardInput(
  view: Pick<KinChoiceCardView, "orgId" | "widgetId" | "revision" | "send">,
  editing: KinSendEditing,
  open: boolean,
): KinConnectionSaveEditedInput | null {
  // Bound past the card on screen, only what the host acknowledged says whether words are saved.
  const saved =
    editing.saved === true || (editing.revision <= view.revision && view.send?.edited != null);
  return !open || !saved
    ? null
    : {
        orgId: view.orgId,
        widgetId: view.widgetId,
        revision: kinSendEditBound(editing, view).revision,
        edit: null,
      };
}

const isKinChatError = Schema.is(KinChatError);
/** Why the edited mail didn't go: the host's own sentence where it gave one. */
export function kinSendEditFailure(cause: unknown): string {
  return isKinChatError(cause) && cause.reason !== "disabled" && cause.message.trim() !== ""
    ? cause.message.trim()
    : kinActionFailureNotice(cause).text;
}

/**
 * A refused send keeps every typed word. The host's "this card changed" marks the card that press
 * carried (`view` is the card as it was at the press) as dead, so the next Send is for a newer one.
 */
export function kinSendEditRefused(
  editing: KinSendEditing,
  view: Pick<KinChoiceCardView, "revision">,
  cause: unknown,
): KinSendEditing {
  const problem = kinSendEditFailure(cause);
  const gone = isKinChatError(cause) ? cause.mayHaveGone : undefined;
  const next =
    gone === undefined ? { ...editing, problem } : { ...editing, problem, mayHaveGone: gone };
  return isKinChatError(cause) && cause.reason === "widget_changed"
    ? { ...next, revision: kinSendEditBound(editing, view).revision, stale: true }
    : next;
}

type KinChoiceSend<I, A> = (value: {
  readonly environmentId: EnvironmentId;
  readonly input: I;
}) => Promise<AtomCommandResult<A, unknown>>;

export type KinChoiceCardStatus = (KinCardStatus & { readonly optionId: string }) | null;

/** What a card keeps between renders outside React: its tap queue and the tick a press reads. */
export interface KinChoiceCardTaps {
  queue: ReturnType<typeof createKinCardActions<KinChoiceCardView, string>> | null;
  ticked: KinSendTry | null;
}
export const kinChoiceCardTaps = (): KinChoiceCardTaps => ({ queue: null, ticked: null });

/**
 * What a choice card's taps do, the same on every client: each app holds the state and draws it.
 */
export function kinChoiceCardActions(options: {
  readonly choice: KinChoiceCardView;
  readonly environmentId: EnvironmentId;
  readonly newId: () => string;
  /** Made once per card (`kinChoiceCardTaps`): a press reads the tick when it posts. */
  readonly taps: KinChoiceCardTaps;
  readonly heldKey: string;
  readonly state: {
    readonly pending: string | null;
    readonly switching: boolean;
    /** The editor as shown (`kinSendEditShown`), else null. */
    readonly editing: KinSendEditing | null;
    readonly editBusy: KinSendEditBusy;
    readonly editable: boolean;
    readonly ticked: KinSendTry | null;
    readonly nowMs: number;
  };
  readonly commands: {
    readonly post: KinChoiceSend<KinWidgetsActInput, unknown>;
    readonly setSendFrom: KinChoiceSend<KinConnectionSetSendFromInput, KinConnectionSetSendFrom>;
    readonly sendEdited: KinChoiceSend<KinConnectionSendEditedInput, KinConnectionSendEdited>;
    readonly saveEdited: KinChoiceSend<KinConnectionSaveEditedInput, KinConnectionSaveEdited>;
  };
  readonly set: {
    readonly pending: (pending: string | null) => void;
    readonly lastStatus: (status: KinChoiceCardStatus) => void;
    readonly switching: (switching: boolean) => void;
    readonly switchProblem: (problem: string | null) => void;
    readonly editBusy: (busy: KinSendEditBusy) => void;
    readonly editing: (editing: KinSendEditing | null) => void;
    readonly ack: (ack: KinSendEditAck) => void;
    readonly ticked: (ticked: KinSendTry | null) => void;
  };
}) {
  const { choice, environmentId, taps, state, commands, set } = options;
  const shownEdit = state.editing;
  const editBound = shownEdit === null ? null : kinSendEditBound(shownEdit, choice);
  const warnedView = kinSendEditWarned(choice, shownEdit, new Date(state.nowMs));

  /** The person ticked they checked the sent mail, for the try the warning beside it names. */
  const tick = (next: boolean) => {
    taps.ticked = next ? kinSendTry(warnedView) : null;
    set.ticked(taps.ticked);
  };
  const press = async (optionId: string) => {
    if (state.pending !== null) return;
    if (taps.queue === null)
      taps.queue = createKinCardActions<KinChoiceCardView, string>({
        newId: options.newId,
        toInput: (view, optionId, id) =>
          kinChoiceActInput(view, optionId, id, kinSendTicked(view, taps.ticked)),
        failureNotice: kinChoiceFailureNotice,
        post: async (input) => {
          const result = await commands.post({ environmentId, input });
          return AsyncResult.isFailure(result)
            ? { ok: false, cause: squashAtomCommandFailure(result) }
            : { ok: true };
        },
      });
    const revision = choice.revision;
    const outcome = await taps.queue(choice, optionId, () => {
      set.pending(optionId);
      set.lastStatus(null);
    });
    if (outcome.status === "ignored") return;
    set.pending(null);
    set.lastStatus(
      outcome.status === "failed"
        ? { revision, optionId, notice: outcome.notice, holding: false }
        : { revision, optionId, notice: null, holding: true },
    );
  };

  const pickFrom = async (choiceId: string) => {
    if (state.switching || state.pending !== null) return;
    set.switching(true);
    set.switchProblem(null);
    const failed = await kinConnectionChange(
      commands.setSendFrom({
        environmentId,
        input: {
          orgId: choice.orgId,
          widgetId: choice.widgetId,
          revision: choice.revision,
          choice: choiceId,
        },
      }),
      "change who it's from",
    );
    set.switching(false);
    set.switchProblem(failed);
  };

  /** The editor after the host answered: words it refused stay on this device until let go. */
  const settle = (next: KinSendEditing | null, kept: KinSendEditing | null = next) => {
    kinSendEditHold(options.heldKey, kept);
    set.editing(next);
  };
  const sendEdit = async () => {
    if (shownEdit === null || state.editBusy !== null || editBound?.ready !== true) return;
    set.editBusy("sending");
    const result = await commands.sendEdited({
      environmentId,
      input: kinSendEditInput(
        choice,
        shownEdit,
        options.newId(),
        kinSendTicked(warnedView, state.ticked),
      ),
    });
    set.editBusy(null);
    settle(
      AsyncResult.isFailure(result)
        ? kinSendEditRefused(shownEdit, choice, squashAtomCommandFailure(result))
        : null,
    );
  };
  /** Save closes the editor; a save on leaving keeps it open over the saved card. */
  const saveEdit = async (stay = false) => {
    if (shownEdit === null || state.editBusy !== null || editBound?.ready !== true) return;
    if (!kinSendEditUnsaved(shownEdit)) return settle(null);
    set.editBusy("saving");
    const result = await commands.saveEdited({
      environmentId,
      input: kinSendEditSaveInput(choice, shownEdit),
    });
    set.editBusy(null);
    if (AsyncResult.isFailure(result))
      return settle(kinSendEditRefused(shownEdit, choice, squashAtomCommandFailure(result)));
    set.ack({ revision: result.value.revision, saved: shownEdit.draft });
    settle(stay ? kinSendEditKept(shownEdit, result.value.revision) : null, null);
  };
  const discardEdit = async () => {
    if (shownEdit === null || state.editBusy !== null) return;
    const input = kinSendEditDiscardInput(choice, shownEdit, state.editable);
    if (input === null) return settle(null);
    set.editBusy("discarding");
    const result = await commands.saveEdited({ environmentId, input });
    set.editBusy(null);
    if (AsyncResult.isSuccess(result)) set.ack({ revision: result.value.revision, saved: null });
    settle(
      AsyncResult.isFailure(result)
        ? kinSendEditRefused(shownEdit, choice, squashAtomCommandFailure(result))
        : null,
    );
  };
  return { tick, press, pickFrom, sendEdit, saveEdit, discardEdit };
}

/** A mail card's Cancel asks first, then waits a few seconds for Undo before it is sent. */
export const KIN_MAIL_CANCEL_COPY = {
  ask: "Don't send this mail?",
  detail: "The mail won't go, and its card closes.",
  yes: "Don't send",
  no: "Keep it",
  held: "This mail won't be sent.",
  undo: "Undo",
} as const;
export const KIN_MAIL_CANCEL_UNDO_MS = 5_000;

/** Whether a tap on this option is a mail card's Cancel, which is asked and held for Undo. */
export function kinMailCancels(
  view: Pick<KinChoiceCardView, "send" | "options">,
  optionId: string,
): boolean {
  return (
    view.send?.edit != null && view.options.find((option) => option.id === optionId)?.kind === "no"
  );
}

export interface KinHeldPress {
  /** Starts the wait; a second hold while one waits changes nothing. */
  readonly hold: () => void;
  /** Drops the waiting press: nothing is sent. */
  readonly undo: () => void;
  /** Sends a waiting press now, as leaving the screen does. */
  readonly flush: () => void;
  readonly waiting: () => boolean;
}

/** The device's own timers, for `createKinHeldPress`. */
export const kinDeviceTimers = {
  set: (run: () => void, ms: number) => globalThis.setTimeout(run, ms),
  clear: (handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle),
};

/** A press held back `delayMs` so it can be undone; it is sent at most once. */
export function createKinHeldPress<H>(input: {
  readonly delayMs: number;
  readonly send: () => void;
  readonly timers: {
    readonly set: (run: () => void, ms: number) => H;
    readonly clear: (handle: H) => void;
  };
}): KinHeldPress {
  const { timers } = input;
  let handle: { readonly value: H } | null = null;
  const fire = () => {
    if (handle === null) return;
    timers.clear(handle.value);
    handle = null;
    input.send();
  };
  return {
    hold: () => {
      if (handle === null) handle = { value: timers.set(fire, input.delayMs) };
    },
    undo: () => {
      if (handle === null) return;
      timers.clear(handle.value);
      handle = null;
    },
    flush: fire,
    waiting: () => handle !== null,
  };
}
