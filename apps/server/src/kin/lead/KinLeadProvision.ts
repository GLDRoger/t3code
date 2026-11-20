import {
  KinAgentId,
  KinRecordKey,
  KinRecordState,
  KinChatId,
  KinLead,
  KinLeadCharter,
  KinLeadDomain,
  KinLeadIntro,
  type KinLeadAccessResult,
  type KinLeadContact,
  type KinLeadProfile,
  type KinReachListResult,
  type KinReachParty,
  KIN_LEAD_TRACKING_CAP,
  KinLeadTracking,
  KinOrgId,
  KinPersonId,
  KinRoleTags,
  type ModelSelection,
  type ProjectId,
  type TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import { ServerSettingsService, layer as serverSettingsLayer } from "../../serverSettings.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as ChatService from "../chat/KinChatService.ts";
import { KinIdentity, KinIdentityConfig, type PersonIdentity } from "../chat/KinIdentity.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KinPresence, syncQueued } from "../reply/KinPresence.ts";
import {
  isOwnerHimself,
  mayActAsOwner,
  ownerLevel,
  ownerLevelSql,
  ownsAgent,
} from "../people/KinAccess.ts";
import { closeDirect, setPeoplePair } from "./directClose.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import * as KinLevels from "./KinLevels.ts";
import { KinStop } from "./KinStop.ts";
import * as Retirement from "./Retirement.ts";
import * as LeadAccess from "./LeadAccess.ts";
import * as Reach from "./Reach.ts";
import {
  companyDefaultModel,
  encodeLeadModel,
  isDevServer,
  leadModelProblem,
  leadProviderProblem,
} from "./leadModels.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";

// `create`, `retire` and `restore` have two callers: the host's `kin lead` CLI and the owner's
// RPCs. `profiles`, `contacts` and `update` back `kin.leads.list` and `kin.lead.update`; `access`,
// `allow` and `disallow` back `kin.lead.access.*`. The rest is CLI only. No MCP tool or agent
// reaches any of it.

export class KinLeadProvisionError extends Schema.TaggedError<KinLeadProvisionError>()(
  "KinLeadProvisionError",
  {
    reason: Schema.Literals([
      "not_owner",
      "unknown_project",
      "no_models",
      "not_found",
      "retired",
      "conflict",
      "not_claude",
      // The owner would be left with no agent to talk to.
      "last_agent",
    ]),
    message: Schema.String,
  },
) {
  // The CLI prints the message; a refusal is an answer, not a crash.
  override readonly [Runtime.errorReported] = false;
}

/** Who is creating the lead; the lead belongs to them and its authority comes from them. */
export type LeadCreator =
  | { readonly _tag: "session"; readonly session: AuthenticatedSession }
  | { readonly _tag: "person"; readonly personId: KinPersonId };
/** Who retires or restores one: a person, or the host's own command, which acts as its owner. */
export type LeadActor = LeadCreator | { readonly _tag: "host" };

export const LeadSummary = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: Schema.String,
  domain: KinLeadDomain,
  charter: KinLeadCharter,
  intro: KinLeadIntro,
  roleTags: Schema.fromJsonString(KinRoleTags),
  level: KinLead.fields.level,
  ownerPersonId: KinPersonId,
  createdByPersonId: Schema.NullOr(KinPersonId),
  ownerChatId: KinChatId,
  model: Schema.fromJsonString(KinLead.fields.model),
  workerProjects: Schema.fromJsonString(KinLead.fields.workerProjects),
  retiredAt: Schema.NullOr(Schema.String),
  retiredByPersonId: Schema.NullOr(KinPersonId),
  pausedAt: Schema.NullOr(Schema.String),
});
export type LeadSummary = typeof LeadSummary.Type;
const decodeLeads = Schema.decodeUnknownEffect(Schema.Array(LeadSummary));
const encodeProjects = Schema.encodeEffect(Schema.fromJsonString(KinLead.fields.workerProjects));
const encodeRoleTags = Schema.encodeEffect(Schema.fromJsonString(KinRoleTags));

export interface CreateLeadInput {
  readonly creator: LeadCreator;
  readonly name: typeof TrimmedNonEmptyString.Type;
  readonly domain: KinLeadDomain;
  readonly charter: KinLeadCharter;
  readonly intro?: KinLeadIntro | undefined;
  /** Omitted: the company default, else the org's first live lead's. */
  readonly model?: ModelSelection | undefined;
  readonly workerProjects: ReadonlyArray<ProjectId>;
}

const refuse = (reason: KinLeadProvisionError["reason"], message: string) =>
  new KinLeadProvisionError({ reason, message });

const transaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  operation: string,
  effect: Effect.Effect<A, E, R>,
) =>
  sql
    .withTransaction(effect)
    .pipe(
      Effect.catchIf(SqlError.isSqlError, (cause) =>
        Effect.fail(toPersistenceSqlError(operation)(cause)),
      ),
    );

const leadsChanged = Effect.fn("KinLeadProvision.leadsChanged")(function* (orgId: KinOrgId) {
  yield* (yield* KinRefreshObserver).touch(orgId, "leads");
});

export const leadsIn = Effect.fn("KinLeadProvision.leadsIn")(function* (
  orgId: KinOrgId,
  options: { readonly liveOnly: boolean; readonly agentId?: KinAgentId },
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT l.org_id AS "orgId", l.agent_id AS "agentId", l.name, l.domain,
      l.charter, l.public_intro AS intro, l.role_tags_json AS "roleTags", l.level, a.owner_person_id AS "ownerPersonId",
      l.created_by_person_id AS "createdByPersonId", l.owner_chat_id AS "ownerChatId",
      l.models_json AS model, l.worker_projects_json AS "workerProjects", a.retired_at AS "retiredAt",
      a.retired_by_person_id AS "retiredByPersonId", a.paused_at AS "pausedAt"
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${orgId} AND a.role = 'lead'
      ${options.liveOnly ? sql`AND a.retired_at IS NULL` : sql``}
      ${options.agentId === undefined ? sql`` : sql`AND l.agent_id = ${options.agentId}`}
    ORDER BY a.created_at, l.agent_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.leadsIn")),
  );
  return yield* decodeLeads(rows).pipe(
    Effect.mapError(toPersistenceDecodeError("KinLeadProvision.leadsIn")),
  );
});

/** The deduplicated projects, refused unless each is a live project on this host. */
const knownProjects = Effect.fn("KinLeadProvision.knownProjects")(function* (
  workerProjects: ReadonlyArray<ProjectId>,
) {
  const sql = yield* SqlClient.SqlClient;
  const projects = [...new Set(workerProjects)];
  if (projects.length === 0) return projects;
  const found = yield* sql<{ projectId: string }>`SELECT project_id AS "projectId"
      FROM projection_projects
      WHERE project_id IN ${sql.in(projects)} AND deleted_at IS NULL ORDER BY project_id`;
  const missing = projects.filter((id) => !found.some((row) => row.projectId === id));
  if (missing.length > 0)
    return yield* refuse("unknown_project", `Unknown project: ${missing.join(", ")}.`);
  return projects;
});

