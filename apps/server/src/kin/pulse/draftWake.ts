// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous event-id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  formatKinWhen,
  isKinSalesDomain,
  KIN_CHOICE_CARD_ACTION,
  KIN_TEXT_LOCALE,
  KinAgentId,
  KinChatId,
  KinEvent,
  KinEventId,
  KinPersonId,
  type KinMessage,
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
import { touchesOf } from "../work/touches.ts";
import * as KinShell from "../shell/KinShell.ts";
import { personQuietUntil, validZone } from "../triggers/quietHold.ts";
import { fieldList, parseFields } from "../work/lists.ts";
import { DEFAULT_STAGES, stagesOf } from "../work/dealStages.ts";
import { dayIn, formatMoneyPlain } from "../work/money.ts";
import { principalOfText } from "../work/projectSpine.ts";
import { labelledNow, owedInvoices, ownerZone, startOfDay } from "../work/recordRows.ts";
import { crmSeenBy, placesOf, seenBy, viewerOfPeople } from "../work/teamView.ts";
import { isFactCard, plansOf } from "../widgets/cardPlans.ts";
import { HEAD_STARTS_PER_DAY } from "./prepareSenses.ts";
import { daysText, iso, type SenseContext } from "./senses/shared.ts";
import { DAY_MS, HOUR_MS } from "./thresholds.ts";
import { lateBandDays } from "./told.ts";

/** Draft wakes one person gets in a day, at most: one per follow-up, never more than this. */
/** The told ledger's party for a person's draft wakes, apart from what they were told. */
const draftParty = (personId: string) => `draft:${personId}`;
/** A follow-up's slot in that ledger: by its task's own id, whichever sense it is now. */
const taskSlot = (recordId: string) => `task:${recordId}`;
/** A deal's facts its person gets a drafted follow-up for (`stillQuiet`). */
const DEAL_FOLLOW_UPS = new Set<string>(["deal_quiet", "deal_date_passed"]);
/** A deal or prospect with no next step, and a project with no plan, get one proposed. */
const PROPOSALS = new Set<string>(["deal_no_next_step", "project_no_plan"]);
/** A meeting's facts: the prep before it (`stillAhead`), its outcome asked after (`stillPassed`). */
const MEETINGS = new Set<string>(["meeting_soon", "meeting_passed"]);
/** Facts Kin routes to a person itself and checks against that person's own view. */
const ROUTED = new Set<string>([...MEETINGS, ...PROPOSALS]);
const FOLLOW_UPS = new Set<string>([
  "task_late",
  "task_due_soon",
  "theirs_late",
  ...MEETINGS,
  ...DEAL_FOLLOW_UPS,
  ...PROPOSALS,
]);
/** After Not this on a suggestion for it, a deal or project gets no new proposal this long. */
const DECLINED_REST_MS = 14 * DAY_MS;
/** A prep note this close to its meeting comes too late to read: none is made. */
const PREP_BEFORE_MS = 2 * HOUR_MS;
/** What a prep note lists of the client's open work, at most. */
const PREP_OPEN = 8;
/** A deal still open this long after its follow-up for a passed date was drafted gets another. */
const DATE_PASSED_AGAIN_MS = 7 * DAY_MS;
const senseOf = (factKey: string) => factKey.split(":")[0] ?? "";
/** A mail sent for an entry this recently is its follow-up still: no other is drafted. */
const SENT_WITHIN_MS = 3 * DAY_MS;
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 24);

/** A follow-up to a client is drafted as mail or call notes; any other task, as a doc. */
type DraftPath = "mail" | "doc";

/**
 * Who may draft a follow-up, in order: the live lead its project (or it, a project) names as its
 * lead; for one to a client, the first live lead whose domain sells; the company's own lead
 * (`routing`). A paused lead runs nothing, so it drafts nothing.
 * @public
 */
