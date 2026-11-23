import {
  KinAgentId,
  KinChatError,
  KinEvent,
  KinEventId,
  KinOrgId,
  KinPersonId,
  KinPulseFact,
  type KinPulseHandleAction,
  type KinPulseHandled,
  type KinPulseScope,
  type KinShell as Shell,
  type KinWakeupId,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinConnections } from "../connections/ConnectionsService.ts";
import { MAIL_PRESETS } from "../connections/mailProviders.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { agentQuietUntil } from "../triggers/quietHold.ts";
import { CHIEF_OF_STAFF_DOMAIN, ENGINEERING_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import * as KinShell from "../shell/KinShell.ts";
import { sectionOfKey, sectionOfSense, type SectionId } from "../shell/sections.ts";
import { ownerLevelPeople } from "../people/KinAccess.ts";
import { ownerZone, promiseOnDeal } from "../work/recordRows.ts";
import { matchName } from "../work/nameMatch.ts";
import { crmVisible, viewSees } from "../work/teamView.ts";
import { clientSenses } from "./senses/clients.ts";
import { dealSenses, LOOKED_AFTER_SENSES } from "./senses/deals.ts";
import { goalSenses } from "./senses/goals.ts";
import { moneySenses } from "./senses/money.ts";
import { numberSenses } from "./senses/numbers.ts";
import { projectSenses } from "./senses/projects.ts";
import { iso, type SenseContext, type SensedFact } from "./senses/shared.ts";
import { systemSenses } from "./senses/system.ts";
import { workSenses } from "./senses/work.ts";
import { fromConnections, noOutside, poll } from "./outside.ts";
import { alertsOnMail } from "../work/statements/alertMail.ts";
import { DAY_MS } from "./thresholds.ts";
import { KinPushSender } from "../push/KinPushSenderService.ts";
import { handledOf, storedRows, type StoredRow } from "./factState.ts";
import { tellHolder } from "./holderNotice.ts";
import { morningPages, pageMinuteSince } from "./personMorning.ts";
import {
  agentParty,
  checkInHandling,
  forHolder,
  markTold,
  SHELL_QUIET_EVENT_PREFIX,
  untold,
} from "./told.ts";
import { visibleOverflow } from "./senses/capped.ts";
import { draftWakes } from "./draftWake.ts";
import {
  asideOf,
  asideView,
  covers,
  type Hold,
  holdRecord,
  holdsFor,
  liftHold,
  liveHolds,
  setHold,
} from "./holds.ts";

const FINANCE_DOMAIN = "finance";
/** How long "I've got it" with no date holds a fact. */
export const GOT_IT_MS = 3 * DAY_MS;
const TICK_EVERY_MS = 15 * 60_000;
const OUTSIDE_EVERY_MS = 3 * 60_000;
const READ_CAP = 50;
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const encodeScope = Schema.encodeEffect(Schema.fromJsonString(KinPulseFact.fields.scope));
const encodeTickRows = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        sense: Schema.String,
        record: Schema.NullOr(Schema.String),
        scope: Schema.String,
      }),
    ),
  ),
);
const encodeKeys = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const { handled: _handled, ...sensedFields } = KinPulseFact.fields;
const encodeSensed = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct(sensedFields))),
);

/**
 * Who a read is for: the owner sees every fact; people see only facts about tasks and milestones,
 * not sensitive, that every one of them may see (`viewSees`). Clients, money, goals and the
 * company's own facts are owner-level.
 */
export type Viewer =
  | { readonly _tag: "owner" }
  | { readonly _tag: "people"; readonly people: ReadonlyArray<KinPersonId> };

export const context = Effect.fn("KinPulse.context")(function* (orgId: KinOrgId, at: number) {
  const sql = yield* SqlClient.SqlClient;
  const chief = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
  const leads = yield* sql<{ agentId: string; domain: string }>`SELECT l.agent_id AS "agentId",
      l.domain FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    WHERE l.org_id = ${orgId} ORDER BY a.created_at, l.agent_id`;
  const finance = leads.find((lead) => lead.domain === FINANCE_DOMAIN);
  const tech = leads.find((lead) => lead.domain === ENGINEERING_DOMAIN);
  return {
    orgId,
    at,
    zone: yield* ownerZone(orgId),
    chief: chief?.agentId,
    finance: finance === undefined ? chief?.agentId : KinAgentId.make(finance.agentId),
    tech: tech === undefined ? chief?.agentId : KinAgentId.make(tech.agentId),
    liveAgents: new Set(leads.map((lead) => lead.agentId)),
  } satisfies SenseContext;
});

/** Every sense over the org's rows as of `ctx.at`, before handling and viewers. */
const senseIn = Effect.fn("KinPulse.sense")(function* (ctx: SenseContext) {
  const facts = [
    ...(yield* workSenses(ctx)),
    ...(yield* moneySenses(ctx)),
    ...(yield* systemSenses(ctx)),
    ...(yield* clientSenses(ctx)),
    ...(yield* goalSenses(ctx)),
    ...(yield* numberSenses(ctx)),
    ...(yield* projectSenses(ctx)),
    ...(yield* dealSenses(ctx)),
  ];
  return facts.toSorted(
    (a, b) =>
      Number(b.sense === "sense_overflow") - Number(a.sense === "sense_overflow") ||
      DateTime.toEpochMillis(a.since) - DateTime.toEpochMillis(b.since) ||
      (a.key < b.key ? -1 : 1),
  );
});
const sense = (orgId: KinOrgId, at: number) => context(orgId, at).pipe(Effect.flatMap(senseIn));

/** A hold reads as handled for clients that know nothing of holds, with `aside` for those that do. */
const heldAs = (hold: Hold): KinPulseHandled => ({
  by:
    hold.byKind === "agent"
      ? { _tag: "agent", agentId: KinAgentId.make(hold.byId) }
      : { _tag: "person", personId: KinPersonId.make(hold.byId) },
  at: iso(hold.setAt),
  until: hold.until === null ? null : iso(hold.until),
  note: hold.note,
});

