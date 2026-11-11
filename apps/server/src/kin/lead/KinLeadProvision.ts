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
  KIN_LEAD_TRACKING_CAP,
  KinLeadTracking,
  KinOrgId,
  KinPersonId,
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
import * as Audit from "../approvals/Audit.ts";
import * as PendingActions from "../approvals/PendingActions.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import * as KinLevels from "./KinLevels.ts";
import { KinStop } from "./KinStop.ts";
import * as Retirement from "./Retirement.ts";
import * as LeadAccess from "./LeadAccess.ts";
import { nonClaudeLeadModel } from "./leadModels.ts";

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
  level: KinLead.fields.level,
  ownerPersonId: KinPersonId,
  createdByPersonId: Schema.NullOr(KinPersonId),
  ownerChatId: KinChatId,
  models: Schema.fromJsonString(KinLead.fields.models),
  workerProjects: Schema.fromJsonString(KinLead.fields.workerProjects),
  retiredAt: Schema.NullOr(Schema.String),
  retiredByPersonId: Schema.NullOr(KinPersonId),
});
export type LeadSummary = typeof LeadSummary.Type;
const decodeLeads = Schema.decodeUnknownEffect(Schema.Array(LeadSummary));
const encodeModels = Schema.encodeEffect(Schema.fromJsonString(KinLead.fields.models));
const encodeProjects = Schema.encodeEffect(Schema.fromJsonString(KinLead.fields.workerProjects));

export interface CreateLeadInput {
  readonly creator: LeadCreator;
  readonly name: typeof TrimmedNonEmptyString.Type;
  readonly domain: KinLeadDomain;
  readonly charter: KinLeadCharter;
  readonly intro?: KinLeadIntro | undefined;
  /** Omitted: the models of the org's first live lead. */
  readonly models?: { readonly strong: ModelSelection; readonly cheap: ModelSelection } | undefined;
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

const leadsIn = Effect.fn("KinLeadProvision.leadsIn")(function* (
  orgId: KinOrgId,
  options: { readonly liveOnly: boolean; readonly agentId?: KinAgentId },
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT l.org_id AS "orgId", l.agent_id AS "agentId", l.name, l.domain,
      l.charter, l.public_intro AS intro, l.level, a.owner_person_id AS "ownerPersonId",
      l.created_by_person_id AS "createdByPersonId", l.owner_chat_id AS "ownerChatId",
      l.models_json AS models, l.worker_projects_json AS "workerProjects", a.retired_at AS "retiredAt",
      a.retired_by_person_id AS "retiredByPersonId"
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
 * Who may create a lead. Only the owner, for now; members will create their own, with authority
 * capped at theirs, through this same check.
 */
const mayCreate = Effect.fn("KinLeadProvision.mayCreate")(function* (person: PersonIdentity) {
  const { owner } = yield* KinIdentity;
  if (person.orgId === owner.orgId && person.personId === owner.personId) return;
  return yield* refuse(
    "not_owner",
    `Person ${person.personId} isn't the owner of Kin org ${owner.orgId}. Only the owner can create leads.`,
  );
});

/** The models a lead gets when none are named: the org's first live lead's. */
const defaultModels = Effect.fn("KinLeadProvision.defaultModels")(function* (orgId: KinOrgId) {
  const [first] = yield* leadsIn(orgId, { liveOnly: true });
  if (first === undefined)
    return yield* refuse(
      "no_models",
      "This org has no lead to copy models from. Pass --strong and --cheap.",
    );
  return first.models;
});

export const create = Effect.fn("KinLeadProvision.create")(function* (input: CreateLeadInput) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const chats = yield* ChatService.KinChatService;
  const person: PersonIdentity = yield* creatorFor(input.creator);
  yield* mayCreate(person);
  const { orgId } = person;
  const models = input.models ?? (yield* defaultModels(orgId));
  const notClaude = nonClaudeLeadModel(yield* (yield* ServerSettingsService).getSettings, models);
  if (notClaude !== undefined) return yield* refuse("not_claude", notClaude);
  return yield* transaction(
    sql,
    "KinLeadProvision.create",
    Effect.gen(function* () {
      // A re-run reports the creator's live lead of that name and domain. Writable transactions
      // open with BEGIN IMMEDIATE, so this read-then-insert can't race another create.
      const same = (yield* leadsIn(orgId, { liveOnly: true })).find(
        (lead) =>
          lead.ownerPersonId === person.personId &&
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
        ownerPersonId: person.personId,
        createdAt: DateTime.formatIso(now),
      });
      const chat = yield* chats.createDirect(person, { orgId, agentId });
      // Both were decoded by the caller, so re-encoding them can't fail.
      const modelsJson = yield* encodeModels(models).pipe(Effect.orDie);
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
      if (!inserted) return yield* refuse("conflict", `Lead ${agentId} could not be recorded.`);
      const intro = input.intro?.trim() ?? "";
      if (intro !== "")
        yield* sql`UPDATE kin_leads SET public_intro = ${intro}
          WHERE org_id = ${orgId} AND agent_id = ${agentId}`.pipe(
          Effect.mapError(toPersistenceSqlError("KinLeadProvision.create")),
        );
      const [lead] = yield* leadsIn(orgId, { liveOnly: true, agentId });
      if (lead === undefined)
        return yield* refuse("conflict", `Lead ${agentId} could not be recorded.`);
      return { _tag: "created" as const, lead };
    }),
  );
});

export const list = Effect.fn("KinLeadProvision.list")(function* () {
  const identity = yield* KinIdentity;
  return yield* leadsIn(identity.owner.orgId, { liveOnly: false });
});

/** Replaces a live lead's worker projects. Readers query the row per call, so it applies at once. */
export const setWorkerProjects = Effect.fn("KinLeadProvision.setWorkerProjects")(function* (
  agentId: KinAgentId,
  workerProjects: ReadonlyArray<ProjectId>,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId } = (yield* KinIdentity).owner;
  return yield* transaction(
    sql,
    "KinLeadProvision.setWorkerProjects",
    Effect.gen(function* () {
      const [lead] = yield* leadsIn(orgId, { liveOnly: false, agentId });
      if (lead === undefined)
        return yield* refuse("not_found", `Org ${orgId} has no lead ${agentId}.`);
      if (lead.retiredAt !== null)
        return yield* refuse("retired", `Lead ${agentId} was retired at ${lead.retiredAt}.`);
      const projects = yield* knownProjects(workerProjects);
      const json = yield* encodeProjects(projects).pipe(Effect.orDie);
      const changed = yield* sql`UPDATE kin_leads SET worker_projects_json = ${json}
          WHERE org_id = ${orgId} AND agent_id = ${agentId} RETURNING agent_id`;
      if (changed.length === 0)
        return yield* refuse("conflict", `Lead ${agentId} changed while updating.`);
      return { _tag: "updated" as const, lead: { ...lead, workerProjects: projects } };
    }),
  );
});