/** The creator, by the same mapping a paired client gets from KinIdentity. */
const creatorFor = Effect.fn("KinLeadProvision.creatorFor")(function* (creator: LeadCreator) {
  const identity = yield* KinIdentity;
  if (creator._tag === "session") {
    const [person] = yield* identity.resolve(creator.session);
    if (person === undefined)
      return yield* refuse(
        "not_owner",
        "That session doesn't map to the Kin owner. Pair a client with the standard scopes, or pass --person.",
      );
    return person;
  }
  return { _tag: "person", orgId: identity.owner.orgId, personId: creator.personId } as const;
});

/**
 * Who may create a lead: the owner or a co-owner. A co-owner's lead is the company's, owned by the
 * owner like every other; members will create their own, capped at theirs, through this check.
 */
const mayCreate = Effect.fn("KinLeadProvision.mayCreate")(function* (person: PersonIdentity) {
  const { owner } = yield* KinIdentity;
  if (
    person.orgId === owner.orgId &&
    (yield* ownerLevel(person.orgId, person.personId).pipe(Effect.orElseSucceed(() => false)))
  )
    return;
  return yield* refuse(
    "not_owner",
    `Person ${person.personId} isn't owner-level in Kin org ${owner.orgId}. Only the owner or a co-owner can create agents.`,
  );
});

/** The org's co-owners, from their stored kind. */
export const coOwners = Effect.fn("KinLeadProvision.coOwners")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: KinPersonId }>`SELECT person_id AS "personId"
    FROM kin_people WHERE org_id = ${orgId} AND access = 'co_owner' ORDER BY person_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.coOwners")),
  );
  return rows.map((row): PersonIdentity => ({ _tag: "person", orgId, personId: row.personId }));
});

/** The model a lead gets when none is named: the company default, else the first live lead's. */
const defaultModel = Effect.fn("KinLeadProvision.defaultModel")(function* (orgId: KinOrgId) {
  const chosen = yield* companyDefaultModel(orgId).pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.defaultModel")),
  );
  if (chosen !== null) return chosen;
  const [first] = yield* leadsIn(orgId, { liveOnly: true });
  if (first === undefined)
    return yield* refuse("no_models", "This org has no agent to copy a model from. Pass --model.");
  return first.model;
});

export const create = Effect.fn("KinLeadProvision.create")(function* (input: CreateLeadInput) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const chats = yield* ChatService.KinChatService;
  const person: PersonIdentity = yield* creatorFor(input.creator);
  yield* mayCreate(person);
  const { owner } = yield* KinIdentity;
  const { orgId } = person;
  const model = input.model ?? (yield* defaultModel(orgId));
  const wrongProvider = leadProviderProblem(
    yield* (yield* ServerSettingsService).getSettings,
    model,
    yield* isDevServer,
  );
  if (wrongProvider !== undefined) return yield* refuse("not_claude", wrongProvider);
  return yield* transaction(
    sql,
    "KinLeadProvision.create",
    Effect.gen(function* () {
      // A re-run reports the creator's live lead of that name and domain. Writable transactions
      // open with BEGIN IMMEDIATE, so this read-then-insert can't race another create.
      const same = (yield* leadsIn(orgId, { liveOnly: true })).find(
        (lead) =>
          lead.ownerPersonId === owner.personId &&
          lead.name === input.name &&
          lead.domain === input.domain,
      );
      if (same !== undefined) return { _tag: "existing" as const, lead: same };
      const projects = yield* knownProjects(input.workerProjects);
      const agentId = KinAgentId.make(`lead-${SecureRandom.uuidV4Unsafe()}`);
      const now = yield* DateTime.now;
      yield* repo.insertAgent({
        orgId,
        agentId,
        displayName: input.name,
        role: "lead",
        ownerPersonId: owner.personId,
        createdAt: DateTime.formatIso(now),
      });
      const chat = yield* chats.createDirect(owner, { orgId, agentId });
      // Every co-owner gets their own chat with it; the owner's stays his.
      for (const coOwner of yield* coOwners(orgId))
        yield* chats.createDirect(coOwner, { orgId, agentId });
      // Both were decoded by the caller, so re-encoding them can't fail.
      const modelsJson = encodeLeadModel(model);
      const workerProjects = yield* encodeProjects(projects).pipe(Effect.orDie);
      const inserted = yield* KinLevels.insertLeadAtL0({
        orgId,
        agentId,
        name: input.name,
        since: DateTime.toEpochMillis(now),
        modelsJson,
        workerProjectsJson: workerProjects,
        ownerChatId: chat.chatId,
        domain: input.domain,
        charter: input.charter,
        createdByPersonId: person.personId,
      });
      if (!inserted) return yield* refuse("conflict", `Agent ${agentId} could not be recorded.`);
      const intro = input.intro?.trim() ?? "";
      if (intro !== "")
        yield* sql`UPDATE kin_leads SET public_intro = ${intro}
          WHERE org_id = ${orgId} AND agent_id = ${agentId}`.pipe(
          Effect.mapError(toPersistenceSqlError("KinLeadProvision.create")),
        );
      const [lead] = yield* leadsIn(orgId, { liveOnly: true, agentId });
      if (lead === undefined)
        return yield* refuse("conflict", `Agent ${agentId} could not be recorded.`);
      yield* leadsChanged(orgId);
      return { _tag: "created" as const, lead };
    }),
  );
});

export const list = Effect.fn("KinLeadProvision.list")(function* () {
  const identity = yield* KinIdentity;
  return yield* leadsIn(identity.owner.orgId, { liveOnly: false });
});

interface LeadChange {
  readonly name?: typeof TrimmedNonEmptyString.Type | undefined;
  readonly domain?: KinLeadDomain | undefined;
  readonly charter?: KinLeadCharter | undefined;
  /** What teammates see about it. The prompt doesn't read it yet. */
  readonly intro?: KinLeadIntro | undefined;
  readonly roleTags?: KinRoleTags | undefined;
  /** Checked by the caller: Claude, and offered on this host. */
  readonly model?: ModelSelection | undefined;
}

/**
 * Changes a live lead's name, domain, charter or intro inside the caller's transaction. With `ownedBy`,
 * a lead that person doesn't own reads as not found. The prompt reads all three per wake-up.
 */
const change = Effect.fn("KinLeadProvision.change")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  fields: LeadChange,
  ownedBy?: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const live = yield* leadsIn(orgId, { liveOnly: false });
  const lead = live.find((entry) => entry.agentId === agentId);
  if (lead === undefined || (ownedBy !== undefined && !ownsAgent(lead, ownedBy)))
    return yield* refuse("not_found", `Org ${orgId} has no agent ${agentId}.`);
  if (lead.retiredAt !== null)
    return yield* refuse("retired", `Agent ${agentId} was retired at ${lead.retiredAt}.`);
  const next = {
    name: fields.name ?? lead.name,
    domain: fields.domain ?? lead.domain,
    charter: fields.charter ?? lead.charter,
    intro: fields.intro?.trim() ?? lead.intro,
    roleTags: fields.roleTags === undefined ? lead.roleTags : [...new Set(fields.roleTags)],
  };
  // `create` treats a live lead with the same owner, name and domain as the same lead.
  const twin = live.find(
    (entry) =>
      entry.agentId !== agentId &&
      entry.retiredAt === null &&
      entry.ownerPersonId === lead.ownerPersonId &&
      entry.name === next.name &&
      entry.domain === next.domain,
  );
  if (twin !== undefined)
    return yield* refuse(
      "conflict",
      `Another agent is already called ${next.name} in ${next.domain}.`,
    );
  const roleTags = yield* encodeRoleTags(next.roleTags).pipe(Effect.orDie);
  const changed = yield* sql`UPDATE kin_leads SET name = ${next.name}, domain = ${next.domain},
      charter = ${next.charter}, public_intro = ${next.intro}, role_tags_json = ${roleTags}
    WHERE org_id = ${orgId} AND agent_id = ${agentId} RETURNING agent_id`;
  if (changed.length === 0)
    return yield* refuse("conflict", `Agent ${agentId} changed while updating.`);
  // The runner reads the row at each wake-up, so the next turn runs on it.
  if (fields.model !== undefined)
    yield* sql`UPDATE kin_leads SET models_json = ${encodeLeadModel(fields.model)}
      WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
  // Chats show the agent's name, so both rows carry it.
  yield* sql`UPDATE kin_agents SET display_name = ${next.name}
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND role = 'lead' RETURNING agent_id`;
  yield* leadsChanged(orgId);
  return {
    ...lead,
    ...next,
    ...(fields.model === undefined ? {} : { model: fields.model }),
  };
});

