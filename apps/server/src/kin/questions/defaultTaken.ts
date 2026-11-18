import {
  KinAgentId,
  KinChatError,
  type KinChatId,
  KinEvent,
  KinEventId,
  type KinChoiceOutcome,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
  ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { KinChatService } from "../chat/KinChatService.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { reversal } from "../lead/changeRows.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { type TakenPlan, sealPlans } from "../widgets/cardPlans.ts";
import type { KinRecords, Writer } from "../work/KinRecords.ts";
import { parseChanges } from "../work/recordRows.ts";
import { teamGuard } from "../work/teamView.ts";

const decodeEvent = Schema.decodeUnknownEffect(KinEvent);

/** The field a record change carries when Kin made it by taking a question's default. */
const DEFAULT_FIELD = "default";
export const takenFor = (questionId: string) => [
  { field: DEFAULT_FIELD, from: null, to: questionId },
];
/** The told ledger's key for a question's "went with the default" notice is this, then its id. */
export const TAKEN_KEY = "default_taken:";

const quoted = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `“${flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`}”`;
};

/** "Nobody answered, so I went with “Mark W-8 done” for W-8 Apex review." */
const takenLine = (
  label: string,
  about: { readonly key: string; readonly title: string } | { readonly question: string },
) =>
  `Nobody answered, so I went with ${quoted(label, 60)} ${
    "key" in about ? `for ${about.key} ${about.title}` : `on ${quoted(about.question, 120)}`
  }.`;

/** The change a default made to a record, found by the field it carries. */
const changeOf = Effect.fn("KinDefaultTaken.changeOf")(function* (
  orgId: KinOrgId,
  questionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    seq: number;
    rev: number;
    recordId: string;
    key: string;
    title: string;
  }>`SELECT c.seq, c.rev, c.record_id AS "recordId", r.key, r.title
    FROM kin_record_changes c
    JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
    WHERE c.org_id = ${orgId} AND c.kind = 'updated' AND EXISTS (SELECT 1
      FROM json_each(c.fields_json) f WHERE json_extract(f.value, '$.field') = ${DEFAULT_FIELD}
        AND json_extract(f.value, '$.to') = ${questionId})
    ORDER BY c.seq LIMIT 1`;
  return row;
});

/**
 * Tells the person asked, once, in their chat with the asking agent, what Kin went with. When the
 * default changed a record, the note is a card whose Undo puts that change back; else a line.
 * Marked told in the caller's transaction, so a retried pass posts nothing more.
 */
export const tellTaken = Effect.fn("KinDefaultTaken.tell")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly questionId: string;
    readonly agentId: KinAgentId;
    readonly personId: KinPersonId;
    readonly chatId: KinChatId;
    readonly label: string;
    readonly question: string;
    readonly about: ReadonlyArray<string>;
    readonly now: number;
  },
  chat: Pick<KinChatService["Service"], "ask" | "notice">,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId } = input;
  const change = yield* changeOf(orgId, input.questionId);
  const [named] =
    change !== undefined || input.about.length === 0
      ? []
      : yield* sql<{ key: string; title: string }>`SELECT key, title FROM kin_records
          WHERE org_id = ${orgId} AND key IN ${sql.in(input.about)} ORDER BY key LIMIT 1`;
  const line = takenLine(input.label, change ?? named ?? { question: input.question });
  const [agent] = yield* sql<{ owner: string; threadId: string | null }>`SELECT
      a.owner_person_id AS owner, l.thread_id AS "threadId"
    FROM kin_agents a JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${input.agentId} AND a.retired_at IS NULL`;
  if (change !== undefined && agent !== undefined && agent.threadId !== null) {
    const plan = (kind: TakenPlan["kind"]): TakenPlan => ({
      kind,
      questionId: input.questionId,
      agentId: input.agentId,
      recordId: change.recordId,
      key: change.key,
      title: change.title,
      label: input.label,
      seq: change.seq,
      rev: change.rev,
    });
    const asked = {
      question: line.length <= 240 ? line : `${line.slice(0, 239)}…`,
      options: [{ label: "Undo" }, { label: "Keep it" }],
      actions: [
        { label: "Undo", line: `Put ${change.key} ${quoted(change.title)} back as it was` },
        undefined,
      ],
      untilAnswered: true as const,
    };
    const card = yield* chat.ask(
      {
        _tag: "agent",
        orgId,
        agentId: input.agentId,
        ownerPersonId: KinPersonId.make(agent.owner),
        threadId: ThreadId.make(agent.threadId),
        hostPosted: true,
      },
      { ...asked, chatId: input.chatId, clientMessageId: `kin-default-taken:${input.questionId}` },
    );
    yield* sealPlans({
      orgId,
      chatId: input.chatId,
      widgetId: card.widgetId,
      plans: [
        { optionId: "option-1", plan: plan("undo_default") },
        { optionId: "option-2", plan: plan("keep_default") },
      ],
      now: input.now,
    });
    yield* markTaken(orgId, input.personId, input.questionId, card.messageId, input.now);
    return;
  }
  const messageId = KinMessageId.make(`kin-default-taken:${input.questionId}`);
  yield* chat.notice({
    orgId,
    chatId: input.chatId,
    messageId,
    audience: "chat",
    body: line,
    ...(agent === undefined ? {} : { from: input.agentId }),
  });
  yield* markTaken(orgId, input.personId, input.questionId, messageId, input.now);
});

const markTaken = Effect.fn("KinDefaultTaken.markTold")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  questionId: string,
  messageId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id, sig, told_at)
    VALUES (${orgId}, ${personId}, ${`${TAKEN_KEY}${questionId}`}, ${messageId}, 'told', ${now})
    ON CONFLICT DO NOTHING`;
});