interface LeadChange {
  readonly name?: typeof TrimmedNonEmptyString.Type | undefined;
  readonly domain?: KinLeadDomain | undefined;
  readonly charter?: KinLeadCharter | undefined;
  /** What teammates see about it. The prompt doesn't read it yet. */
  readonly intro?: KinLeadIntro | undefined;
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
  if (lead === undefined || (ownedBy !== undefined && lead.ownerPersonId !== ownedBy))
    return yield* refuse("not_found", `Org ${orgId} has no lead ${agentId}.`);
  if (lead.retiredAt !== null)
    return yield* refuse("retired", `Lead ${agentId} was retired at ${lead.retiredAt}.`);
  const next = {
    name: fields.name ?? lead.name,
    domain: fields.domain ?? lead.domain,
    charter: fields.charter ?? lead.charter,
    intro: fields.intro?.trim() ?? lead.intro,
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
      `Another lead is already called ${next.name} in ${next.domain}.`,
    );
  const changed = yield* sql`UPDATE kin_leads SET name = ${next.name}, domain = ${next.domain},
      charter = ${next.charter}, public_intro = ${next.intro}
    WHERE org_id = ${orgId} AND agent_id = ${agentId} RETURNING agent_id`;
  if (changed.length === 0)
    return yield* refuse("conflict", `Lead ${agentId} changed while updating.`);
  // Chats show the agent's name, so both rows carry it.
  yield* sql`UPDATE kin_agents SET display_name = ${next.name}
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND role = 'lead' RETURNING agent_id`;
  return { ...lead, ...next };
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
});
const decodeTracked = Schema.decodeUnknownEffect(Schema.Array(TrackedRow));