const withStored = (
  fact: SensedFact,
  row: StoredRow | undefined,
  at: number,
  reader: {
    readonly viewer: Viewer;
    readonly level: ReadonlySet<string>;
    readonly personId?: string | undefined;
  },
  hold?: Hold | undefined,
): KinPulseFact => {
  const {
    yours,
    quietForMs: _quietForMs,
    section: _section,
    overflow: _overflow,
    extraSection: _extraSection,
    ...shared
  } = fact;
  // One person reading a fact that names them reads it as theirs; a shared view keeps names.
  const own =
    reader.viewer._tag === "people" && reader.viewer.people.length === 1
      ? yours?.(reader.viewer.people[0]!)
      : undefined;
  return {
    ...shared,
    ...(own === undefined ? {} : { consequence: own }),
    since:
      row !== undefined && row.firstSeenAt < DateTime.toEpochMillis(fact.since)
        ? iso(row.firstSeenAt)
        : fact.since,
    handled: hold === undefined ? handledOf(row, at, fact, reader) : heldAs(hold),
    ...(hold === undefined ? {} : { aside: asideView(hold, reader.viewer, reader.personId) }),
  };
};

/** By key, or by name as typed: any case, a start of it, or a close spelling. */
const matches = (text: string | undefined, key: string | undefined, wanted: string) =>
  key?.toLowerCase() === wanted.toLowerCase() ||
  (text !== undefined && matchName(wanted, [{ name: text }])._tag === "found");

export const quiet = (
  fact: {
    readonly sense: string;
    readonly subject?: {
      readonly recordId?: string | undefined;
      readonly key?: string | undefined;
    };
    readonly section?: SectionId | undefined;
    readonly extraSection?: SectionId | undefined;
  },
  shell: Shell,
  onDeals: ReadonlySet<string> = new Set(),
) => {
  if (fact.section !== undefined && !KinShell.sectionOn(shell, fact.section)) return true;
  if (fact.extraSection !== undefined && !KinShell.sectionOn(shell, fact.extraSection)) return true;
  if (fact.subject?.recordId !== undefined && onDeals.has(fact.subject.recordId)) return true;
  const section = sectionOfSense(fact.sense);
  if (section === null) return false;
  const subject = fact.subject?.key === undefined ? null : sectionOfKey(fact.subject.key);
  return (
    !KinShell.sectionOn(shell, section) || (subject !== null && !KinShell.sectionOn(shell, subject))
  );
};

