// @effect-diagnostics-next-line nodeBuiltinImport:off -- A decision's id is a synchronous hash of its card or discussion.
import * as NodeCrypto from "node:crypto";
import {
  KinChoiceCardState,
  KinMemoryItemId,
  type KinAgentId,
  type KinChatId,
  type KinMessageId,
  type KinOrgId,
  type KinWidget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { STILL_OPEN } from "../questions/openQuestions.ts";
import type { KinDecision } from "./MemoryWriter.ts";

/**
 * Decisions saved to memory by code, with no model in the path: the card's own question and the
 * chosen answer, or the discussion's recorded outcome. Each id comes from the card or the
 * discussion, so the same decision is saved once however often it is seen.
 */

const TITLE_MAX = 240;
const decodeChoice = Schema.decodeUnknownOption(KinChoiceCardState);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const idOf = (orgId: KinOrgId, what: string) =>
  KinMemoryItemId.make(
    `decision-${NodeCrypto.createHash("sha256").update(`${orgId}\u0000${what}`).digest("hex").slice(0, 16)}`,
  );
const chatSource = (chatId: KinChatId, messageId: KinMessageId) =>
  `kin:chat:${chatId}:message:${messageId}`;

/**
 * The owner level's answer on an agent's choice card: what was asked and what they chose. None
 * for a card that sends something out (its send is the record) or whose state isn't a choice.
 */
export const cardDecision = (input: {
  readonly orgId: KinOrgId;
  readonly widget: KinWidget;
  readonly label: string;
  /** The answerer's handle, as memory names who said a thing. */
  readonly by: string;
}): KinDecision | undefined => {
  const card = Option.getOrUndefined(decodeChoice(input.widget.state));
  if (card === undefined || card.send !== undefined) return undefined;
  const others = card.options
    .map((option) => option.label)
    .filter((label) => label !== input.label);
  return {
    itemId: idOf(input.orgId, `card:${input.widget.widgetId}`),
    title: oneLine(
      card.question.startsWith(STILL_OPEN) ? card.question.slice(STILL_OPEN.length) : card.question,
    ).slice(0, TITLE_MAX),
    body: [
      `Chose “${oneLine(input.label)}”${others.length === 0 ? "" : ` over ${others.map((label) => `“${oneLine(label)}”`).join(", ")}`}.`,
      ...(card.detail === null || card.detail.trim() === "" ? [] : ["", card.detail.trim()]),
    ].join("\n"),
    saidBy: input.by,
    trust: "owner",
    source: chatSource(input.widget.chatId, input.widget.messageId),
    chat: input.widget.chatId,
    link: `card:${input.widget.widgetId}`,
  };
};

/** A Team-room discussion that ended decided: its topic and the outcome its decider recorded. */
export const discussionDecision = (input: {
  readonly orgId: KinOrgId;
  readonly discussionId: string;
  readonly topic: string;
  readonly question: string;
  readonly outcome: string;
  readonly decider: KinAgentId;
  readonly chatId: KinChatId;
  /** The discussion's last message: the decider's own words. */
  readonly messageId: KinMessageId;
}): KinDecision => ({
  itemId: idOf(input.orgId, `discussion:${input.discussionId}`),
  title: oneLine(input.topic).slice(0, TITLE_MAX),
  body: [
    oneLine(input.outcome),
    ...(oneLine(input.question) === oneLine(input.topic) ? [] : ["", oneLine(input.question)]),
    "",
    `Decided in the Team room (${input.discussionId}).`,
  ].join("\n"),
  saidBy: input.decider,
  trust: "agent",
  source: chatSource(input.chatId, input.messageId),
  chat: input.chatId,
  link: `discussion:${input.discussionId}`,
});