export const draftersFor = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  recordId: string,
  path: DraftPath,
  routing: KinAgentId | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const leads = yield* sql<{ agentId: string; domain: string; leadsProject: number }>`SELECT
      l.agent_id AS "agentId", l.domain,
      EXISTS (SELECT 1 FROM kin_records r JOIN kin_records p ON p.org_id = r.org_id
          AND p.record_id = COALESCE(r.project_id, r.record_id) AND p.register_id = 'projects'
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
 * How to draft `recordId`, a due or late task `personId` holds and sees: with a client, Clients on,
 * no mail card open and none sent within `SENT_WITHIN_MS`; else no doc linked since its due day.
 * One a client owes us (`theirs`) needs its client and is chased once a late band (`lateBandDays`).
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
    theirs: number;
    sentAt: number | null;
    zone: string | null;
    deal: number;
    client: number;
    seesClients: number;
    carded: number;
    linkedAt: number | null;
  }>`SELECT r.due_at AS "dueAt", (r.side = 'theirs') AS theirs, p.time_zone AS zone,
      (SELECT MAX(k.done_at) FROM kin_connection_asks k WHERE k.org_id = r.org_id
        AND k.entry_record_id = r.record_id AND k.state = 'sent') AS "sentAt",
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
      AND r.state NOT IN ('done', 'dropped')
      AND r.owner_kind = 'person' AND r.owner_id = ${personId}
      AND ${seenBy(sql, viewer)}`;
  if (row === undefined || row.dueAt === null) return undefined;
  const zone = validZone(row.zone) ?? (yield* ownerZone(orgId));
  if (row.dueAt > at && dayIn(row.dueAt, zone) !== dayIn(at, zone)) return undefined;
  if (row.theirs === 1) {
    if (row.client === 0 || row.dueAt > at) return undefined;
    const band = row.dueAt + lateBandDays((at - row.dueAt) / HOUR_MS) * DAY_MS;
    if (yield* chasedSince(orgId, personId, recordId, band, dayIn(at, zone))) return undefined;
  }
  // A doc they can open, linked to it since its day began, is its first piece: a later wake
  // writes nothing. Without Docs they could open none, so none is made.
  if (row.client === 0) {
    if (row.linkedAt !== null && row.linkedAt >= startOfDay(dayIn(row.dueAt, zone), zone))
      return undefined;
    if (viewer._tag !== "ownerLevel" && !(yield* placesOf(orgId, personId)).reaches.docs)
      return undefined;
    return { zone, path: "doc" as const, of: "task" as const };
  }
  if (row.seesClients !== 1 || row.carded === 1) return undefined;
  if (row.sentAt !== null && row.sentAt > at - SENT_WITHIN_MS) return undefined;
  const on = (section: "clients" | "deals") =>
    KinShell.sectionOnFor(orgId, section).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* on("clients")) || (row.deal === 1 && !(yield* on("deals")))) return undefined;
  return {
    zone,
    path: "mail" as const,
    of: row.theirs === 1 ? ("theirs" as const) : ("task" as const),
  };
});

/**
 * Their zone when `dealId` is an open deal `personId` looks after (`deals.ts` `hearer`: theirs, or
 * an agent's on a client of theirs) and sees in Clients, `factKey` still stands, Clients and Deals
 * are on, and no mail card is open on it or from a wake for it. Drafted once a quiet stretch; for a
 * passed date, again after `DATE_PASSED_AGAIN_MS`. Undefined when not.
 */
const stillQuiet = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  factKey: string,
  dealId: string,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const viewer = (yield* ownerLevel(orgId, personId))
    ? ({ _tag: "ownerLevel" } as const)
    : viewerOfPeople([personId]);
  const woken = `${draftParty(personId)}:${taskSlot(dealId)}:`;
  const [row] = yield* sql<{
    zone: string | null;
    seesClients: number;
    standing: number;
    carded: number;
  }>`SELECT p.time_zone AS zone,
      (p.sees_clients = 1 OR p.access IN ('owner', 'co_owner')) AS "seesClients",
      EXISTS (SELECT 1 FROM kin_pulse_facts f WHERE f.org_id = r.org_id
        AND f.fact_key = ${factKey} AND f.subject_record_id = r.record_id
        AND f.cleared_at IS NULL) AS standing,
      -- A deal's mail names no entry (only tasks are named): a card from its own wake counts.
      EXISTS (SELECT 1 FROM kin_connection_asks k JOIN kin_connections c
          ON c.org_id = k.org_id AND c.connection_id = k.connection_id
        WHERE k.org_id = r.org_id AND k.state = 'open'
          AND (c.person_id IS NULL OR c.person_id = ${personId})
          AND (k.entry_record_id = r.record_id OR k.wakeup_id IN (SELECT e.wakeup_id
            FROM kin_events e WHERE e.org_id = r.org_id AND e.wakeup_id IS NOT NULL
              AND substr(e.dedupe_key, 1, ${woken.length}) = ${woken}))) AS carded
    FROM kin_records r
    JOIN kin_records cl ON cl.org_id = r.org_id AND cl.record_id = r.party_id
    JOIN kin_people p ON p.org_id = r.org_id AND p.person_id = ${personId}
      AND p.removed_at IS NULL
    WHERE r.org_id = ${orgId} AND r.record_id = ${dealId} AND r.register_id = 'deals'
      AND r.state = 'open'
      AND ((r.owner_kind = 'person' AND r.owner_id = ${personId})
        OR (r.owner_kind = 'agent' AND cl.owner_kind = 'person' AND cl.owner_id = ${personId}))
      AND ${crmSeenBy(sql, viewer)}`;
  if (row === undefined || row.standing !== 1 || row.seesClients !== 1 || row.carded === 1)
    return undefined;
  const on = (section: "clients" | "deals") =>
    KinShell.sectionOnFor(orgId, section).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* on("clients")) || !(yield* on("deals"))) return undefined;
  const zone = validZone(row.zone) ?? (yield* ownerZone(orgId));
  // `deal_quiet:<key>:<last moved>`: a new key is a new quiet stretch.
  const since =
    senseOf(factKey) === "deal_quiet"
      ? Number(factKey.slice(factKey.lastIndexOf(":") + 1))
      : at - DATE_PASSED_AGAIN_MS + 1;
  if (
    !Number.isFinite(since) ||
    (yield* chasedSince(orgId, personId, dealId, since, dayIn(at, zone)))
  )
    return undefined;
  return { zone, path: "mail" as const, of: "deal" as const };
});

/**
 * Their zone when `meetingId` is an open, unlabelled meeting `personId` holds and sees, with a
 * client (its own or its project's) they see, more than `PREP_BEFORE_MS` ahead, `factKey` still
 * stands, and no doc they can open was linked to it since that fact began; they may open Docs.
 */
const stillAhead = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  factKey: string,
  meetingId: string,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const viewer = (yield* ownerLevel(orgId, personId))
    ? ({ _tag: "ownerLevel" } as const)
    : viewerOfPeople([personId]);
  const [row] = yield* sql<{
    zone: string | null;
    client: number;
    since: number | null;
    linkedAt: number | null;
  }>`SELECT p.time_zone AS zone,
      EXISTS (SELECT 1 FROM kin_records r WHERE r.org_id = m.org_id AND r.register_id = 'clients'
        AND r.record_id = COALESCE(m.party_id, pr.party_id) AND ${seenBy(sql, viewer)}) AS client,
      (SELECT f.first_seen_at FROM kin_pulse_facts f WHERE f.org_id = m.org_id
        AND f.fact_key = ${factKey} AND f.subject_record_id = m.record_id
        AND f.cleared_at IS NULL) AS since,
      (SELECT MAX(l.created_at) FROM kin_record_links l
        WHERE l.org_id = m.org_id AND l.kind = 'record'
          AND (l.record_id = m.record_id OR l.target = m.record_id)
          AND (CASE WHEN l.record_id = m.record_id THEN l.target ELSE l.record_id END) IN (
            SELECT r.record_id FROM kin_records r WHERE r.org_id = ${orgId}
              AND r.register_id = 'docs' AND r.state <> 'dropped' AND ${seenBy(sql, viewer)})
      ) AS "linkedAt"
    FROM kin_records m
    JOIN kin_people p ON p.org_id = m.org_id AND p.person_id = ${personId}
      AND p.removed_at IS NULL
    LEFT JOIN kin_records pr ON pr.org_id = m.org_id AND pr.record_id = m.project_id
    WHERE m.org_id = ${orgId} AND m.record_id = ${meetingId} AND m.register_id = 'work'
      AND m.category = 'meeting' AND m.state NOT IN ('done', 'dropped')
      AND m.date_at > ${at + PREP_BEFORE_MS}
      AND m.owner_kind = 'person' AND m.owner_id = ${personId}
      AND m.record_id IN (SELECT r.record_id FROM kin_records r WHERE r.org_id = ${orgId}
        AND r.record_id = ${meetingId} AND ${seenBy(sql, viewer)} AND NOT ${labelledNow(sql)})`;
  if (row === undefined || row.client !== 1 || row.since === null) return undefined;
  if (row.linkedAt !== null && row.linkedAt >= row.since) return undefined;
  if (viewer._tag !== "ownerLevel" && !(yield* placesOf(orgId, personId)).reaches.docs)
    return undefined;
  const zone = validZone(row.zone) ?? (yield* ownerZone(orgId));
  return { zone, path: "doc" as const, of: "meeting" as const };
});

/**
 * Their zone when `meetingId` is an open, unlabelled client meeting `personId` holds and sees,
 * passed with `factKey` standing, Clients on and theirs, and no open question about it nor mail
 * card on it from their mailbox: asked once a meeting.
 */
const stillPassed = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  factKey: string,
  meetingId: string,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const viewer = (yield* ownerLevel(orgId, personId))
    ? ({ _tag: "ownerLevel" } as const)
    : viewerOfPeople([personId]);
  const [row] = yield* sql<{
    zone: string | null;
    dateAt: number;
    seesClients: number;
    client: number;
    standing: number;
    asked: number;
    carded: number;
  }>`SELECT p.time_zone AS zone, m.date_at AS "dateAt",
      (p.sees_clients = 1 OR p.access IN ('owner', 'co_owner')) AS "seesClients",
      EXISTS (SELECT 1 FROM kin_records r WHERE r.org_id = m.org_id AND r.register_id = 'clients'
        AND r.record_id = COALESCE(m.party_id, pr.party_id) AND ${seenBy(sql, viewer)}) AS client,
      EXISTS (SELECT 1 FROM kin_pulse_facts f WHERE f.org_id = m.org_id
        AND f.fact_key = ${factKey} AND f.subject_record_id = m.record_id
        AND f.cleared_at IS NULL) AS standing,
      EXISTS (SELECT 1 FROM kin_questions q WHERE q.org_id = m.org_id AND q.state = 'open'
        AND (' ' || q.about || ' ') LIKE ('% ' || m.key || ' %')) AS asked,
      EXISTS (SELECT 1 FROM kin_connection_asks k JOIN kin_connections c
          ON c.org_id = k.org_id AND c.connection_id = k.connection_id
        WHERE k.org_id = m.org_id AND k.entry_record_id = m.record_id AND k.state = 'open'
          AND (c.person_id IS NULL OR c.person_id = ${personId})) AS carded
    FROM kin_records m
    JOIN kin_people p ON p.org_id = m.org_id AND p.person_id = ${personId}
      AND p.removed_at IS NULL
    LEFT JOIN kin_records pr ON pr.org_id = m.org_id AND pr.record_id = m.project_id
    WHERE m.org_id = ${orgId} AND m.record_id = ${meetingId} AND m.register_id = 'work'
      AND m.category = 'meeting' AND m.state NOT IN ('done', 'dropped') AND m.date_at <= ${at}
      AND m.owner_kind = 'person' AND m.owner_id = ${personId}
      AND m.record_id IN (SELECT r.record_id FROM kin_records r WHERE r.org_id = ${orgId}
        AND r.record_id = ${meetingId} AND ${seenBy(sql, viewer)} AND NOT ${labelledNow(sql)})`;
  if (
    row === undefined ||
    row.standing !== 1 ||
    row.client !== 1 ||
    row.seesClients !== 1 ||
    row.asked === 1 ||
    row.carded === 1
  )
    return undefined;
  if (!(yield* KinShell.sectionOnFor(orgId, "clients").pipe(Effect.orElseSucceed(() => false))))
    return undefined;
  const zone = validZone(row.zone) ?? (yield* ownerZone(orgId));
  if (yield* chasedSince(orgId, personId, meetingId, row.dateAt, dayIn(at, zone))) return undefined;
  return { zone, path: "mail" as const, of: "outcome" as const };
});

/**
 * Once a stretch: an open deal or prospect they look after (`deals.ts` `hearer`; the owner's when
 * nobody does) and see, with no quiet or late mail of its own standing; or an open project, for
 * the owner. Never within `DECLINED_REST_MS` of a suggestion for it being dropped.
 */
const stillUnplanned = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  factKey: string,
  recordId: string,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const viewer = (yield* ownerLevel(orgId, personId))
    ? ({ _tag: "ownerLevel" } as const)
    : viewerOfPeople([personId]);
  const plan = senseOf(factKey) === "project_no_plan";
  const present = sql`SELECT person_id FROM kin_people WHERE org_id = r.org_id
    AND removed_at IS NULL`;
  const [row] = yield* sql<{
    zone: string | null;
    seesClients: number;
    standing: number;
    mailed: number;
    declined: number;
    since: number;
  }>`SELECT p.time_zone AS zone,
      (p.sees_clients = 1 OR p.access IN ('owner', 'co_owner')) AS "seesClients",
      EXISTS (SELECT 1 FROM kin_pulse_facts f WHERE f.org_id = r.org_id
        AND f.fact_key = ${factKey} AND f.subject_record_id = r.record_id
        AND f.cleared_at IS NULL) AS standing,
      EXISTS (SELECT 1 FROM kin_pulse_facts f WHERE f.org_id = r.org_id
        AND f.subject_record_id = r.record_id AND f.cleared_at IS NULL
        AND f.sense IN ${sql.in([...DEAL_FOLLOW_UPS])}) AS mailed,
      EXISTS (SELECT 1 FROM kin_records w WHERE w.org_id = r.org_id
        AND w.register_id IN ('work', 'milestones') AND w.confirmed = 0 AND w.state = 'dropped'
        AND w.closed_at > ${at - DECLINED_REST_MS}
        AND (w.project_id = r.record_id OR (r.register_id = 'clients' AND w.party_id = r.record_id)
          OR w.record_id IN (SELECT l.record_id FROM kin_record_links l WHERE l.org_id = r.org_id
            AND l.kind = 'record' AND l.target = r.record_id))) AS declined,
      MAX(r.created_at, COALESCE((SELECT MAX(t.closed_at) FROM kin_records t
        WHERE t.org_id = r.org_id AND t.project_id = r.record_id
          AND t.register_id IN ('work', 'milestones')), 0)) AS since
    FROM kin_records r
    LEFT JOIN kin_records cl ON cl.org_id = r.org_id AND cl.record_id = r.party_id
    JOIN kin_people p ON p.org_id = r.org_id AND p.person_id = ${personId}
      AND p.removed_at IS NULL
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId}
      AND ${
        plan
          ? sql`r.register_id = 'projects' AND r.state = 'open' AND p.access = 'owner'`
          : sql`((r.register_id = 'deals' AND r.state = 'open')
            OR (r.register_id = 'clients' AND r.category = 'prospect' AND r.state <> 'dropped'))
          AND ((r.owner_kind = 'person' AND r.owner_id = ${personId})
            OR (r.register_id = 'deals' AND r.owner_kind = 'agent'
              AND cl.owner_kind = 'person' AND cl.owner_id = ${personId})
            OR (p.access = 'owner'
              AND NOT (r.owner_kind = 'person' AND r.owner_id IN (${present}))
              AND NOT (r.register_id = 'deals' AND r.owner_kind = 'agent'
                AND cl.owner_kind = 'person' AND cl.owner_id IN (${present}))))
          AND ${crmSeenBy(sql, viewer)}`
      }`;
  if (row === undefined || row.standing !== 1 || row.declined === 1) return undefined;
  if (!plan && (row.seesClients !== 1 || row.mailed === 1)) return undefined;
  const on = (section: "clients" | "deals") =>
    KinShell.sectionOnFor(orgId, section).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* on("clients")) || (!plan && !(yield* on("deals")))) return undefined;
  const zone = validZone(row.zone) ?? (yield* ownerZone(orgId));
  // `deal_no_next_step:<key>:<since>`; a project's stretch starts when its last task closed.
  const since = plan ? row.since : Number(factKey.slice(factKey.lastIndexOf(":") + 1));
  if (
    !Number.isFinite(since) ||
    (yield* chasedSince(orgId, personId, recordId, since, dayIn(at, zone)))
  )
    return undefined;
  return plan
    ? { zone, path: "doc" as const, of: "plan" as const }
    : { zone, path: "mail" as const, of: "step" as const };
});

/** How to draft the follow-up `factKey` names on `recordId` for `personId` now, if still wanted. */
const stillWanted = (
  orgId: KinOrgId,
  personId: KinPersonId,
  factKey: string,
  recordId: string,
  at: number,
) =>
  DEAL_FOLLOW_UPS.has(senseOf(factKey))
    ? stillQuiet(orgId, personId, factKey, recordId, at)
    : PROPOSALS.has(senseOf(factKey))
      ? stillUnplanned(orgId, personId, factKey, recordId, at)
      : senseOf(factKey) === "meeting_soon"
        ? stillAhead(orgId, personId, factKey, recordId, at)
        : senseOf(factKey) === "meeting_passed"
          ? stillPassed(orgId, personId, factKey, recordId, at)
          : stillDue(orgId, personId, recordId, at);

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
    (fact) => FOLLOW_UPS.has(fact.sense) && fact.subject.recordId !== undefined,
  );
  if (due.length === 0) return woken;
  // A meeting's facts are the main agent's; its prep and its outcome are its holder's.
  const meetings = due.flatMap((fact) =>
    MEETINGS.has(fact.sense) && !fact.sensitive ? [fact.subject.recordId!] : [],
  );
  const sql = yield* SqlClient.SqlClient;
  const held = new Map(
    meetings.length === 0
      ? []
      : (yield* sql<{ recordId: string; personId: string }>`SELECT record_id AS "recordId",
            owner_id AS "personId" FROM kin_records
          WHERE org_id = ${orgId} AND owner_kind = 'person' AND record_id IN ${sql.in(meetings)}
          ORDER BY record_id`).map((row) => [row.recordId, row.personId]),
  );
  // A project's missing plan, and a deal nobody looks after, are the owner's.
  const [orgOwner] = due.some((fact) => PROPOSALS.has(fact.sense) && fact.actor._tag !== "person")
    ? yield* sql<{ personId: string }>`SELECT person_id AS "personId" FROM kin_people
        WHERE org_id = ${orgId} AND access = 'owner' AND removed_at IS NULL
        ORDER BY person_id LIMIT 1`
    : [];
  const byPerson = new Map<string, Array<KinPulseFact>>();
  for (const fact of due) {
    const holder = MEETINGS.has(fact.sense)
      ? held.get(fact.subject.recordId!)
      : fact.actor._tag === "person"
        ? fact.actor.personId
        : PROPOSALS.has(fact.sense)
          ? orgOwner?.personId
          : undefined;
    if (holder !== undefined) byPerson.set(holder, [...(byPerson.get(holder) ?? []), fact]);
  }
  for (const [person, facts] of byPerson) {
    const personId = KinPersonId.make(person);
    const seen = new Set([
      ...(yield* input.sees(
        personId,
        facts.filter((fact) => !ROUTED.has(fact.sense)),
      )).map((fact) => fact.key),
      // Each is checked against their own view as it is made (`stillAhead`, `stillUnplanned`).
      ...facts.filter((fact) => ROUTED.has(fact.sense)).map((fact) => fact.key),
    ]);
    const ready: Array<{ fact: KinPulseFact; recordId: string; zone: string; path: DraftPath }> =
      [];
    const tasks = new Set<string>();
    for (const fact of facts.toSorted((a, b) => (a.key < b.key ? -1 : 1))) {
      const recordId = fact.subject.recordId!;
      if (!seen.has(fact.key) || tasks.has(recordId)) continue;
      const still = yield* stillWanted(orgId, personId, fact.key, recordId, at);
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

/** Whether a wake for `recordId` took its slot on a day before `day`, at `since` or later. */
const chasedSince = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: string,
  since: number,
  day: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_pulse_told WHERE org_id = ${orgId}
      AND person_id = ${draftParty(personId)} AND fact_key = ${taskSlot(recordId)}
      AND sig <> ${day} AND told_at >= ${since} LIMIT 1`;
  return rows.length > 0;
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
  const events = yield* sql<{
    dedupeKey: string | null;
    personId: string | null;
    factKey: string | null;
  }>`SELECT
      e.dedupe_key AS "dedupeKey", json_extract(e.json, '$.origin.personId') AS "personId",
      json_extract(e.json, '$.factKeys[0]') AS "factKey"
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
  const still = yield* stillWanted(orgId, personId, event.factKey ?? "", recordId, at);
  // A proposed plan is tasks, not a doc.
  if (still?.path !== "doc" || still.of === "plan") return undefined;
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
  const still = yield* stillWanted(orgId, personId, event.factKeys[0] ?? "", fact.recordId, at);
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
const ownMailbox = (addresses: ReadonlyArray<string>) =>
  addresses.length === 1
    ? `their own mailbox (${addresses[0]})`
    : `one of their own mailboxes (${addresses.join(", ")}): the one earlier mail with this contact went through, else the first`;
/** The wake's own line when the person has their own mailbox and a contact to write to. */
export const DRAFT_FROM_MAILBOX = (name: string, addresses: ReadonlyArray<string>) =>
  `Kin woke you for ${name}: this follow-up of theirs is due and no mail for it waits on a card. Draft the mail to the contact below from ${ownMailbox(addresses)} with kin_connection_call mail_send, naming the task's key in the mail, so it waits on a Confirm card for them. Nothing goes until they tap Confirm: never say it was sent. Then tell them in one short line that it is ready.`;
