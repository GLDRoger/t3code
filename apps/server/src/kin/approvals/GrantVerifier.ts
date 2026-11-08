import {
  KinApprovalError,
  KinGrantUnsignedPayload,
  type AuthSessionId,
  type KinActionKind,
  type KinApprovalsActionInput,
  type KinApprovalsChallengeResult,
  type KinApprovalsDecisionResult,
  type KinApprovalsRejectInput,
  type KinApprovalsSubmitGrantInput,
  type KinGrantPayload,
  type KinGrantRejectionReason,
  type KinOrgId,
  type KinPendingAction,
} from "@t3tools/contracts";
import { decodeKinGrant, verifyKinGrant } from "@t3tools/shared/kinGrant";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { ApproverKeys, type KinKeyCaller } from "./ApproverKeys.ts";
import {
  KinGrantAudit,
  KinLiveTargets,
  KinOrgRoles,
  type KinAuditAppendInput,
} from "./GrantPorts.ts";
import { KinPendingActions, kinTargetDigest } from "./PendingActions.ts";

// Enough to see an attack in the audit; more only fills the chain. The rest are counted.
const REJECTION_AUDITS_PER_WINDOW = 20;
const REJECTION_WINDOW_MS = 60_000;
const MAX_TRACKED_SESSIONS = 1024;

const isKinApprovalError = Schema.is(KinApprovalError);
const decodeUnsigned = Schema.decodeUnknownEffect(KinGrantUnsignedPayload);

const fail = (reason: KinApprovalError["reason"], message: string) =>
  Effect.fail(new KinApprovalError({ reason, message }));

const REJECTION_MESSAGES = {
  malformed: "The grant isn't a well-formed Kin grant.",
  unknown_key: "No active approver key with this id.",
  revoked_key: "This approver key was revoked.",
  bad_signature: "The grant's signature doesn't verify.",
  not_owner: "Only the owner can approve this.",
  session_mismatch: "This grant was sent from another person's session.",
  stale: "The card changed; refresh it and approve again.",
  target_mismatch: "The grant doesn't match this action.",
  time_window: "The grant's time window is invalid or over.",
  head_moved: "The pull request changed; refresh the card.",
  replayed: "This grant was already used.",
} as const satisfies Record<KinGrantRejectionReason, string>;

const reject = (reason: KinGrantRejectionReason) => fail(reason, REJECTION_MESSAGES[reason]);

const pinsHead = (kind: KinActionKind) => kind === "merge_pull_request" || kind === "delete_branch";

/** The facts a grant must copy from the server's record (check 7), absent ones dropped. */
const recordFacts = (action: KinPendingAction) => ({
  kind: action.kind,
  target: action.target,
  targetDigest: action.targetDigest,
  headSha:
    pinsHead(action.kind) && action.resolved._tag !== "none" ? action.resolved.headSha : undefined,
  base:
    action.kind === "merge_pull_request" && action.resolved._tag === "pull_request"
      ? action.resolved.base
      : undefined,
  mergeMethod: action.target._tag === "pull_request" ? action.target.mergeMethod : undefined,
});

const grantFacts = (payload: KinGrantPayload) => ({
  kind: payload.kind,
  target: payload.target,
  targetDigest: payload.targetDigest,
  headSha: payload.headSha,
  base: payload.base,
  mergeMethod: payload.mergeMethod,
});

const headOf = (action: KinPendingAction) => {
  const resolved = action.resolved;
  return stableStringify({
    tag: resolved._tag,
    headSha: resolved._tag === "none" ? undefined : resolved.headSha,
    base: resolved._tag === "pull_request" ? resolved.base : undefined,
  });
};

/** What the rejection audit knows; the org is server state (the key's), else the caller's. */
type Seen = {
  orgId?: KinOrgId;
  claim?: Pick<KinAuditAppendInput, "actionId" | "kind" | "grantJti" | "keyThumbprint" | "headSha">;
};

