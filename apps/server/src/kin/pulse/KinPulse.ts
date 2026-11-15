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
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinConnections } from "../connections/ConnectionsService.ts";
import { MAIL_PRESETS } from "../connections/mailProviders.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { CHIEF_OF_STAFF_DOMAIN, ENGINEERING_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { ownerLevelPeople } from "../people/KinAccess.ts";
import { ownerZone } from "../work/recordRows.ts";
import { viewSees } from "../work/teamView.ts";
import { clientSenses } from "./senses/clients.ts";
import { goalSenses } from "./senses/goals.ts";
import { codeSenses } from "./senses/code.ts";
import { moneySenses } from "./senses/money.ts";
import { iso, type SenseContext, type SensedFact } from "./senses/shared.ts";
import { systemSenses } from "./senses/system.ts";
import { workSenses } from "./senses/work.ts";
import { fromConnections, noOutside, poll } from "./outside.ts";
import { DAY_MS } from "./thresholds.ts";

const FINANCE_DOMAIN = "finance";
/** How long "I've got it" with no date holds a fact. */
export const GOT_IT_MS = 3 * DAY_MS;
const TICK_EVERY_MS = 15 * 60_000;
const OUTSIDE_EVERY_MS = 3 * 60_000;
const READ_CAP = 50;
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
/** Facts that ask for judgement (money owed, a client waiting, a plan slipping) run on the main model. */
const JUDGEMENT_SENSES: ReadonlySet<string> = new Set([
  "task_late",
  "theirs_late",
  "invoice_overdue",
  "quote_unanswered",
  "budget_over",
]);
export const needsJudgement = (facts: ReadonlyArray<Pick<KinPulseFact, "sense">>) =>
  facts.some((fact) => JUDGEMENT_SENSES.has(fact.sense));
const encodeScope = Schema.encodeEffect(Schema.fromJsonString(KinPulseFact.fields.scope));

/**
 * Who a read is for: the owner sees every fact; people see only facts about tasks and milestones,
 * not sensitive, that every one of them may see (`viewSees`). Clients, money, goals and the
 * company's own facts are owner-level.
 */
export type Viewer =
  | { readonly _tag: "owner" }
  | { readonly _tag: "people"; readonly people: ReadonlyArray<KinPersonId> };

