import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinPersonId,
  type KinOrgId,
  KinWidgetId,
  KIN_TEXT_LOCALE,
  kinWhenFormat,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../../chat/KinChatHub.ts";
import { KinChatRepository } from "../../chat/KinChatRepository.ts";
import { KinFloor } from "../../floor/KinFloor.ts";
import { ownerOnlyChat } from "../../lead/Audience.ts";
import { wakeEvent } from "../../lead/ChatWake.ts";
import { KinEventQueue } from "../../lead/KinEventQueue.ts";
import { formatMoney } from "../money.ts";
import { factsOf, type Settled } from "./statementReading.ts";

/**
 * The owner's tap on a statement card reaches its lead as the owner's own message, as a choice
 * card's answer does. It names the statement by Kin's id, account digits and period only: a file
 * name or the bank's words in it would read as the owner's.
 */

const encodeTap = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

export type StatementTap = "unlock" | "confirm" | "undo" | "read_again";
const LABELS: Readonly<Record<StatementTap, string>> = {
  unlock: "Unlock",
  confirm: "Confirm",
  undo: "Undo",
  read_again: "Read again",
};

/** What a read came to, in numbers, for the lead. */
export const settledLine = (settled: Settled) => {
  if (settled._tag === "reading")
    return settled.scanned
      ? `It is a scan of ${settled.pages} page${settled.pages === 1 ? "" : "s"} with no text: read its rows from the page images with statement_read.`
      : `Kin's own table reading didn't prove out, so its ${settled.pages} page${settled.pages === 1 ? "" : "s"} wait for you to read with statement_read.`;
  const { statement } = settled.review;
  const groups = [...settled.review.matches.values()];
  const count = (group: string) => groups.filter((one) => one.group === group).length;
  const recorded = statement.rows.length - groups.length;
  const credits = statement.rows.filter((row) => row.direction === "credit");
  const total = (rows: typeof credits) =>
    formatMoney({
      minor: rows.reduce((sum, row) => sum + row.amountMinor, 0),
      currency: statement.currency,
    });
  return [
    `${statement.rows.length} rows read (${credits.length} in, ${total(credits)}; ${statement.rows.length - credits.length} out, ${total(statement.rows.filter((row) => row.direction === "debit"))}).`,
    statement.check.line,
    `On its review card: ${count("matched")} matched, ${count("choose")} to choose, ${count("unmatched")} unmatched${recorded === 0 ? "" : `, ${recorded} already recorded`}.`,
  ].join(" ");
};

const DAY = kinWhenFormat("dateYear", { zone: "UTC", locale: KIN_TEXT_LOCALE });
const day = (date: string) => DAY.format(Date.parse(`${date}T00:00:00Z`));
/** The statement's account digits and period, as Kin read them: digits and days only. */
const aboutOf = (stored: {
  readonly account: string | null;
  readonly reviewJson: string | null;
  readonly pagesJson: string | null;
}) => {
  const facts = factsOf(stored);
  const account = /^\d{4}$/.test(facts.account ?? "") ? `••${facts.account}` : undefined;
  const period =
    facts.from === null || facts.to === null ? undefined : `${day(facts.from)} to ${day(facts.to)}`;
  const said = [account, period].filter((one) => one !== undefined);
  return said.length === 0 ? "" : ` (${said.join(", ")})`;
};

/**
 * Posts the owner's tap on a statement card, opening the chat's floor so the lead may answer. A
 * chat shared since the card was posted gets none of it: the lead's own chat with the owner does.
 * A statement with no card yet (`widgetId` null) is told only there, written for the owner alone.
 */
