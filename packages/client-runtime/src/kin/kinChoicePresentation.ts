// @effect-diagnostics globalDate:off - Pure view helpers format a mail thread's date for React render, outside an Effect runtime.
import {
  KIN_CHOICE_CARD_ACTION,
  type KinChatError,
  KIN_CHOICE_CARD_TTL_MS,
  KinChoiceCardState,
  type KinPersonId,
  type KinSendCard,
  type KinWidget,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type KinCardNotice, kinActionFailureNotice } from "./kinDeferralPresentation.ts";
import { formatKinTime, kinSentences } from "./kinScreenState.ts";

const KIN_CHOICE_EXPIRED_TEXT = "This question expired. Answer in the chat instead.";
const KIN_CHOICE_REPLACED_TEXT = "Replaced by a newer one.";

export interface KinChoiceCardView {
  readonly orgId: KinWidget["orgId"];
  readonly widgetId: KinWidget["widgetId"];
  readonly revision: number;
  readonly question: string;
  readonly detail: string | null;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** A picture of what is asked about, such as a new logo: a file in the card's chat. */
  readonly image: { readonly attachmentId: string; readonly mimeType: string } | null;
  readonly answer: {
    readonly optionId: string;
    readonly label: string;
    readonly personId: KinPersonId;
    readonly emoji: string | null;
  } | null;
  /** What the answer did, in the owner's words, on a card Kin asked itself. */
  readonly outcome: { readonly title: string; readonly text: string } | null;
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
  /** After the tap: "Sending…", "Sent", or why it wasn't sent. */
  readonly outcome: { readonly tone: "pending" | "ok" | "error"; readonly text: string } | null;
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
export function kinThreadDate(raw: string | null, now: Date = new Date()): string | null {
  if (raw === null) return null;
  const at = new Date(raw.trim());
  return Number.isNaN(at.getTime()) || at.getTime() < Date.UTC(1995, 0, 1)
    ? null
    : formatKinTime(at, now);
}

function kinSendView(send: KinSendCard, now: Date): KinSendView {
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
    thread:
      send.thread === undefined || send.thread === null
        ? null
        : { ...send.thread, date: kinThreadDate(send.thread.date, now) },
    body: send.body,
    quoted: send.quoted ?? null,
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
    outcome:
      send.outcome === null
        ? null
        : send.outcome.state === "sending"
          ? { tone: "pending", text: "Sending…" }
          : send.outcome.state === "sent"
            ? { tone: "ok", text: send.action === "event" ? "Saved and invitations sent" : "Sent" }
            : // Kin's reason says what happened, including "may or may not have gone".
              { tone: "error", text: send.outcome.reason ?? "Not sent: Kin couldn't send it." },
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
  now: Date = new Date(),
): KinChoiceCardView | null {
  const state = decode(widget.state);
  if (Option.isNone(state)) return null;
  const card = state.value;
  const options = card.options.map((option) => ({
    id: option.optionId,
    label: line(option.label),
  }));
  const chosen =
    card.answer === null
      ? undefined
      : options.find((option) => option.id === card.answer?.optionId);
  const send = card.send === undefined ? null : kinSendView(card.send, now);
  return {
    orgId: widget.orgId,
    widgetId: widget.widgetId,
    revision: widget.revision,
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
    detail: card.detail === null || card.detail.trim() === "" ? null : card.detail.trim(),
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
            emoji: card.answer.via === "reaction" ? card.answer.emoji : null,
          },
    // Unanswered cards are never rewritten, so `updatedAt` is still the time it was posted.
    expiresAtMs: Date.parse(widget.updatedAt) + KIN_CHOICE_CARD_TTL_MS,
    closed: widget.closedAt !== null,
    closedText: card.replaced === true ? KIN_CHOICE_REPLACED_TEXT : KIN_CHOICE_EXPIRED_TEXT,
  };
}

export type KinChoicePhase = "open" | "answered" | "expired";

export function kinChoicePhase(view: KinChoiceCardView, nowMs: number): KinChoicePhase {
  if (view.answer !== null) return "answered";
  return view.closed || nowMs >= view.expiresAtMs ? "expired" : "open";
}

/** "You chose “Ship it”", or with a reaction "You chose “Yes” with 👍". */
export function kinChoiceAnswerText(
  answer: NonNullable<KinChoiceCardView["answer"]>,
  viewerPersonId: KinPersonId | null,
): string {
  const who = answer.personId === viewerPersonId ? "You chose" : "Chose";
  return `${who} “${answer.label}”${answer.emoji === null ? "" : ` with ${answer.emoji}`}`;
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
        ? kinChoiceAnswerText(view.answer, viewerPersonId)
        : tappedLabel !== null
          ? `You chose “${tappedLabel}”`
          : null;
  if (text === null) return null;
  return { text: view.send?.outcome == null ? text : null };
}

export function kinChoiceAccessibilityLabel(view: KinChoiceCardView, status: string | null) {
  if (view.send !== null)
    return kinSentences([
      view.question,
      ...view.send.lines.map((line) => `${line.label}: ${line.value}`),
      ...view.send.attachments.map((file) => `Attached: ${file.name}`),
      view.send.outcome?.text ?? null,
      status,
    ]);
  return kinSentences(["Question", view.question, view.detail, status]);
}

export function kinChoiceActInput(
  view: Pick<KinChoiceCardView, "widgetId" | "revision">,
  optionId: string,
  clientActionId: string,
): KinWidgetsActInput {
  return {
    widgetId: view.widgetId,
    revision: view.revision,
    actionId: KIN_CHOICE_CARD_ACTION,
    value: optionId,
    clientActionId,
  };
}

/**
 * Why a choice tap was refused. A card Kin asked for itself (a receipt, a statement's currency)
 * refuses in the owner's words, such as "The figures changed…", so those are shown as said.
 */
export function kinChoiceFailureNotice(cause: KinChatError): KinCardNotice {
  const said = cause.message.trim();
  if ((cause.reason === "conflict" || cause.reason === "widget_changed") && said !== "")
    return { kind: cause.reason === "conflict" ? "error" : "stale", text: said };
  return kinActionFailureNotice(cause);
}
