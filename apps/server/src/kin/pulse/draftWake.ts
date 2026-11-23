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
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import * as Reach from "../lead/Reach.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import * as KinShell from "../shell/KinShell.ts";
import { personQuietUntil, validZone } from "../triggers/quietHold.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone, startOfDay } from "../work/recordRows.ts";
import { placesOf, seenBy, viewerOfPeople } from "../work/teamView.ts";
import { HEAD_STARTS_PER_DAY } from "./prepareSenses.ts";
import { iso, type SenseContext } from "./senses/shared.ts";

/** Draft wakes one person gets in a day, at most: one per follow-up, never more than this. */
/** The told ledger's party for a person's draft wakes, apart from what they were told. */
const draftParty = (personId: string) => `draft:${personId}`;
/** A follow-up's slot in that ledger: by its task's own id, whichever sense it is now. */
const taskSlot = (recordId: string) => `task:${recordId}`;
const FOLLOW_UPS = new Set<KinPulseFact["sense"]>(["task_late", "task_due_soon"]);
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 24);

/** A follow-up to a client is drafted as mail or call notes; any other task, as a doc. */
type DraftPath = "mail" | "doc";

/**
 * Who may draft a follow-up, in order: the live lead its project names as its lead; for one to a
 * client, the first live lead whose domain sells; the company's own lead (`routing`). A paused
 * lead runs nothing, so it drafts nothing.
 */
const draftersFor = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  recordId: string,
  path: DraftPath,
  routing: KinAgentId | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const leads = yield* sql<{ agentId: string; domain: string; leadsProject: number }>`SELECT
      l.agent_id AS "agentId", l.domain,
      EXISTS (SELECT 1 FROM kin_records r JOIN kin_records p ON p.org_id = r.org_id
          AND p.record_id = r.project_id AND p.register_id = 'projects'
        WHERE r.org_id = l.org_id AND r.record_id = ${recordId}
          AND p.owner_kind = 'agent' AND p.owner_id = l.agent_id) AS "leadsProject"
    FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL AND a.paused_at IS NULL
    WHERE l.org_id = ${orgId} ORDER BY l.agent_id`;
  const live = new Set(leads.map((lead) => lead.agentId));
  const chosen = [
    leads.find((lead) => lead.leadsProject === 1)?.agentId,
    path === "mail" ? leads.find((lead) => isKinSalesDomain(lead.domain))?.agentId : undefined,
    routing,
  ].flatMap((agentId) => (agentId !== undefined && live.has(agentId) ? [agentId] : []));
  return [...new Set(chosen)].map((agentId) => KinAgentId.make(agentId));
});

/**
 * Their zone and how to draft `recordId`, an open task of ours `personId` holds and sees, due today
 * or late; with a client, Clients on for both and no mail card open on it (Deals on for a deal's
 * step); without one, no doc linked to it since its due day began. Undefined when not.
 */