/** The wake's own line for a client meeting coming up: a prep note as a doc linked to it. */
export const DRAFT_MEETING_PREP = (name: string) =>
  `Kin woke you for ${name}: their meeting below with a client is coming up and nothing is prepared for it. Make one short prep note as a new doc with doc_create, linked to the meeting: who is coming, what is open with this client from the data below (ours and theirs), the last contact, and at most three things to settle in it. Use only the data below and Kin's records; never add a figure that isn't there. Then tell them in one short line that the prep note for this meeting is ready. Its card sits right under your reply, so say nothing about what is in it. If there is nothing open and no contact on record, make nothing and say so in one line.`;
/** The wake's own line for a deal gone quiet or past its day (`reason`), from their own mailbox. */
export const DRAFT_DEAL = (name: string, addresses: ReadonlyArray<string>, reason: string) =>
  `Kin woke you for ${name}: their deal below ${reason}, and no mail for it waits on a card. Draft a short follow-up to the contact below from ${ownMailbox(addresses)} with kin_connection_call mail_send, naming the deal's key: pick up from the last contact, ask where it stands, and suggest one next step. Never offer a price, date or term the records don't hold. Nothing goes until they tap Confirm: never say it was sent. Then tell them in one short line that the mail to the contact is ready on its card for their Confirm. The card shows the whole mail, so say nothing more about it.`;
