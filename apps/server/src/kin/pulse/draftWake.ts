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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { KinChatService } from "../chat/KinChatService.ts";
import { personConnections } from "../connections/ConnectionRows.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import * as KinShell from "../shell/KinShell.ts";
import { personQuietUntil, validZone } from "../triggers/quietHold.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone, startOfDay } from "../work/recordRows.ts";
import { seenBy, viewerOfPeople } from "../work/teamView.ts";
import { iso, type SenseContext } from "./senses/shared.ts";

/** Draft wakes one person gets in a day, at most: one per follow-up, never more than this. */
const DRAFT_WAKES_PER_DAY = 20;
/** The told ledger's party for a person's draft wakes, apart from what they were told. */
const draftParty = (personId: string) => `draft:${personId}`;
/** A follow-up's slot in that ledger: by its task's own id, whichever sense it is now. */
const taskSlot = (recordId: string) => `task:${recordId}`;
const FOLLOW_UPS = new Set<KinPulseFact["sense"]>(["task_late", "task_due_soon"]);
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 24);

/** The sales seat that drafts follow-ups: the first live lead whose domain sells. */
const salesLead = Effect.fnUntraced(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const leads = yield* sql<{ agentId: string; domain: string }>`SELECT l.agent_id AS "agentId",
      l.domain FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    WHERE l.org_id = ${orgId} ORDER BY l.agent_id`;
  const found = leads.find((lead) => isKinSalesDomain(lead.domain));
  return found === undefined ? undefined : KinAgentId.make(found.agentId);
});

/**
 * Whether `recordId` is, right now, a follow-up `personId` may be drafted for: an open task of
 * ours they hold, with a client, due today in their zone or late, that they may see; they are on
 * the team with Clients on; the company has Clients on (and Deals, for a deal's step); and no mail
 * card from their own mailbox or the company's is open on it. Their zone, or undefined.
 */
const stillDue = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: string,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* KinShell.sectionOnFor(orgId, "clients").pipe(Effect.orElseSucceed(() => false))))
    return undefined;
  const [row] = yield* sql<{ dueAt: number | null; zone: string | null; deal: number }>`SELECT
      r.due_at AS "dueAt", p.time_zone AS zone,
      EXISTS (SELECT 1 FROM kin_record_links l JOIN kin_records d ON d.org_id = l.org_id
        AND d.record_id = l.target AND d.register_id = 'deals'
        WHERE l.org_id = r.org_id AND l.record_id = r.record_id AND l.kind = 'record') AS deal
    FROM kin_records r
    JOIN kin_people p ON p.org_id = r.org_id AND p.person_id = ${personId}
      AND p.removed_at IS NULL
      AND (p.sees_clients = 1 OR p.access IN ('owner', 'co_owner'))
    LEFT JOIN kin_records pr ON pr.org_id = r.org_id AND pr.record_id = r.project_id
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId} AND r.register_id = 'work'
      AND r.state NOT IN ('done', 'dropped') AND COALESCE(r.side, 'ours') = 'ours'
      AND r.owner_kind = 'person' AND r.owner_id = ${personId}
      AND COALESCE(r.party_id, pr.party_id) IS NOT NULL
      AND ${seenBy(sql, (yield* ownerLevel(orgId, personId)) ? { _tag: "ownerLevel" } : viewerOfPeople([personId]))}
      -- A card a former holder's mailbox drew doesn't stand for theirs.
      AND NOT EXISTS (SELECT 1 FROM kin_connection_asks k JOIN kin_connections c
          ON c.org_id = k.org_id AND c.connection_id = k.connection_id
        WHERE k.org_id = r.org_id AND k.entry_record_id = r.record_id AND k.state = 'open'
          AND (c.person_id IS NULL OR c.person_id = ${personId}))`;
  if (row === undefined || row.dueAt === null) return undefined;
  if (
    row.deal === 1 &&
    !(yield* KinShell.sectionOnFor(orgId, "deals").pipe(Effect.orElseSucceed(() => false)))
  )
    return undefined;
  const zone = validZone(row.zone) ?? (yield* ownerZone(orgId));
  const due = row.dueAt <= at || dayIn(row.dueAt, zone) === dayIn(at, zone);
  return due ? zone : undefined;
});