export const tellLead = Effect.fn("KinStatements.tellLead")(function* (input: {
  readonly orgId: KinOrgId;
  readonly statementId: string;
  readonly widgetId: string | null;
  readonly tap: StatementTap;
  readonly outcome: string;
}) {
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const floor = yield* KinFloor;
  const sql = yield* SqlClient.SqlClient;
  const found =
    input.widgetId === null
      ? undefined
      : yield* repo.getWidget({ orgId: input.orgId, widgetId: KinWidgetId.make(input.widgetId) });
  if (found !== undefined && Option.isNone(found))
    return yield* invalid("The statement's card is gone.");
  const card = found === undefined ? undefined : Option.getOrUndefined(found);
  const [owner] = yield* sql<{
    personId: string;
    agentId: string;
    account: string | null;
    reviewJson: string | null;
    pagesJson: string | null;
  }>`SELECT a.owner_person_id AS "personId", s.agent_id AS "agentId", s.account,
      s.review_json AS "reviewJson", s.pages_json AS "pagesJson"
    FROM kin_bank_statements s
    JOIN kin_agents a ON a.org_id = s.org_id AND a.agent_id = s.agent_id
    WHERE s.org_id = ${input.orgId} AND s.statement_id = ${input.statementId}`;
  if (owner === undefined) return yield* invalid("The statement is gone.");
  const memberIn = (chatId: string) =>
    sql<{ memberId: string }>`SELECT member_id AS "memberId" FROM kin_chat_members
      WHERE org_id = ${input.orgId} AND chat_id = ${chatId} AND principal_kind = 'person'
        AND person_id = ${owner.personId} AND left_at IS NULL ORDER BY member_id`;
  const shared =
    card !== undefined &&
    !(yield* ownerOnlyChat(
      { orgId: input.orgId, agentId: KinAgentId.make(owner.agentId) },
      card.chatId,
    ));
  const [own] = yield* sql<{ chatId: string }>`SELECT owner_chat_id AS "chatId" FROM kin_leads
    WHERE org_id = ${input.orgId} AND agent_id = ${owner.agentId}`;
  const onCard = card !== undefined && !shared;
  const target = onCard ? card.chatId : own?.chatId;
  if (target === undefined || (shared && target === card?.chatId))
    return yield* invalid(
      "The statement's chat is shared now, and its agent has no chat with you alone.",
    );
  const [member] = yield* memberIn(target);
  if (member === undefined) return yield* invalid("The owner isn't in that chat.");
  const chatId = KinChatId.make(target);
  const chat = yield* repo.getChat({ orgId: input.orgId, chatId });
  if (Option.isNone(chat)) return yield* invalid("The statement's chat is gone.");
  const now = yield* Clock.currentTimeMillis;
  const body = yield* encodeTap({
    ...(card === undefined ? {} : { widgetId: card.widgetId, revision: card.revision }),
    actionId: input.tap,
    text: `${shared ? "The chat this statement was sent in is shared now, so this is here instead. " : ""}Tapped "${LABELS[input.tap]}" on statement ${input.statementId}${aboutOf(owner)}. ${input.outcome}`.slice(
      0,
      3_000,
    ),
  });
  const message = yield* repo.insertMessage({
    orgId: input.orgId,
    audience: onCard ? "chat" : "owner",
    chatId,
    messageId: KinMessageId.make(`kin-statement-tap:${input.statementId}:${input.tap}:${now}`),
    author: {
      _tag: "human",
      personId: KinPersonId.make(owner.personId),
      memberId: KinMemberId.make(member.memberId),
    },
    kind: "widget_action",
    body,
    intent: null,
    mentions: [],
    replyTo: onCard ? card.messageId : null,
    widgetId: onCard ? card.widgetId : null,
    floorRunId: null,
    status: "posted",
    sentBy: null,
    clientMessageId: null,
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    editedAt: null,
  });
  yield* floor.open(message, chat.value);
  yield* sql.afterCommit(hub.publish({ type: "message.posted", orgId: input.orgId, message }));
  return { message, agentId: KinAgentId.make(owner.agentId), event: input.tap };
});

/** A tap's wake-up, queued by a writer whose hub no `ChatWake` listens to, such as the host CLI. */
export const queueTap = Effect.fn("KinStatements.queueTap")(function* (
  told: Effect.Success<ReturnType<typeof tellLead>>,
) {
  const queue = yield* KinEventQueue;
  return yield* queue.enqueue(wakeEvent(told.message, told.agentId, told.event));
});