/** The same, for something a client owes us that is late: a chase. */
export const DRAFT_CHASE = (name: string, addresses: ReadonlyArray<string>) =>
  `Kin woke you for ${name}: the client below owed this to us by the day below and it hasn't come, and no mail for it waits on a card. Draft a short, friendly chase to the contact below from ${ownMailbox(addresses)} with kin_connection_call mail_send, naming the entry's key, asking for it or for a day it will come. Nothing goes until they tap Confirm: never say it was sent, and promise nothing for us. Then tell them in one short line that the chase to the contact is ready on its card for their Confirm. The card shows the whole mail, so say nothing more about it.`;
/**
 * The wake's own line for a client meeting that passed with no outcome: one question, then its
 * answer noted, the follow-up drafted (`mail` when they have a mailbox and a contact) and its
 * action items suggested.
 */
export const DRAFT_MEETING_OUTCOME = (
  name: string,
  meeting: { readonly key: string; readonly title: string },
  mail: { readonly to: string; readonly from: ReadonlyArray<string> } | undefined,
) =>
  `Kin woke you for ${name}: their meeting below with a client has passed and no outcome is noted. Ask them once with kin_ask in this chat: question "How did ${meeting.title} go?", options "It didn't happen" (action drop on ${meeting.key}) and "Nothing to follow up" (action done on ${meeting.key}), default "none", about ${meeting.key}, and detail "Or reply here in a line or two: I'll note it on ${meeting.key}, ${mail === undefined ? "write you call notes for the follow-up" : `draft the follow-up to ${mail.to} for your Confirm`} and suggest the action items." Say nothing else now. When they reply with how it went: close that question as answered with kin_ask_close, then put what they said in ${meeting.key}'s notes and mark it done with record_update, ${mail === undefined ? "give them call notes for the follow-up here (there is no mailbox of theirs or no contact to write to)" : `draft the follow-up to the contact below with kin_connection_call mail_send from ${ownMailbox(mail.from)}, promising nothing for us that their reply and the records don't hold`}, and record each action item, even one the client asked for, as a Work row with suggested true, owner whoever their reply names for it, else them. Nothing goes until they tap Confirm: never say it was sent. ${mail === undefined ? `After the call notes, say in one short line that ${meeting.key} is noted and done and how many action items you suggested; their tasks show them, so don't list them.` : `Then tell them in one short line that ${meeting.key} is noted and done, the follow-up waits on its card for their Confirm, and how many action items you suggested. The cards show the mail and the tasks, so say nothing more about them.`}`;