/**
 * A person's own follow-up to a client that is due (`stillDue`): one wake of the sales agent in
 * their own chat with it, opened if they may message it and have none. The wake starts only if
 * it is still due and outside their quiet hours then (`draftWakeText`), which takes the day's slot.
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
  const chats = yield* Effect.serviceOption(KinChatService);
  const woken: Array<{ readonly personId: string; readonly key: string }> = [];
  const due = input.open.filter(
    (fact) =>
      FOLLOW_UPS.has(fact.sense) &&
      fact.actor._tag === "person" &&
      fact.subject.recordId !== undefined,
  );
  if (due.length === 0) return woken;
  const agentId = yield* salesLead(orgId);
  if (agentId === undefined) return woken;
  const byPerson = new Map<string, Array<KinPulseFact>>();
  for (const fact of due)
    if (fact.actor._tag === "person")
      byPerson.set(fact.actor.personId, [...(byPerson.get(fact.actor.personId) ?? []), fact]);
  for (const [person, facts] of byPerson) {
    const personId = KinPersonId.make(person);
    const seen = new Set((yield* input.sees(personId, facts)).map((fact) => fact.key));
    const ready: Array<{ fact: KinPulseFact; recordId: string; zone: string }> = [];
    const tasks = new Set<string>();
    for (const fact of facts.toSorted((a, b) => (a.key < b.key ? -1 : 1))) {
      const recordId = fact.subject.recordId!;
      if (!seen.has(fact.key) || tasks.has(recordId)) continue;
      const zone = yield* stillDue(orgId, personId, recordId, at);
      if (zone === undefined) continue;
      tasks.add(recordId);
      ready.push({ fact, recordId, zone });
    }
    if (ready.length === 0) continue;
    const zone = ready[0]!.zone;
    const day = dayIn(at, zone);
    const taken = new Set(
      (yield* sql<{ key: string }>`SELECT DISTINCT fact_key AS key FROM kin_pulse_told
        WHERE org_id = ${orgId} AND person_id = ${draftParty(personId)} AND sig = ${day}
        ORDER BY fact_key`).map((row) => row.key),
    );
    const fresh = ready
      .filter((one) => !taken.has(taskSlot(one.recordId)))
      .slice(0, Math.max(0, DRAFT_WAKES_PER_DAY - taken.size));
    if (fresh.length === 0) continue;
    const chatId = yield* directChat(orgId, personId, agentId, chats);
    if (chatId === undefined) continue;
    const notBefore = yield* personQuietUntil(orgId, personId, at);
    for (const { fact, recordId } of fresh) {
      const dedupeKey = `${draftParty(personId)}:${taskSlot(recordId)}:${day}`;
      const queued = yield* queue
        .enqueue(
          yield* decodeEvent({
            _tag: "pulse",
            orgId,
            // A later pass that day is the same wake: its dedupe key finds this one.
            eventId: KinEventId.make(`pulse-${shortHash(`${orgId}\0${dedupeKey}\0${at}`)}`),
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
      if (queued) woken.push({ personId, key: fact.key });
    }
  }
  return woken;
});

/** Their direct chat with the sales agent, opened by the usual path when they may message it. */
const directChat = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  agentId: KinAgentId,
  chats: Option.Option<KinChatService["Service"]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const [found] = yield* sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
    JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
      AND m.principal_kind = 'person' AND m.person_id = ${personId} AND m.left_at IS NULL
    WHERE c.org_id = ${orgId} AND c.kind = 'direct' AND c.archived_at IS NULL
      AND c.direct_key = ${directKey(personId, agentId)}
    ORDER BY c.chat_id LIMIT 1`;
  if (found !== undefined) return KinChatId.make(found.chatId);
  if (Option.isNone(chats)) return undefined;
  const made = yield* chats.value
    .createDirect({ _tag: "person", orgId, personId }, { orgId, agentId })
    .pipe(Effect.option);
  return Option.isSome(made) ? made.value.chatId : undefined;
});

/** A wake Kin checked again as it started, and found nothing to draft for now. */
export const DRAFT_NOTHING_NOW =
  "Kin checked this follow-up again as this turn started: there is nothing to draft for it now.";
/** The wake's own line when the person has their own mailbox and a contact to write to. */
export const DRAFT_FROM_MAILBOX = (name: string, address: string) =>
  `Kin woke you for ${name}: this follow-up of theirs is due and no mail for it waits on a card. Draft the mail to the contact below from their own mailbox (${address}) with kin_connection_call mail_send, naming the task's key in the mail, so it waits on a Confirm card for them. Nothing goes until they tap Confirm: never say it was sent. Then tell them in one short line that it is ready.`;
/** The wake's own line when there is no mailbox of theirs, or no contact they may see. */
export const DRAFT_CALL_NOTES = (name: string, mailbox: boolean) =>
  `Kin woke you for ${name}: this follow-up of theirs is due and no mail for it waits on a card. ${mailbox ? "There is no contact address for it that they may see" : "No mailbox of theirs is connected"}, so draft no mail: give them call notes here in this chat (what to say, what was promised, the last contact).`;