/** Promises on a deal (`promises.ts`), by record id: quiet with Deals, as the deal's own facts. */
const promisesOnDeals = Effect.fn("KinPulse.promisesOnDeals")(function* (
  orgId: KinOrgId,
  shell: Shell,
) {
  if (KinShell.sectionOn(shell, "deals")) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId" FROM kin_records r
    WHERE r.org_id = ${orgId} AND ${promiseOnDeal(sql)} ORDER BY r.record_id`;
  return new Set(rows.map((row) => row.recordId));
});

/** Only what this viewer may see; for people, Work facts on tasks every one of them sees. */
const visibleTo = Effect.fn("KinPulse.visibleTo")(function* (
  orgId: KinOrgId,
  viewer: Viewer,
  sensed: ReadonlyArray<SensedFact>,
  shell?: Shell,
  includeOverflow = false,
) {
  const current = shell ?? (yield* KinShell.get(orgId));
  const onDeals = yield* promisesOnDeals(orgId, current);
  const facts = sensed.filter((fact) => !quiet(fact, current, onDeals));
  if (viewer._tag === "owner") return facts;
  const deals = yield* dealsHeardBy(orgId, viewer, facts);
  // Who holds a task after their access went is the owner's to settle, not a teammate's.
  const candidates = facts.filter(
    (fact) =>
      fact.family === "work" &&
      fact.sense !== "holder_removed" &&
      !LOOKED_AFTER_SENSES.has(fact.sense) &&
      !fact.sensitive &&
      fact.subject.recordId !== undefined,
  );
  const counts = includeOverflow
    ? (yield* Effect.forEach(
        facts.filter((fact) => fact.overflow !== undefined),
        (fact) => visibleOverflow(orgId, viewer.people, fact),
      )).flat()
    : [];
  if (candidates.length === 0 || viewer.people.length === 0) return [...counts, ...deals];
  const sql = yield* SqlClient.SqlClient;
  const ids = [...new Set(candidates.map((fact) => fact.subject.recordId!))];
  const seen = new Set<string>();
  for (let start = 0; start < ids.length; start += 500)
    for (const row of yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId"
      FROM kin_records r WHERE r.org_id = ${orgId}
        AND r.record_id IN ${sql.in(ids.slice(start, start + 500))}
        AND r.register_id IN ('work', 'milestones') AND ${viewSees(sql, viewer.people)}
      ORDER BY r.record_id`)
      seen.add(row.recordId);
  // A meeting's alert asks how it went: only for the people who were in it.
  const meetingIds = [
    ...new Set(
      candidates
        .filter((fact) => fact.sense.startsWith("meeting_") && seen.has(fact.subject.recordId!))
        .map((fact) => fact.subject.recordId!),
    ),
  ];
  const attended = new Set<string>();
  if (meetingIds.length > 0)
    for (const row of yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId"
      FROM kin_records r WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in(meetingIds.slice(0, 500))}
        AND ${sql.and(
          viewer.people.map(
            (person) => sql`EXISTS (SELECT 1 FROM json_each(r.fields_json, '$.attendees') a
              WHERE a.value = 'person:' || ${person})`,
          ),
        )}
      ORDER BY r.record_id`)
      attended.add(row.recordId);
  const shown = candidates.filter(
    (fact) =>
      seen.has(fact.subject.recordId!) &&
      (!fact.sense.startsWith("meeting_") || attended.has(fact.subject.recordId!)),
  );
  // A task they see may sit under a project or client they don't: that one goes unnamed.
  const scopeKeys = [
    ...new Set(
      shown.flatMap((fact) =>
        [fact.scope.projectKey, fact.scope.clientKey].filter((key) => key !== undefined),
      ),
    ),
  ];
  const named = new Set<string>();
  for (let start = 0; start < scopeKeys.length; start += 500)
    for (const row of yield* sql<{ key: string }>`SELECT r.key FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.key IN ${sql.in(scopeKeys.slice(start, start + 500))}
        AND ${viewSees(sql, viewer.people)} ORDER BY r.key`)
      named.add(row.key);
  const work = shown.map((fact) => {
    const { projectKey, projectTitle, clientKey, clientTitle, ...rest } = fact.scope;
    return {
      ...fact,
      scope: {
        ...rest,
        ...(projectKey !== undefined && named.has(projectKey) ? { projectKey, projectTitle } : {}),
        ...(clientKey !== undefined && named.has(clientKey) ? { clientKey, clientTitle } : {}),
      },
    };
  });
  return [...counts, ...work, ...deals];
});

/**
 * A deal's or prospect's fact reaches one person: the one it is for (`actor`), reading alone,
 * while their Clients switch still shows them the record. Nobody else on the team hears it.
 */
const dealsHeardBy = Effect.fn("KinPulse.dealsHeardBy")(function* (
  orgId: KinOrgId,
  viewer: Extract<Viewer, { _tag: "people" }>,
  facts: ReadonlyArray<SensedFact>,
) {
  const [person] = viewer.people;
  if (viewer.people.length !== 1 || person === undefined) return [];
  const theirs = facts.filter(
    (fact) =>
      LOOKED_AFTER_SENSES.has(fact.sense) &&
      // A private project's notice day stays the owner level's, whoever looks after the client.
      !(fact.sense === "notice_due" && fact.sensitive) &&
      fact.actor._tag === "person" &&
      fact.actor.personId === person &&
      fact.subject.recordId !== undefined,
  );
  if (theirs.length === 0) return [];
  const seen = yield* crmVisible(
    orgId,
    person,
    theirs.map((fact) => fact.subject.recordId!),
  );
  return theirs.filter((fact) => seen.has(fact.subject.recordId!));
});

/** The facts that need attention as of `at`, for one viewer, filtered by scope. */
export const read = Effect.fn("KinPulse.read")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly viewer: Viewer;
  readonly scope?: KinPulseScope | undefined;
  readonly includeHandled?: boolean | undefined;
  readonly excludeOverflow?: boolean | undefined;
  /** What is set aside, without the facts it covers: for an agent asked about one. */
  readonly withAside?: boolean | undefined;
  /** The person reading, for "by you" and "on your word". */
  readonly personId?: string | undefined;
  readonly limit?: number | undefined;
  readonly factKeys?: ReadonlySet<string> | undefined;
  /** What a tick already sensed (`lastTick`), instead of sensing again. */
  readonly sensed?: ReadonlyArray<SensedFact> | undefined;
  readonly shell?: Shell | undefined;
}) {
  const { orgId, at, scope } = input;
  const shell = input.shell ?? (yield* KinShell.getForDisplay(orgId));
  const current = input.sensed ?? (yield* sense(orgId, at));
  const sensed = input.excludeOverflow
    ? current.filter((fact) => fact.sense !== "sense_overflow")
    : current;
  const holds = yield* liveHolds(orgId, at);
  // Before a teammate's view drops the scope it can't name: a hold on that client still counts.
  const asides = new Map(
    sensed.flatMap((fact) => {
      const hold = asideOf(fact, holds, input.viewer);
      return hold === undefined ? [] : [[fact.key, hold] as const];
    }),
  );
  const visible = yield* visibleTo(orgId, input.viewer, sensed, shell, !input.excludeOverflow);
  const scoped = visible.filter(
    (fact) =>
      (input.factKeys === undefined || input.factKeys.has(fact.key)) &&
      (scope?.family === undefined || fact.family === scope.family) &&
      (scope?.project === undefined ||
        matches(fact.scope.projectTitle, fact.scope.projectKey, scope.project)) &&
      (scope?.client === undefined ||
        matches(fact.scope.clientTitle, fact.scope.clientKey, scope.client)),
  );
  const stored = yield* storedRows(
    orgId,
    scoped.map((fact) => fact.key),
  );
  const reader = {
    viewer: input.viewer,
    level: yield* ownerLevelPeople(orgId),
    personId: input.personId,
  };
  const facts = scoped
    .map((fact) => withStored(fact, stored.get(fact.key), at, reader, asides.get(fact.key)))
    .filter((fact) => input.includeHandled === true || fact.handled === null);
  // A teammate sees their own holds, and the company's only where it covers what they see; a
  // scoped read, those on what it is about or covering a fact in it.
  const narrowed = scope?.client !== undefined || scope?.project !== undefined;
  const shownHolds = holdsFor(holds, input.viewer).filter(
    (hold) =>
      (input.withAside !== true ||
        ((section) => section === null || KinShell.sectionOn(shell, section))(
          sectionOfKey(hold.recordKey),
        )) &&
      (input.viewer._tag === "owner" ||
        hold.forPersonId !== null ||
        visible.some((fact) => asides.get(fact.key)?.holdId === hold.holdId)) &&
      (!narrowed ||
        [scope?.client, scope?.project].some(
          (name) => name !== undefined && matches(hold.title, hold.recordKey, name),
        ) ||
        scoped.some((fact) => asides.get(fact.key)?.holdId === hold.holdId)),
  );
  return {
    asOf: iso(at),
    total: facts.length,
    facts: facts.slice(0, Math.max(1, Math.min(input.limit ?? READ_CAP, 200))),
    ...((input.includeHandled === true || input.withAside === true) && shownHolds.length > 0
      ? { setAside: shownHolds.map((hold) => asideView(hold, input.viewer, input.personId)) }
      : {}),
  };
});

const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 32);

/** What each org's last tick sensed, hashed: the server's own memory, gone on restart. */
const lastSensed = new Map<KinOrgId, string>();
const lastFacts = new Map<
  KinOrgId,
  { readonly at: number; readonly facts: ReadonlyArray<SensedFact> }
>();
/**
 * What the org's last tick sensed and when, for screens it moves; none once a person's handling
 * moved Needs attention since, so their next read senses afresh.
 */
export const lastTick = (orgId: KinOrgId) => lastFacts.get(orgId);
/** Facts that can't wait for the morning: they wake their agent whatever the hour. */
const URGENT_SENSES = new Set<KinPulseFact["sense"]>(["client_waiting_on_us"]);

/**
 * Late and due-today work reaches whoever holds it, once (`kin_pulse_told`): an agent holder is
 * woken with it; the Chief of staff's owner hears it through the Chief of staff; anyone else,
 * a co-owner too, reads Kin's own notice in their chat, held by their own clock. One wake per
 * agent per pass carries all of that agent's untold facts. Returns who was told what.
 */
const tellHolders = Effect.fn("KinPulse.tellHolders")(function* (
  ctx: SenseContext,
  facts: ReadonlyArray<SensedFact>,
  stored: ReadonlyMap<string, StoredRow>,
  holds: ReadonlyArray<Hold>,
  shell: Shell,
) {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const { orgId, at, zone } = ctx;
  const onDeals = yield* promisesOnDeals(orgId, shell);
  const due = facts.flatMap((sensed): Array<KinPulseFact> => {
    if (quiet(sensed, shell, onDeals)) return [];
    const {
      yours: _yours,
      quietForMs: _quietForMs,
      section: _section,
      overflow: _overflow,
      extraSection: _extraSection,
      ...fact
    } = sensed;
    const open = { ...fact, handled: handledOf(stored.get(fact.key), at, sensed) };
    return open.handled === null &&
      forHolder(open, at, zone) &&
      asideOf(fact, holds, { _tag: "owner" }) === undefined
      ? [open]
      : [];
  });
  const personIds = [
    ...new Set(due.flatMap((fact) => (fact.actor._tag === "person" ? [fact.actor.personId] : []))),
  ];
  const present = new Set<string>();
  for (let start = 0; start < personIds.length; start += 500)
    for (const row of yield* sql<{ personId: string }>`SELECT person_id AS "personId"
      FROM kin_people WHERE org_id = ${orgId} AND removed_at IS NULL
        AND person_id IN ${sql.in(personIds.slice(start, start + 500))} ORDER BY person_id`)
      present.add(row.personId);
  // Who hears it, and the agent woken to act on it or to tell them.
  const parties = new Map<string, { agentId: KinAgentId; facts: Array<KinPulseFact> }>();
  for (const fact of due) {
    const party =
      fact.actor._tag === "agent"
        ? { to: agentParty(fact.actor.agentId), agentId: fact.actor.agentId }
        : fact.actor._tag === "person" && present.has(fact.actor.personId) && ctx.chief
          ? { to: fact.actor.personId, agentId: ctx.chief }
          : undefined;
    if (party === undefined) continue;
    // A teammate's own hold on it, or one on its project or client, keeps it from them.
    if (
      fact.actor._tag === "person" &&
      asideOf(fact, holds, { _tag: "people", people: [fact.actor.personId] }) !== undefined
    )
      continue;
    const entry = parties.get(party.to) ?? { agentId: party.agentId, facts: [] };
    entry.facts.push(fact);
    parties.set(party.to, entry);
  }
  // A wake waits out its agent owner's clock, so only the owner's own work wakes the agent.
  const [chiefOwner] =
    ctx.chief === undefined || personIds.length === 0
      ? []
      : yield* sql<{ personId: string }>`SELECT owner_person_id AS "personId" FROM kin_agents
          WHERE org_id = ${orgId} AND agent_id = ${ctx.chief} ORDER BY agent_id`;
  const told: Array<{ readonly agentId: KinAgentId; readonly to: string; readonly key: string }> =
    [];
  const wakes = new Map<KinAgentId, Array<{ to: string; facts: ReadonlyArray<KinPulseFact> }>>();
  for (const [to, entry] of parties) {
    const tell = yield* untold({
      orgId,
      personId: to,
      facts: entry.facts,
      at,
      zone,
      anyState: true,
    });
    if (tell.length === 0) continue;
    if (to.startsWith("agent:") || to === chiefOwner?.personId) {
      wakes.set(entry.agentId, [...(wakes.get(entry.agentId) ?? []), { to, facts: tell }]);
      continue;
    }
    // Anyone else's own late work has one right message: Kin writes it, no agent turn.
    const personId = KinPersonId.make(to);
    const sees = new Set(
      (yield* visibleTo(orgId, { _tag: "people", people: [personId] }, tell, shell)).map(
        (fact) => fact.key,
      ),
    );
    // Counted unnamed only where their Tasks opens it; one kept from them (a promise on a deal
    // kept private) isn't theirs to hear of at all, and waits until they may see it.
    const hidden = tell.filter((fact) => !sees.has(fact.key));
    const opens = new Set(
      hidden.length === 0
        ? []
        : (yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId" FROM kin_records r
            WHERE r.org_id = ${orgId}
              AND r.record_id IN ${sql.in(hidden.flatMap((fact) => fact.subject.recordId ?? []))}
              AND ${viewSees(sql, [personId])} ORDER BY r.record_id`).map((row) => row.recordId),
    );
    const heard = tell.filter(
      (fact) => sees.has(fact.key) || opens.has(fact.subject.recordId ?? ""),
    );
    const noticeId = yield* tellHolder({
      ctx,
      personId,
      agentId: entry.agentId,
      facts: heard.filter((fact) => sees.has(fact.key)),
      unnamed: heard.filter((fact) => !sees.has(fact.key)),
    });
    if (noticeId === undefined) continue;
    yield* markTold({ orgId, personId: to, eventId: noticeId, facts: heard, at, zone });
    for (const fact of heard) told.push({ agentId: entry.agentId, to, key: fact.key });
  }
  for (const [agentId, groups] of wakes) {
    // One event carries at most 50 facts: the rest stay untold for the next pass.
    let room = 50;
    const batch = groups.flatMap(({ to, facts: some }) => {
      const taken = some.slice(0, room);
      room -= taken.length;
      return taken.length === 0 ? [] : [{ to, facts: taken }];
    });
    const dedupeKey = `holders:${agentId}:${at}`;
    const eventId = KinEventId.make(`pulse-${shortHash(`${orgId}\0${dedupeKey}`)}`);
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
          factKeys: batch.flatMap((group) => group.facts.map((fact) => fact.key)),
        }),
        // Nobody asked: it waits out the owner's quiet hours.
        yield* agentQuietUntil(orgId, agentId, at).pipe(
          Effect.map((notBefore) => (notBefore === undefined ? undefined : { notBefore })),
        ),
      )
      .pipe(
        Effect.map((result) => !result.duplicate),
        Effect.catchTags({
          KinEventQueueUnknownAgent: () => Effect.succeed(false),
          KinEventQueueRetiredAgent: () => Effect.succeed(false),
        }),
      );
    if (!queued) continue;
    for (const group of batch) {
      yield* markTold({ orgId, personId: group.to, eventId, facts: group.facts, at, zone });
      for (const fact of group.facts) told.push({ agentId, to: group.to, key: fact.key });
    }
  }
  return told;
});