const context = Effect.fn("KinPulse.context")(function* (orgId: KinOrgId, at: number) {
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

/** Every sense over the org's rows as of `at`, before handling and viewers. */
const sense = Effect.fn("KinPulse.sense")(function* (orgId: KinOrgId, at: number) {
  const ctx = yield* context(orgId, at);
  const facts = [
    ...(yield* workSenses(ctx)),
    ...(yield* moneySenses(ctx)),
    ...(yield* systemSenses(ctx)),
    ...(yield* clientSenses(ctx)),
    ...(yield* goalSenses(ctx)),
    ...(yield* codeSenses(ctx)),
  ];
  return facts.toSorted(
    (a, b) =>
      DateTime.toEpochMillis(a.since) - DateTime.toEpochMillis(b.since) || (a.key < b.key ? -1 : 1),
  );
});

interface StoredRow {
  readonly key: string;
  readonly firstSeenAt: number;
  readonly wokeAt: number | null;
  readonly byKind: string | null;
  readonly byId: string | null;
  readonly handledAt: number | null;
  readonly until: number | null;
  readonly note: string | null;
}

const storedRows = Effect.fn("KinPulse.stored")(function* (
  orgId: KinOrgId,
  keys: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = new Map<string, StoredRow>();
  for (let start = 0; start < keys.length; start += 500)
    for (const row of yield* sql<StoredRow>`SELECT fact_key AS key,
        first_seen_at AS "firstSeenAt", woke_at AS "wokeAt", handled_by_kind AS "byKind",
        handled_by_id AS "byId", handled_at AS "handledAt", handled_until AS until,
        handled_note AS note
      FROM kin_pulse_facts
      WHERE org_id = ${orgId} AND fact_key IN ${sql.in(keys.slice(start, start + 500))}
      ORDER BY fact_key`)
      rows.set(row.key, row);
  return rows;
});

/**
 * A stored hold that still applies at `at`; an expired "I've got it" brings the fact back. With a
 * reader, only theirs: an agent's or an owner-level person's hold the owner's view, a person's own
 * hold theirs. Handling a fact hides it from no one else, and never hides the task.
 */
const handledOf = (
  row: StoredRow | undefined,
  at: number,
  reader?: { readonly viewer: Viewer; readonly level: ReadonlySet<string> },
): KinPulseHandled | null => {
  if (row?.byKind == null || row.byId === null || row.handledAt === null) return null;
  if (row.until !== null && row.until <= at) return null;
  if (reader !== undefined) {
    const theirs =
      reader.viewer._tag === "owner"
        ? row.byKind === "agent" || reader.level.has(row.byId)
        : row.byKind === "person" && reader.viewer.people.some((person) => person === row.byId);
    if (!theirs) return null;
  }
  return {
    by:
      row.byKind === "agent"
        ? { _tag: "agent", agentId: KinAgentId.make(row.byId) }
        : { _tag: "person", personId: KinPersonId.make(row.byId) },
    at: iso(row.handledAt),
    until: row.until === null ? null : iso(row.until),
    note: row.note,
  };
};

const withStored = (
  fact: SensedFact,
  row: StoredRow | undefined,
  at: number,
  reader: { readonly viewer: Viewer; readonly level: ReadonlySet<string> },
): KinPulseFact => {
  return {
    ...fact,
    since:
      row !== undefined && row.firstSeenAt < DateTime.toEpochMillis(fact.since)
        ? iso(row.firstSeenAt)
        : fact.since,
    handled: handledOf(row, at, reader),
  };
};

const matches = (text: string | undefined, key: string | undefined, wanted: string) =>
  key?.toLowerCase() === wanted.toLowerCase() || text?.toLowerCase() === wanted.toLowerCase();

/** Only what this viewer may see; for people, Work facts on tasks every one of them sees. */
const visibleTo = Effect.fn("KinPulse.visibleTo")(function* (
  orgId: KinOrgId,
  viewer: Viewer,
  facts: ReadonlyArray<SensedFact>,
) {
  if (viewer._tag === "owner") return facts;
  const candidates = facts.filter(
    (fact) => fact.family === "work" && !fact.sensitive && fact.subject.recordId !== undefined,
  );
  if (candidates.length === 0 || viewer.people.length === 0) return [];
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
  return candidates.filter((fact) => seen.has(fact.subject.recordId!));
});

/** The facts that need attention as of `at`, for one viewer, filtered by scope. */
export const read = Effect.fn("KinPulse.read")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly viewer: Viewer;
  readonly scope?: KinPulseScope | undefined;
  readonly includeHandled?: boolean | undefined;
  readonly limit?: number | undefined;
}) {
  const { orgId, at, scope } = input;
  const visible = yield* visibleTo(orgId, input.viewer, yield* sense(orgId, at));
  const scoped = visible.filter(
    (fact) =>
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
  const reader = { viewer: input.viewer, level: yield* ownerLevelPeople(orgId) };
  const facts = scoped
    .map((fact) => withStored(fact, stored.get(fact.key), at, reader))
    .filter((fact) => input.includeHandled === true || fact.handled === null);
  return {
    asOf: iso(at),
    total: facts.length,
    facts: facts.slice(0, Math.max(1, Math.min(input.limit ?? READ_CAP, 200))),
  };
});

const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 32);

/**
 * Stores what is true now, clears what stopped being true, and wakes each fact's agent once for
 * the facts that matter now. No model runs here.
 */