/** Refuses a model a turn here couldn't run on: not Claude, switched off, or not offered. */
export const checkModel = Effect.fn("KinLeadProvision.checkModel")(function* (
  model: ModelSelection,
) {
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  const problem = leadModelProblem(
    yield* (yield* ServerSettingsService).getSettings,
    Option.isSome(registry) ? yield* registry.value.getProviders : null,
    model,
    yield* isDevServer,
  );
  if (problem !== undefined) return yield* refuse("not_claude", problem);
});

/** Replaces a live lead's domain or charter, from the host's CLI. */
export const setCharter = Effect.fn("KinLeadProvision.setCharter")(function* (
  agentId: KinAgentId,
  fields: Pick<LeadChange, "domain" | "charter">,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId } = (yield* KinIdentity).owner;
  const lead = yield* transaction(
    sql,
    "KinLeadProvision.setCharter",
    change(orgId, agentId, fields),
  );
  return { _tag: "updated" as const, lead };
});

const TrackedRow = Schema.Struct({
  kind: KinLeadTracking.fields.kind,
  title: Schema.String,
  dueAt: Schema.NullOr(Schema.Number),
  chatId: Schema.NullOr(KinChatId),
  agentId: Schema.NullOr(KinAgentId),
  key: Schema.NullOr(KinRecordKey),
  state: Schema.NullOr(KinRecordState),
  dueAllDay: Schema.Number,
  waitingOnKind: Schema.NullOr(Schema.Literals(["person", "agent"])),
  waitingOnId: Schema.NullOr(Schema.String),
});
const decodeTracked = Schema.decodeUnknownEffect(Schema.Array(TrackedRow));

/**
 * What each lead has in hand, from stored rows: its open Work, the deferrals still waiting to
 * come due and the scheduled tasks still on. A deferral belongs to its chat's first-joined
 * lead, the one the trigger wakes for it (`orgLeads.liveLead`); a native schedule to its row's.
 */
const tracked = Effect.fn("KinLeadProvision.tracked")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const firstLead = sql`(SELECT m.agent_id FROM kin_chat_members m
      JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
        AND a.role = 'lead' AND a.retired_at IS NULL
      WHERE m.org_id = w.org_id AND m.chat_id = w.chat_id AND m.principal_kind = 'agent'
        AND m.left_at IS NULL
      ORDER BY m.joined_at, m.agent_id LIMIT 1)`;
  // Its open Work entries, then its alarms.
  const rows = yield* sql`
    SELECT 'work' AS kind, e.title, e.due_at AS "dueAt", e.source_chat_id AS "chatId",
      e.owner_id AS "agentId",
      CASE e.state WHEN 'doing' THEN 0 WHEN 'waiting' THEN 0 ELSE 1 END AS rank,
      COALESCE(e.due_at, e.updated_at) AS at, e.key, e.state, e.due_all_day AS "dueAllDay",
      CASE WHEN e.state = 'waiting' THEN e.waiting_on_kind END AS "waitingOnKind",
      CASE WHEN e.state = 'waiting' THEN e.waiting_on_id END AS "waitingOnId"
    FROM kin_records e WHERE e.org_id = ${orgId} AND e.register_id = 'work'
      AND e.owner_kind = 'agent' AND e.state NOT IN ('done', 'dropped')
    UNION ALL
    SELECT CASE r.on_due WHEN 'remind' THEN 'reminder' ELSE 'follow_up' END,
      COALESCE(json_extract(w.state_json, '$.title'), ''), COALESCE(f.next_run_at, r.due_at),
      w.chat_id, ${firstLead}, 2, COALESCE(f.next_run_at, r.due_at, r.updated_at), NULL, NULL, 0,
      NULL, NULL
    FROM kin_deferral_runs r
    JOIN kin_widgets w ON w.org_id = r.org_id
      AND w.widget_id = 'deferral:' || r.org_id || ':' || r.item_id
    LEFT JOIN kin_triggers f ON f.org_id = r.org_id
      AND f.trigger_id = 'deferral:' || r.item_id || ':due' AND f.enabled = 1
    WHERE r.org_id = ${orgId} AND (r.state = 'asked'
      OR (r.state IN ('armed', 'heads_up', 'grace', 'snoozed') AND f.next_run_at IS NOT NULL))
    UNION ALL
    SELECT 'scheduled', COALESCE(json_extract(w.state_json, '$.title'), ''), NULL, w.chat_id,
      ${firstLead}, 3, t.updated_at, NULL, NULL, 0, NULL, NULL
    FROM kin_scheduled_tasks t
    JOIN kin_widgets w ON w.org_id = t.org_id
      AND w.widget_id = 'scheduled:' || t.org_id || ':' || t.item_id
    JOIN kin_triggers f ON f.org_id = t.org_id
      AND f.trigger_id = 'schedule:' || t.item_id AND f.enabled = 1 AND f.next_run_at IS NOT NULL
    WHERE t.org_id = ${orgId} AND t.state = 'active' AND t.paused = 0
    UNION ALL
    SELECT 'scheduled', n.title, NULL, COALESCE(w.chat_id, s.chat_id), s.agent_id, 3, s.updated_at,
      NULL, NULL, 0, NULL, NULL
    FROM kin_schedules s
    JOIN scheduled_tasks n ON n.task_id = s.task_id AND n.enabled = 1
    LEFT JOIN kin_widgets w ON w.org_id = s.org_id
      AND w.widget_id = 'scheduled:' || s.org_id || ':' || s.schedule_id
    WHERE s.org_id = ${orgId} AND s.deleted_at IS NULL AND COALESCE(s.pending_enabled, 1) = 1
    ORDER BY rank, at, title`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.tracked")),
  );
  return yield* decodeTracked(rows).pipe(
    Effect.mapError(toPersistenceDecodeError("KinLeadProvision.tracked")),
  );
});

