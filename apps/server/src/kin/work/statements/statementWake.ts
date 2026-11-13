import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinPersonId,
  type KinOrgId,
  KinWidgetId,
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
import { wakeEvent } from "../../lead/ChatWake.ts";
import { KinEventQueue } from "../../lead/KinEventQueue.ts";
import { formatMoney } from "../money.ts";
import type { Settled } from "./statementReading.ts";

/**
 * What the owner did on a statement's card reaches the statement's lead as a tap, the way a choice
 * card's answer does: the owner's own message in the chat, which wakes the lead to carry on with
 * what was asked. Only the button shows in the chat; the lead reads the outcome in numbers.
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

/** Posts the owner's tap on a statement card, opening the chat's floor so the lead may answer. */
export const tellLead = Effect.fn("KinStatements.tellLead")(function* (input: {
  readonly orgId: KinOrgId;
  readonly statementId: string;
  readonly widgetId: string;
  readonly tap: StatementTap;
  readonly fileName: string;
  readonly outcome: string;
}) {
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const floor = yield* KinFloor;
  const sql = yield* SqlClient.SqlClient;
  const widget = yield* repo.getWidget({
    orgId: input.orgId,
    widgetId: KinWidgetId.make(input.widgetId),
  });
  if (Option.isNone(widget)) return yield* invalid("The statement's card is gone.");
  const [owner] = yield* sql<{ personId: string; memberId: string; agentId: string }>`SELECT
      a.owner_person_id AS "personId", m.member_id AS "memberId", s.agent_id AS "agentId"
    FROM kin_bank_statements s
    JOIN kin_agents a ON a.org_id = s.org_id AND a.agent_id = s.agent_id
    JOIN kin_chat_members m ON m.org_id = s.org_id AND m.chat_id = s.chat_id
      AND m.principal_kind = 'person' AND m.person_id = a.owner_person_id AND m.left_at IS NULL
    WHERE s.org_id = ${input.orgId} AND s.statement_id = ${input.statementId}`;
  if (owner === undefined) return yield* invalid("The owner isn't in the statement's chat.");
  const chatId = KinChatId.make(widget.value.chatId);
  const chat = yield* repo.getChat({ orgId: input.orgId, chatId });
  if (Option.isNone(chat)) return yield* invalid("The statement's chat is gone.");
  const now = yield* Clock.currentTimeMillis;
  const body = yield* encodeTap({
    widgetId: input.widgetId,
    revision: widget.value.revision,
    actionId: input.tap,
    text: `Tapped "${LABELS[input.tap]}" on the statement "${input.fileName.slice(0, 120)}". ${input.outcome}`.slice(
      0,
      3_000,
    ),
  });
  const message = yield* repo.insertMessage({
    orgId: input.orgId,
    audience: "chat",
    chatId,
    messageId: KinMessageId.make(`kin-statement-tap:${input.statementId}:${input.tap}:${now}`),
    author: {
      _tag: "human",
      personId: KinPersonId.make(owner.personId),
      memberId: KinMemberId.make(owner.memberId),
    },
    kind: "widget_action",
    body,
    intent: null,
    mentions: [],
    replyTo: widget.value.messageId,
    widgetId: widget.value.widgetId,
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