export const tick = Effect.fn("KinPulse.tick")(function* (orgId: KinOrgId, at: number) {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const refreshes = yield* KinRefreshObserver;
  const facts = yield* sense(orgId, at);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      let moved = 0;
      for (const fact of facts) {
        const inserted = yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense,
            subject_record_id, scope_json, first_seen_at, last_seen_at)
          VALUES (${orgId}, ${fact.key}, ${fact.sense}, ${fact.subject.recordId ?? null},
            ${yield* encodeScope(fact.scope)}, ${at}, ${at})
          ON CONFLICT (org_id, fact_key) DO NOTHING RETURNING fact_key`;
        if (inserted.length > 0) {
          moved += 1;
          continue;
        }
        const reopened = yield* sql`UPDATE kin_pulse_facts SET cleared_at = NULL
          WHERE org_id = ${orgId} AND fact_key = ${fact.key} AND cleared_at IS NOT NULL
          RETURNING fact_key`;
        moved += reopened.length;
        yield* sql`UPDATE kin_pulse_facts SET last_seen_at = ${at}
          WHERE org_id = ${orgId} AND fact_key = ${fact.key}`;
      }
      const cleared = yield* sql`UPDATE kin_pulse_facts SET cleared_at = ${at}
        WHERE org_id = ${orgId} AND cleared_at IS NULL AND last_seen_at < ${at}
        RETURNING fact_key`;
      moved += cleared.length;

      const stored = yield* storedRows(
        orgId,
        facts.map((fact) => fact.key),
      );
      const woken: Array<string> = [];
      for (const fact of facts) {
        const row = stored.get(fact.key);
        if (fact.wake !== "now" || fact.actor._tag !== "agent") continue;
        if (row === undefined || row.wokeAt !== null || handledOf(row, at) !== null) continue;
        const enqueued = yield* queue
          .enqueue(
            yield* decodeEvent({
              _tag: "pulse",
              orgId,
              eventId: KinEventId.make(`pulse-${shortHash(`${orgId}\0${fact.key}`)}`),
              agentId: fact.actor.agentId,
              receivedAt: DateTime.formatIso(iso(at)),
              dedupeKey: fact.key,
              provenance: { _tag: "system" },
              factKeys: [fact.key],
              ...(needsJudgement([fact]) ? { strong: true } : {}),
            }),
          )
          .pipe(
            Effect.as(true),
            Effect.catchTags({
              KinEventQueueUnknownAgent: () => Effect.succeed(false),
              KinEventQueueRetiredAgent: () => Effect.succeed(false),
            }),
          );
        if (!enqueued) continue;
        yield* sql`UPDATE kin_pulse_facts SET woke_at = ${at}
          WHERE org_id = ${orgId} AND fact_key = ${fact.key}`;
        woken.push(fact.key);
      }
      if (moved > 0) yield* refreshes.touch(orgId, "pulse");
      return { facts: facts.length, cleared: cleared.length, woken };
    }),
  );
});

/** Someone has a fact in hand, or says it is not a problem; `undo` takes that back. */
export const handle = Effect.fn("KinPulse.handle")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly viewer: Viewer;
  readonly by: KinWorkPrincipal;
  readonly factKey: string;
  readonly action: KinPulseHandleAction;
  readonly until?: number | undefined;
  readonly note?: string | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  const visible = yield* visibleTo(orgId, input.viewer, yield* sense(orgId, at));
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
      else
        yield* sql`UPDATE kin_pulse_facts SET handled_by_kind = ${byKind},
            handled_by_id = ${byId}, handled_at = ${at}, handled_until = ${until},
            handled_note = ${input.note ?? null}
          WHERE org_id = ${orgId} AND fact_key = ${fact.key}`;
      yield* (yield* KinRefreshObserver).touch(orgId, "pulse");
    }),
  );
  const stored = yield* storedRows(orgId, [fact.key]);
  return withStored(fact, stored.get(fact.key), at, {
    viewer: input.viewer,
    level: yield* ownerLevelPeople(orgId),
  });
});

/**
 * Every 15 minutes, and within seconds of a change to an org's entries, each org's pulse runs on
 * the shared scheduler beside the watchdogs.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ticks = yield* Scheduler.Scheduler;
    const queue = yield* KinEventQueue.KinEventQueue;
    const refreshes = yield* KinRefreshObserver;
    const last = new Map<string, { readonly at: number; readonly seq: number }>();
    const outside = Option.match(yield* Effect.serviceOption(KinConnections), {
      onNone: () => noOutside,
      onSome: (connections) => fromConnections(connections, sql),
    });
    const polled = new Map<string, number>();
    // Mail and calendar between check-ins: metadata reads with no model, waking only on a match.
    yield* ticks.register(
      "kin-pulse-outside",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // Scheduler maintenance: orgs with a live mail connection; each poll is org-scoped.
        const orgs = yield* sql<{ orgId: string }>`SELECT DISTINCT org_id AS "orgId"
          FROM kin_connections WHERE preset IN ${sql.in(MAIL_PRESETS)} AND removed_at IS NULL
            AND paused_at IS NULL AND state = 'active'
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
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // Scheduler maintenance scans organizations; the pulse below is org-scoped.
        const orgs = yield* sql<{ orgId: string; seq: number | null }>`SELECT o.org_id AS "orgId",
            (SELECT MAX(c.seq) FROM kin_record_changes c WHERE c.org_id = o.org_id) AS seq
          FROM kin_orgs o ORDER BY o.org_id`.pipe(NodeSqliteClient.readOnly);
        for (const { orgId, seq } of orgs) {
          const seen = last.get(orgId);
          if (seen !== undefined && seen.seq === (seq ?? 0) && now - seen.at < TICK_EVERY_MS)
            continue;
          last.set(orgId, { at: now, seq: seq ?? 0 });
          yield* tick(KinOrgId.make(orgId), now).pipe(
            Effect.provideService(KinEventQueue.KinEventQueue, queue),
            Effect.provideService(KinRefreshObserver, refreshes),
            Effect.catch((cause) => Effect.logWarning("Kin pulse failed", { orgId, cause })),
          );
        }
      }).pipe(Effect.catch((cause) => Effect.logWarning("Kin pulse scan failed", { cause }))),
    );
  }),
);