const stillDue = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: string,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const viewer = (yield* ownerLevel(orgId, personId))
    ? ({ _tag: "ownerLevel" } as const)
    : viewerOfPeople([personId]);
  const [row] = yield* sql<{
    dueAt: number | null;
    zone: string | null;
    deal: number;
    client: number;
    seesClients: number;
    carded: number;
    linkedAt: number | null;
  }>`SELECT r.due_at AS "dueAt", p.time_zone AS zone,
      EXISTS (SELECT 1 FROM kin_record_links l JOIN kin_records d ON d.org_id = l.org_id
        AND d.record_id = l.target AND d.register_id = 'deals'
        WHERE l.org_id = r.org_id AND l.record_id = r.record_id AND l.kind = 'record') AS deal,
      COALESCE(r.party_id, pr.party_id) IS NOT NULL AS client,
      (p.sees_clients = 1 OR p.access IN ('owner', 'co_owner')) AS "seesClients",
      -- A card a former holder's mailbox drew doesn't stand for theirs.
      EXISTS (SELECT 1 FROM kin_connection_asks k JOIN kin_connections c
          ON c.org_id = k.org_id AND c.connection_id = k.connection_id
        WHERE k.org_id = r.org_id AND k.entry_record_id = r.record_id AND k.state = 'open'
          AND (c.person_id IS NULL OR c.person_id = ${personId})) AS carded,
      -- Only a doc they can open counts as its first piece.
      (SELECT MAX(l.created_at) FROM kin_record_links l
        WHERE l.org_id = r.org_id AND l.kind = 'record'
          AND (l.record_id = r.record_id OR l.target = r.record_id)
          AND (CASE WHEN l.record_id = r.record_id THEN l.target ELSE l.record_id END) IN (
            SELECT r.record_id FROM kin_records r WHERE r.org_id = ${orgId}
              AND r.register_id = 'docs' AND r.state <> 'dropped' AND ${seenBy(sql, viewer)})
      ) AS "linkedAt"
    FROM kin_records r
    JOIN kin_people p ON p.org_id = r.org_id AND p.person_id = ${personId}
      AND p.removed_at IS NULL
    LEFT JOIN kin_records pr ON pr.org_id = r.org_id AND pr.record_id = r.project_id
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId} AND r.register_id = 'work'
      AND r.state NOT IN ('done', 'dropped') AND COALESCE(r.side, 'ours') = 'ours'
      AND r.owner_kind = 'person' AND r.owner_id = ${personId}
      AND ${seenBy(sql, viewer)}`;
  if (row === undefined || row.dueAt === null) return undefined;
  const zone = validZone(row.zone) ?? (yield* ownerZone(orgId));
  if (row.dueAt > at && dayIn(row.dueAt, zone) !== dayIn(at, zone)) return undefined;
  // A doc they can open, linked to it since its day began, is its first piece: a later wake
  // writes nothing. Without Docs they could open none, so none is made.
  if (row.client === 0) {
    if (row.linkedAt !== null && row.linkedAt >= startOfDay(dayIn(row.dueAt, zone), zone))
      return undefined;
    if (viewer._tag !== "ownerLevel" && !(yield* placesOf(orgId, personId)).reaches.docs)
      return undefined;
    return { zone, path: "doc" as const };
  }
  if (row.seesClients !== 1 || row.carded === 1) return undefined;
  const on = (section: "clients" | "deals") =>
    KinShell.sectionOnFor(orgId, section).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* on("clients")) || (row.deal === 1 && !(yield* on("deals")))) return undefined;
  return { zone, path: "mail" as const };
});

