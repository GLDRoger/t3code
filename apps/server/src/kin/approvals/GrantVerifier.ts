import {
  KinApprovalError,
  KinGrantUnsignedPayload,
  type AuthSessionId,
  type KinApprovalsActionInput,
  type KinApprovalsChallengeResult,
  type KinApprovalsDecisionResult,
  type KinApprovalsRejectInput,
  type KinApprovalsSubmitGrantInput,
  type KinApprovalView,
  type KinGrantRejectionReason,
  type KinOrgId,
  type KinPendingAction,
} from "@t3tools/contracts";
import { decodeKinGrant, verifyKinGrant } from "@t3tools/shared/kinGrant";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { ApproverKeys, type KinKeyCaller } from "./ApproverKeys.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { KinAuditAppendInput } from "./Audit.ts";
import { KinGrantAudit, KinLiveTargets, KinOrgRoles } from "./GrantPorts.ts";
import { grantMatchesRecord, pinsHead, recordFacts } from "./grantFacts.ts";
import { KinPendingActions, kinTargetDigest } from "./PendingActions.ts";

// Each kind of rejection gets its own budget per session and org a minute, so junk can't use up
// the budget that records forgeries against a real key. Past the budget, rejections are counted.
const AUDITS_PER_WINDOW = 20;
const JUNK_WINDOW = Duration.minutes(1);
type AuditBucket = "signed" | "junk" | "names_key";
const auditBucket = (
  reason: KinApprovalError["reason"],
  signatureVerified: boolean,
): AuditBucket =>
  signatureVerified
    ? "signed"
    : reason === "malformed" || reason === "unknown_key"
      ? "junk"
      : "names_key";

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

/** The lead an action concerns: a raise names its lead, anything else its requester. */
const leadOf = (action: KinPendingAction) =>
  action.target._tag === "level" ? action.target.agentId : action.requestedBy.agentId;

const headOf = (action: KinPendingAction) => {
  const resolved = action.resolved;
  return stableStringify({
    tag: resolved._tag,
    headSha: resolved._tag === "none" ? undefined : resolved.headSha,
    base: resolved._tag === "pull_request" ? resolved.base : undefined,
  });
};

/** What the rejection audit knows. `orgId` is the key's, set only once its signature verified. */
type Seen = {
  orgId?: KinOrgId;
  claimedOrgId?: KinOrgId;
  claim?: Pick<KinAuditAppendInput, "actionId" | "kind" | "grantJti" | "keyThumbprint" | "headSha">;
  /** The refusal is already on the audit chain. */
  audited?: boolean;
};