const profileOf = (
  lead: LeadSummary,
  working: ReadonlySet<string>,
  items: Effect.Success<ReturnType<typeof tracked>>,
): KinLeadProfile => ({
  orgId: lead.orgId,
  agentId: lead.agentId,
  name: lead.name as KinLeadProfile["name"],
  domain: lead.domain,
  charter: lead.charter,
  intro: lead.intro,
  roleTags: lead.roleTags,
  model: lead.model.model,
  ownerChatId: lead.ownerChatId,
  working: working.has(lead.agentId),
  tracking: items
    .filter((item) => item.agentId === lead.agentId && item.title.trim() !== "")
    .slice(0, KIN_LEAD_TRACKING_CAP)
    .map((item): KinLeadTracking => ({
      kind: item.kind,
      title: item.title.slice(0, 280),
      ...(item.dueAt === null
        ? {}
        : { dueAt: DateTime.formatIso(DateTime.makeUnsafe(item.dueAt)) }),
      ...(item.dueAllDay === 1 ? { dueAllDay: true } : {}),
      chatId: item.chatId,
      ...(item.key === null ? {} : { key: item.key }),
      ...(item.state === null ? {} : { state: item.state }),
      ...(item.waitingOnKind === null || item.waitingOnId === null
        ? {}
        : {
            waitingOn:
              item.waitingOnKind === "agent"
                ? { _tag: "agent" as const, agentId: KinAgentId.make(item.waitingOnId) }
                : { _tag: "person" as const, personId: KinPersonId.make(item.waitingOnId) },
          }),
    })),
  ...(lead.pausedAt === null
    ? {}
    : { paused: { at: DateTime.formatIso(DateTime.makeUnsafe(lead.pausedAt)) } }),
  ...(lead.retiredAt === null
    ? {}
    : {
        retired: {
          at: DateTime.formatIso(DateTime.makeUnsafe(lead.retiredAt)),
          byPersonId: lead.retiredByPersonId,
        },
      }),
});

/**
 * The person's own live leads, oldest first, then with `includeRetired` their retired ones; only
 * the org's owner sees retired leads, and anyone else's ask is ignored. Someone with none, such as
 * a teammate, gets none. Plain reads, outside a transaction, so a client's list never holds the
 * writer's lock.
 */