/**
 * What a draft wake's turn reads, checked again as it starts: still theirs and due (`stillDue`),
 * outside their quiet hours, and the day's slot for this task taken now, at most 20 a day. Only
 * what their own screens show: the task, and its client, contact and last comment where they may
 * see them. Undefined when the wake should do nothing.
 */
export const draftWakeText = Effect.fn("KinPulse.draftWakeText")(function* (
  orgId: KinOrgId,
  event: Extract<KinEvent, { readonly _tag: "pulse" }>,
) {
  const personId = event.origin?.personId;
  if (personId === undefined || event.chatId === undefined) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [fact] = yield* sql<{ recordId: string | null }>`SELECT subject_record_id AS "recordId"
    FROM kin_pulse_facts WHERE org_id = ${orgId} AND fact_key = ${event.factKeys[0] ?? ""}`;
  if (fact?.recordId == null) return undefined;
  const at = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const zone = yield* stillDue(orgId, personId, fact.recordId, at);
  if (zone === undefined) return undefined;
  if ((yield* personQuietUntil(orgId, personId, at)) !== undefined) return undefined;
  const day = dayIn(at, zone);
  const party = draftParty(personId);
  const slot = taskSlot(fact.recordId);
  const today = yield* sql<{ key: string; eventId: string }>`SELECT fact_key AS key,
      event_id AS "eventId" FROM kin_pulse_told
    WHERE org_id = ${orgId} AND person_id = ${party} AND sig = ${day} ORDER BY fact_key`;
  const mine = today.find((row) => row.key === slot);
  if (mine !== undefined && mine.eventId !== event.eventId) return undefined;
  if (mine === undefined) {
    if (new Set(today.map((row) => row.key)).size >= DRAFT_WAKES_PER_DAY) return undefined;
    yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id, sig, told_at)
      VALUES (${orgId}, ${party}, ${slot}, ${event.eventId}, ${day}, ${at})
      ON CONFLICT DO NOTHING`;
  }
  const viewer = (yield* ownerLevel(orgId, personId))
    ? ({ _tag: "ownerLevel" } as const)
    : viewerOfPeople([personId]);
  const [task] = yield* sql<{
    key: string;
    title: string;
    late: number;
    client: string | null;
    partyId: string | null;
  }>`SELECT r.key, r.title, (r.due_at < ${startOfDay(day, zone)}) AS late,
      c.title AS client, c.record_id AS "partyId"
    FROM kin_records r
    LEFT JOIN kin_records pr ON pr.org_id = r.org_id AND pr.record_id = r.project_id
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.register_id = 'clients'
      AND c.record_id = COALESCE(r.party_id, pr.party_id)
      AND c.record_id IN (SELECT r.record_id FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.register_id = 'clients' AND ${seenBy(sql, viewer)})
    WHERE r.org_id = ${orgId} AND r.record_id = ${fact.recordId}`;
  const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId} AND removed_at IS NULL`;
  if (task === undefined || person === undefined) return undefined;
  const [contact] =
    task.partyId === null
      ? []
      : yield* sql<{ name: string; email: string }>`SELECT r.title AS name,
          trim(json_extract(r.fields_json, '$.email')) AS email FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.register_id = 'contacts' AND r.state = 'open'
          AND r.party_id = ${task.partyId} AND ${seenBy(sql, viewer)}
          AND trim(COALESCE(json_extract(r.fields_json, '$.email'), '')) <> ''
        ORDER BY lower(r.title), r.key LIMIT 1`;
  const [said] = yield* sql<{ text: string }>`SELECT m.body AS text FROM kin_record_comments m
    WHERE m.org_id = ${orgId} AND m.record_id = ${fact.recordId} AND m.removed_at IS NULL
    ORDER BY m.seq DESC LIMIT 1`;
  const [mailbox] = yield* personConnections(orgId, personId);
  const address =
    mailbox === undefined || mailbox.state !== "active" || mailbox.pausedAt !== null
      ? undefined
      : (mailbox.accountLabel ?? mailbox.label);
  return {
    text:
      address !== undefined && contact !== undefined
        ? DRAFT_FROM_MAILBOX(person.name, address)
        : DRAFT_CALL_NOTES(person.name, address !== undefined),
    data: {
      task: task.key,
      title: task.title,
      ...(task.late === 1 ? { late: true } : { dueToday: true }),
      ...(task.client === null ? {} : { client: task.client }),
      ...(contact === undefined ? {} : { writeTo: contact }),
      ...(said === undefined
        ? {}
        : { lastComment: Array.from(said.text.trim()).slice(0, 200).join("") }),
      ...(address === undefined ? { mailbox: "none connected" } : { from: address }),
    },
  };
});