/**
 * What each lead has in hand, from stored rows: its running workers, the deferrals still waiting
 * to come due and the scheduled tasks still on. A deferral belongs to its chat's first-joined
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
  // Its open Work entries, any running worker not yet in Work, then its alarms.
  const rows = yield* sql`
    SELECT 'work' AS kind, e.title, e.due_at AS "dueAt", e.source_chat_id AS "chatId",
      e.owner_id AS "agentId",
      CASE e.state WHEN 'doing' THEN 0 WHEN 'waiting' THEN 0 ELSE 1 END AS rank,
      COALESCE(e.due_at, e.updated_at) AS at, e.key, e.state
    FROM kin_records e WHERE e.org_id = ${orgId} AND e.register_id = 'work'
      AND e.owner_kind = 'agent' AND e.state NOT IN ('done', 'dropped')
    UNION ALL
    SELECT 'work', COALESCE(k.title, 'Coding task'), NULL, k.chat_id, k.agent_id, 0, k.started_at,
      NULL, NULL
    FROM kin_workers k WHERE k.org_id = ${orgId} AND k.ended_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM kin_record_links l WHERE l.org_id = k.org_id
        AND l.kind = 'worker' AND l.target = k.worker_id)
    UNION ALL
    SELECT CASE r.on_due WHEN 'remind' THEN 'reminder' ELSE 'follow_up' END,
      COALESCE(json_extract(w.state_json, '$.title'), ''), COALESCE(f.next_run_at, r.due_at),
      w.chat_id, ${firstLead}, 2, COALESCE(f.next_run_at, r.due_at, r.updated_at), NULL, NULL
    FROM kin_deferral_runs r
    JOIN kin_widgets w ON w.org_id = r.org_id
      AND w.widget_id = 'deferral:' || r.org_id || ':' || r.item_id
    LEFT JOIN kin_triggers f ON f.org_id = r.org_id
      AND f.trigger_id = 'deferral:' || r.item_id || ':due' AND f.enabled = 1
    WHERE r.org_id = ${orgId} AND (r.state = 'asked'
      OR (r.state IN ('armed', 'heads_up', 'grace', 'snoozed') AND f.next_run_at IS NOT NULL))
    UNION ALL
    SELECT 'scheduled', COALESCE(json_extract(w.state_json, '$.title'), ''), NULL, w.chat_id,
      ${firstLead}, 3, t.updated_at, NULL, NULL
    FROM kin_scheduled_tasks t
    JOIN kin_widgets w ON w.org_id = t.org_id
      AND w.widget_id = 'scheduled:' || t.org_id || ':' || t.item_id
    JOIN kin_triggers f ON f.org_id = t.org_id
      AND f.trigger_id = 'schedule:' || t.item_id AND f.enabled = 1 AND f.next_run_at IS NOT NULL
    WHERE t.org_id = ${orgId} AND t.state = 'active' AND t.paused = 0
    UNION ALL
    SELECT 'scheduled', n.title, NULL, COALESCE(w.chat_id, s.chat_id), s.agent_id, 3, s.updated_at,
      NULL, NULL
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
  model: lead.models.strong.model,
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
      chatId: item.chatId,
      ...(item.key === null ? {} : { key: item.key }),
      ...(item.state === null ? {} : { state: item.state }),
    })),
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
 * The person's own live leads, oldest first, then with `includeRetired` their retired ones.
 * Someone with none, such as a teammate, gets none. Plain reads, outside a transaction, so a
 * client's list never holds the writer's lock.
 */
export const profiles = Effect.fn("KinLeadProvision.profiles")(function* (
  person: PersonIdentity,
  options: { readonly includeRetired?: boolean | undefined } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const own = (yield* leadsIn(person.orgId, { liveOnly: options.includeRetired !== true })).filter(
    (lead) => lead.ownerPersonId === person.personId,
  );
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
    return yield* refuse("not_found", `Org ${input.orgId} has no lead ${input.agentId}.`);
  return yield* transaction(
    sql,
    "KinLeadProvision.update",
    Effect.gen(function* () {
      return yield* profileIn(
        yield* change(person.orgId, input.agentId, input.fields, person.personId),
      );
    }),
  );
});