const markQuiet = Effect.fn("KinPulse.markQuiet")(function* (
  ctx: SenseContext,
  muted: readonly SensedFact[],
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at, zone } = ctx;
  yield* sql`UPDATE kin_pulse_facts SET woke_at = ${at} WHERE org_id = ${orgId}
    AND woke_at IS NULL AND fact_key IN
      (SELECT value FROM json_each(${yield* encodeKeys(muted.map((fact) => fact.key))}))`;
  const parties = new Map<string, Array<KinPulseFact>>();
  const owners = yield* ownerLevelPeople(orgId);
  for (const {
    yours: _yours,
    quietForMs: _quietForMs,
    section: _section,
    overflow: _overflow,
    extraSection: _extraSection,
    ...fact
  } of muted) {
    const destinations = new Set(owners);
    if (fact.actor._tag === "person") destinations.add(fact.actor.personId);
    if (fact.actor._tag === "agent") destinations.add(agentParty(fact.actor.agentId));
    for (const to of destinations) {
      const group = parties.get(to) ?? [];
      group.push({ ...fact, handled: null });
      parties.set(to, group);
    }
  }
  for (const [personId, facts] of parties) {
    const stamp = { orgId, personId, at, zone };
    const silent = yield* untold({ ...stamp, facts, deliveredOnly: true });
    yield* markTold({ ...stamp, eventId: `${SHELL_QUIET_EVENT_PREFIX}${at}`, facts: silent });
  }
});