export const profiles = Effect.fn("KinLeadProvision.profiles")(function* (
  person: PersonIdentity,
  options: { readonly includeRetired?: boolean | undefined } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const { owner } = yield* KinIdentity;
  // A co-owner sees the company's leads as the owner does, each opening their own chat with it.
  const coOwner =
    person.orgId === owner.orgId &&
    !isOwnerHimself(owner, person.personId) &&
    (yield* ownerLevel(person.orgId, person.personId).pipe(Effect.orElseSucceed(() => false)));
  const includeRetired =
    options.includeRetired === true &&
    person.orgId === owner.orgId &&
    (isOwnerHimself(owner, person.personId) || coOwner);
  const chatsOf = coOwner
    ? new Map(
        (yield* sql<{ agentId: string; chatId: KinChatId }>`SELECT l.agent_id AS "agentId",
            c.chat_id AS "chatId" FROM kin_leads l
          JOIN kin_chats c ON c.org_id = l.org_id AND c.kind = 'direct'
            AND c.direct_key = ${person.personId} || ':' || l.agent_id
          WHERE l.org_id = ${person.orgId} ORDER BY l.agent_id`.pipe(
          Effect.mapError(toPersistenceSqlError("KinLeadProvision.profiles")),
        )).map((row) => [row.agentId, row.chatId]),
      )
    : undefined;
  const own = (yield* leadsIn(person.orgId, { liveOnly: !includeRetired })).flatMap((lead) => {
    if (chatsOf === undefined) return ownsAgent(lead, person.personId) ? [lead] : [];
    const chatId = chatsOf.get(lead.agentId);
    return lead.ownerPersonId === owner.personId && chatId !== undefined
      ? [{ ...lead, ownerChatId: chatId }]
      : [];
  });
  const leads = [
    ...own.filter((lead) => lead.retiredAt === null),
    ...own.filter((lead) => lead.retiredAt !== null),
  ];
  if (leads.length === 0) return [];
  const running = yield* sql<{ agentId: string }>`SELECT agent_id AS "agentId" FROM kin_wakeups
    WHERE org_id = ${person.orgId} AND status = 'running' ORDER BY agent_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.profiles")),
  );
  const working = new Set(running.map((row) => row.agentId));
  const items = yield* tracked(person.orgId);
  return leads.map((lead) => profileOf(lead, working, items));
});

/**
 * The owner changes what one of their leads is called and what it is for. Owner only, like
 * `create`; another person's lead, or another org's, reads as not found.
 */
export const update = Effect.fn("KinLeadProvision.update")(function* (input: {
  readonly editor: LeadCreator;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly fields: LeadChange;
}) {
  const sql = yield* SqlClient.SqlClient;
  const person: PersonIdentity = yield* creatorFor(input.editor);
  yield* mayCreate(person);
  if (person.orgId !== input.orgId)
    return yield* refuse("not_found", `Org ${input.orgId} has no agent ${input.agentId}.`);
  if (input.fields.model !== undefined) yield* checkModel(input.fields.model);
  return yield* transaction(
    sql,
    "KinLeadProvision.update",
    Effect.gen(function* () {
      const { owner } = yield* KinIdentity;
      return yield* profileIn(
        yield* change(person.orgId, input.agentId, input.fields, owner.personId),
      );
    }),
  );
});

/** One lead's profile, read inside the caller's transaction. */
export const profileIn = Effect.fn("KinLeadProvision.profileIn")(function* (lead: LeadSummary) {
  const sql = yield* SqlClient.SqlClient;
  const running = yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${lead.orgId}
    AND agent_id = ${lead.agentId} AND status = 'running' ORDER BY wakeup_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.profileIn")),
  );
  return profileOf(
    lead,
    new Set(running.length > 0 ? [lead.agentId] : []),
    yield* tracked(lead.orgId),
  );
});

/**
 * The lead a person may retire or restore, by the authority that may make it: the owner or a
 * co-owner, any of the org's; its creator, their own once members may create (`mayCreate`);
 * anyone else's reads as not found. The host's command acts as the owner. Inside the transaction.
 */
export const retirable = Effect.fn("KinLeadProvision.retirable")(function* (input: {
  readonly by: LeadActor;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const { owner } = yield* KinIdentity;
  const missing = refuse("not_found", `Org ${input.orgId} has no agent ${input.agentId}.`);
  const person: PersonIdentity | undefined =
    input.by._tag === "host" ? undefined : yield* creatorFor(input.by);
  const orgId = person?.orgId ?? owner.orgId;
  if (orgId !== input.orgId) return yield* missing;
  const [lead] = yield* leadsIn(orgId, { liveOnly: false, agentId: input.agentId });
  if (lead === undefined) return yield* missing;
  const ownerTier =
    person === undefined ||
    (yield* mayActAsOwner(person.orgId, person.personId, owner).pipe(
      Effect.orElseSucceed(() => false),
    ));
  if (person !== undefined && !ownerTier) {
    if (!ownsAgent(lead, person.personId)) return yield* missing;
    yield* mayCreate(person);
  }
  return { lead, by: person?.personId ?? null };
});

/**
 * Retires a lead. It is not deleted: its chats, history, memory and Work stay, and `restore`
 * brings it back. In one transaction: no turn of it runs again, what it has in flight stops or
 * waits (`Retirement.retire`), and after commit its running turns are stopped. The owner keeps a
 * live lead of their own, and teammates the team agent's successor, so someone always answers.
 */
export const retire = Effect.fn("KinLeadProvision.retire")(function* (input: {
  readonly by: LeadActor;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  /** Required when it is the team agent: who teammates talk to instead. */
  readonly nextTeamAgentId?: KinAgentId | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const chats = yield* ChatService.KinChatService;
  const stop = yield* Effect.serviceOption(KinStop);
  const queue = yield* Effect.serviceOption(KinEventQueue);
  const presence = yield* Effect.serviceOption(KinPresence);
  return yield* transaction(
    sql,
    "KinLeadProvision.retire",
    Effect.gen(function* () {
      const { lead, by } = yield* retirable(input);
      if (lead.retiredAt !== null)
        return { _tag: "already_retired" as const, lead, profile: yield* profileIn(lead) };
      const { owner } = yield* KinIdentity;
      const others = (yield* leadsIn(lead.orgId, { liveOnly: true })).filter(
        (entry) => entry.agentId !== lead.agentId && entry.ownerPersonId === owner.personId,
      );
      if (lead.ownerPersonId === owner.personId && others.length === 0)
        return yield* refuse(
          "last_agent",
          `${lead.name} is your only agent. Create another before retiring it.`,
        );
      const team = yield* LeadAccess.teamAgent(lead.orgId).pipe(
        Effect.mapError(toPersistenceSqlError("KinLeadProvision.retire")),
      );
      if (team === lead.agentId) {
        const live = yield* leadsIn(lead.orgId, { liveOnly: true });
        if (input.nextTeamAgentId === undefined)
          return yield* refuse(
            "conflict",
            `${lead.name} is the team agent, so teammates talk to it. Choose who they should talk to instead, then retire it.`,
          );
        const next = live.find(
          (entry) => entry.agentId === input.nextTeamAgentId && entry.agentId !== lead.agentId,
        );
        if (next === undefined)
          return yield* refuse(
            "not_found",
            `The team needs an active agent other than ${lead.name} to talk to instead.`,
          );
        yield* switchTeamAgent(lead.orgId, by ?? owner.personId, next);
      }
      const now = yield* DateTime.now;
      const retiredAt = DateTime.formatIso(now);
      const changed = yield* sql`UPDATE kin_agents
          SET retired_at = ${retiredAt}, retired_by_person_id = ${by}
          WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId} AND role = 'lead'
            AND retired_at IS NULL
          RETURNING agent_id`;
      if (changed.length === 0)
        return yield* refuse("conflict", `Agent ${lead.agentId} changed while retiring.`);
      yield* leadsChanged(lead.orgId);
      const stopped = yield* Retirement.retire(
        { orgId: lead.orgId, agentId: lead.agentId, retiredAt, now: DateTime.toEpochMillis(now) },
        chats,
      );
      const after = Effect.gen(function* () {
        if (Option.isSome(stop) && stopped.turns.length > 0)
          yield* stop.value.abortTurns(lead.orgId, stopped.turns);
        // Wakes the runner, which ends its thread.
        if (Option.isSome(queue))
          yield* queue.value
            .expireAgent(lead.orgId, lead.agentId)
            .pipe(Effect.catchCause((cause) => Effect.logWarning("Kin retire wake failed", cause)));
        if (Option.isSome(presence))
          yield* syncQueued(presence.value, lead.orgId, lead.agentId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchCause((cause) => Effect.logWarning("Kin retire line failed", cause)),
          );
      });
      yield* sql.afterCommit(after);
      const retired = { ...lead, retiredAt, retiredByPersonId: by };
      return { _tag: "retired" as const, lead: retired, profile: yield* profileIn(retired) };
    }),
  );
});

/**
 * Brings a retired lead back as it was: its chats, level, access and Work, and the timers and
 * schedules retiring paused. Its next turn starts a fresh thread. Events that expired stay
 * expired. Refused while another live lead has its name and domain.
 */
export const restore = Effect.fn("KinLeadProvision.restore")(function* (input: {
  readonly by: LeadActor;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* transaction(
    sql,
    "KinLeadProvision.restore",
    Effect.gen(function* () {
      const { lead } = yield* retirable(input);
      if (lead.retiredAt === null)
        return { _tag: "already_live" as const, lead, profile: yield* profileIn(lead) };
      const twin = (yield* leadsIn(lead.orgId, { liveOnly: true })).find(
        (entry) =>
          entry.ownerPersonId === lead.ownerPersonId &&
          entry.name === lead.name &&
          entry.domain === lead.domain,
      );
      if (twin !== undefined)
        return yield* refuse(
          "conflict",
          `Another agent is already called ${lead.name} in ${lead.domain}.`,
        );
      const changed = yield* sql`UPDATE kin_agents
          SET retired_at = NULL, retired_by_person_id = NULL
          WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId} AND role = 'lead'
            AND retired_at IS NOT NULL
          RETURNING agent_id`;
      if (changed.length === 0)
        return yield* refuse("conflict", `Agent ${lead.agentId} changed while restoring.`);
      yield* leadsChanged(lead.orgId);
      yield* Retirement.restore({
        orgId: lead.orgId,
        agentId: lead.agentId,
        retiredAt: lead.retiredAt,
        now: DateTime.toEpochMillis(yield* DateTime.now),
      });
      const restored = { ...lead, retiredAt: null, retiredByPersonId: null };
      return { _tag: "restored" as const, lead: restored, profile: yield* profileIn(restored) };
    }),
  );
});

/** The host's `kin lead retire` and `restore`: the same methods, acting as the host's owner. */
export const retireOnHost = Effect.fn("KinLeadProvision.retireOnHost")(function* (
  agentId: KinAgentId,
) {
  const { owner } = yield* KinIdentity;
  return yield* retire({ by: { _tag: "host" }, orgId: owner.orgId, agentId });
});
export const restoreOnHost = Effect.fn("KinLeadProvision.restoreOnHost")(function* (
  agentId: KinAgentId,
) {
  const { owner } = yield* KinIdentity;
  return yield* restore({ by: { _tag: "host" }, orgId: owner.orgId, agentId });
});

/**
 * Pauses or resumes one live agent. Paused, nothing new wakes it: what reaches it waits in its
 * queue, and a reply already under way still lands. Resuming lets the runner take what waited.
 */
export const setPaused = Effect.fn("KinLeadProvision.setPaused")(function* (input: {
  readonly by: LeadActor;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly paused: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* Effect.serviceOption(KinEventQueue);
  return yield* transaction(
    sql,
    "KinLeadProvision.setPaused",
    Effect.gen(function* () {
      const { lead } = yield* retirable(input);
      if (lead.retiredAt !== null)
        return yield* refuse("retired", `Agent ${lead.agentId} was retired at ${lead.retiredAt}.`);
      if ((lead.pausedAt !== null) === input.paused) return yield* profileIn(lead);
      const pausedAt = input.paused ? DateTime.formatIso(yield* DateTime.now) : null;
      yield* sql`UPDATE kin_agents SET paused_at = ${pausedAt}
        WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}`.pipe(
        Effect.mapError(toPersistenceSqlError("KinLeadProvision.setPaused")),
      );
      yield* leadsChanged(lead.orgId);
      if (!input.paused && Option.isSome(queue))
        yield* sql.afterCommit(queue.value.nudge(lead.orgId));
      return yield* profileIn({ ...lead, pausedAt });
    }),
  );
});

/** The model new agents start on, for owner-level people; null until one is chosen. */
export const agentDefaults = Effect.fn("KinLeadProvision.agentDefaults")(function* (
  editor: LeadCreator,
  orgId: KinOrgId,
) {
  const person: PersonIdentity = yield* creatorFor(editor);
  yield* mayCreate(person);
  if (person.orgId !== orgId) return yield* refuse("not_found", `No org ${orgId}.`);
  const model = yield* companyDefaultModel(orgId).pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.agentDefaults")),
  );
  if (model !== null) return { orgId, model, chosen: true };
  const [first] = yield* leadsIn(orgId, { liveOnly: true });
  return { orgId, model: first?.model ?? null, chosen: false };
});

export const setAgentDefaults = Effect.fn("KinLeadProvision.setAgentDefaults")(function* (
  editor: LeadCreator,
  orgId: KinOrgId,
  model: ModelSelection,
) {
  const sql = yield* SqlClient.SqlClient;
  const person: PersonIdentity = yield* creatorFor(editor);
  yield* mayCreate(person);
  if (person.orgId !== orgId) return yield* refuse("not_found", `No org ${orgId}.`);
  yield* checkModel(model);
  const json = encodeLeadModel(model);
  yield* sql`INSERT INTO kin_agent_defaults (org_id, models_json) VALUES (${orgId}, ${json})
    ON CONFLICT (org_id) DO UPDATE SET models_json = excluded.models_json`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.setAgentDefaults")),
  );
  yield* leadsChanged(orgId);
  return { orgId, model, chosen: true };
});

/** The caller as the org's owner and the live lead of theirs being shared; anything else is refused. */
const ownedLead = Effect.fn("KinLeadProvision.ownedLead")(function* (input: {
  readonly editor: LeadCreator;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const person: PersonIdentity = yield* creatorFor(input.editor);
  yield* mayCreate(person);
  const missing = refuse("not_found", `Org ${input.orgId} has no agent ${input.agentId}.`);
  if (person.orgId !== input.orgId) return yield* missing;
  const [lead] = yield* leadsIn(person.orgId, { liveOnly: true, agentId: input.agentId });
  const { owner } = yield* KinIdentity;
  if (lead === undefined || lead.ownerPersonId !== owner.personId) return yield* missing;
  return { person, lead };
});

/**
 * The teammates who may message the agent now, since they were added or last let back. Owners
 * and co-owners message every agent and are never restricted, so they aren't listed.
 */
const accessRows = Effect.fn("KinLeadProvision.accessRows")(function* (lead: LeadSummary) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    personId: KinPersonId;
    displayName: string;
    createdAt: string;
    lifted: number | null;
    ownerLevel: number;
  }>`
    SELECT p.person_id AS "personId", p.display_name AS "displayName", p.created_at AS "createdAt",
      (SELECT MAX(rl.lifted_at) FROM kin_reach_limits rl WHERE rl.org_id = p.org_id
        AND rl.one_kind = 'agent' AND rl.one_id = ag.agent_id AND rl.other_kind = 'person'
        AND rl.other_id = p.person_id) AS lifted,
      ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))} AS "ownerLevel"
    FROM kin_people p
    JOIN kin_agents ag ON ag.org_id = p.org_id AND ag.agent_id = ${lead.agentId}
    WHERE p.org_id = ${lead.orgId} AND p.removed_at IS NULL
      AND p.person_id IS NOT ag.owner_person_id
      AND NOT ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))}
      AND NOT ${sql.literal(Reach.restrictedSql("p.org_id", "ag.agent_id", "p.person_id"))}
    ORDER BY p.created_at, p.person_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.accessRows")),
  );
  const team = yield* LeadAccess.teamAgent(lead.orgId).pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.accessRows")),
  );
  return {
    everyone: team === lead.agentId,
    people: rows.map((row) => ({
      personId: row.personId,
      displayName: row.displayName as KinLeadAccessResult["people"][number]["displayName"],
      since:
        row.lifted === null ? row.createdAt : DateTime.formatIso(DateTime.makeUnsafe(row.lifted)),
      ownerLevel: row.ownerLevel === 1,
    })),
  } satisfies KinLeadAccessResult;
});

