// @effect-diagnostics nodeBuiltinImport:off -- a synchronous SHA-256 for the target digest.
import * as NodeCrypto from "node:crypto";

import {
  KinActionId,
  KinActionKind,
  KinActionTarget,
  KinApprovalError,
  KinEvent,
  KinEventId,
  KinPendingActionState,
  KinResolvedTarget,
  KinShadowResult,
  ProjectId,
  type Hex64,
  type KinLevel,
  type KinProvenance,
  type KinProvenanceRole,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { sourceControlDefinitions } from "../../sourceControl/sourceControlDefinitions.ts";
import type { AgentIdentity } from "../chat/KinIdentity.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import * as Audit from "./Audit.ts";
import * as PendingActions from "./PendingActions.ts";

export const RequestActionInput = Schema.Struct({
  kind: KinActionKind,
  target: KinActionTarget,
  reason: Schema.String.check(Schema.isMaxLength(500)),
  sourceEventId: KinEventId,
});
export type RequestActionInput = typeof RequestActionInput.Type;
export const RequestActionResult = Schema.Union([
  Schema.Struct({
    actionId: KinActionId,
    state: KinPendingActionState,
    waitingOn: Schema.Literal("owner"),
  }),
  KinShadowResult,
]);
export type RequestActionResult = typeof RequestActionResult.Type;

type PullRequestTarget = Extract<KinActionTarget, { readonly _tag: "pull_request" }>;
type PullRequestFacts = Extract<KinResolvedTarget, { readonly _tag: "pull_request" }>;

/**
 * What the server reads from GitHub itself; the agent only names the PR. `target` comes back
 * with the worker project's spelling of the repository, so one PR keys one action.
 */
export class KinPullRequestFacts extends Context.Service<
  KinPullRequestFacts,
  {
    readonly read: (input: {
      readonly target: PullRequestTarget;
      readonly projectIds: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<
      { readonly target: PullRequestTarget; readonly resolved: PullRequestFacts },
      KinApprovalError
    >;
    /** The worker-project mapping alone, with no GitHub read: the target in the project's spelling. */
    readonly canonical: (input: {
      readonly target: PullRequestTarget;
      readonly projectIds: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<PullRequestTarget, KinApprovalError>;
  }
>()("t3/kin/approvals/RequestAction/KinPullRequestFacts") {}

const decodePullRequestFacts = Schema.decodeUnknownEffect(KinResolvedTarget);
const checkStatus = (status: string) =>
  status === "success"
    ? ("passed" as const)
    : status === "skipped" || status === "neutral"
      ? ("skipped" as const)
      : status === "pending"
        ? ("pending" as const)
        : ("failed" as const);

export const layerPullRequestFacts = Layer.effect(
  KinPullRequestFacts,
  Effect.gen(function* () {
    const pullRequests = yield* PullRequestService;
    const projects = yield* ProjectService.ProjectService;
    const unavailable = (message: string) =>
      new KinApprovalError({ reason: "unavailable", message });
    // One refusal for "not this lead's repo" and "no such PR", so private repos can't be probed.
    const notFound = new KinApprovalError({
      reason: "not_found",
      message: "No such pull request in this lead's worker projects.",
    });
    // Public GitHub reads through any project, so the lead's worker projects are the allowlist.
    const project = Effect.fn("KinPullRequestFacts.project")(function* (
      target: PullRequestTarget,
      projectIds: ReadonlyArray<ProjectId>,
    ) {
      const shells = yield* projects
        .listShells({ projectIds })
        .pipe(Effect.mapError(() => unavailable("This lead's worker projects can't be read.")));
      const match = shells
        .filter((shell) => projectIds.includes(shell.id))
        .map((shell) => ({
          projectId: shell.id,
          repo: sourceControlDefinitions.repositorySelector(shell.repositoryIdentity),
        }))
        .find(({ repo }) => repo?.toLowerCase() === target.repo.toLowerCase());
      if (match?.repo == null) return yield* notFound;
      return { projectId: match.projectId, canonical: { ...target, repo: match.repo } };
    });
    return KinPullRequestFacts.of({
      canonical: Effect.fn("KinPullRequestFacts.canonical")(function* ({ target, projectIds }) {
        return (yield* project(target, projectIds)).canonical;
      }),
      read: Effect.fn("KinPullRequestFacts.read")(function* ({ target, projectIds }) {
        const { projectId, canonical } = yield* project(target, projectIds);
        // No host: the read stays on the project's own repository instead of routing elsewhere.
        const detail = yield* pullRequests
          .detail({ projectId, repository: canonical.repo, number: target.number })
          .pipe(Effect.mapError(() => notFound));
        if (
          detail.repository.toLowerCase() !== canonical.repo.toLowerCase() ||
          detail.number !== target.number ||
          URL.parse(detail.url)?.hostname.toLowerCase() !== target.host
        )
          return yield* unavailable("GitHub returned a different pull request.");
        if (detail.state !== "open")
          return yield* new KinApprovalError({
            reason: "invalid_state",
            message: `The pull request is ${detail.state}.`,
          });
        const facts = yield* decodePullRequestFacts({
          _tag: "pull_request",
          headSha: detail.headSha,
          base: detail.baseBranch,
          head: detail.headBranch,
          title: detail.title,
          additions: detail.additions,
          deletions: detail.deletions,
          files: detail.changedFiles,
          checks: detail.checks.map((check) => ({
            name: check.name,
            required: check.required === true,
            status: checkStatus(check.status),
          })),
        }).pipe(Effect.mapError(() => unavailable("GitHub's answer is missing the head or base.")));
        return facts._tag === "pull_request"
          ? { target: canonical, resolved: facts }
          : yield* unavailable("GitHub's answer is missing the head or base.");
      }),
    });
  }),
);

/** sha256(stableStringify({kind, target, headSha, base})) (approvals spec section 3). */
const kinTargetDigest = (input: {
  readonly kind: KinActionKind;
  readonly target: KinActionTarget;
  readonly resolved: KinResolvedTarget;
}): Hex64 =>
  NodeCrypto.createHash("sha256")
    .update(
      stableStringify({
        kind: input.kind,
        target: input.target,
        headSha: input.resolved._tag === "none" ? undefined : input.resolved.headSha,
        base: input.resolved._tag === "pull_request" ? input.resolved.base : undefined,
      }),
    )
    .digest("hex");

// Approvals spec section 8: a member can't get these cards in front of the owner.
const OWNER_ONLY_KINDS: ReadonlySet<KinActionKind> = new Set([
  "change_rules",
  "set_level",
  "register_approver_key",
  "set_delegation",
  "set_next_of_kin",
]);
// Kinds whose target the server can resolve and whose handler is specified for phase 1.
// The executor's handler registry (APPR-9) replaces this list.
const REQUESTABLE_KINDS: ReadonlySet<KinActionKind> = new Set(["merge_pull_request"]);
// The lead spec's level table: a privileged request reaches the owner only from L3 (APPR-13 will
// narrow merges at L3 to low-risk targets). Below it the request becomes a shadow entry.
const PRIVILEGED_LEVEL = "L3";
// Bounds how many cards one lead can put in front of the owner at once.
export const MAX_OPEN_ACTIONS_PER_LEAD = 10;

const refuse = (reason: KinApprovalError["reason"], message: string) =>
  Effect.fail(new KinApprovalError({ reason, message }));

const isApprovalError = Schema.is(KinApprovalError);
const ROLE_RANK = { none: 0, guest: 1, member: 2, owner: 3 } as const;
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(KinEvent));
const decodeProjects = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(ProjectId)));
const decodeTarget = Schema.decodeUnknownEffect(KinActionTarget);

export class KinRequestAction extends Context.Service<
  KinRequestAction,
  {
    readonly request: (
      agent: AgentIdentity,
      input: RequestActionInput,
    ) => Effect.Effect<RequestActionResult, KinApprovalError>;
  }
>()("t3/kin/approvals/RequestAction/KinRequestAction") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pending = yield* PendingActions.KinPendingActions;
  const facts = yield* KinPullRequestFacts;

  /** Who stands behind one event, from stored rows; event provenance alone never names a role. */
  const roleOf = Effect.fn("KinRequestAction.roleOf")(
    function* (agent: AgentIdentity, event: KinEvent) {
      const author = event.provenance;
      if (author._tag !== "human") return "none" as const;
      const rows =
        event._tag === "chat.message"
          ? yield* sql<{ role: KinProvenanceRole }>`SELECT author_role AS role FROM kin_messages
            WHERE org_id = ${event.orgId} AND message_id = ${event.messageId} AND chat_id = ${event.chatId}
              AND author_kind = 'human' AND author_person_id = ${author.personId}
              AND author_member_id = ${author.memberId} AND status = 'posted'
            ORDER BY message_id`
          : yield* sql<{ role: KinProvenanceRole }>`SELECT role FROM kin_chat_members
            WHERE org_id = ${event.orgId} AND member_id = ${author.memberId}
              AND principal_kind = 'person' AND person_id = ${author.personId} AND left_at IS NULL
            ORDER BY member_id`;
      const role = rows[0]?.role ?? ("none" as const);
      // Only this lead's own owner counts as owner; anyone else in the chat is a member.
      return role === "owner" && author.personId !== agent.ownerPersonId
        ? ("member" as const)
        : role;
    },
    Effect.mapError(toPersistenceSqlError("KinRequestAction.roleOf")),
  );

  /** Provenance from the wake-up the caller is running, never from tool input (spec section 8). */
  const provenanceFor = Effect.fn("KinRequestAction.provenanceFor")(function* (
    agent: AgentIdentity,
    sourceEventId: KinEventId,
  ) {
    const rows = yield* sql<{ json: string }>`SELECT e.json FROM kin_events e
      JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
      WHERE w.org_id = ${agent.orgId} AND w.agent_id = ${agent.agentId}
        AND w.thread_id = ${agent.threadId} AND w.status = 'running' AND e.state = 'claimed'
      ORDER BY e.received_at, e.event_id`.pipe(
      Effect.mapError(toPersistenceSqlError("KinRequestAction.provenanceFor")),
    );
    const events = yield* Effect.forEach(rows, (row) => decodeEvent(row.json));
    const chain = yield* Effect.forEach(events, (event) =>
      roleOf(agent, event).pipe(
        Effect.map((authorRole) => ({
          event,
          entry: { kind: event._tag, id: event.eventId, authorRole },
        })),
      ),
    );
    const sourceLink = chain.find(({ event }) => event.eventId === sourceEventId);
    if (sourceLink === undefined) return undefined;
    const source = sourceLink.event;
    const startedByRole = sourceLink.entry.authorRole;
    const nonOwner = chain.find(
      ({ event, entry }) =>
        event._tag === "chat.message" &&
        event.provenance._tag === "human" &&
        entry.authorRole !== "owner" &&
        entry.authorRole !== "none",
    );
    const ceiling = chain.reduce(
      (lowest, { entry }) => Math.min(lowest, ROLE_RANK[entry.authorRole]),
      ROLE_RANK.owner as number,
    );
    const ceilingIsOwner = ceiling === ROLE_RANK.owner;
    const provenance: KinProvenance = {
      startedBy:
        source.provenance._tag === "human"
          ? { humanId: source.provenance.personId }
          : source._tag === "github"
            ? "github"
            : "schedule",
      startedByRole,
      chain: chain.map(({ entry }) => entry),
      ceilingBelowOwner: !ceilingIsOwner,
      ...(nonOwner !== undefined &&
      nonOwner.event._tag === "chat.message" &&
      nonOwner.event.provenance._tag === "human"
        ? {
            afterNonOwnerMessage: {
              humanId: nonOwner.event.provenance.personId,
              messageId: nonOwner.event.messageId,
            },
          }
        : {}),
    };
    return { provenance, ceilingIsOwner };
  });

  const leadOf = (agent: AgentIdentity) =>
    sql<{ worker_projects_json: string }>`SELECT l.worker_projects_json
      FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${agent.orgId} AND l.agent_id = ${agent.agentId}
        AND a.role = 'lead' AND a.retired_at IS NULL
      ORDER BY l.agent_id`.pipe(Effect.mapError(toPersistenceSqlError("KinRequestAction.leadOf")));

  /** Refuses once this lead has the most cards it may keep in front of the owner. */
  const admitOpen = Effect.fn("KinRequestAction.admitOpen")(function* (agent: AgentIdentity) {
    const now = yield* Clock.currentTimeMillis;
    const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_pending_actions
      WHERE org_id = ${agent.orgId} AND requested_by_agent_id = ${agent.agentId}
        AND state = 'awaiting_approval' AND expires_at > ${now}
      ORDER BY n`.pipe(Effect.mapError(toPersistenceSqlError("KinRequestAction.openCount")));
    if ((count?.n ?? 0) >= MAX_OPEN_ACTIONS_PER_LEAD)
      return yield* refuse(
        "invalid_state",
        `You already have ${MAX_OPEN_ACTIONS_PER_LEAD} actions waiting on the owner; wait for some to be decided.`,
      );
  });

  /** Who may ask and from which event, checked again inside the write after the GitHub read. */
  const authorize = Effect.fn("KinRequestAction.authorize")(function* (
    agent: AgentIdentity,
    input: RequestActionInput,
  ) {
    const [lead] = yield* leadOf(agent);
    if (lead === undefined)
      return yield* refuse("not_a_lead", "Only a Kin lead can request actions.");
    const origin = yield* provenanceFor(agent, input.sourceEventId);
    if (origin === undefined)
      return yield* refuse(
        "invalid_state",
        "sourceEventId must name an event in your current wake-up.",
      );
    if (OWNER_ONLY_KINDS.has(input.kind) && !origin.ceilingIsOwner)
      return yield* refuse(
        "not_owner",
        `${input.kind} needs a request from the owner alone; ask the owner to send it directly.`,
      );
    const level = yield* KinLevels.effectiveLevel(agent).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({
        KinLevelRefused: () => refuse("not_a_lead", "Only a Kin lead can request actions."),
      }),
    );
    return { lead, origin, level };
  });

  /**
   * Below the kind's level nothing reaches the owner; the would-be request is recorded instead.
   * A new entry first passes the open-card cap the real request would meet.
   */
  const shadow = Effect.fn("KinRequestAction.shadow")(function* (
    agent: AgentIdentity,
    input: RequestActionInput,
    level: KinLevel,
    provenance: KinProvenance,
  ) {
    const target = input.target;
    const entry = yield* KinLevels.recordShadow(
      {
        orgId: agent.orgId,
        agentId: agent.agentId,
        threadId: agent.threadId,
        level,
        unlocksLevel: PRIVILEGED_LEVEL,
        tool: "request_action",
        key: input,
        // Provenance is the server's, kept so the owner's review shows who drove the request.
        input: { ...input, provenance },
        wouldTarget:
          target._tag === "pull_request"
            ? `${target.repo}#${target.number}`
            : target._tag === "branch"
              ? `${target.repo}:${target.ref}`
              : input.kind,
      },
      admitOpen(agent),
    ).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({
        KinLevelRefused: (error) =>
          error.reason === "conflict"
            ? refuse("invalid_state", "This request was already recorded differently.")
            : error.reason === "limit"
              ? refuse("invalid_state", KinLevels.SHADOW_LIMIT_MESSAGE)
              : refuse("not_a_lead", "Only a Kin lead in a running wake-up can request actions."),
      }),
    );
    if (entry.created) yield* KinLevels.refreshSummary(agent);
    return { shadowed: true as const, entryId: entry.entryId };
  });

  const request = Effect.fn("KinRequestAction.request")(
    function* (agent: AgentIdentity, input: RequestActionInput) {
      // Levels are raised only from the owner's promotion card (LEAD-12), never by a lead's request.
      if (input.kind === "set_level")
        return yield* refuse(
          "unsupported_kind",
          "Leads can never request a level change; the owner raises a level from the promotion card.",
        );
      const { lead, origin, level } = yield* authorize(agent, input);
      if (!REQUESTABLE_KINDS.has(input.kind))
        return yield* refuse("unsupported_kind", `${input.kind} can't be requested yet.`);
      // Defensive: decoding here too keeps only declared fields, whoever calls the service.
      const named = yield* decodeTarget(input.target);
      if (named._tag !== "pull_request")
        return yield* refuse("invalid_state", `${input.kind} needs a pull_request target.`);
      const projectIds = yield* decodeProjects(lead.worker_projects_json);
      // Shadowed before GitHub is read: below the level the request has no side effect at all.
      if (!KinLevels.atLeast(level, PRIVILEGED_LEVEL)) {
        const target = yield* facts.canonical({ target: named, projectIds });
        return yield* shadow(agent, { ...input, target }, level, origin.provenance);
      }
      const { target, resolved } = yield* facts.read({ target: named, projectIds });
      const source = input.sourceEventId;
      const idempotencyKey = PendingActions.kinIdempotencyKey({
        orgId: agent.orgId,
        kind: input.kind,
        target,
        source,
      });
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          // The lead may be retired, lowered or its wake-up ended while GitHub answered.
          const { origin, level } = yield* authorize(agent, input);
          if (!KinLevels.atLeast(level, PRIVILEGED_LEVEL))
            return yield* shadow(agent, { ...input, target }, level, origin.provenance);
          const now = yield* Clock.currentTimeMillis;
          const open = yield* sql<{ action_id: KinActionId; idempotency_key: string }>`
            SELECT action_id, idempotency_key FROM kin_pending_actions
            WHERE org_id = ${agent.orgId} AND kind = ${input.kind} AND state = 'awaiting_approval'
              AND expires_at > ${now}
              AND lower(json_extract(target_json, '$.repo')) = ${target.repo.toLowerCase()}
              AND json_extract(target_json, '$.number') = ${target.number}
            ORDER BY created_at, action_id`.pipe(
            Effect.mapError(toPersistenceSqlError("KinRequestAction.openForTarget")),
          );
          const other = open.find((row) => row.idempotency_key !== idempotencyKey);
          if (other !== undefined)
            return yield* refuse(
              "invalid_state",
              `Action ${other.action_id} for this pull request is already waiting on the owner; wait for it to be decided.`,
            );
          if (open.length === 0) yield* admitOpen(agent);
          const { action } = yield* pending.create({
            orgId: agent.orgId,
            kind: input.kind,
            target,
            resolved,
            targetDigest: kinTargetDigest({ kind: input.kind, target, resolved }),
            reason: input.reason,
            requestedBy: { agentId: agent.agentId, threadId: agent.threadId },
            provenance: origin.provenance,
            source,
          });
          return { actionId: action.id, state: action.state, waitingOn: "owner" as const };
        }),
      );
    },
    Effect.catchIf(
      (error) => !isApprovalError(error),
      (error) =>
        Effect.logWarning("Kin request_action failed", error).pipe(
          Effect.andThen(refuse("unavailable", "Kin approvals are unavailable.")),
        ),
    ),
  );

  return KinRequestAction.of({ request });
});

export const layer = Layer.effect(KinRequestAction, make).pipe(
  Layer.provide(PendingActions.layer.pipe(Layer.provide(Audit.layer))),
);