/**
 * A person's own task that is due (`stillDue`): one wake, in their own chat, of the first agent
 * that may draft it (`draftersFor`) and that they may message, the chat opened if they have none.
 * The wake starts only if it is still due and outside their quiet hours then (`draftWakeText`),
 * which takes the day's slot.
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
  const byPerson = new Map<string, Array<KinPulseFact>>();
  for (const fact of due)
    if (fact.actor._tag === "person")
      byPerson.set(fact.actor.personId, [...(byPerson.get(fact.actor.personId) ?? []), fact]);
  for (const [person, facts] of byPerson) {
    const personId = KinPersonId.make(person);
    const seen = new Set((yield* input.sees(personId, facts)).map((fact) => fact.key));
    const ready: Array<{ fact: KinPulseFact; recordId: string; zone: string; path: DraftPath }> =
      [];
    const tasks = new Set<string>();
    for (const fact of facts.toSorted((a, b) => (a.key < b.key ? -1 : 1))) {
      const recordId = fact.subject.recordId!;
      if (!seen.has(fact.key) || tasks.has(recordId)) continue;
      const still = yield* stillDue(orgId, personId, recordId, at);
      if (still === undefined) continue;
      tasks.add(recordId);
      ready.push({ fact, recordId, ...still });
    }
    if (ready.length === 0) continue;
    const zone = ready[0]!.zone;
    const day = dayIn(at, zone);
    const notBefore = yield* personQuietUntil(orgId, personId, at);
    const chatWith = new Map<KinAgentId, KinChatId | undefined>();
    for (const { fact, recordId, path } of ready) {
      // One wake a task and day, whichever agent holds it: a held one is checked as it starts.
      if (yield* slotTaken(orgId, personId, recordId, day)) continue;
      if (path === "doc" && (yield* triedOut(orgId, personId, recordId, day))) continue;
      let drafter: { agentId: KinAgentId; chatId: KinChatId } | undefined;
      for (const agentId of yield* draftersFor(orgId, recordId, path, ctx.chief)) {
        if (!chatWith.has(agentId))
          chatWith.set(agentId, yield* directChat(orgId, personId, agentId, chats));
        const chatId = chatWith.get(agentId);
        if (chatId !== undefined) {
          drafter = { agentId, chatId };
          break;
        }
      }
      if (drafter === undefined) continue;
      const { agentId, chatId } = drafter;
      const dedupeKey = `${draftParty(personId)}:${taskSlot(recordId)}:${day}:${agentId}`;
      const eventId = KinEventId.make(`pulse-${shortHash(`${orgId}\0${dedupeKey}\0${at}`)}`);
      // The day's window is charged only for a wake that is queued: counted and taken at once.
      if (!(yield* reserve(orgId, personId, recordId, day, eventId, at))) {
        if (yield* windowFull(orgId, personId, day)) break;
        continue;
      }
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
            KinEventQueueConflict: () => Effect.succeed(false),
            KinEventQueueUnknownEvent: () => Effect.succeed(false),
            KinEventQueueUnknownAgent: () => Effect.succeed(false),
            KinEventQueueRetiredAgent: () => Effect.succeed(false),
          }),
        );
      if (!queued) {
        yield* freeSlot(orgId, personId, eventId);
        continue;
      }
      woken.push({ personId, key: fact.key });
    }
  }
  return woken;
});

const daySlots = Effect.fnUntraced(function* (orgId: KinOrgId, personId: KinPersonId, day: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ key: string; eventId: string }>`SELECT fact_key AS key,
      event_id AS "eventId" FROM kin_pulse_told
    WHERE org_id = ${orgId} AND person_id = ${draftParty(personId)} AND sig = ${day}
    ORDER BY fact_key, event_id`;
});

const slotTaken = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: string,
  day: string,
) {
  return (yield* daySlots(orgId, personId, day)).some((row) => row.key === taskSlot(recordId));
});

const windowFull = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  day: string,
) {
  const keys = new Set((yield* daySlots(orgId, personId, day)).map((row) => row.key));
  return keys.size >= HEAD_STARTS_PER_DAY;
});

/** Takes the task's slot for the day if it is free and the day's window has room, in one write. */
const reserve = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: string,
  day: string,
  eventId: string,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const party = draftParty(personId);
  const slot = taskSlot(recordId);
  const taken = yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id, sig,
      told_at)
    SELECT ${orgId}, ${party}, ${slot}, ${eventId}, ${day}, ${at}
    WHERE NOT EXISTS (SELECT 1 FROM kin_pulse_told WHERE org_id = ${orgId}
        AND person_id = ${party} AND fact_key = ${slot} AND sig = ${day})
      AND (SELECT COUNT(DISTINCT fact_key) FROM kin_pulse_told WHERE org_id = ${orgId}
        AND person_id = ${party} AND sig = ${day}) < ${HEAD_STARTS_PER_DAY}
    ON CONFLICT DO NOTHING RETURNING fact_key`;
  return taken.length > 0;
});

/** Gives back the slot a wake took, so a later pass may route the task again. */
const freeSlot = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  eventId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM kin_pulse_told WHERE org_id = ${orgId}
    AND person_id = ${draftParty(personId)} AND event_id = ${eventId}`;
});

/** Doc head starts a task gets before one stands: the first day and two more. */
const DOC_TRIES = 3;
/**
 * Whether a task's doc head start was tried on `DOC_TRIES` other days since its title, notes,
 * due day or holder last changed, with nothing made: it waits for one of those to change.
 */
const triedOut = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: string,
  day: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ days: number }>`SELECT COUNT(DISTINCT t.sig) AS days
    FROM kin_pulse_told t
    WHERE t.org_id = ${orgId} AND t.person_id = ${draftParty(personId)}
      AND t.fact_key = ${taskSlot(recordId)} AND t.sig <> ${day}
      AND t.told_at > COALESCE((SELECT MAX(c.at) FROM kin_record_changes c, json_each(c.fields_json) f
        WHERE c.org_id = t.org_id AND c.record_id = ${recordId}
          AND json_extract(f.value, '$.field') IN ('title', 'notes', 'due', 'owner')), 0)`;
  return (row?.days ?? 0) >= DOC_TRIES;
});