/** The wake's own line for a deal, or a prospect with no deal, that has no next step. */
export const PROPOSE_STEP = (name: string, deal: boolean) =>
  `Kin woke you for ${name}: ${deal ? "the deal below" : "the prospect below, which has no deal,"} has no next step. Propose one: a single Work row with record_create, suggested true, for this client${deal ? " and deal" : ""}, owner them, due a day this week, titled as the step itself (a call, a mail, a demo, a quote), from the last contact and comment below. Never offer a price, date or term the records don't hold. Make nothing else. Then tell them in one short line what you suggested, with its key, and that it waits on its task to be kept or not. The task shows why you suggested it, so say nothing more about it.`;
/** The wake's own line for a project with no plan: its breakdown as suggested tasks. */
export const PROPOSE_PLAN = (name: string) =>
  `Kin woke you for ${name}: the project below has no milestones and no open tasks. Propose its plan in one record_create call: at most 8 tasks, each with the project, a size (S, M or L), an owner from its members and a one-line reason, and milestones only where its own words name stages. Every row, milestones too, is suggested true, so none stands until they keep it. Use only the project's own words, its docs and the records below; never add a figure or date that isn't there. Then tell them in one short line how many tasks you suggested and that they keep each or not on Tasks. The rows show what each is and why, so say nothing more about them.`;
/** The wake's own line when there is no mailbox of theirs, or no contact they may see. */
export const DRAFT_CALL_NOTES = (name: string, mailbox: boolean) =>
  `Kin woke you for ${name}: this follow-up of theirs is due and no mail for it waits on a card. ${mailbox ? "There is no contact address for it that they may see" : "No mailbox of theirs is connected"}, so draft no mail: give them call notes here in this chat (what to say, what was promised, the last contact).`;
const mailboxOf = (name: string, addresses: ReadonlyArray<string>) =>
  addresses.length === 1
    ? `${name}'s own mailbox (${addresses[0]})`
    : `one of ${name}'s own mailboxes (${addresses.join(", ")})`;
/**
 * What a person's Give notice on Kin's notice-day card tells the agent it wakes: the notice mail
 * to draft (`to` and the mailboxes `from`), or what is missing for one; `owner` when a teammate
 * tapped, who is told in one line and asked nothing.
 */
export const NOTICE_GIVEN = (input: {
  readonly name: string;
  readonly client: string;
  readonly key: string;
  readonly renewsOn: string;
  readonly noticeBy: string;
  readonly mail:
    | { readonly to: string; readonly from: ReadonlyArray<string> }
    | { readonly missing: "contact" | "mailbox" };
  readonly owner?: string;
}) => {
  const { name, client, key, mail } = input;
  const drafts = "to" in mail;
  const what = drafts
    ? `Draft the notice mail now to ${mail.to} from ${mailboxOf(name, mail.from)} with kin_connection_call mail_send: ${key} will not renew after its current term. Promise nothing else. It waits on ${name}'s Confirm card and nothing is sent before it: never say it was sent.`
    : `${mail.missing === "contact" ? `There is no contact address at ${client} that ${name} may see` : `No mailbox of ${name}'s is connected`}, so draft no mail.`;
  const relay =
    input.owner === undefined
      ? ""
      : ` Tell ${input.owner} in one line with kin_relay that ${name} chose to give notice on ${client}'s contract ${key} and ${drafts ? `the mail waits on ${name}'s Confirm` : "no notice mail is drafted yet"}; ask ${input.owner} nothing.`;
  return `Kin's own card asked ${name} about ${client}'s contract ${key} (renews ${input.renewsOn}, notice due by ${input.noticeBy}), and ${name} chose Give notice. That is ${name}'s answer to Kin's question: ask nobody first. ${what} Record nothing on the project and file no task.${relay} Then tell ${name} in one short line ${drafts ? "that the notice mail waits on the Confirm. The card shows the whole mail, so say nothing more about it" : "what is missing"}.`;
};
/** What a person's Stuck on Kin's stalled-task card tells the agent it wakes. */
export const STALL_STUCK = (input: { readonly name: string; readonly key: string }) =>
  `Kin's own card asked ${input.name} where ${input.key} is, and ${input.name} chose Stuck. Ask ${input.name} what is in the way in one short question in your reply, and nothing else: no card, no list of guesses, nothing retold, and no tool that changes ${input.key}.`;

