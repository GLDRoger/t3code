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
import { kinSentences } from "./kinScreenState.ts";

export const KIN_CHOICE_EXPIRED_TEXT = "This question expired. Answer in the chat instead.";

export interface KinChoiceCardView {
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
  /** What a send card would send, in full: shown instead of `detail`. */
  readonly send: KinSendView | null;
  /** When an unanswered card stops taking taps; the host refuses later ones. */
  readonly expiresAtMs: number;
  readonly closed: boolean;
}

export interface KinSendView {
  /** "Email from owner@company.com", "Event in Google Calendar". */
  readonly heading: string;
  /** Labelled lines, in order: To, Cc, Subject or Event. */
  readonly lines: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly body: string;
  readonly attachments: ReadonlyArray<{ readonly name: string; readonly detail: string }>;
  /** After the tap: "Sending…", "Sent", or why it wasn't sent. */
  readonly outcome: { readonly tone: "pending" | "ok" | "error"; readonly text: string } | null;
}

const kb = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;

function kinSendView(send: KinSendCard): KinSendView {
  const account = send.from === null ? "" : ` from ${send.from}`;
  const heading =
    send.action === "event"
      ? `Event in ${send.service}${account}`
      : send.action === "call"
        ? `${send.service}${account}`
        : `${send.action === "reply" ? "Reply" : "Email"}${account}`;
  const lines =
    send.action === "event"
      ? [
          { label: "Event", value: send.subject },
          { label: "Invites", value: send.to.length === 0 ? "No one" : send.to.join(", ") },
        ]
      : send.action === "call"
        ? [{ label: "Tool", value: send.subject }]
        : [
            { label: "To", value: send.to.join(", ") },
            ...(send.cc.length === 0 ? [] : [{ label: "Cc", value: send.cc.join(", ") }]),
            { label: "Subject", value: send.subject },
          ];
  return {
    heading,
    lines,
    body: send.body,
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
            : {
                tone: "error",
                text: `Not sent: ${send.outcome.reason ?? "Kin couldn't send it."}`,
              },
  };
}

const decode = Schema.decodeUnknownOption(KinChoiceCardState);
// The lead writes these, so they are shown as plain text on one line.
const line = (text: string) => text.replace(/\s+/g, " ").trim();

export function kinChoiceCardView(widget: KinWidget): KinChoiceCardView | null {
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
  return {
    widgetId: widget.widgetId,
    revision: widget.revision,
    question: line(card.question),
    detail: card.detail === null || card.detail.trim() === "" ? null : card.detail.trim(),
    options,
    image: card.image === undefined ? null : card.image,
    send: card.send === undefined ? null : kinSendView(card.send),
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
