// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous event-id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  isKinSalesDomain,
  KinAgentId,
  KinChatId,
  KinEvent,
  KinEventId,
  KinPersonId,
  type KinOrgId,
  type KinPulseFact,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { personConnections } from "../connections/ConnectionRows.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { personQuietUntil, validZone } from "../triggers/quietHold.ts";
import { dayIn } from "../work/money.ts";
import { startOfDay } from "../work/recordRows.ts";
import { iso, type SenseContext } from "./senses/shared.ts";
import { forHolder, markTold } from "./told.ts";

/** Draft wakes one person gets in a day, at most: one per follow-up, never more than this. */
const DRAFT_WAKES_PER_DAY = 20;
/** The told ledger's party for a person's draft wakes, apart from what they were told. */
const draftParty = (personId: string) => `draft:${personId}`;
const FOLLOW_UPS = new Set<KinPulseFact["sense"]>(["task_late", "task_due_soon"]);
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 24);

/**
 * A person's own follow-up to a client, due today or late, with no mail card open on it: one
 * wake of the sales agent in their own chat with it. One per follow-up per day in their zone, at
 * most `DRAFT_WAKES_PER_DAY`, told as `draftParty`; Clients on, and only facts they may see.
 */
export const draftWakes = Effect.fn("KinPulse.draftWakes")(function* (input: {
  readonly ctx: SenseContext;
  /** Open facts, unhandled and not set aside. */
  readonly open: ReadonlyArray<KinPulseFact>;
  /** The facts this person may see (`visibleTo`). */
  readonly sees: (
    personId: KinPersonId,
    facts: ReadonlyArray<KinPulseFact>,
  ) => Effect.Effect<ReadonlyArray<{ readonly key: string }>, SqlError, SqlClient.SqlClient>;
}) {
  const { ctx } = input;
  const { orgId, at } = ctx;
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const woken: Array<{ readonly personId: string; readonly key: string }> = [];
  const due = input.open.filter(
    (fact) =>
      FOLLOW_UPS.has(fact.sense) &&
      fact.actor._tag === "person" &&
      fact.subject.recordId !== undefined &&
      forHolder(fact, at, ctx.zone),
  );
  if (due.length === 0) return woken;
  const leads = yield* sql<{ agentId: string; domain: string }>`SELECT l.agent_id AS "agentId",
      l.domain FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    WHERE l.org_id = ${orgId} ORDER BY l.agent_id`;
  const sales = leads.find((lead) => isKinSalesDomain(lead.domain));
  if (sales === undefined) return woken;
  const agentId = KinAgentId.make(sales.agentId);
  // A follow-up of ours with a client, and no mail waiting on a Confirm for it yet.
  const records = new Set(
    (yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId" FROM kin_records r
      LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id
      WHERE r.org_id = ${orgId} AND r.register_id = 'work'
        AND r.record_id IN ${sql.in(due.map((fact) => fact.subject.recordId!))}
        AND COALESCE(r.side, 'ours') = 'ours' AND COALESCE(r.party_id, p.party_id) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM kin_connection_asks k WHERE k.org_id = r.org_id
          AND k.entry_record_id = r.record_id AND k.state = 'open')
      ORDER BY r.record_id`).map((row) => row.recordId),
  );
  const byPerson = new Map<string, Array<KinPulseFact>>();
  for (const fact of due)
    if (fact.actor._tag === "person" && records.has(fact.subject.recordId!))
      byPerson.set(fact.actor.personId, [...(byPerson.get(fact.actor.personId) ?? []), fact]);
  for (const [person, facts] of byPerson) {
    const personId = KinPersonId.make(person);
    const [who] = yield* sql<{ zone: string | null; chatId: string }>`SELECT
        p.time_zone AS zone, c.chat_id AS "chatId"
      FROM kin_people p
      JOIN kin_chats c ON c.org_id = p.org_id AND c.kind = 'direct' AND c.archived_at IS NULL
        AND c.direct_key = ${directKey(personId, agentId)}
      JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
        AND m.principal_kind = 'person' AND m.person_id = p.person_id AND m.left_at IS NULL
      WHERE p.org_id = ${orgId} AND p.person_id = ${personId} AND p.removed_at IS NULL
        AND (p.sees_clients = 1 OR p.access IN ('owner', 'co_owner'))
        AND NOT EXISTS (SELECT 1 FROM kin_agents a WHERE a.org_id = p.org_id
          AND a.agent_id = ${agentId} AND a.owner_person_id = p.person_id)
      ORDER BY c.chat_id LIMIT 1`;
    if (who === undefined) continue;
    const zone = validZone(who.zone) ?? ctx.zone;
    const day = dayIn(at, zone);
    const party = draftParty(personId);
    const today = new Set(
      (yield* sql<{ key: string }>`SELECT DISTINCT fact_key AS key FROM kin_pulse_told
        WHERE org_id = ${orgId} AND person_id = ${party}
          AND told_at >= ${startOfDay(day, zone)} AND told_at <= ${at}
        ORDER BY fact_key`).map((row) => row.key),
    );
    const seen = new Set((yield* input.sees(personId, facts)).map((fact) => fact.key));
    const fresh = facts
      .filter((fact) => seen.has(fact.key) && !today.has(fact.key))
      .toSorted((a, b) => (a.key < b.key ? -1 : 1))
      .slice(0, Math.max(0, DRAFT_WAKES_PER_DAY - today.size));
    const notBefore = yield* personQuietUntil(orgId, personId, at);
    for (const fact of fresh) {
      const dedupeKey = `${party}:${fact.key}:${day}`;
      const eventId = KinEventId.make(`pulse-${shortHash(`${orgId}\0${dedupeKey}`)}`);
      const chatId = KinChatId.make(who.chatId);
      const queued = yield* queue
        .enqueue(
          yield* decodeEvent({
            _tag: "pulse",
            orgId,
            eventId,
            agentId,
            receivedAt: DateTime.formatIso(iso(at)),
            dedupeKey,
            provenance: { _tag: "system" },
            factKeys: [fact.key],
            chatId,
            origin: { agentId, chatId, personId },
          }),
          notBefore === undefined ? undefined : { notBefore },
        )
        .pipe(
          Effect.map((result) => !result.duplicate),
          Effect.catchTags({
            KinEventQueueUnknownAgent: () => Effect.succeed(false),
            KinEventQueueRetiredAgent: () => Effect.succeed(false),
          }),
        );
      if (!queued) continue;
      yield* markTold({ orgId, personId: party, eventId, facts: [fact], at, zone: ctx.zone });
      woken.push({ personId, key: fact.key });
    }
  }
  return woken;
});

/** The wake's own line when the person has their own mailbox: the agent reads it. */
export const DRAFT_FROM_MAILBOX = (name: string, address: string) =>
  `Kin woke you for ${name}: this follow-up of theirs is due, and nobody has written to the client yet. Draft the mail to the contact below from their own mailbox (${address}) with kin_connection_call mail_send, naming the task's key in the mail, so it waits on a Confirm card for them. Nothing goes until they tap Confirm: never say it was sent. Then tell them in one short line that it is ready.`;
/** The wake's own line when the person has no mailbox of their own connected. */
export const DRAFT_CALL_NOTES = (name: string) =>
  `Kin woke you for ${name}: this follow-up of theirs is due, and nobody has written to the client yet. No mailbox of theirs is connected, so draft no mail: write call notes on the task with record_comment (what to say, what was promised, the last contact), then tell them in one short line that the notes are on the task.`;

/**
 * What a draft wake's turn reads: Kin's line and the follow-up as data, from stored rows: the
 * task, its client's first contact with an address, the last comment on it, and the mailbox it
 * may draft from. Undefined once the follow-up closed or the person left.
 */
export const draftWakeText = Effect.fn("KinPulse.draftWakeText")(function* (
  orgId: KinOrgId,
  event: Extract<KinEvent, { readonly _tag: "pulse" }>,
) {
  const personId = event.origin?.personId;
  if (personId === undefined || event.chatId === undefined) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [task] = yield* sql<{
    key: string;
    title: string;
    sense: string;
    client: string | null;
    partyId: string | null;
  }>`SELECT r.key, r.title, f.sense, c.title AS client, c.record_id AS "partyId"
    FROM kin_pulse_facts f
    JOIN kin_records r ON r.org_id = f.org_id AND r.record_id = f.subject_record_id
      AND r.register_id = 'work' AND r.state NOT IN ('done', 'dropped')
    LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.register_id = 'clients'
      AND c.record_id = COALESCE(r.party_id, p.party_id)
    WHERE f.org_id = ${orgId} AND f.fact_key = ${event.factKeys[0] ?? ""}
      AND f.cleared_at IS NULL`;
  if (task === undefined) return undefined;
  const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId} AND removed_at IS NULL`;
  if (person === undefined) return undefined;
  const [contact] =
    task.partyId === null
      ? []
      : yield* sql<{ name: string; email: string }>`SELECT title AS name,
          trim(json_extract(fields_json, '$.email')) AS email FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'contacts' AND state = 'open'
          AND party_id = ${task.partyId}
          AND trim(COALESCE(json_extract(fields_json, '$.email'), '')) <> ''
        ORDER BY lower(title), key LIMIT 1`;
  const [said] = yield* sql<{ text: string }>`SELECT m.body AS text FROM kin_record_comments m
    JOIN kin_records r ON r.org_id = m.org_id AND r.record_id = m.record_id
    WHERE m.org_id = ${orgId} AND r.key = ${task.key} AND m.removed_at IS NULL
    ORDER BY m.seq DESC LIMIT 1`;
  const [mailbox] = yield* personConnections(orgId, personId);
  const address =
    mailbox === undefined || mailbox.state !== "active" || mailbox.pausedAt !== null
      ? undefined
      : (mailbox.accountLabel ?? mailbox.label);
  return {
    text:
      address === undefined
        ? DRAFT_CALL_NOTES(person.name)
        : DRAFT_FROM_MAILBOX(person.name, address),
    data: {
      task: task.key,
      title: task.title,
      ...(task.sense === "task_late" ? { late: true } : { dueToday: true }),
      ...(task.client === null ? {} : { client: task.client }),
      writeTo: contact ?? `${task.client ?? "this client"} has no contact with an email`,
      ...(said === undefined
        ? {}
        : { lastComment: Array.from(said.text.trim()).slice(0, 200).join("") }),
      ...(address === undefined ? { mailbox: "none connected" } : { from: address }),
    },
  };
});