/** Their direct chat with `agentId`, opened by the usual path, while they may message it now. */
const directChat = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  agentId: KinAgentId,
  chats: Option.Option<KinChatService["Service"]>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* Reach.reaches(orgId, Reach.person(personId), Reach.agent(agentId))))
    return undefined;
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

/**
 * The doc head start this turn is, from its stored event: a draft wake alone in it, for a task of
 * its holder's that is still due with no client and no first piece (`stillDue`). Its one doc,
 * linked to the task, is what the turn may file for them (`teamView.draftDoc`).
 */
export const docHeadStart = Effect.fn("KinPulse.docHeadStart")(function* (
  orgId: KinOrgId,
  agentId: string,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* sql<{ dedupeKey: string | null; personId: string | null }>`SELECT
      e.dedupe_key AS "dedupeKey", json_extract(e.json, '$.origin.personId') AS "personId"
    FROM kin_events e
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
    ORDER BY e.event_id`;
  const [event] = events;
  if (events.length !== 1 || event?.personId == null || event.dedupeKey === null) return undefined;
  const personId = KinPersonId.make(event.personId);
  const prefix = `${draftParty(personId)}:task:`;
  if (!event.dedupeKey.startsWith(prefix)) return undefined;
  // `draft:<person>:task:<record>:<day>`, and since slots are taken as they queue, `:<agent>`.
  const rest = event.dedupeKey.slice(prefix.length);
  const recordId = rest.endsWith(`:${agentId}`)
    ? rest.slice(0, -`:YYYY-MM-DD:${agentId}`.length)
    : rest.slice(0, -":YYYY-MM-DD".length);
  const at = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  if ((yield* stillDue(orgId, personId, recordId, at))?.path !== "doc") return undefined;
  const [task] = yield* sql<{ key: string }>`SELECT key FROM kin_records
    WHERE org_id = ${orgId} AND record_id = ${recordId}`;
  return task === undefined ? undefined : { personId, recordId, key: task.key };
});

/** Whether `agentId` may draft this task for them now: a candidate still, and one they may message. */
const mayDraft = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: string,
  path: DraftPath,
  agentId: KinAgentId,
) {
  const sql = yield* SqlClient.SqlClient;
  const routing = (yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN }))?.agentId;
  return (
    (yield* draftersFor(orgId, recordId, path, routing)).includes(agentId) &&
    (yield* Reach.reaches(orgId, Reach.person(personId), Reach.agent(agentId)))
  );
});

/**
 * A draft wake checked as it is claimed: gone when its task is no longer theirs and due, or its
 * agent may no longer draft it for them; then its slot is given back, so a later pass routes it.
 */
export const draftWakeGone = Effect.fn("KinPulse.draftWakeGone")(function* (
  orgId: KinOrgId,
  event: Extract<KinEvent, { readonly _tag: "pulse" }>,
) {
  const personId = event.origin?.personId;
  if (personId === undefined) return false;
  const sql = yield* SqlClient.SqlClient;
  const [fact] = yield* sql<{ recordId: string | null }>`SELECT subject_record_id AS "recordId"
    FROM kin_pulse_facts WHERE org_id = ${orgId} AND fact_key = ${event.factKeys[0] ?? ""}`;
  if (fact?.recordId == null) return true;
  const at = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const still = yield* stillDue(orgId, personId, fact.recordId, at);
  if (
    still !== undefined &&
    (yield* mayDraft(orgId, personId, fact.recordId, still.path, event.agentId))
  )
    return false;
  if (still !== undefined) yield* freeSlot(orgId, personId, event.eventId);
  return true;
});

/** A wake Kin queued for one person's own task (`draftWakes`), in their chat. */
export const isDraftWake = (event: Extract<KinEvent, { readonly _tag: "pulse" }>) =>
  event.checkIn === undefined &&
  event.origin !== undefined &&
  event.chatId !== undefined &&
  (event.dedupeKey ?? "").startsWith("draft:");