/** Who besides the owner may message one of the owner's leads. Owner only, like `update`. */
export const access = Effect.fn("KinLeadProvision.access")(function* (
  input: Parameters<typeof ownedLead>[0],
) {
  const { lead } = yield* ownedLead(input);
  return yield* accessRows(lead);
});

/** A refused restriction or lift, as the agent page's error: owners and co-owners conflict. */
const limitRefused = (change: Reach.LimitChange) =>
  change._tag === "refused"
    ? refuse(change.reason === "not_found" ? "not_found" : "conflict", change.message)
    : Effect.void;

/**
 * The owner lifts a restriction on a person and one of their leads (`Reach`). That person has
 * their own direct chat with it, which the owner is not in; letting them back reopens it.
 */
export const allow = Effect.fn("KinLeadProvision.allow")(function* (
  input: Parameters<typeof ownedLead>[0] & { readonly personId: KinPersonId },
) {
  const sql = yield* SqlClient.SqlClient;
  const chats = yield* ChatService.KinChatService;
  return yield* transaction(
    sql,
    "KinLeadProvision.allow",
    Effect.gen(function* () {
      const { person, lead } = yield* ownedLead(input);
      // The owner already talks to it; everyone else must be a person of this org.
      const known = yield* sql`SELECT 1 FROM kin_people
        WHERE org_id = ${lead.orgId} AND person_id = ${input.personId} LIMIT 1`.pipe(
        Effect.mapError(toPersistenceSqlError("KinLeadProvision.allow")),
      );
      if (known.length === 0 || ownsAgent(lead, input.personId))
        return yield* refuse("not_found", `Org ${lead.orgId} has no such person to allow.`);
      const change = yield* Reach.setLimit({
        orgId: lead.orgId,
        by: person.personId,
        a: Reach.person(input.personId),
        b: Reach.agent(lead.agentId),
        restricted: false,
      }).pipe(Effect.mapError(toPersistenceSqlError("KinLeadProvision.allow")));
      yield* limitRefused(change);
      if (change._tag === "changed") yield* leadsChanged(lead.orgId);
      yield* chats.createDirect(
        { _tag: "person", orgId: lead.orgId, personId: input.personId },
        { orgId: lead.orgId, agentId: lead.agentId },
      );
      return yield* accessRows(lead);
    }),
  );
});