const decodeChoiceTap = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      widgetId: Schema.String,
      actionId: Schema.String,
      value: Schema.optional(Schema.Unknown),
    }),
  ),
);
/**
 * The line a tap on the plain answer of Kin's own card about a fact adds to the turn reading it,
 * read as the turn starts: what the tapper may see, their mailboxes now. Undefined for other taps.
 */
export const cardTapText = Effect.fn("KinPulse.cardTapText")(function* (
  orgId: KinOrgId,
  message: KinMessage,
) {
  if (message.kind !== "widget_action" || message.author._tag !== "human") return undefined;
  const personId = message.author.personId;
  const tap = Option.getOrUndefined(decodeChoiceTap(message.body));
  if (tap?.actionId !== KIN_CHOICE_CARD_ACTION || typeof tap.value !== "string") return undefined;
  const plans = yield* plansOf(orgId, tap.widgetId);
  if (plans.has(tap.value)) return undefined;
  const plan = [...plans.values()].find(isFactCard);
  if (plan === undefined || plan.personId !== personId) return undefined;
  if (plan.kind === "stall_answer") return STALL_STUCK({ name: plan.personName, key: plan.key });
  if (plan.kind !== "notice_renew") return undefined;
  const sql = yield* SqlClient.SqlClient;
  const own = yield* ownerLevel(orgId, personId);
  const viewer = own ? ({ _tag: "ownerLevel" } as const) : viewerOfPeople([personId]);
  const [client] = yield* sql<{ title: string; partyId: string }>`SELECT c.title,
      c.record_id AS "partyId"
    FROM kin_records p JOIN kin_records c ON c.org_id = p.org_id AND c.record_id = p.party_id
      AND c.record_id IN (SELECT r.record_id FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.register_id = 'clients' AND ${crmSeenBy(sql, viewer)})
    WHERE p.org_id = ${orgId} AND p.record_id = ${plan.recordId}`;
  const contact = yield* contactOf(orgId, client?.partyId ?? null, crmSeenBy(sql, viewer));
  const addresses = (yield* personConnections(orgId, personId))
    .filter((row) => row.state === "active" && row.pausedAt === null)
    .map((row) => row.accountLabel ?? row.label);
  const chief = own
    ? undefined
    : (yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN }))?.agentId;
  const [owner] =
    chief === undefined
      ? []
      : yield* sql<{ name: string }>`SELECT p.display_name AS name FROM kin_agents a
          JOIN kin_people p ON p.org_id = a.org_id AND p.person_id = a.owner_person_id
            AND p.removed_at IS NULL
          WHERE a.org_id = ${orgId} AND a.agent_id = ${chief}`;
  return NOTICE_GIVEN({
    name: plan.personName,
    client: client?.title ?? plan.title,
    key: plan.key,
    renewsOn: plan.renewsOn,
    noticeBy: plan.noticeBy,
    mail:
      addresses.length === 0
        ? { missing: "mailbox" }
        : contact === undefined
          ? { missing: "contact" }
          : { to: `${contact.name} (${contact.email})`, from: addresses },
    ...(own ? {} : { owner: owner?.name ?? "the owner" }),
  });
});

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
  const factKey = event.factKeys[0] ?? "";
  const still = yield* stillWanted(orgId, personId, factKey, fact.recordId, at);
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
  const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId} AND removed_at IS NULL`;
  if (person === undefined) return undefined;
  const addresses = (yield* personConnections(orgId, personId))
    .filter((row) => row.state === "active" && row.pausedAt === null)
    .map((row) => row.accountLabel ?? row.label);
  const from =
    addresses.length === 0
      ? { mailbox: "none connected" }
      : { from: addresses.length === 1 ? addresses[0]! : addresses };
  const [said] = yield* sql<{ text: string }>`SELECT m.body AS text FROM kin_record_comments m
    WHERE m.org_id = ${orgId} AND m.record_id = ${fact.recordId} AND m.removed_at IS NULL
    ORDER BY m.seq DESC LIMIT 1`;
  const lastComment =
    said === undefined ? {} : { lastComment: Array.from(said.text.trim()).slice(0, 200).join("") };
  if (still.of === "deal") {
    const [deal] = yield* sql<{
      key: string;
      title: string;
      dueAt: number | null;
      client: string | null;
      partyId: string | null;
    }>`SELECT d.key, d.title, d.due_at AS "dueAt", c.title AS client, c.record_id AS "partyId"
      FROM kin_records d
      LEFT JOIN kin_records c ON c.org_id = d.org_id AND c.record_id = d.party_id
        AND c.record_id IN (SELECT r.record_id FROM kin_records r
          WHERE r.org_id = ${orgId} AND r.register_id = 'clients' AND ${crmSeenBy(sql, viewer)})
      WHERE d.org_id = ${orgId} AND d.record_id = ${fact.recordId}`;
    if (deal === undefined) return undefined;
    const contact = yield* contactOf(orgId, deal.partyId, crmSeenBy(sql, viewer));
    const [touch] =
      deal.partyId === null ? [] : yield* touchesOf(orgId, deal.partyId, at, 1, viewer);
    const quiet = senseOf(factKey) === "deal_quiet";
    const quietDays = Math.floor(
      (at - Number(factKey.slice(factKey.lastIndexOf(":") + 1))) / DAY_MS,
    );
    const expectedBy = deal.dueAt === null ? undefined : dayIn(deal.dueAt, zone);
    const reason =
      quiet || expectedBy === undefined
        ? `has had no contact, note or move for ${daysText(quietDays)}`
        : `was expected by ${expectedBy} and is still open`;
    return {
      text:
        addresses.length > 0 && contact !== undefined
          ? DRAFT_DEAL(person.name, addresses, reason)
          : DRAFT_CALL_NOTES(person.name, addresses.length > 0),
      data: {
        deal: deal.key,
        title: deal.title,
        ...(quiet || expectedBy === undefined ? { quietDays } : { expectedBy }),
        ...(deal.client === null ? {} : { client: deal.client }),
        ...(touch === undefined
          ? {}
          : {
              lastContact: {
                on: dayIn(Date.parse(touch.at), zone),
                kind: touch.kind,
                ...(touch.note.trim() === ""
                  ? {}
                  : { note: Array.from(touch.note.trim()).slice(0, 200).join("") }),
              },
            }),
        ...lastComment,
        ...(contact === undefined ? {} : { writeTo: contact }),
        ...from,
      },
    };
  }
  if (still.of === "meeting")
    return yield* meetingPrep(orgId, person.name, {
      meetingId: fact.recordId,
      zone,
      at,
      viewer,
      lastComment,
    });
  if (still.of === "outcome")
    return yield* meetingOutcome(orgId, person.name, {
      meetingId: fact.recordId,
      zone,
      viewer,
      addresses,
      from,
    });
  if (still.of === "step" || still.of === "plan")
    return yield* proposal(orgId, person.name, {
      recordId: fact.recordId,
      zone,
      at,
      viewer,
      lastComment,
      plan: still.of === "plan",
    });
  const [task] = yield* sql<{
    key: string;
    title: string;
    dueAt: number | null;
    late: number;
    client: string | null;
    partyId: string | null;
  }>`SELECT r.key, r.title, r.due_at AS "dueAt", (r.due_at < ${startOfDay(day, zone)}) AS late,
      c.title AS client, c.record_id AS "partyId"
    FROM kin_records r
    LEFT JOIN kin_records pr ON pr.org_id = r.org_id AND pr.record_id = r.project_id
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.register_id = 'clients'
      AND c.record_id = COALESCE(r.party_id, pr.party_id)
      AND c.record_id IN (SELECT r.record_id FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.register_id = 'clients' AND ${seenBy(sql, viewer)})
    WHERE r.org_id = ${orgId} AND r.record_id = ${fact.recordId}`;
  if (task === undefined) return undefined;
  const theirs = still.of === "theirs";
  const when = theirs
    ? task.dueAt === null
      ? {}
      : { wasDue: dayIn(task.dueAt, zone) }
    : task.late === 1
      ? { late: true }
      : { dueToday: true };
  if (still.path === "doc")
    return {
      text: DRAFT_DOCUMENT(person.name),
      data: { task: task.key, title: task.title, ...when, ...lastComment },
    };
  const contact = yield* contactOf(orgId, task.partyId, seenBy(sql, viewer));
  return {
    text:
      addresses.length > 0 && contact !== undefined
        ? (theirs ? DRAFT_CHASE : DRAFT_FROM_MAILBOX)(person.name, addresses)
        : DRAFT_CALL_NOTES(person.name, addresses.length > 0),
    data: {
      task: task.key,
      title: task.title,
      ...when,
      ...(task.client === null ? {} : theirs ? { owedBy: task.client } : { client: task.client }),
      ...(contact === undefined ? {} : { writeTo: contact }),
      ...lastComment,
      ...from,
    },
  };
});

/**
 * A prep note's wake: the meeting, who is coming, what is open with its client that they see (ours
 * and theirs, soonest due first), the last contacts, and for owner level only the client's overdue
 * invoices as a count and a total.
 */
const meetingPrep = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  name: string,
  input: {
    readonly meetingId: string;
    readonly zone: string;
    readonly at: number;
    readonly viewer: ReturnType<typeof viewerOfPeople>;
    readonly lastComment: { readonly lastComment?: string };
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const { zone, viewer } = input;
  const [meeting] = yield* sql<{
    key: string;
    title: string;
    dateAt: number;
    fieldsJson: string;
    client: string;
    partyId: string;
  }>`SELECT m.key, m.title, m.date_at AS "dateAt", m.fields_json AS "fieldsJson",
      c.title AS client, c.record_id AS "partyId"
    FROM kin_records m
    LEFT JOIN kin_records pr ON pr.org_id = m.org_id AND pr.record_id = m.project_id
    JOIN kin_records c ON c.org_id = m.org_id AND c.register_id = 'clients'
      AND c.record_id = COALESCE(m.party_id, pr.party_id)
    WHERE m.org_id = ${orgId} AND m.record_id = ${input.meetingId}`;
  if (meeting === undefined) return undefined;
  const names = yield* namesOf(orgId);
  const attendees = fieldList(parseFields(meeting.fieldsJson), "attendees").flatMap((text) => {
    const who = principalOfText(text);
    const found =
      who === null ? undefined : names.get(who._tag === "person" ? who.personId : who.agentId);
    return found === undefined ? [] : [found];
  });
  const open = yield* sql<{
    key: string;
    title: string;
    holderId: string;
    dueAt: number | null;
    side: string | null;
  }>`SELECT r.key, r.title, r.owner_id AS "holderId", r.due_at AS "dueAt", r.side
    FROM kin_records r
    LEFT JOIN kin_records pr ON pr.org_id = r.org_id AND pr.record_id = r.project_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.record_id <> ${input.meetingId}
      AND r.state NOT IN ('done', 'dropped')
      AND COALESCE(r.party_id, pr.party_id) = ${meeting.partyId} AND ${seenBy(sql, viewer)}
    ORDER BY r.due_at IS NULL, r.due_at, r.key LIMIT ${PREP_OPEN}`;
  const touches = yield* touchesOf(orgId, meeting.partyId, input.at, 3, viewer);
  const overdue =
    viewer._tag === "ownerLevel" &&
    (yield* KinShell.sectionOnFor(orgId, "invoices").pipe(Effect.orElseSucceed(() => false)))
      ? (yield* owedInvoices({ orgId, now: input.at, partyId: meeting.partyId })).filter(
          (one) => one.overdue,
        )
      : [];
  const sums = new Map<string, number>();
  for (const one of overdue)
    sums.set(one.balance.currency, (sums.get(one.balance.currency) ?? 0) + one.balance.minor);
  return {
    text: DRAFT_MEETING_PREP(name),
    data: {
      meeting: meeting.key,
      title: meeting.title,
      at: formatKinWhen(meeting.dateAt, "dayTime", { zone, locale: KIN_TEXT_LOCALE }),
      attendees,
      client: meeting.client,
      open: open.map((one) => ({
        key: one.key,
        title: one.title,
        holder: names.get(one.holderId) ?? null,
        ...(one.dueAt === null ? {} : { due: dayIn(one.dueAt, zone) }),
        side: one.side === "theirs" ? "theirs" : "ours",
      })),
      lastContacts: touches.map((touch) => ({
        on: dayIn(Date.parse(touch.at), zone),
        kind: touch.kind,
        ...(touch.who === null ? {} : { who: touch.who }),
        ...(touch.note.trim() === ""
          ? {}
          : { note: Array.from(touch.note.trim()).slice(0, 200).join("") }),
      })),
      ...input.lastComment,
      ...(overdue.length === 0
        ? {}
        : {
            overdueInvoices: {
              count: overdue.length,
              total: [...sums]
                .map(([currency, minor]) => formatMoneyPlain({ minor, currency }))
                .join(" + "),
            },
          }),
    },
  };
});

/** A passed meeting's wake: the meeting, who was in it, its client and the contact to write to. */
const meetingOutcome = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  name: string,
  input: {
    readonly meetingId: string;
    readonly zone: string;
    readonly viewer: ReturnType<typeof viewerOfPeople>;
    readonly addresses: ReadonlyArray<string>;
    readonly from: { readonly mailbox: string } | { readonly from: string | ReadonlyArray<string> };
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const [meeting] = yield* sql<{
    key: string;
    title: string;
    dateAt: number;
    fieldsJson: string;
    client: string;
    partyId: string;
  }>`SELECT m.key, m.title, m.date_at AS "dateAt", m.fields_json AS "fieldsJson",
      c.title AS client, c.record_id AS "partyId"
    FROM kin_records m
    LEFT JOIN kin_records pr ON pr.org_id = m.org_id AND pr.record_id = m.project_id
    JOIN kin_records c ON c.org_id = m.org_id AND c.register_id = 'clients'
      AND c.record_id = COALESCE(m.party_id, pr.party_id)
    WHERE m.org_id = ${orgId} AND m.record_id = ${input.meetingId}`;
  if (meeting === undefined) return undefined;
  const names = yield* namesOf(orgId);
  const attendees = fieldList(parseFields(meeting.fieldsJson), "attendees").flatMap((text) => {
    const who = principalOfText(text);
    const found =
      who === null ? undefined : names.get(who._tag === "person" ? who.personId : who.agentId);
    return found === undefined ? [] : [found];
  });
  const contact = yield* contactOf(orgId, meeting.partyId, seenBy(sql, input.viewer));
  return {
    text: DRAFT_MEETING_OUTCOME(
      name,
      meeting,
      contact === undefined || input.addresses.length === 0
        ? undefined
        : { to: contact.name, from: input.addresses },
    ),
    data: {
      meeting: meeting.key,
      title: meeting.title,
      at: formatKinWhen(meeting.dateAt, "dayTime", { zone: input.zone, locale: KIN_TEXT_LOCALE }),
      attendees,
      client: meeting.client,
      ...(contact === undefined ? {} : { writeTo: contact }),
      ...input.from,
    },
  };
});

/** Every person's and agent's name by id, for the people a record names. */
const namesOf = Effect.fnUntraced(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return new Map(
    (yield* sql<{ id: string; name: string }>`SELECT person_id AS id, display_name AS name
      FROM kin_people WHERE org_id = ${orgId}
      UNION ALL SELECT agent_id AS id, display_name AS name FROM kin_agents WHERE org_id = ${orgId}
      ORDER BY id`).map((one) => [one.id, one.name]),
  );
});

/**
 * A proposal's wake: for a deal, its client and stage; for a prospect, itself; either with the
 * last contacts they see. For a project: its notes, the docs on it they see, and its people.
 */
const proposal = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  name: string,
  input: {
    readonly recordId: string;
    readonly zone: string;
    readonly at: number;
    readonly viewer: ReturnType<typeof viewerOfPeople>;
    readonly lastComment: { readonly lastComment?: string };
    readonly plan: boolean;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const { recordId, viewer } = input;
  const [row] = yield* sql<{
    key: string;
    title: string;
    registerId: string;
    notes: string;
    fieldsJson: string;
    ownerId: string;
    client: string | null;
    partyId: string | null;
  }>`SELECT r.key, r.title, r.register_id AS "registerId", r.notes, r.fields_json AS "fieldsJson",
      r.owner_id AS "ownerId", c.title AS client, c.record_id AS "partyId"
    FROM kin_records r
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
      AND c.record_id IN (SELECT r.record_id FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.register_id = 'clients' AND ${crmSeenBy(sql, viewer)})
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId}`;
  if (row === undefined) return undefined;
  const fields = parseFields(row.fieldsJson);
  const client = row.client === null ? {} : { client: row.client };
  if (input.plan) {
    const docs = yield* sql<{ key: string; title: string }>`SELECT r.key, r.title
      FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.register_id = 'docs' AND r.state <> 'dropped'
        AND (r.project_id = ${recordId} OR r.record_id IN (SELECT
          CASE WHEN l.record_id = ${recordId} THEN l.target ELSE l.record_id END
          FROM kin_record_links l WHERE l.org_id = ${orgId} AND l.kind = 'record'
            AND (l.record_id = ${recordId} OR l.target = ${recordId})))
        AND ${seenBy(sql, viewer)}
      ORDER BY r.key LIMIT ${PREP_OPEN}`;
    const names = yield* namesOf(orgId);
    const members = [
      row.ownerId,
      ...fieldList(fields, "members").flatMap((text) => {
        const who = principalOfText(text);
        return who === null ? [] : [who._tag === "person" ? who.personId : who.agentId];
      }),
    ].flatMap((id) => {
      const found = names.get(id);
      return found === undefined ? [] : [found];
    });
    const notes = Array.from(row.notes.trim()).slice(0, 2_000).join("");
    return {
      text: PROPOSE_PLAN(name),
      data: {
        project: row.key,
        title: row.title,
        ...client,
        ...(notes === "" ? {} : { notes }),
        docs,
        members: [...new Set(members)],
        ...input.lastComment,
      },
    };
  }
  const deal = row.registerId === "deals";
  const partyId = deal ? row.partyId : recordId;
  const touches = partyId === null ? [] : yield* touchesOf(orgId, partyId, input.at, 3, viewer);
  const stageId = typeof fields["stage"] === "string" ? fields["stage"] : undefined;
  const stage =
    stageId === undefined
      ? undefined
      : ((
          (yield* stagesOf(orgId)).stages.find((one) => one.id === stageId) ??
          DEFAULT_STAGES.find((one) => one.id === stageId)
        )?.name ?? stageId);
  return {
    text: PROPOSE_STEP(name, deal),
    data: {
      ...(deal ? { deal: row.key } : { prospect: row.key }),
      title: row.title,
      ...(deal ? client : {}),
      ...(stage === undefined ? {} : { stage }),
      lastContacts: touches.map((touch) => ({
        on: dayIn(Date.parse(touch.at), input.zone),
        kind: touch.kind,
        ...(touch.who === null ? {} : { who: touch.who }),
        ...(touch.note.trim() === ""
          ? {}
          : { note: Array.from(touch.note.trim()).slice(0, 200).join("") }),
      })),
      ...input.lastComment,
    },
  };
});

/** The first open contact of `partyId` with an address, among those `seen` lets them see. */
const contactOf = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  partyId: string | null,
  seen: ReturnType<typeof seenBy>,
) {
  if (partyId === null) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [contact] = yield* sql<{ name: string; email: string }>`SELECT r.title AS name,
      trim(json_extract(r.fields_json, '$.email')) AS email FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'contacts' AND r.state = 'open'
      AND r.party_id = ${partyId} AND ${seen}
      AND trim(COALESCE(json_extract(r.fields_json, '$.email'), '')) <> ''
    ORDER BY lower(r.title), r.key LIMIT 1`;
  return contact;
});