/** A wake Kin checked again as it started, and found nothing to draft for now. */
export const DRAFT_NOTHING_NOW =
  "Kin checked this follow-up again as this turn started: there is nothing to draft for it now.";
/** The wake's own line when the person has their own mailbox and a contact to write to. */
export const DRAFT_FROM_MAILBOX = (name: string, address: string) =>
  `Kin woke you for ${name}: this follow-up of theirs is due and no mail for it waits on a card. Draft the mail to the contact below from their own mailbox (${address}) with kin_connection_call mail_send, naming the task's key in the mail, so it waits on a Confirm card for them. Nothing goes until they tap Confirm: never say it was sent. Then tell them in one short line that it is ready.`;
/** The wake's own line when there is no mailbox of theirs, or no contact they may see. */
export const DRAFT_CALL_NOTES = (name: string, mailbox: boolean) =>
  `Kin woke you for ${name}: this follow-up of theirs is due and no mail for it waits on a card. ${mailbox ? "There is no contact address for it that they may see" : "No mailbox of theirs is connected"}, so draft no mail: give them call notes here in this chat (what to say, what was promised, the last contact).`;
/** The wake's own line for a task with no client: its first piece is a doc linked to it. */
export const DRAFT_DOCUMENT = (name: string) =>
  `Kin woke you for ${name}: this task of theirs is due and nothing is prepared for it yet. Make its first piece now, whichever its own words call for: a first draft, an outline, a filled form or working notes, as a new doc with doc_create, linked to the task. Never change a doc someone else wrote. Then tell them in at most three short sentences: what you made, with its card, and what was left open in it. Never retell what the doc says. If nothing can be prepared, say in one line what is missing and make nothing.`;

/**
 * What a draft wake's turn reads, checked again as it starts: still theirs and due (`stillDue`),
 * a drafter they may message, and the day's slot for this task taken now, at most 20 a day. Only
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
  const still = yield* stillDue(orgId, personId, fact.recordId, at);
  if (still === undefined) return undefined;
  const { zone } = still;
  if (!(yield* mayDraft(orgId, personId, fact.recordId, still.path, event.agentId)))
    return undefined;
  const day = dayIn(at, zone);
  const slot = taskSlot(fact.recordId);
  const mine = (yield* daySlots(orgId, personId, day)).filter((row) => row.key === slot);
  // A wake queued before slots were taken as it was queued takes its own now.
  if (
    mine.length === 0 &&
    !(yield* reserve(orgId, personId, fact.recordId, day, event.eventId, at))
  )
    return undefined;
  if (mine.length > 0 && !mine.some((row) => row.eventId === event.eventId)) return undefined;
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
  const [said] = yield* sql<{ text: string }>`SELECT m.body AS text FROM kin_record_comments m
    WHERE m.org_id = ${orgId} AND m.record_id = ${fact.recordId} AND m.removed_at IS NULL
    ORDER BY m.seq DESC LIMIT 1`;
  const when = task.late === 1 ? { late: true } : { dueToday: true };
  const lastComment =
    said === undefined ? {} : { lastComment: Array.from(said.text.trim()).slice(0, 200).join("") };
  if (still.path === "doc")
    return {
      text: DRAFT_DOCUMENT(person.name),
      data: { task: task.key, title: task.title, ...when, ...lastComment },
    };
  const [contact] =
    task.partyId === null
      ? []
      : yield* sql<{ name: string; email: string }>`SELECT r.title AS name,
          trim(json_extract(r.fields_json, '$.email')) AS email FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.register_id = 'contacts' AND r.state = 'open'
          AND r.party_id = ${task.partyId} AND ${seenBy(sql, viewer)}
          AND trim(COALESCE(json_extract(r.fields_json, '$.email'), '')) <> ''
        ORDER BY lower(r.title), r.key LIMIT 1`;
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
      ...when,
      ...(task.client === null ? {} : { client: task.client }),
      ...(contact === undefined ? {} : { writeTo: contact }),
      ...lastComment,
      ...(address === undefined ? { mailbox: "none connected" } : { from: address }),
    },
  };
});