/** One lead's profile, read inside the caller's transaction. */
const profileIn = Effect.fn("KinLeadProvision.profileIn")(function* (lead: LeadSummary) {
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
 * The lead a person may retire or restore, by the authority that may make it: the org's owner,
 * any of the org's; its creator, their own once members may create (`mayCreate`); anyone else's
 * reads as not found. The host's command acts as the owner. Inside the caller's transaction.
 */
const retirable = Effect.fn("KinLeadProvision.retirable")(function* (input: {
  readonly by: LeadActor;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const { owner } = yield* KinIdentity;
  const missing = refuse("not_found", `Org ${input.orgId} has no lead ${input.agentId}.`);
  const person: PersonIdentity | undefined =
    input.by._tag === "host" ? undefined : yield* creatorFor(input.by);
  const orgId = person?.orgId ?? owner.orgId;
  if (orgId !== input.orgId) return yield* missing;
  const [lead] = yield* leadsIn(orgId, { liveOnly: false, agentId: input.agentId });
  if (lead === undefined) return yield* missing;
  if (person !== undefined && person.personId !== owner.personId) {
    if (lead.ownerPersonId !== person.personId) return yield* missing;
    yield* mayCreate(person);
  }
  return { lead, by: person?.personId ?? null };
});

/**
 * Retires a lead. It is not deleted: its chats, history, memory and Work stay, and `restore`
 * brings it back. In one transaction: no turn of it runs again, what it has in flight stops or
 * waits (`Retirement.retire`), and after commit its running turns are stopped. The owner keeps
 * at least one live lead of their own, so there is always someone to talk to.
 */
export const retire = Effect.fn("KinLeadProvision.retire")(function* (input: {
  readonly by: LeadActor;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const sql = yield* SqlClient.SqlClient;
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
      const now = yield* DateTime.now;
      const retiredAt = DateTime.formatIso(now);
      const changed = yield* sql`UPDATE kin_agents
          SET retired_at = ${retiredAt}, retired_by_person_id = ${by}
          WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId} AND role = 'lead'
            AND retired_at IS NULL
          RETURNING agent_id`;
      if (changed.length === 0)
        return yield* refuse("conflict", `Lead ${lead.agentId} changed while retiring.`);
      const stopped = yield* Retirement.retire({
        orgId: lead.orgId,
        agentId: lead.agentId,
        retiredAt,
        now: DateTime.toEpochMillis(now),
      });
      const after = Effect.gen(function* () {
        if (Option.isSome(stop) && stopped.turns.length > 0)
          yield* stop.value.abortTurns(lead.orgId, stopped.turns);
        // Wakes the runner, which ends its thread and sends its workers' stored stops.
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
 * schedules retiring paused. Its next turn starts a fresh thread. Workers it had stay stopped
 * and events that expired stay expired. Refused while another live lead has its name and domain.
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
          `Another lead is already called ${lead.name} in ${lead.domain}.`,
        );
      const changed = yield* sql`UPDATE kin_agents
          SET retired_at = NULL, retired_by_person_id = NULL
          WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId} AND role = 'lead'
            AND retired_at IS NOT NULL
          RETURNING agent_id`;
      if (changed.length === 0)
        return yield* refuse("conflict", `Lead ${lead.agentId} changed while restoring.`);
      yield* Retirement.restore({
        orgId: lead.orgId,
        agentId: lead.agentId,
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

/** The caller as the org's owner and the live lead of theirs being shared; anything else is refused. */
const ownedLead = Effect.fn("KinLeadProvision.ownedLead")(function* (input: {
  readonly editor: LeadCreator;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const person: PersonIdentity = yield* creatorFor(input.editor);
  yield* mayCreate(person);
  const missing = refuse("not_found", `Org ${input.orgId} has no lead ${input.agentId}.`);
  if (person.orgId !== input.orgId) return yield* missing;
  const [lead] = yield* leadsIn(person.orgId, { liveOnly: true, agentId: input.agentId });
  if (lead === undefined || lead.ownerPersonId !== person.personId) return yield* missing;
  return { person, lead };
});

const accessRows = Effect.fn("KinLeadProvision.accessRows")(function* (lead: LeadSummary) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: KinPersonId; displayName: string; since: number }>`
    SELECT x.person_id AS "personId", p.display_name AS "displayName", x.granted_at AS since
    FROM kin_lead_access x
    JOIN kin_people p ON p.org_id = x.org_id AND p.person_id = x.person_id
    WHERE x.org_id = ${lead.orgId} AND x.agent_id = ${lead.agentId} AND x.revoked_at IS NULL
    ORDER BY x.granted_at, x.person_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.accessRows")),
  );
  return {
    people: rows.map((row) => ({
      personId: row.personId,
      displayName: row.displayName as KinLeadAccessResult["people"][number]["displayName"],
      since: DateTime.formatIso(DateTime.makeUnsafe(row.since)),
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

/**
 * The owner lets a person message one of their leads. That person gets their own direct chat
 * with it, which the owner is not in; allowing them again reopens the chat they had.
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
      if (known.length === 0 || input.personId === person.personId)
        return yield* refuse("not_found", `Org ${lead.orgId} has no such person to allow.`);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* sql`INSERT INTO kin_lead_access
          (org_id, agent_id, person_id, granted_by, granted_at, revoked_at)
        VALUES (${lead.orgId}, ${lead.agentId}, ${input.personId}, ${person.personId}, ${now}, NULL)
        ON CONFLICT (org_id, agent_id, person_id) DO UPDATE SET
          granted_by = excluded.granted_by, granted_at = excluded.granted_at, revoked_at = NULL
        WHERE kin_lead_access.revoked_at IS NOT NULL`.pipe(
        Effect.mapError(toPersistenceSqlError("KinLeadProvision.allow")),
      );
      yield* chats.createDirect(
        { _tag: "person", orgId: lead.orgId, personId: input.personId },
        { orgId: lead.orgId, agentId: lead.agentId },
      );
      return yield* accessRows(lead);
    }),
  );
});

/**
 * The owner stops a person messaging one of their leads. Nothing they send wakes it from here
 * on and what was still waiting is dropped; a reply already under way still lands. Their chat
 * stays theirs to read but not to write in, and one they never wrote in leaves their list.
 */
export const disallow = Effect.fn("KinLeadProvision.disallow")(function* (
  input: Parameters<typeof ownedLead>[0] & { readonly personId: KinPersonId },
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const presence = yield* Effect.serviceOption(KinPresence);
  return yield* transaction(
    sql,
    "KinLeadProvision.disallow",
    Effect.gen(function* () {
      const { lead } = yield* ownedLead(input);
      const now = yield* DateTime.now;
      const ended =
        yield* sql`UPDATE kin_lead_access SET revoked_at = ${DateTime.toEpochMillis(now)}
        WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}
          AND person_id = ${input.personId} AND revoked_at IS NULL
        RETURNING person_id`.pipe(
          Effect.mapError(toPersistenceSqlError("KinLeadProvision.disallow")),
        );
      if (ended.length === 0) return yield* accessRows(lead);
      const [chat] = yield* sql<{ chatId: KinChatId; lastSeq: number }>`
        SELECT chat_id AS "chatId", last_seq AS "lastSeq" FROM kin_chats
        WHERE org_id = ${lead.orgId} AND kind = 'direct'
          AND direct_key = ${LeadAccess.directKey(input.personId, lead.agentId)}
        ORDER BY chat_id`.pipe(Effect.mapError(toPersistenceSqlError("KinLeadProvision.disallow")));
      if (chat === undefined) return yield* accessRows(lead);
      const dropped = yield* LeadAccess.dropQueued(lead, chat.chatId).pipe(
        Effect.mapError(toPersistenceSqlError("KinLeadProvision.disallow")),
      );
      if (dropped > 0 && Option.isSome(presence))
        yield* sql.afterCommit(
          syncQueued(presence.value, lead.orgId, lead.agentId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        );
      const member = yield* repo.activeMember({
        orgId: lead.orgId,
        chatId: chat.chatId,
        principal: { _tag: "person", personId: input.personId },
      });
      if (Option.isNone(member)) return yield* accessRows(lead);
      if (chat.lastSeq === 0) {
        for (const item of yield* repo.leaveChat({
          ...member.value,
          leftAt: DateTime.formatIso(now),
        }))
          yield* hub.publish({ type: "waiting.updated", orgId: lead.orgId, item });
        const gone = yield* repo.getMember(member.value);
        if (Option.isSome(gone))
          yield* hub.publish({ type: "member.removed", orgId: lead.orgId, member: gone.value });
      } else {
        // Guests read and never write: the chat service refuses their sends, taps and reactions.
        const guest = yield* repo.setRole({ ...member.value, role: "guest" });
        if (Option.isSome(guest))
          yield* hub.publish({
            type: "member.updated",
            orgId: lead.orgId,
            chatId: chat.chatId,
            member: guest.value,
          });
      }
      return yield* accessRows(lead);
    }),
  );
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
    FROM kin_lead_access x
    JOIN kin_leads l ON l.org_id = x.org_id AND l.agent_id = x.agent_id
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL AND a.owner_person_id <> x.person_id
    JOIN kin_people o ON o.org_id = a.org_id AND o.person_id = a.owner_person_id
    JOIN kin_chats c ON c.org_id = x.org_id AND c.kind = 'direct'
      AND c.direct_key = x.person_id || ':' || x.agent_id
    WHERE x.org_id = ${person.orgId} AND x.person_id = ${person.personId}
      AND x.revoked_at IS NULL
    ORDER BY x.granted_at, l.agent_id`.pipe(
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
  // Retiring closes the approval requests a lead raised, from the host too.
  PendingActions.layer.pipe(Layer.provide(Audit.layer)),
).pipe(
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provide(KinPersistence.layer),
);

/** Settings name each provider instance's driver; the CLI reads this host's file. */
export const settingsLayer = serverSettingsLayer;

export type Requirements =
  | Layer.Success<typeof layer>
  | SqlClient.SqlClient
  | ServerSettingsService;