export class GrantVerifier extends Context.Service<
  GrantVerifier,
  {
    /** The unsigned payload the phone renders and signs; re-reads GitHub and rotates if it moved. */
    readonly challenge: (
      caller: KinKeyCaller,
      input: KinApprovalsActionInput,
    ) => Effect.Effect<KinApprovalsChallengeResult, KinApprovalError>;
    /** Approvals spec section 5 checks 1-10, in order; every rejection is audited. */
    readonly submitGrant: (
      caller: KinKeyCaller,
      input: KinApprovalsSubmitGrantInput,
    ) => Effect.Effect<KinApprovalsDecisionResult, KinApprovalError>;
    /** No signature: rejecting is always safe. Still only the approver can, and it's audited. */
    readonly reject: (
      caller: KinKeyCaller,
      input: KinApprovalsRejectInput,
    ) => Effect.Effect<KinApprovalsDecisionResult, KinApprovalError>;
  }
>()("t3/kin/approvals/GrantVerifier") {}

const make = Effect.gen(function* () {
  const keys = yield* ApproverKeys;
  const actions = yield* KinPendingActions;
  const roles = yield* KinOrgRoles;
  const live = yield* KinLiveTargets;
  const audit = yield* KinGrantAudit;
  const budgets = new Map<
    AuthSessionId,
    { windowStart: number; used: number; suppressed: number }
  >();

  const internal = (cause: unknown) =>
    isKinApprovalError(cause)
      ? cause
      : new KinApprovalError({ reason: "unavailable", message: "Kin approvals failed." });

  /** The action by id in one of the caller's own orgs: the client never names the org. */
  const actionFor = Effect.fn("GrantVerifier.actionFor")(function* (
    caller: KinKeyCaller,
    actionId: KinPendingAction["id"],
  ) {
    if (caller.people.length === 0)
      return yield* fail("not_owner", "Only the owner can decide this.");
    for (const person of caller.people) {
      const action = yield* actions.get({ orgId: person.orgId, actionId });
      if (Option.isSome(action)) {
        // Phase 1 requirements are all the owner role; phase 3 and 5 add kinds here (spec §3).
        if (!(yield* roles.isOwner(person)))
          return yield* fail("not_owner", "Only the owner can decide this.");
        return { action: action.value, person };
      }
    }
    return yield* fail("not_found", "No such action.");
  });

  /** Check 9's read; a moved head or base rotates the nonce so the card refreshes. */
  const readLive = Effect.fn("GrantVerifier.readLive")(function* (action: KinPendingAction) {
    const resolved = yield* live.resolve({ kind: action.kind, target: action.target });
    if (resolved._tag !== action.resolved._tag)
      return yield* fail("unavailable", "GitHub returned a different kind of target.");
    return resolved;
  });

  const refreshWith = (action: KinPendingAction, resolved: KinPendingAction["resolved"]) =>
    actions.refresh({
      orgId: action.orgId,
      actionId: action.id,
      revision: action.revision,
      resolved,
      targetDigest: kinTargetDigest(action.kind, action.target, resolved),
    });

  const check = Effect.fn("GrantVerifier.check")(function* (
    caller: KinKeyCaller,
    compact: string,
    seen: Seen,
  ) {
    // 1. Shape and canonical bytes.
    const decoded = decodeKinGrant(compact);
    if (decoded === null) return yield* reject("malformed");
    const { header, payload } = decoded;
    seen.claim = {
      actionId: payload.actionId,
      kind: payload.kind,
      grantJti: payload.jti,
      keyThumbprint: header.kid,
      ...(payload.headSha === undefined ? {} : { headSha: payload.headSha }),
    };

    // 2. An active key in the grant's org, after session revocations.
    const key = yield* keys.requireActive({ orgId: payload.orgId, thumbprint: header.kid });
    seen.orgId = key.orgId;
    if (!key.attested) return yield* reject("unknown_key");

    // 2's kid binding, 3 and 8 are the shared pure check; its time_window waits for step 8.
    const now = yield* Clock.currentTimeMillis;
    const verified = verifyKinGrant({
      compact,
      publicJwk: key.publicJwk,
      nowEpochSeconds: now / 1000,
    });
    if (!verified.ok && verified.reason !== "time_window") return yield* reject(verified.reason);

    // 4. The signer is the key's person, who holds the owner role now.
    if (
      payload.approver.humanId !== key.humanId ||
      !(yield* roles.isOwner({ orgId: key.orgId, personId: key.humanId }))
    )
      return yield* reject("not_owner");

    // 5. Sent by the key's session or another session of the same person.
    const fromKeySession =
      key.sessionId !== undefined && key.sessionId === caller.session.sessionId;
    const samePerson = caller.people.some(
      (person) => person.orgId === key.orgId && person.personId === key.humanId,
    );
    if (!fromKeySession && !samePerson) return yield* reject("session_mismatch");

    // 6. The action is waiting at this revision and nonce.
    const found = yield* actions.get({ orgId: key.orgId, actionId: payload.actionId });
    if (
      Option.isNone(found) ||
      found.value.state !== "awaiting_approval" ||
      found.value.revision !== payload.revision ||
      found.value.nonce !== payload.nonce ||
      DateTime.toEpochMillis(found.value.expiresAt) <= now
    ) {
      const held = yield* actions.heldGrant({
        orgId: key.orgId,
        actionId: payload.actionId,
        jti: payload.jti,
        approverHumanId: key.humanId,
      });
      return yield* reject(held ? "replayed" : "stale");
    }
    const action = found.value;

    // 7. What was signed is what the server recorded.
    if (stableStringify(grantFacts(payload)) !== stableStringify(recordFacts(action)))
      return yield* reject("target_mismatch");

    // 8.
    if (!verified.ok) return yield* reject("time_window");

    // 9. GitHub still shows the head and base that were signed.
    if (pinsHead(action.kind)) {
      const resolved = yield* readLive(action);
      if (headOf({ ...action, resolved }) !== headOf(action)) {
        yield* refreshWith(action, resolved);
        return yield* reject("head_moved");
      }
    }

    // 10. Grant row and CAS in one transaction, against the row's own org and nonce.
    const result = yield* actions.approve({
      orgId: action.orgId,
      actionId: action.id,
      revision: action.revision,
      nonce: action.nonce,
      jti: payload.jti,
      approverHumanId: key.humanId,
      keyThumbprint: key.thumbprint,
      compact,
      iat: payload.iat,
      exp: payload.exp,
    });
    if (result._tag !== "approved") return yield* reject(result._tag);
    return { action, grant: result.grant };
  });

  /** At most REJECTION_AUDITS_PER_WINDOW per session per minute; returns how many were held back. */
  const admitRejection = (sessionId: AuthSessionId, now: number) => {
    let budget = budgets.get(sessionId);
    let carried = 0;
    if (budget === undefined || now - budget.windowStart >= REJECTION_WINDOW_MS) {
      carried = budget?.suppressed ?? 0;
      if (budget === undefined && budgets.size >= MAX_TRACKED_SESSIONS) {
        for (const [id, entry] of budgets) {
          if (now - entry.windowStart >= REJECTION_WINDOW_MS) budgets.delete(id);
        }
      }
      budget = { windowStart: now, used: 0, suppressed: 0 };
      budgets.set(sessionId, budget);
    }
    if (budget.used >= REJECTION_AUDITS_PER_WINDOW) {
      budget.suppressed += 1;
      return { admitted: false, carried };
    }
    budget.used += 1;
    return { admitted: true, carried };
  };

  const recordRejection = Effect.fn("GrantVerifier.recordRejection")(function* (
    caller: KinKeyCaller,
    seen: Seen,
    error: KinApprovalError,
  ) {
    const sessionId = caller.session.sessionId;
    const orgId = seen.orgId ?? caller.people[0]?.orgId;
    if (orgId === undefined) {
      // No org to chain it in: a session that is no person in Kin. Logged, never silent.
      return yield* Effect.logWarning("Kin grant rejected from a session with no Kin person.", {
        sessionId,
        reason: error.reason,
      });
    }
    const { admitted, carried } = admitRejection(sessionId, yield* Clock.currentTimeMillis);
    if (!admitted) return;
    yield* audit.append({
      orgId,
      event: "grant_rejected",
      ...seen.claim,
      sessionId,
      result: carried > 0 ? `${error.reason}; ${carried} more not recorded` : error.reason,
    });
  });

  const submitGrant = Effect.fn("GrantVerifier.submitGrant")(function* (
    caller: KinKeyCaller,
    input: KinApprovalsSubmitGrantInput,
  ) {
    const seen: Seen = {};
    const { action, grant } = yield* check(caller, input.compact, seen).pipe(
      Effect.mapError(internal),
      Effect.tapError((error) => recordRejection(caller, seen, error)),
    );
    const { headSha } = recordFacts(action);
    yield* audit.append({
      orgId: action.orgId,
      event: "grant_accepted",
      actionId: action.id,
      kind: action.kind,
      target: action.target,
      ...(headSha === undefined ? {} : { headSha }),
      grantJti: grant.jti,
      keyThumbprint: grant.keyThumbprint,
      sessionId: caller.session.sessionId,
      provenance: action.provenance,
    });
    return { actionId: action.id, state: "approved" as const };
  });

  /** The key this person signs with: this session's, else their most recently confirmed one. */
  const signingKey = Effect.fn("GrantVerifier.signingKey")(function* (
    caller: KinKeyCaller,
    person: PersonIdentity,
  ) {
    const { keys: listed } = yield* keys.listKeys(caller, { orgId: person.orgId });
    const usable = listed
      .filter((key) => key.state === "active" && key.attested && key.humanId === person.personId)
      .toSorted(
        (a, b) =>
          (b.confirmedAt === undefined ? 0 : DateTime.toEpochMillis(b.confirmedAt)) -
          (a.confirmedAt === undefined ? 0 : DateTime.toEpochMillis(a.confirmedAt)),
      );
    const key =
      usable.find((candidate) => candidate.sessionId === caller.session.sessionId) ?? usable[0];
    if (key === undefined)
      return yield* fail("unknown_key", "Add an approver key on this phone first.");
    return key;
  });

  const challenge = Effect.fn("GrantVerifier.challenge")(function* (
    caller: KinKeyCaller,
    input: KinApprovalsActionInput,
  ) {
    const { action: found, person } = yield* actionFor(caller, input.actionId);
    const now = yield* Clock.currentTimeMillis;
    if (found.state !== "awaiting_approval" || DateTime.toEpochMillis(found.expiresAt) <= now)
      return yield* fail("invalid_state", "This action isn't waiting for approval.");
    let action = found;
    if (pinsHead(found.kind)) {
      const resolved = yield* readLive(found);
      if (stableStringify(resolved) !== stableStringify(found.resolved)) {
        const refreshed = yield* refreshWith(found, resolved);
        if (Option.isNone(refreshed)) return yield* fail("stale", REJECTION_MESSAGES.stale);
        action = refreshed.value;
      }
    }
    const key = yield* signingKey(caller, person);
    const facts = recordFacts(action);
    const payload = yield* decodeUnsigned({
      v: 1,
      orgId: action.orgId,
      actionId: action.id,
      revision: action.revision,
      nonce: action.nonce,
      ...facts,
      approver: { humanId: key.humanId, kid: key.thumbprint },
      decision: "approve",
    });
    return { payload, resolved: action.resolved };
  }, Effect.mapError(internal));

  const rejectAction = Effect.fn("GrantVerifier.reject")(function* (
    caller: KinKeyCaller,
    input: KinApprovalsRejectInput,
  ) {
    const { action } = yield* actionFor(caller, input.actionId);
    const won = yield* actions.transition({
      orgId: action.orgId,
      actionId: action.id,
      revision: input.revision,
      to: "rejected",
      reason: "owner_rejected",
    });
    if (!won) return yield* fail("stale", "This action already changed; refresh the card.");
    yield* audit.append({
      orgId: action.orgId,
      event: "action_rejected",
      actionId: action.id,
      kind: action.kind,
      target: action.target,
      sessionId: caller.session.sessionId,
      provenance: action.provenance,
    });
    return { actionId: action.id, state: "rejected" as const };
  }, Effect.mapError(internal));

  return GrantVerifier.of({ challenge, submitGrant, reject: rejectAction });
});

export const layer = Layer.effect(GrantVerifier, make);