/**
 * The owner restricts a person and one of their leads, both ways (`Reach`). Nothing they send
 * wakes it from here on and what was still waiting is dropped; a reply already under way still
 * lands. Their chat stays theirs to read but not to write in, and one they never wrote in leaves
 * their list. Owners and co-owners are never restricted.
 */
export const disallow = Effect.fn("KinLeadProvision.disallow")(function* (
  input: Parameters<typeof ownedLead>[0] & { readonly personId: KinPersonId },
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* transaction(
    sql,
    "KinLeadProvision.disallow",
    Effect.gen(function* () {
      const { person, lead } = yield* ownedLead(input);
      const change = yield* Reach.setLimit({
        orgId: lead.orgId,
        by: person.personId,
        a: Reach.person(input.personId),
        b: Reach.agent(lead.agentId),
        restricted: true,
      }).pipe(Effect.mapError(toPersistenceSqlError("KinLeadProvision.disallow")));
      yield* limitRefused(change);
      if (change._tag !== "changed") return yield* accessRows(lead);
      yield* leadsChanged(lead.orgId);
      yield* closeDirect(yield* closeDeps, lead, input.personId, null);
      return yield* accessRows(lead);
    }),
  );
});

const toReach = (party: KinReachParty): Reach.KinParty =>
  party.kind === "person" ? Reach.person(party.personId) : Reach.agent(party.agentId);
const fromReach = (kind: "agent" | "person", id: string): KinReachParty =>
  kind === "person"
    ? { kind, personId: KinPersonId.make(id) }
    : { kind, agentId: KinAgentId.make(id) };

/** The restrictions that bind now: one stored before someone became a co-owner binds no one. */
const reachRows = Effect.fn("KinLeadProvision.reachRows")(
  function* (orgId: KinOrgId) {
    const limits: Array<KinReachListResult["limits"][number]> = [];
    for (const row of yield* Reach.liveLimits(orgId)) {
      const one = fromReach(row.oneKind, row.oneId);
      const other = fromReach(row.otherKind, row.otherId);
      if ((yield* Reach.mayReach(orgId, toReach(one), toReach(other))) === "restricted")
        limits.push({
          one,
          other,
          setBy: row.setBy,
          setAt: DateTime.formatIso(DateTime.makeUnsafe(row.setAt)),
        });
    }
    return { limits } satisfies KinReachListResult;
  },
  Effect.mapError(toPersistenceSqlError("KinLeadProvision.reachRows")),
);

/** The caller, when they are an owner or co-owner of this org. */
const reachEditor = Effect.fn("KinLeadProvision.reachEditor")(function* (
  editor: LeadCreator,
  orgId: KinOrgId,
) {
  const person = yield* creatorFor(editor);
  if (
    person.orgId !== orgId ||
    !(yield* ownerLevel(person.orgId, person.personId).pipe(Effect.orElseSucceed(() => false)))
  )
    return yield* refuse("not_owner", "Only the owner or a co-owner restricts who messages whom.");
  return person;
});

/** Who may not message whom: Settings' list. Owners and co-owners only. */
export const reachList = Effect.fn("KinLeadProvision.reachList")(function* (input: {
  readonly editor: LeadCreator;
  readonly orgId: KinOrgId;
}) {
  yield* reachEditor(input.editor, input.orgId);
  return yield* reachRows(input.orgId);
});

/**
 * Restricts a pair of a person and an agent or another person, both ways, or lifts it. A person
 * and an agent go as the agent page's revoke and grant do; two people's own chat turns read-only
 * for both, and back.
 */