export class GrantVerifier extends Context.Service<
  GrantVerifier,
  {
    /** `get`: the full card for an approver, the redacted one for anyone else in the action's org. */
    readonly view: (
      caller: KinKeyCaller,
      input: KinApprovalsActionInput,
    ) => Effect.Effect<KinApprovalView, KinApprovalError>;
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
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Effect.scope;
  const junkWindows = new Map<string, { used: number; skipped: number }>();

  // Callers see a plain refusal; the cause is logged through the persistence error shape.
  const internal = (operation: string) => (cause: unknown) =>
    isKinApprovalError(cause)
      ? Effect.fail(cause)
      : Effect.logWarning(`${operation} failed`, toPersistenceSqlError(operation)(cause)).pipe(
          Effect.andThen(
            Effect.fail(
              new KinApprovalError({ reason: "unavailable", message: "Kin approvals failed." }),
            ),
          ),
        );

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
    seen.claimedOrgId = payload.orgId;
    seen.claim = {
      actionId: payload.actionId,
      kind: payload.kind,
      grantJti: payload.jti,
      keyThumbprint: header.kid,
      ...(payload.headSha === undefined ? {} : { headSha: payload.headSha }),
    };

    // 2. An active key in the grant's org, after session revocations. `attested` also needs the
    // seal the server wrote when it activated the key, so a row put straight into SQLite fails.
    const key = yield* keys.requireActive({ orgId: payload.orgId, thumbprint: header.kid });
    if (!key.attested) return yield* reject("unknown_key");

    // 2's kid binding, 3 and 8 are the shared pure check; its time_window waits for step 8.
    const now = yield* Clock.currentTimeMillis;
    const verified = verifyKinGrant({
      compact,
      publicJwk: key.publicJwk,
      nowEpochSeconds: now / 1000,
    });
    if (!verified.ok && verified.reason !== "time_window") return yield* reject(verified.reason);
    // The key's holder signed this, so its rejections may go in the key's org.
    seen.orgId = key.orgId;

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
    if (!grantMatchesRecord(payload, action)) return yield* reject("target_mismatch");

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

    // 10. Grant row and CAS in one transaction, against the row's own org and nonce. A refusal
    // here spends the verified-grant budget like any other; the slot is handed back on approval.
    const window = yield* auditWindow(action.orgId, caller.session.sessionId, "signed");
    const auditRefusal = window.used < AUDITS_PER_WINDOW;
    if (auditRefusal) window.used += 1;
    const release = Effect.sync(() => {
      if (auditRefusal) window.used -= 1;
    });
    const result = yield* actions
      .approve({
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
        sessionId: caller.session.sessionId,
        auditRefusal,
        ...(payload.headSha === undefined ? {} : { headSha: payload.headSha }),
      })
      .pipe(
        // Only a refusal keeps its slot; approval, failure and interruption hand it back.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) && exit.value._tag !== "approved" ? Effect.void : release,
        ),
      );
    if (result._tag === "approved") return { action, grant: result.grant };
    // `approve` wrote this refusal's `grant_rejected` on the action's own chain, or counted it.
    // Re-read the window: the one checked above may have closed while `approve` ran.
    if (!auditRefusal)
      (yield* auditWindow(action.orgId, caller.session.sessionId, "signed")).skipped += 1;
    seen.audited = true;
    return yield* reject(result._tag);
  });

  /** The window's skipped count is written when it ends, or when the server stops. */
  const openJunkWindow = (slot: string, orgId: KinOrgId, sessionId: AuthSessionId) => {
    const window = { used: 0, skipped: 0 };
    junkWindows.set(slot, window);
    const close = Effect.suspend(() => {
      junkWindows.delete(slot);
      return window.skipped === 0
        ? Effect.void
        : audit.append({
            orgId,
            event: "grant_rejected",
            sessionId,
            result: `${window.skipped} more not recorded`,
          });
    });
    return Effect.sleep(JUNK_WINDOW).pipe(
      Effect.ensuring(close),
      Effect.forkIn(scope),
      Effect.as(window),
    );
  };

  const auditWindow = (orgId: KinOrgId, sessionId: AuthSessionId, bucket: AuditBucket) =>
    Effect.suspend(() => {
      const slot = `${orgId} ${sessionId} ${bucket}`;
      const window = junkWindows.get(slot);
      return window === undefined ? openJunkWindow(slot, orgId, sessionId) : Effect.succeed(window);
    });

  const recordRejection = Effect.fn("GrantVerifier.recordRejection")(function* (
    caller: KinKeyCaller,
    seen: Seen,
    error: KinApprovalError,
  ) {
    const sessionId = caller.session.sessionId;
    // Before a signature verifies, the org named in the grant is only a claim: use the caller's.
    const orgId =
      seen.orgId ??
      (caller.people.find((person) => person.orgId === seen.claimedOrgId) ?? caller.people[0])
        ?.orgId;
    if (orgId === undefined) {
      // No org to chain it in: a session that is no person in Kin. Logged, never silent.
      return yield* Effect.logWarning("Kin grant rejected from a session with no Kin person.", {
        sessionId,
        reason: error.reason,
      });
    }
    const entry = {
      orgId,
      event: "grant_rejected" as const,
      ...seen.claim,
      sessionId,
      result: error.reason,
    };
    const window = yield* auditWindow(
      orgId,
      sessionId,
      auditBucket(error.reason, seen.orgId !== undefined),
    );
    if (window.used >= AUDITS_PER_WINDOW) {
      window.skipped += 1;
      return;
    }
    window.used += 1;
    yield* audit.append(entry);
  });

  const submitGrant = Effect.fn("GrantVerifier.submitGrant")(function* (
    caller: KinKeyCaller,
    input: KinApprovalsSubmitGrantInput,
  ) {
    const seen: Seen = {};
    // `grant_accepted` is written by `approve`, in the transaction that approves.
    const { action } = yield* check(caller, input.compact, seen).pipe(
      Effect.catch(internal("GrantVerifier.submitGrant")),
      Effect.tapError((error) =>
        seen.audited ? Effect.void : recordRejection(caller, seen, error),
      ),
    );
    return { actionId: action.id, state: "approved" as const };
  });

  /**
   * The new key a `device_key` card shows, only while the server vouches for it: registration's
   * pending seal verifies (or, once active, its seal) and its hardware is what the card names.
   */
  const newKey = Effect.fn("GrantVerifier.newKey")(function* (action: KinPendingAction) {
    if (action.target._tag !== "device_key") return undefined;
    const target = action.target;
    const key = yield* keys.get({ orgId: action.orgId, thumbprint: target.thumbprint });
    if (Option.isNone(key)) return undefined;
    const { state, attested, hardware, deviceLabel } = key.value;
    if (state === "revoked" || !attested || hardware !== target.hardware) return undefined;
    return { hardware: target.hardware, label: deviceLabel.trim() || undefined };
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

  const challenge = Effect.fn("GrantVerifier.challenge")(
    function* (caller: KinKeyCaller, input: KinApprovalsActionInput) {
      const { action: found, person } = yield* actionFor(caller, input.actionId);
      const now = yield* Clock.currentTimeMillis;
      if (found.state !== "awaiting_approval" || DateTime.toEpochMillis(found.expiresAt) <= now)
        return yield* fail("invalid_state", "This action isn't waiting for approval.");
      if (found.target._tag === "device_key" && (yield* newKey(found)) === undefined)
        return yield* fail(
          "invalid_state",
          "Kin can't vouch for this phone's key. Decline it, then set up the new phone again.",
        );
      let action = found;
      let resolved = found.resolved;
      if (pinsHead(found.kind)) {
        resolved = yield* readLive(found);
        // Rotate only on what check 9 compares; checks or size moving would only void a good grant.
        if (headOf({ ...found, resolved }) !== headOf(found)) {
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
      return { payload, resolved };
    },
    Effect.catch(internal("GrantVerifier.challenge")),
  );

  const displayName = Effect.fn("GrantVerifier.displayName")(function* (
    table: "kin_people" | "kin_agents",
    orgId: KinOrgId,
    id: string,
  ) {
    const [row] =
      table === "kin_people"
        ? yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
            WHERE org_id = ${orgId} AND person_id = ${id} ORDER BY person_id LIMIT 1`
        : yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_agents
            WHERE org_id = ${orgId} AND agent_id = ${id} ORDER BY agent_id LIMIT 1`;
    return row?.name.trim() || undefined;
  });

  /** The person the card waits on: the owner of the lead it concerns (phase 1's only approver). */
  const ownerName = Effect.fn("GrantVerifier.ownerName")(function* (action: KinPendingAction) {
    const lead = leadOf(action);
    const [row] = yield* sql<{ name: string }>`SELECT p.display_name AS name FROM kin_agents a
      JOIN kin_people p ON p.org_id = a.org_id AND p.person_id = a.owner_person_id
      WHERE a.org_id = ${action.orgId} AND a.agent_id = ${lead}
      ORDER BY a.agent_id, p.person_id LIMIT 1`;
    return row?.name.trim() || undefined;
  });

  const view = Effect.fn("GrantVerifier.view")(
    function* (caller: KinKeyCaller, input: KinApprovalsActionInput) {
      for (const person of caller.people) {
        const found = yield* actions.get({ orgId: person.orgId, actionId: input.actionId });
        if (Option.isNone(found)) continue;
        const action = found.value;
        if (yield* roles.isOwner(person)) {
          const leadName = yield* displayName("kin_agents", action.orgId, leadOf(action));
          const after = action.provenance.afterNonOwnerMessage;
          const afterNonOwnerName =
            after === undefined
              ? undefined
              : yield* displayName("kin_people", action.orgId, after.humanId);
          const vouched = yield* newKey(action);
          return {
            _tag: "full" as const,
            action,
            canApprove: true as const,
            ...(leadName === undefined ? {} : { leadName }),
            ...(afterNonOwnerName === undefined ? {} : { afterNonOwnerName }),
            ...(vouched === undefined ? {} : { keyHardware: vouched.hardware }),
            ...(vouched?.label === undefined ? {} : { keyDeviceLabel: vouched.label }),
          };
        }
        // Anyone else sees what waits and on whom, never the facts a challenge would sign.
        const pr = action.target._tag === "pull_request" ? action.target : undefined;
        return {
          _tag: "redacted" as const,
          actionId: action.id,
          orgId: action.orgId,
          kind: action.kind,
          repo:
            action.target._tag === "pull_request" || action.target._tag === "branch"
              ? action.target.repo
              : null,
          number: pr?.number ?? null,
          title: action.resolved._tag === "pull_request" ? action.resolved.title : null,
          state: action.state,
          waitingOn: (yield* ownerName(action)) ?? "the owner",
          canApprove: false as const,
        };
      }
      return yield* fail("not_found", "No such action.");
    },
    Effect.catch(internal("GrantVerifier.view")),
  );

  const rejectAction = Effect.fn("GrantVerifier.reject")(
    function* (caller: KinKeyCaller, input: KinApprovalsRejectInput) {
      const { action } = yield* actionFor(caller, input.actionId);
      if (
        action.state === "awaiting_approval" &&
        DateTime.toEpochMillis(action.expiresAt) <= (yield* Clock.currentTimeMillis)
      ) {
        const expired = yield* actions.transition({
          orgId: action.orgId,
          actionId: action.id,
          revision: action.revision,
          to: "expired",
          reason: "expired",
          sessionId: caller.session.sessionId,
        });
        // An approve that landed first wins; say so rather than claim it expired.
        if (!expired) return yield* fail("stale", "This action already changed; refresh the card.");
        return yield* fail("invalid_state", "This action expired.");
      }
      const won = yield* actions.transition({
        orgId: action.orgId,
        actionId: action.id,
        revision: input.revision,
        to: "rejected",
        reason: "owner_rejected",
        sessionId: caller.session.sessionId,
      });
      // `transition` writes `action_rejected` in the same transaction.
      if (!won) return yield* fail("stale", "This action already changed; refresh the card.");
      return { actionId: action.id, state: "rejected" as const };
    },
    Effect.catch(internal("GrantVerifier.reject")),
  );

  return GrantVerifier.of({ view, challenge, submitGrant, reject: rejectAction });
});

export const layer = Layer.effect(GrantVerifier, make);
