import {
  KinAgentId,
  KinChatId,
  KinLead,
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
import * as JudgeShadow from "../floor/JudgeShadow.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as ChatService from "../chat/KinChatService.ts";
import { KinIdentity, KinIdentityConfig, type PersonIdentity } from "../chat/KinIdentity.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinLevels from "./KinLevels.ts";

// Host-operator only: the `kin lead` CLI is the one caller. No RPC, MCP tool or agent reaches it.

export class KinLeadProvisionError extends Schema.TaggedError<KinLeadProvisionError>()(
  "KinLeadProvisionError",
  {
    reason: Schema.Literals([
      "not_owner",
      "lead_exists",
      "unknown_project",
      "not_found",
      "conflict",
    ]),
    message: Schema.String,
  },
) {
  // The CLI prints the message; a refusal is an answer, not a crash.
  override readonly [Runtime.errorReported] = false;
}

export type LeadOwner =
  | { readonly _tag: "session"; readonly session: AuthenticatedSession }
  | { readonly _tag: "person"; readonly personId: KinPersonId };

export const LeadSummary = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: Schema.String,
  level: KinLead.fields.level,
  ownerPersonId: KinPersonId,
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
  readonly owner: LeadOwner;
  readonly name: typeof TrimmedNonEmptyString.Type;
  readonly models: { readonly strong: ModelSelection; readonly cheap: ModelSelection };
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
  const rows = yield* sql`SELECT l.org_id AS "orgId", l.agent_id AS "agentId", l.name, l.level,
      a.owner_person_id AS "ownerPersonId", l.owner_chat_id AS "ownerChatId",
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

/** The person the lead belongs to, by the same mapping a paired client gets from KinIdentity. */
const ownerFor = Effect.fn("KinLeadProvision.ownerFor")(function* (owner: LeadOwner) {
  const identity = yield* KinIdentity;
  if (owner._tag === "session") {
    const [person] = yield* identity.resolve(owner.session);
    if (person === undefined)
      return yield* refuse(
        "not_owner",
        "That session doesn't map to the Kin owner. Pair a client with the standard scopes, or pass --person.",
      );
    return person;
  }
  if (owner.personId !== identity.owner.personId)
    return yield* refuse(
      "not_owner",
      `Person ${owner.personId} isn't the owner of Kin org ${identity.owner.orgId}. Only the owner can have a lead.`,
    );
  return identity.owner;
});

export const create = Effect.fn("KinLeadProvision.create")(function* (input: CreateLeadInput) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const chats = yield* ChatService.KinChatService;
  const person: PersonIdentity = yield* ownerFor(input.owner);
  const { orgId } = person;
  return yield* transaction(
    sql,
    "KinLeadProvision.create",
    Effect.gen(function* () {
      // Material, budget notices and routines each read one lead per org. Writable transactions
      // open with BEGIN IMMEDIATE, so this read-then-insert can't race another create.
      const [live] = yield* leadsIn(orgId, { liveOnly: true });
      if (live !== undefined) {
        if (live.ownerPersonId === person.personId)
          return { _tag: "existing" as const, lead: live };
        return yield* refuse(
          "lead_exists",
          `Org ${orgId} already has live lead ${live.agentId}. Retire it first.`,
        );
      }
      const projects = [...new Set(input.workerProjects)];
      if (projects.length > 0) {
        const found = yield* sql<{ projectId: string }>`SELECT project_id AS "projectId"
            FROM projection_projects
            WHERE project_id IN ${sql.in(projects)} AND deleted_at IS NULL ORDER BY project_id`;
        const missing = projects.filter((id) => !found.some((row) => row.projectId === id));
        if (missing.length > 0)
          return yield* refuse("unknown_project", `Unknown project: ${missing.join(", ")}.`);
      }
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
      const models = yield* encodeModels(input.models).pipe(Effect.orDie);
      const workerProjects = yield* encodeProjects(projects).pipe(Effect.orDie);
      const inserted = yield* KinLevels.insertLeadAtL0({
        orgId,
        agentId,
        name: input.name,
        since: DateTime.toEpochMillis(now),
        modelsJson: models,
        workerProjectsJson: workerProjects,
        ownerChatId: chat.chatId,
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

/** What the CLI provides on top of the server's SQLite and environment layers. */
export const layer = Layer.mergeAll(
  KinIdentity.layer.pipe(Layer.provide(KinIdentityConfig.layer)),
  ChatService.layer,
).pipe(
  // Creating a direct chat posts nothing, so the floor judge never runs.
  Layer.provide(JudgeShadow.layerOff),
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provide(KinPersistence.layer),
);

export type Requirements = Layer.Success<typeof layer> | SqlClient.SqlClient;