/**
 * Stores what is true now, clears what stopped being true, and wakes each fact's agent once for
 * the facts that matter now, and each holder once for its late and due work. No model runs here.
 */
/** After a commit: Kin's notices about these facts are withdrawn where nothing of them stands. */
const settleNotices = Effect.fn("KinPulse.settleNotices")(function* (
  orgId: KinOrgId,
  keys: ReadonlyArray<string>,
) {
  const push = yield* Effect.serviceOption(KinPushSender);
  if (keys.length === 0 || Option.isNone(push)) return;
  yield* push.value.settle(orgId, { keys: keys.map((key) => `fact:${key}`) });
});

export const tick = Effect.fn("KinPulse.tick")(function* (orgId: KinOrgId, at: number) {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const refreshes = yield* KinRefreshObserver;
  // Sensed from committed rows before the transaction, on a reader: off the writer it needs.
  const ctx = yield* context(orgId, at).pipe(NodeSqliteClient.readOnly);
  const facts = yield* senseIn(ctx).pipe(NodeSqliteClient.readOnly);
  const sensedText = yield* encodeSensed(
    facts.map((fact) => (fact.sense === "sense_overflow" ? { ...fact, since: iso(0) } : fact)),
  );
  let gone: ReadonlyArray<string> = [];
  const result = yield* sql.withTransaction(
    Effect.gen(function* () {
      const shell = yield* KinShell.get(orgId);
      // Set-wise over one JSON array: a tick can sense thousands of facts.
      const rows = yield* encodeTickRows(
        yield* Effect.forEach(facts, (fact) =>
          encodeScope(fact.scope).pipe(
            Effect.map((scope) => ({
              key: fact.key,
              sense: fact.sense,
              record: fact.subject.recordId ?? null,
              scope,
            })),
          ),
        ),
      );
      const sensedKeys = sql`SELECT json_extract(value, '$.key') FROM json_each(${rows})`;
      const inserted = yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense,
          subject_record_id, scope_json, first_seen_at, last_seen_at)
        SELECT ${orgId}, json_extract(value, '$.key'), json_extract(value, '$.sense'),
          json_extract(value, '$.record'), json_extract(value, '$.scope'), ${at}, ${at}
        FROM json_each(${rows}) WHERE true
        ON CONFLICT (org_id, fact_key) DO NOTHING RETURNING fact_key`;
      const reopened = yield* sql<{ key: string }>`UPDATE kin_pulse_facts
        SET cleared_at = NULL, woke_at = NULL
        WHERE org_id = ${orgId} AND cleared_at IS NOT NULL AND fact_key IN (${sensedKeys})
        RETURNING fact_key AS key`;
      // Back after it stopped being true: its holder and the check-ins hear of it again.
      if (reopened.length > 0)
        yield* sql`DELETE FROM kin_pulse_told WHERE org_id = ${orgId}
          AND fact_key IN (SELECT value FROM json_each(${yield* encodeKeys(reopened.map((row) => row.key))}))`;
      yield* sql`UPDATE kin_pulse_facts SET last_seen_at = ${at}
        WHERE org_id = ${orgId} AND fact_key IN (${sensedKeys})`;
      const cleared = yield* sql<{ fact_key: string }>`UPDATE kin_pulse_facts SET cleared_at = ${at}
        WHERE org_id = ${orgId} AND cleared_at IS NULL AND last_seen_at < ${at}
        RETURNING fact_key`;
      const moved = inserted.length + reopened.length + cleared.length;

      const stored = yield* storedRows(
        orgId,
        facts.map((fact) => fact.key),
      );
      const holds = yield* liveHolds(orgId, at);
      // Owner-level screens read Needs attention again only on this topic, so any change to what
      // was sensed or is set aside moves it: a fact's words, progress, or a handling running out.
      const handled = facts.filter(
        (fact) =>
          handledOf(stored.get(fact.key), at, fact) !== null ||
          asideOf(fact, holds, { _tag: "owner" }) !== undefined,
      );
      const sensedNow = shortHash(`${sensedText}\0${handled.map((fact) => fact.key).join("\n")}`);
      const onDeals = yield* promisesOnDeals(orgId, shell);
      const muted = facts.filter((fact) => quiet(fact, shell, onDeals));
      if (muted.length > 0) yield* markQuiet(ctx, muted);
      const woken: Array<string> = [];
      const latestWakeKeys = facts.flatMap((fact) => {
        const wokeAt = stored.get(fact.key)?.wokeAt;
        return fact.wake === "now" && wokeAt != null && !quiet(fact, shell, onDeals)
          ? [`${fact.key}:${wokeAt}`]
          : [];
      });
      const failedWakes = new Set<string>();
      for (let start = 0; start < latestWakeKeys.length; start += 500)
        for (const row of yield* sql<{ key: string }>`SELECT dedupe_key AS key FROM kin_events
          WHERE org_id = ${orgId} AND tag = 'pulse' AND state = 'failed'
            AND dedupe_key IN ${sql.in(latestWakeKeys.slice(start, start + 500))}
          ORDER BY dedupe_key`)
          failedWakes.add(row.key);
      for (const fact of facts) {
        if (quiet(fact, shell, onDeals)) continue;
        const row = stored.get(fact.key);
        if (fact.wake !== "now" || fact.actor._tag !== "agent") continue;
        if (row === undefined || handledOf(row, at, fact) !== null) continue;
        const personId = agentParty(fact.actor.agentId);
        const delivery = {
          orgId,
          personId,
          at,
          zone: ctx.zone,
          facts: [{ ...fact, handled: null }],
        };
        if (
          row.wokeAt !== null &&
          (!failedWakes.has(`${fact.key}:${row.wokeAt}`) ||
            (yield* untold({ ...delivery, anyState: true })).length === 0)
        )
          continue;
        // Set aside: it wakes no one; when the hold ends, the check-in tells it once.
        if (asideOf(fact, holds, { _tag: "owner" }) !== undefined) continue;
        const eventId = KinEventId.make(`pulse-${shortHash(`${orgId}\0${fact.key}\0${at}`)}`);
        const enqueued = yield* queue
          .enqueue(
            yield* decodeEvent({
              _tag: "pulse",
              orgId,
              // A fact that comes back wakes anew: `woke_at` keeps a fact from waking twice.
              eventId,
              agentId: fact.actor.agentId,
              receivedAt: DateTime.formatIso(iso(at)),
              dedupeKey: `${fact.key}:${at}`,
              provenance: { _tag: "system" },
              factKeys: [fact.key],
            }),
            // Nobody asked: it waits out the owner's quiet hours, unless a client is waiting on us.
            URGENT_SENSES.has(fact.sense)
              ? undefined
              : yield* agentQuietUntil(orgId, fact.actor.agentId, at).pipe(
                  Effect.map((notBefore) => (notBefore === undefined ? undefined : { notBefore })),
                ),
          )
          .pipe(
            Effect.as(true),
            Effect.catchTags({
              KinEventQueueUnknownAgent: () => Effect.succeed(false),
              KinEventQueueRetiredAgent: () => Effect.succeed(false),
            }),
          );
        if (!enqueued) continue;
        yield* markTold({ ...delivery, eventId });
        yield* sql`UPDATE kin_pulse_facts SET woke_at = ${at}
          WHERE org_id = ${orgId} AND fact_key = ${fact.key}`;
        woken.push(fact.key);
      }
      // A teammate's page first: what it tells, the holder notice after it doesn't repeat.
      const pages = yield* morningPages({
        ctx,
        open: facts.filter((fact) => handledOf(stored.get(fact.key), at, fact) === null),
        holds,
        sees: (personId) => visibleTo(orgId, { _tag: "people", people: [personId] }, facts, shell),
        shell,
      });
      const told = yield* tellHolders(ctx, facts, stored, holds, shell);
      // A teammate's own follow-up to a client, due now: the sales agent drafts it for them.
      const drafted = yield* draftWakes({
        ctx,
        open: facts.flatMap((sensed): Array<KinPulseFact> => {
          const {
            yours: _yours,
            quietForMs: _quietForMs,
            section: _section,
            overflow: _overflow,
            extraSection: _extraSection,
            ...fact
          } = sensed;
          const handled = handledOf(stored.get(fact.key), at, sensed);
          const aside =
            asideOf(fact, holds, { _tag: "owner" }) !== undefined ||
            (fact.actor._tag === "person" &&
              asideOf(fact, holds, { _tag: "people", people: [fact.actor.personId] }) !==
                undefined);
          return handled === null && !aside ? [{ ...fact, handled }] : [];
        }),
        sees: (personId, some) => visibleTo(orgId, { _tag: "people", people: [personId] }, some),
      });
      if (moved > 0 || sensedNow !== lastSensed.get(orgId)) yield* refreshes.touch(orgId, "pulse");
      yield* sql.afterCommit(
        Effect.sync(() => {
          lastSensed.set(orgId, sensedNow);
          lastFacts.set(orgId, { at, facts });
        }),
      );
      gone = cleared.map((row) => row.fact_key);
      return { facts: facts.length, cleared: cleared.length, woken, told, pages, drafted };
    }),
  );
  yield* settleNotices(orgId, gone);
  return result;
});

/**
 * Whose hold a caller may set or lift: the company's (`forPersonId` null) or a teammate's own, on
 * whose word when an agent acts; or refused, with the sentence that says who can.
 */
export type Holding =
  | {
      readonly _tag: "may";
      readonly forPersonId: string | null;
      readonly onWordOf: string | null;
    }
  | { readonly _tag: "refused"; readonly message: string };

const refusedBy = (holding: Holding) =>
  new KinChatError({
    reason: "not_allowed",
    message:
      holding._tag === "refused"
        ? holding.message
        : "Only the owner or a co-owner can lift what the company set aside.",
  });

/** Sets a record aside, or lifts its hold, for whom `holding` says; the hold as it stands now. */
const holdOn = Effect.fn("KinPulse.holdOn")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly by: KinWorkPrincipal;
  readonly recordKey: string;
  readonly action: "set" | "lift";
  readonly until: number | null;
  readonly note: string | null;
  readonly holding: Holding;
  readonly sensed: ReadonlyArray<SensedFact>;
}) {
  const { holding } = input;
  if (holding._tag === "refused") return yield* refusedBy(holding);
  const record = yield* holdRecord(input.orgId, input.recordKey);
  const hold =
    input.action === "set"
      ? yield* setHold({
          orgId: input.orgId,
          at: input.at,
          recordKey: record.key,
          forPersonId: holding.forPersonId,
          until: input.until,
          by: input.by,
          onWordOf: holding.onWordOf,
          note: input.note,
          covered: (on) => input.sensed.filter((fact) => covers(on, fact)).map((fact) => fact.key),
        })
      : yield* liftHold({
          orgId: input.orgId,
          at: input.at,
          recordId: record.recordId,
          forPersonId: holding.forPersonId,
          by: input.by,
        });
  lastFacts.delete(input.orgId);
  yield* (yield* KinRefreshObserver).touch(input.orgId, "pulse");
  return input.action === "set" ? hold : null;
});

/** Someone has a fact in hand, says it is not a problem, or sets its record aside; `undo` takes it back. */
export const handle = Effect.fn("KinPulse.handle")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly viewer: Viewer;
  readonly by: KinWorkPrincipal;
  readonly factKey: string;
  readonly wakeupId?: KinWakeupId;
  readonly action: KinPulseHandleAction;
  readonly until?: number | undefined;
  readonly note?: string | undefined;
  /** Who this caller sets or lifts a record's hold for; absent, it may not. */
  readonly holding?: Holding | undefined;
  /** For `set_aside` on a fact that is not a record: mark it got_it instead of refusing. */
  readonly orPlain?: boolean | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  const sensed = yield* sense(orgId, at);
  const visible = yield* visibleTo(orgId, input.viewer, sensed);
  const fact = visible.find((candidate) => candidate.key === input.factKey);
  if (fact === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No fact ${input.factKey} needs attention now. Read the pulse again for current keys.`,
    });
  if (input.until !== undefined && input.until <= at)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "until must be in the future.",
    });
  const holding: Holding = input.holding ?? {
    _tag: "refused",
    message: "Only a person can set this aside or lift it.",
  };
  const raw = sensed.find((candidate) => candidate.key === fact.key)!;
  const level = yield* ownerLevelPeople(orgId);
  const reader = {
    viewer: input.viewer,
    level,
    personId: input.by._tag === "person" ? input.by.personId : undefined,
  };
  const isRecord = fact.subject.kind === "record" && fact.subject.recordId !== undefined;
  if (input.action === "set_aside" && (isRecord || input.orPlain !== true)) {
    if (!isRecord)
      return yield* new KinChatError({
        reason: "invalid_state",
        message: `${fact.subject.title} is not a record, so it can't be set aside. Mark it got_it instead.`,
      });
    const hold = yield* holdOn({
      orgId,
      at,
      by: input.by,
      recordKey: fact.subject.key,
      action: "set",
      until: input.until ?? null,
      note: input.note ?? null,
      holding,
      sensed,
    });
    const stored = yield* storedRows(orgId, [fact.key]);
    return withStored(fact, stored.get(fact.key), at, reader, hold ?? undefined);
  }
  if (input.action === "undo") {
    const held = asideOf(raw, yield* liveHolds(orgId, at), input.viewer);
    if (held !== undefined) {
      if (holding._tag === "refused" || holding.forPersonId !== held.forPersonId)
        return yield* refusedBy(holding);
      yield* holdOn({
        orgId,
        at,
        by: input.by,
        recordKey: held.recordKey,
        action: "lift",
        until: null,
        note: null,
        holding,
        sensed,
      });
    }
  }
  const byKind = input.by._tag;
  const byId = input.by._tag === "agent" ? input.by.agentId : input.by.personId;
  const until = input.action === "not_a_problem" ? null : (input.until ?? at + GOT_IT_MS);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense, subject_record_id,
          scope_json, first_seen_at, last_seen_at)
        VALUES (${orgId}, ${fact.key}, ${fact.sense}, ${fact.subject.recordId ?? null},
          ${yield* encodeScope(fact.scope)}, ${at}, ${at})
        ON CONFLICT (org_id, fact_key) DO NOTHING`;
      if (input.action === "undo")
        yield* sql`UPDATE kin_pulse_facts SET handled_by_kind = NULL, handled_by_id = NULL,
            handled_at = NULL, handled_until = NULL, handled_note = NULL
          WHERE org_id = ${orgId} AND fact_key = ${fact.key}`;
      else {
        yield* sql`UPDATE kin_pulse_facts SET handled_by_kind = ${byKind},
            handled_by_id = ${byId}, handled_at = ${at}, handled_until = ${until},
            handled_note = ${input.note ?? null}
          WHERE org_id = ${orgId} AND fact_key = ${fact.key}`;
        const checks =
          input.wakeupId !== undefined && input.by._tag === "agent" && input.viewer._tag === "owner"
            ? yield* checkInHandling({
                orgId,
                wakeupId: input.wakeupId,
                agentId: input.by.agentId,
                factKey: fact.key,
              })
            : [];
        // Told again once when it is back, as after a hold: a teammate's own is theirs alone.
        yield* sql`DELETE FROM kin_pulse_told WHERE org_id = ${orgId} AND fact_key = ${fact.key}
          ${checks.length === 0 ? sql`` : sql`AND event_id NOT IN ${sql.in(checks.map((row) => row.event_id))}`}
          AND (${input.viewer._tag === "owner" ? 1 : 0} = 1 OR person_id IN ${sql.in(
            input.viewer._tag === "owner" ? [""] : input.viewer.people,
          )})`;
      }
      lastFacts.delete(orgId);
      yield* (yield* KinRefreshObserver).touch(orgId, "pulse");
    }),
  );
  if (input.action !== "undo") yield* settleNotices(orgId, [fact.key]);
  const stored = yield* storedRows(orgId, [fact.key]);
  return withStored(
    fact,
    stored.get(fact.key),
    at,
    reader,
    asideOf(raw, yield* liveHolds(orgId, at), input.viewer),
  );
});

/**
 * Sets a record aside or lifts its hold, whether or not any fact is about it yet: a later fact
 * about it is born held. A teammate may hold only what they see. Returns the hold, or null.
 */
export const aside = Effect.fn("KinPulse.aside")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly viewer: Viewer;
  readonly by: KinWorkPrincipal;
  readonly recordKey: string;
  readonly action: "set" | "lift";
  readonly until: number | null;
  readonly note: string | null;
  readonly holding: Holding;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId } = input;
  const record = yield* holdRecord(orgId, input.recordKey);
  if (input.viewer._tag === "people") {
    const seen = yield* sql`SELECT 1 FROM kin_records r WHERE r.org_id = ${orgId}
      AND r.record_id = ${record.recordId} AND ${viewSees(sql, input.viewer.people)}`;
    if (seen.length === 0)
      return yield* new KinChatError({
        reason: "not_found",
        message: `No record ${input.recordKey} here.`,
      });
  }
  const hold = yield* holdOn({
    ...input,
    recordKey: record.key,
    sensed: input.action === "set" ? yield* sense(orgId, input.at) : [],
  });
  return hold === null
    ? null
    : asideView(hold, input.viewer, input.by._tag === "person" ? input.by.personId : undefined);
});

/** When each org's pulse last ran, its change number then, and the minute last checked for pages. */
export type Passes = Map<
  string,
  { readonly at: number; readonly seq: number; readonly minute: number }
>;

/** One scheduler pass: each org whose pulse is due runs it (`last` remembers when). */
// Untraced: the scheduler runs it every few seconds; each org's `tick` carries its own span.
export const pass = Effect.fnUntraced(
  function* (last: Passes) {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    // Scheduler maintenance scans organizations; the pulse below is org-scoped.
    const orgs = yield* sql<{ orgId: string; seq: number | null }>`SELECT o.org_id AS "orgId",
        (SELECT MAX(c.seq) FROM kin_record_changes c WHERE c.org_id = o.org_id) AS seq
      FROM kin_orgs o ORDER BY o.org_id`.pipe(NodeSqliteClient.readOnly);
    const minute = Math.floor(now / 60_000);
    for (const { orgId, seq } of orgs) {
      const seen = last.get(orgId);
      const due =
        seen === undefined ||
        seen.seq !== (seq ?? 0) ||
        now - seen.at >= TICK_EVERY_MS ||
        // A morning page goes at its own minute, not at the pulse's next turn.
        (seen.minute !== minute &&
          (yield* pageMinuteSince(KinOrgId.make(orgId), seen.at, now).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Kin page check failed", { orgId, cause }).pipe(Effect.as(false)),
            ),
          )));
      if (!due) {
        last.set(orgId, { ...seen, minute });
        continue;
      }
      last.set(orgId, { at: now, seq: seq ?? 0, minute });
      yield* tick(KinOrgId.make(orgId), now).pipe(
        Effect.catch((cause) => Effect.logWarning("Kin pulse failed", { orgId, cause })),
      );
    }
  },
  Effect.catch((cause) => Effect.logWarning("Kin pulse scan failed", { cause })),
);

/**
 * Every 15 minutes, within seconds of a change to an org's entries, and at the minute a person's
 * morning page is set for, each org's pulse runs on the shared scheduler beside the watchdogs.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ticks = yield* Scheduler.Scheduler;
    const queue = yield* KinEventQueue.KinEventQueue;
    const refreshes = yield* KinRefreshObserver;
    const chats = yield* Effect.serviceOption(KinChatService);
    // Facts that clear withdraw Kin's notices about them (`settleNotices`).
    const push = yield* Effect.serviceOption(KinPushSender);
    const last: Passes = new Map();
    const connections = yield* Effect.serviceOption(KinConnections);
    const outside = Option.isNone(connections)
      ? noOutside
      : fromConnections(connections.value, sql, yield* alertsOnMail(connections.value));
    const polled = new Map<string, number>();
    // Mail and calendar between check-ins: metadata reads with no model, waking only on a match.
    yield* ticks.register(
      "kin-pulse-outside",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // Scheduler maintenance: orgs with a live mail connection; each poll is org-scoped.
        const orgs = yield* sql<{ orgId: string }>`SELECT DISTINCT org_id AS "orgId"
          FROM kin_connections WHERE preset IN ${sql.in(MAIL_PRESETS)} AND removed_at IS NULL
            AND paused_at IS NULL AND state = 'active' AND person_id IS NULL
          ORDER BY org_id`.pipe(NodeSqliteClient.readOnly);
        for (const { orgId } of orgs) {
          if (now - (polled.get(orgId) ?? -Infinity) < OUTSIDE_EVERY_MS) continue;
          polled.set(orgId, now);
          yield* poll(KinOrgId.make(orgId), now, outside).pipe(
            Effect.provideService(KinEventQueue.KinEventQueue, queue),
            Effect.catch((cause) => Effect.logWarning("Kin outside poll failed", { orgId, cause })),
          );
        }
      }).pipe(Effect.catch((cause) => Effect.logWarning("Kin outside scan failed", { cause }))),
    );
    yield* ticks.register(
      "kin-pulse",
      Effect.suspend(() => pass(last)).pipe(
        Effect.provideService(KinEventQueue.KinEventQueue, queue),
        Effect.provideService(KinRefreshObserver, refreshes),
        Option.isSome(chats) ? Effect.provideService(KinChatService, chats.value) : (e) => e,
        Option.isSome(push) ? Effect.provideService(KinPushSender, push.value) : (e) => e,
      ),
    );
  }),
);
