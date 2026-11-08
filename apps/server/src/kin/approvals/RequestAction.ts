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
  ProjectId,
  type Hex64,
  type KinProvenance,
  type KinProvenanceRole,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import type { AgentIdentity } from "../chat/KinIdentity.ts";
import * as PendingActions from "./PendingActions.ts";

export const RequestActionInput = Schema.Struct({
  kind: KinActionKind,
  target: KinActionTarget,
  reason: Schema.String.check(Schema.isMaxLength(500)),
  sourceEventId: KinEventId,
});
export type RequestActionInput = typeof RequestActionInput.Type;
export const RequestActionResult = Schema.Struct({
  actionId: KinActionId,
  state: KinPendingActionState,
  waitingOn: Schema.Literal("owner"),
});
export type RequestActionResult = typeof RequestActionResult.Type;

type PullRequestTarget = Extract<KinActionTarget, { readonly _tag: "pull_request" }>;
type PullRequestFacts = Extract<KinResolvedTarget, { readonly _tag: "pull_request" }>;

/** What the server reads from GitHub itself; the agent only names the PR. */
export class KinPullRequestFacts extends Context.Service<
  KinPullRequestFacts,
  {
    readonly read: (input: {
      readonly target: PullRequestTarget;
      readonly projectIds: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<PullRequestFacts, KinApprovalError>;
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
    const unavailable = (message: string) =>
      new KinApprovalError({ reason: "unavailable", message });
    return KinPullRequestFacts.of({
      read: Effect.fn("KinPullRequestFacts.read")(function* ({ target, projectIds }) {
        // GitHub's public host reads through any project; worker projects carry the lead's access.
        const [projectId] = projectIds;
        if (projectId === undefined)
          return yield* unavailable("This lead has no worker project to read GitHub through.");
        const detail = yield* pullRequests
          .detail({ projectId, host: target.host, repository: target.repo, number: target.number })
          .pipe(Effect.mapError(() => unavailable("The pull request could not be read.")));
        if (
          detail.repository.toLowerCase() !== target.repo.toLowerCase() ||
          detail.number !== target.number
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
          ? facts
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
  const roleOf = Effect.fn("KinRequestAction.roleOf")(function* (event: KinEvent) {
    const author = event.provenance;
    if (author._tag !== "human") return "none" as const;
    const rows =
      event._tag === "chat.message"
        ? yield* sql<{ role: KinProvenanceRole }>`SELECT author_role AS role FROM kin_messages
            WHERE org_id = ${event.orgId} AND message_id = ${event.messageId} AND chat_id = ${event.chatId}
              AND author_kind = 'human' AND author_person_id = ${author.personId}
              AND author_member_id = ${author.memberId} AND status = 'posted'`
        : yield* sql<{ role: KinProvenanceRole }>`SELECT role FROM kin_chat_members
            WHERE org_id = ${event.orgId} AND member_id = ${author.memberId}
              AND principal_kind = 'person' AND person_id = ${author.personId} AND left_at IS NULL`;
    return rows[0]?.role ?? ("none" as const);
  });

  /** Provenance from the wake-up the caller is running, never from tool input (spec section 8). */
  const provenanceFor = Effect.fn("KinRequestAction.provenanceFor")(function* (
    agent: AgentIdentity,
    sourceEventId: KinEventId,
  ) {
    const rows = yield* sql<{ json: string }>`SELECT e.json FROM kin_events e
      JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
      WHERE w.org_id = ${agent.orgId} AND w.agent_id = ${agent.agentId}
        AND w.thread_id = ${agent.threadId} AND w.status = 'running' AND e.state = 'claimed'
      ORDER BY e.received_at, e.event_id`;
    const events = yield* Effect.forEach(rows, (row) => decodeEvent(row.json));
    const chain = yield* Effect.forEach(events, (event) =>
      roleOf(event).pipe(
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
    const provenance: KinProvenance = {
      startedBy:
        source.provenance._tag === "human"
          ? { humanId: source.provenance.personId }
          : source._tag === "github"
            ? "github"
            : "schedule",
      startedByRole,
      chain: chain.map(({ entry }) => entry),
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
    const ceiling = chain.reduce(
      (lowest, { entry }) => Math.min(lowest, ROLE_RANK[entry.authorRole]),
      ROLE_RANK.owner as number,
    );
    return { provenance, ceilingIsOwner: ceiling === ROLE_RANK.owner };
  });

  const request = Effect.fn("KinRequestAction.request")(
    function* (agent: AgentIdentity, input: RequestActionInput) {
      const [lead] = yield* sql<{ worker_projects_json: string }>`SELECT l.worker_projects_json
        FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE l.org_id = ${agent.orgId} AND l.agent_id = ${agent.agentId}
          AND a.role = 'lead' AND a.retired_at IS NULL`;
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
      if (!REQUESTABLE_KINDS.has(input.kind))
        return yield* refuse("unsupported_kind", `${input.kind} can't be requested yet.`);
      // Decoding again keeps only declared fields, so a smuggled headSha never reaches the digest.
      const target = yield* decodeTarget(input.target);
      if (target._tag !== "pull_request")
        return yield* refuse("invalid_state", `${input.kind} needs a pull_request target.`);
      const resolved = yield* facts.read({
        target,
        projectIds: yield* decodeProjects(lead.worker_projects_json),
      });
      const { action } = yield* pending.create({
        orgId: agent.orgId,
        kind: input.kind,
        target,
        resolved,
        targetDigest: kinTargetDigest({ kind: input.kind, target, resolved }),
        reason: input.reason,
        requestedBy: { agentId: agent.agentId, threadId: agent.threadId },
        provenance: origin.provenance,
        source: input.sourceEventId,
      });
      return { actionId: action.id, state: action.state, waitingOn: "owner" as const };
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

export const layer = Layer.effect(KinRequestAction, make).pipe(Layer.provide(PendingActions.layer));