export const reachSet = Effect.fn("KinLeadProvision.reachSet")(function* (input: {
  readonly editor: LeadCreator;
  readonly orgId: KinOrgId;
  readonly a: KinReachParty;
  readonly b: KinReachParty;
  readonly restricted: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const chats = yield* ChatService.KinChatService;
  return yield* transaction(
    sql,
    "KinLeadProvision.reachSet",
    Effect.gen(function* () {
      const person = yield* reachEditor(input.editor, input.orgId);
      const { orgId } = input;
      const change = yield* Reach.setLimit({
        orgId,
        by: person.personId,
        a: toReach(input.a),
        b: toReach(input.b),
        restricted: input.restricted,
      }).pipe(Effect.mapError(toPersistenceSqlError("KinLeadProvision.reachSet")));
      yield* limitRefused(change);
      if (change._tag !== "changed") return yield* reachRows(orgId);
      const deps = yield* closeDeps;
      const agent = [input.a, input.b].find((one) => one.kind === "agent");
      const people = [input.a, input.b].flatMap((one) =>
        one.kind === "person" ? [one.personId] : [],
      );
      if (agent?.kind === "agent" && people[0] !== undefined) {
        const lead = { orgId, agentId: agent.agentId };
        if (input.restricted) yield* closeDirect(deps, lead, people[0], null);
        else {
          const [had] = yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${orgId}
            AND kind = 'direct' AND direct_key = ${LeadAccess.directKey(people[0], agent.agentId)}
            LIMIT 1`.pipe(Effect.mapError(toPersistenceSqlError("KinLeadProvision.reachSet")));
          if (had !== undefined)
            yield* chats.createDirect({ _tag: "person", orgId, personId: people[0] }, lead);
        }
      } else if (people[0] !== undefined && people[1] !== undefined)
        yield* setPeoplePair(
          deps,
          orgId,
          [people[0], people[1]],
          input.restricted ? "guest" : "member",
        ).pipe(Effect.mapError(toPersistenceSqlError("KinLeadProvision.reachSet")));
      yield* leadsChanged(orgId);
      return yield* reachRows(orgId);
    }),
  );
});

/** What closing a direct chat needs, read from the caller's services. */
const closeDeps = Effect.gen(function* () {
  return {
    repo: yield* Repository.KinChatRepository,
    hub: yield* Hub.KinChatHub,
    presence: yield* Effect.serviceOption(KinPresence),
  };
});

/** The members with a device that still opens Kin: who the team agent is for. */
const teammates = Effect.fn("KinLeadProvision.teammates")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  // Owner-level people have their own chat with every agent already.
  const rows = yield* sql<{ personId: KinPersonId }>`
    SELECT DISTINCT b.person_id AS "personId" FROM kin_session_bindings b
    WHERE b.org_id = ${orgId} AND b.revoked_at IS NULL
      AND NOT ${sql.literal(ownerLevelSql("b.org_id", "b.person_id"))}
    ORDER BY b.person_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.teammates")),
  );
  return rows.map((row) => row.personId);
});

/** The agent every teammate may message, or null when the owner has none. */
export const teamAgent = (orgId: KinOrgId) =>
  LeadAccess.teamAgent(orgId).pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.teamAgent")),
  );

/**
 * The owner or a co-owner picks the team agent, or none. Each teammate gets a direct chat with it,
 * reopened if they had one; their chats with the previous one stay as they were.
 */
export const setTeamAgent = Effect.fn("KinLeadProvision.setTeamAgent")(function* (input: {
  readonly editor: LeadCreator;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* transaction(
    sql,
    "KinLeadProvision.setTeamAgent",
    Effect.gen(function* () {
      const person: PersonIdentity = yield* creatorFor(input.editor);
      yield* mayCreate(person);
      if (person.orgId !== input.orgId)
        return yield* refuse("not_found", `Org ${input.orgId} has no such agent.`);
      const live = yield* leadsIn(person.orgId, { liveOnly: true });
      const next =
        input.agentId === null ? null : live.find((lead) => lead.agentId === input.agentId);
      if (next === undefined)
        return yield* refuse("not_found", `Org ${input.orgId} has no agent ${input.agentId}.`);
      return { teamAgentId: yield* switchTeamAgent(person.orgId, person.personId, next) };
    }),
  );
});

/**
 * Inside the caller's transaction: `next` (or none) becomes the team agent. Each teammate gets a
 * direct chat with it, reopened if they had one.
 */
const switchTeamAgent = Effect.fn("KinLeadProvision.switchTeamAgent")(function* (
  orgId: KinOrgId,
  setBy: KinPersonId,
  next: LeadSummary | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const chats = yield* ChatService.KinChatService;
  const sqlError = toPersistenceSqlError("KinLeadProvision.setTeamAgent");
  const previous = yield* LeadAccess.teamAgent(orgId).pipe(Effect.mapError(sqlError));
  const nextId = next?.agentId ?? null;
  if (previous === nextId) return nextId;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  yield* (
    nextId === null
      ? sql`DELETE FROM kin_team_agents WHERE org_id = ${orgId}`
      : sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
          VALUES (${orgId}, ${nextId}, ${setBy}, ${now})
          ON CONFLICT (org_id) DO UPDATE SET agent_id = excluded.agent_id,
            set_by = excluded.set_by, set_at = excluded.set_at`
  ).pipe(Effect.mapError(sqlError));
  const people = yield* teammates(orgId);
  // Everyone keeps messaging the previous one (`Reach`); only the new one's chats are opened.
  if (next !== null)
    for (const personId of people)
      yield* chats.createDirect(
        { _tag: "person", orgId, personId },
        { orgId, agentId: next.agentId },
      );
  yield* leadsChanged(orgId);
  return nextId;
});

/**
 * The leads of other people this person may message, oldest first: name, what the owner lets
 * teammates read about it, the person's own chat with it, and who owns it (and so can see that
 * chat). Nothing else of the lead.
 */
export const contacts = Effect.fn("KinLeadProvision.contacts")(function* (person: PersonIdentity) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<Omit<KinLeadContact, "ownerName"> & { readonly ownerName: string }>`
    SELECT l.org_id AS "orgId", l.agent_id AS "agentId", l.name, l.public_intro AS intro,
      c.chat_id AS "chatId", o.display_name AS "ownerName"
    FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL AND a.owner_person_id <> ${person.personId}
    JOIN kin_people o ON o.org_id = a.org_id AND o.person_id = a.owner_person_id
    JOIN kin_chats c ON c.org_id = l.org_id AND c.kind = 'direct'
      AND c.direct_key = ${person.personId} || ':' || l.agent_id
    JOIN kin_people me ON me.org_id = l.org_id AND me.person_id = ${person.personId}
    WHERE l.org_id = ${person.orgId}
      AND NOT ${sql.literal(Reach.restrictedSql("l.org_id", "l.agent_id", "me.person_id"))}
    ORDER BY a.created_at, l.agent_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.contacts")),
  );
  return rows.map(({ orgId, agentId, name, intro, chatId, ownerName }) => ({
    orgId,
    agentId,
    name,
    intro,
    chatId,
    ownerName,
  }));
});

/** What the CLI provides on top of the server's SQLite and environment layers. */
export const layer = Layer.mergeAll(
  KinIdentity.layer.pipe(Layer.provide(KinIdentityConfig.layer)),
  ChatService.layer,
).pipe(
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provide(KinPersistence.layer),
);

/** Settings name each provider instance's driver; the CLI reads this host's file. */
export const settingsLayer = serverSettingsLayer;

/** The CLI adds `KinRetiredActions` from the approvals module, as the server's layer does. */
export type Requirements =
  | Layer.Success<typeof layer>
  | Retirement.KinRetiredActions
  | SqlClient.SqlClient
  | ServerSettingsService;