/** The asking agent hears once that its default was undone, so it doesn't go on as if it stood. */
const tellUndone = Effect.fn("KinDefaultTaken.tellUndone")(function* (
  orgId: KinOrgId,
  plan: TakenPlan,
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [lead] = yield* sql<{ ownerChatId: string }>`SELECT owner_chat_id AS "ownerChatId"
    FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${plan.agentId}`;
  const [question] = yield* sql<{ personId: string }>`SELECT person_id AS "personId"
    FROM kin_questions WHERE org_id = ${orgId} AND question_id = ${plan.questionId}`;
  const event = yield* decodeEvent({
    _tag: "deferral.due",
    eventId: KinEventId.make(
      `question_${NodeCrypto.createHash("sha256")
        .update(`${orgId}\0${plan.questionId}\0undone`)
        .digest("hex")
        .slice(0, 32)}`,
    ),
    orgId,
    agentId: plan.agentId,
    receivedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
    provenance: { _tag: "system" },
    dedupeKey: `question-undone:${plan.questionId}`,
    subject: { type: "question", questionId: plan.questionId, undone: true },
    lateByMs: 0,
    ...(lead === undefined || lead.ownerChatId === chatId || question === undefined
      ? {}
      : { origin: { agentId: plan.agentId, chatId, personId: question.personId } }),
  }).pipe(Effect.orDie);
  // A retired asker has no turn to tell.
  yield* (yield* KinEventQueue).enqueue(event).pipe(
    Effect.catchTags({
      KinEventQueueRetiredAgent: () => Effect.void,
      KinEventQueueUnknownAgent: () => Effect.void,
      // The whole tap rolls back, so nothing is undone without its agent hearing of it.
      KinEventQueueConflict: () => Effect.fail(notNow(plan.key)),
      KinEventQueueUnknownEvent: () => Effect.fail(notNow(plan.key)),
    }),
  );
});

const notNow = (key: string) =>
  new KinChatError({
    reason: "conflict",
    message: `${key} couldn't be undone just now, so nothing changed. Try again.`,
  });

const undone = (why: string): KinChoiceOutcome => ({
  title: "Nothing was undone",
  text: `${why}, so nothing was undone.`,
});

/**
 * A tap on the note of a taken default: Keep leaves it; Undo puts back what that one change
 * wrote, only while the entry is still as it left it. The person asked may, and anyone who may
 * change the entry; the change is theirs, or the asking agent's for them when they couldn't.
 */
export const runTaken = Effect.fn("KinDefaultTaken.run")(function* (
  tap: {
    readonly orgId: KinOrgId;
    readonly personId: KinPersonId;
    readonly chatId: KinChatId;
  },
  plan: TakenPlan,
  records: KinRecords["Service"],
) {
  const { orgId, personId } = tap;
  const sql = yield* SqlClient.SqlClient;
  const [question] = yield* sql<{ personId: string; agentId: string; state: string }>`SELECT
      person_id AS "personId", agent_id AS "agentId", state FROM kin_questions
    WHERE org_id = ${orgId} AND question_id = ${plan.questionId}`;
  const [row] = yield* sql<{ key: string; registerId: string; state: string; rev: number }>`
    SELECT key, register_id AS "registerId", state, rev FROM kin_records
    WHERE org_id = ${orgId} AND record_id = ${plan.recordId}`;
  const [change] = yield* sql<{ fields: string }>`SELECT fields_json AS fields
    FROM kin_record_changes
    WHERE org_id = ${orgId} AND record_id = ${plan.recordId} AND seq = ${plan.seq}`;
  if (
    question === undefined ||
    question.state !== "default_taken" ||
    question.agentId !== plan.agentId ||
    row === undefined ||
    change === undefined
  )
    return undone(`${plan.key} isn't there as it was`);
  const patch = reversal({
    kind: "updated",
    registerId: row.registerId,
    state: row.state,
    fields: parseChanges(change.fields),
  });
  const owner = yield* ownerLevel(orgId, personId);
  const mayChange =
    owner ||
    (yield* teamGuard(orgId, personId, {
      row: { recordId: plan.recordId, key: row.key },
      changes: true,
      input: patch ?? {},
    }).pipe(Effect.as(true), Effect.catchTags({ KinChatError: () => Effect.succeed(false) })));
  if (!mayChange && question.personId !== personId)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: `Only the person it was asked of, or someone who may change ${plan.key}, can undo this.`,
    });
  if (plan.kind === "keep_default")
    return { title: "Kept", text: `${quoted(plan.label, 60)} stands.` };
  if (row.rev !== plan.rev) return undone(`${plan.key} changed since`);
  if (patch === undefined) return undone(`Kin can't put ${plan.key} back on its own`);
  const writer: Writer = mayChange
    ? {
        actor: { _tag: "person", personId },
        via: "owner",
        askedBy: personId,
        chatId: tap.chatId,
        ...(owner ? {} : { teammate: true }),
      }
    : {
        actor: { _tag: "agent", agentId: KinAgentId.make(plan.agentId) },
        via: "lead",
        askedBy: personId,
        chatId: tap.chatId,
      };
  yield* records.update(orgId, writer, row.key, patch, plan.rev);
  yield* tellUndone(orgId, plan, tap.chatId);
  return { title: "Undone", text: `Put ${plan.key} ${quoted(plan.title)} back as it was.` };
});
