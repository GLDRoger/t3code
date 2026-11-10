import {
  KinAgentId,
  KinChatId,
  KinLead,
  KinLeadCharter,
  KinLeadDomain,
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
import * as KinLevels from "./KinLevels.ts";
import { nonClaudeLeadModel } from "./leadModels.ts";

// `create` has two callers: the host's `kin lead` CLI and the owner's `kin.lead.create` RPC.
// `profiles` and `update` back `kin.leads.list` and `kin.lead.update`. The rest is CLI only. No
// MCP tool or agent reaches any of it.

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

export const LeadSummary = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: Schema.String,
  domain: KinLeadDomain,
  charter: KinLeadCharter,
  level: KinLead.fields.level,
  ownerPersonId: KinPersonId,
  createdByPersonId: Schema.NullOr(KinPersonId),
  ownerChatId: KinChatId,
  models: Schema.fromJsonString(KinLead.fields.models),
  workerProjects: Schema.fromJsonString(KinLead.fields.workerProjects),
  retiredAt: Schema.NullOr(Schema.String),
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
      l.charter, l.level, a.owner_person_id AS "ownerPersonId",
      l.created_by_person_id AS "createdByPersonId", l.owner_chat_id AS "ownerChatId",
      l.models_json AS models, l.worker_projects_json AS "workerProjects", a.retired_at AS "retiredAt"
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

/** Marks the lead retired. The server's wake-up runner then expires its queue and ends its thread. */
export const retire = Effect.fn("KinLeadProvision.retire")(function* (agentId: KinAgentId) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId } = (yield* KinIdentity).owner;
  return yield* transaction(
    sql,
    "KinLeadProvision.retire",
    Effect.gen(function* () {
      const [lead] = yield* leadsIn(orgId, { liveOnly: false, agentId });
      if (lead === undefined)
        return yield* refuse("not_found", `Org ${orgId} has no lead ${agentId}.`);
      if (lead.retiredAt !== null) return { _tag: "already_retired" as const, lead };
      const retiredAt = DateTime.formatIso(yield* DateTime.now);
      const changed = yield* sql`UPDATE kin_agents SET retired_at = ${retiredAt}
          WHERE org_id = ${orgId} AND agent_id = ${agentId} AND role = 'lead' AND retired_at IS NULL
          RETURNING agent_id`;
      if (changed.length === 0)
        return yield* refuse("conflict", `Lead ${agentId} changed while retiring.`);
      return { _tag: "retired" as const, lead: { ...lead, retiredAt } };
    }),
  );
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
}

/**
 * Changes a live lead's name, domain or charter inside the caller's transaction. With `ownedBy`,
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
      charter = ${next.charter}
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
});
const decodeTracked = Schema.decodeUnknownEffect(Schema.Array(TrackedRow));

/**
 * What each lead has in hand, from stored rows: its running workers, the deferrals still waiting
 * to come due and the scheduled tasks still on. A deferral belongs to its chat's first-joined
 * lead, the one the trigger wakes for it (`orgLeads.liveLead`).
 */
const tracked = Effect.fn("KinLeadProvision.tracked")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const firstLead = sql`(SELECT m.agent_id FROM kin_chat_members m
      JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
        AND a.role = 'lead' AND a.retired_at IS NULL
      WHERE m.org_id = w.org_id AND m.chat_id = w.chat_id AND m.principal_kind = 'agent'
        AND m.left_at IS NULL
      ORDER BY m.joined_at, m.agent_id LIMIT 1)`;
  const rows = yield* sql`
    SELECT 'work' AS kind, COALESCE(k.title, 'Coding task') AS title, NULL AS "dueAt",
      k.chat_id AS "chatId", k.agent_id AS "agentId", 0 AS rank, k.started_at AS at
    FROM kin_workers k WHERE k.org_id = ${orgId} AND k.ended_at IS NULL
    UNION ALL
    SELECT CASE r.on_due WHEN 'remind' THEN 'reminder' ELSE 'follow_up' END,
      COALESCE(json_extract(w.state_json, '$.title'), ''), r.due_at, w.chat_id, ${firstLead},
      1, COALESCE(r.due_at, r.updated_at)
    FROM kin_deferral_runs r
    JOIN kin_widgets w ON w.org_id = r.org_id
      AND w.widget_id = 'deferral:' || r.org_id || ':' || r.item_id
    WHERE r.org_id = ${orgId} AND r.state IN ('armed', 'heads_up', 'asked', 'grace', 'snoozed')
    UNION ALL
    SELECT 'scheduled', COALESCE(json_extract(w.state_json, '$.title'), ''), NULL, w.chat_id,
      ${firstLead}, 2, t.updated_at
    FROM kin_scheduled_tasks t
    JOIN kin_widgets w ON w.org_id = t.org_id
      AND w.widget_id = 'scheduled:' || t.org_id || ':' || t.item_id
    WHERE t.org_id = ${orgId} AND t.state = 'active' AND t.paused = 0
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
    })),
});

/** The person's own live leads, oldest first. Someone with none, such as a teammate, gets none. */
export const profiles = Effect.fn("KinLeadProvision.profiles")(function* (person: PersonIdentity) {
  const sql = yield* SqlClient.SqlClient;
  return yield* transaction(
    sql,
    "KinLeadProvision.profiles",
    Effect.gen(function* () {
      const leads = (yield* leadsIn(person.orgId, { liveOnly: true })).filter(
        (lead) => lead.ownerPersonId === person.personId,
      );
      if (leads.length === 0) return [];
      const running = yield* sql<{ agentId: string }>`SELECT agent_id AS "agentId" FROM kin_wakeups
        WHERE org_id = ${person.orgId} AND status = 'running' ORDER BY agent_id`.pipe(
        Effect.mapError(toPersistenceSqlError("KinLeadProvision.profiles")),
      );
      const working = new Set(running.map((row) => row.agentId));
      const items = yield* tracked(person.orgId);
      return leads.map((lead) => profileOf(lead, working, items));
    }),
  );
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
      const lead = yield* change(person.orgId, input.agentId, input.fields, person.personId);
      const running = yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${lead.orgId}
        AND agent_id = ${lead.agentId} AND status = 'running' ORDER BY wakeup_id`.pipe(
        Effect.mapError(toPersistenceSqlError("KinLeadProvision.update")),
      );
      return profileOf(
        lead,
        new Set(running.length > 0 ? [lead.agentId] : []),
        yield* tracked(lead.orgId),
      );
    }),
  );
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

export type Requirements =
  | Layer.Success<typeof layer>
  | SqlClient.SqlClient
  | ServerSettingsService;
