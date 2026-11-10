// @effect-diagnostics nodeBuiltinImport:off -- synchronous SHA-256 and constant-time compares.
import * as NodeCrypto from "node:crypto";

import {
  KinActionId,
  KinActionTarget,
  KinAgentId,
  KinApprovalError,
  KinEventId,
  ThreadId,
  type AuthSessionId,
  type KinApprovalsKeyChallengeResult,
  type KinApprovalsKeyInput,
  type KinApprovalsListKeysResult,
  type KinApprovalsOrgInput,
  type KinApprovalsRegisterKeyInput,
  type KinApprovalsRegisterKeyResult,
  type KinApproverKey,
  type KinKeyThumbprint,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import { computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { proofKeyRevoked } from "../auth/ProofKeySessions.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import {
  internal,
  makeKeyStore,
  sealFields,
  type KeyRef,
  type KeyRow,
} from "./ApproverKeyStore.ts";
import { KinAttestationTrust } from "./attestation/AttestationTrust.ts";
import {
  verifyAndroidKeyAttestation,
  verifyAppleAppAttest,
  type AttestationResult,
} from "./attestation/verify.ts";
import {
  KIN_APPROVER_KEYS_REQUESTER,
  KinPendingActions,
  kinTargetDigest,
} from "./PendingActions.ts";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type KinKeyCaller = {
  readonly session: AuthenticatedSession;
  readonly people: ReadonlyArray<PersonIdentity>;
};

const decodeEventId = Schema.decodeEffect(KinEventId);
const decodeTarget = Schema.decodeUnknownEffect(KinActionTarget);
const isActionId = Schema.is(KinActionId);

const SERVER_REQUESTER = {
  agentId: Schema.decodeSync(KinAgentId)(KIN_APPROVER_KEYS_REQUESTER),
  threadId: Schema.decodeSync(ThreadId)(KIN_APPROVER_KEYS_REQUESTER),
};

const fail = (reason: KinApprovalError["reason"], message: string) =>
  Effect.fail(new KinApprovalError({ reason, message }));

const sameBytes = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

/** Spec section 4: six digits from `sha256(thumbprint ‖ serverNonce)`; the nonce is the challenge. */
export const kinKeyConfirmationCode = (thumbprint: string, challenge: Uint8Array) => {
  const digest = NodeCrypto.createHash("sha256").update(thumbprint).update(challenge).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
};

export class ApproverKeys extends Context.Service<
  ApproverKeys,
  {
    readonly keyChallenge: (
      caller: KinKeyCaller,
    ) => Effect.Effect<KinApprovalsKeyChallengeResult, KinApprovalError>;
    /** Stores the key `pending`; the host's `kin approvals confirm-key` CLI confirms the first. */
    readonly registerKey: (
      caller: KinKeyCaller,
      input: KinApprovalsRegisterKeyInput,
    ) => Effect.Effect<KinApprovalsRegisterKeyResult, KinApprovalError>;
    readonly listKeys: (
      caller: KinKeyCaller,
      input: KinApprovalsOrgInput,
    ) => Effect.Effect<KinApprovalsListKeysResult, KinApprovalError>;
    readonly revokeKey: (
      caller: KinKeyCaller,
      input: KinApprovalsKeyInput,
    ) => Effect.Effect<KinApproverKey, KinApprovalError>;
    /** What grant verification and the executor trust: the key, after session revocations. */
    readonly get: (ref: KeyRef) => Effect.Effect<Option.Option<KinApproverKey>, KinApprovalError>;
    /** Grant check 2: an `active` key in the org, else `unknown_key` or `revoked_key`. */
    readonly requireActive: (ref: KeyRef) => Effect.Effect<KinApproverKey, KinApprovalError>;
    /** The `register_approver_key` handler's step, only after a verified grant. */
    readonly activateByGrant: (ref: KeyRef) => Effect.Effect<boolean, KinApprovalError>;
    /** Revokes keys whose T3 session was revoked. Returns how many. */
    /** One org, or every org at startup: sessions are environment-local (the `kin_auth_*` exception). */
    readonly reconcileSessions: (
      orgId: KinOrgId | undefined,
    ) => Effect.Effect<number, KinApprovalError>;
    /** People holding an `active` key in the org: the only ones approval pushes reach. */
    readonly activeApprovers: (
      orgId: KinOrgId,
    ) => Effect.Effect<ReadonlyArray<KinPersonId>, KinApprovalError>;
  }
>()("t3/kin/approvals/ApproverKeys") {}

const make = Effect.gen(function* () {
  const trust = yield* KinAttestationTrust;
  const actions = yield* KinPendingActions;
  const store = yield* makeKeyStore;
  const { sql, seal, toKey, select, hasActiveKey } = store;
  // Single-use, session-bound, short-lived: memory is enough, and a restart only means retrying.
  const challenges = new Map<
    AuthSessionId,
    { readonly challenge: string; readonly expiresAt: number }
  >();

  const personIn = (caller: KinKeyCaller, orgId: KinOrgId) => {
    const person = caller.people.find((candidate) => candidate.orgId === orgId);
    return person === undefined
      ? fail("not_owner", "Only a person in this org can manage its approver keys.")
      : Effect.succeed(person);
  };

  const reconcileSessions = Effect.fn("ApproverKeys.reconcileSessions")(
    function* (orgId: KinOrgId | undefined) {
      return yield* store.reconcileSessions(orgId);
    },
    Effect.catch(internal("ApproverKeys.reconcileSessions")),
  );

  const keyChallenge = Effect.fn("ApproverKeys.keyChallenge")(function* (caller: KinKeyCaller) {
    if (caller.people.length === 0)
      return yield* fail("not_owner", "Only a person can register an approver key.");
    const now = yield* Clock.currentTimeMillis;
    for (const [sessionId, entry] of challenges) {
      if (entry.expiresAt <= now) challenges.delete(sessionId);
    }
    const challenge = Base64Url.encode(SecureRandom.randomBytesUnsafe(32));
    const expiresAt = now + CHALLENGE_TTL_MS;
    challenges.set(caller.session.sessionId, { challenge, expiresAt });
    return { challenge, expiresAt: DateTime.makeUnsafe(expiresAt) };
  });

  const attest = Effect.fn("ApproverKeys.attest")(function* (
    input: KinApprovalsRegisterKeyInput,
    challenge: Uint8Array,
  ) {
    const attestation = input.attestation;
    const format = input.platform === "android" ? "android-key" : "apple-app-attest";
    if (attestation === undefined || attestation.format !== format)
      return { attested: false, reason: `no ${format} attestation` } satisfies AttestationResult;
    const loaded = yield* trust
      .load(input.platform)
      .pipe(
        Effect.mapError(
          (error) => new KinApprovalError({ reason: "unavailable", message: error.message }),
        ),
      );
    const now = yield* Clock.currentTimeMillis;
    const common = { challenge, publicJwk: input.publicJwk, trust: loaded, now };
    return attestation.format === "android-key"
      ? verifyAndroidKeyAttestation({ ...common, certificateChain: attestation.certificateChain })
      : verifyAppleAppAttest({
          ...common,
          keyId: attestation.keyId,
          attestationObject: attestation.attestationObject,
        });
  });

  const registerKey = Effect.fn("ApproverKeys.registerKey")(
    function* (caller: KinKeyCaller, input: KinApprovalsRegisterKeyInput) {
      const person = yield* personIn(caller, input.orgId);
      const now = yield* Clock.currentTimeMillis;
      const issued = challenges.get(caller.session.sessionId);
      challenges.delete(caller.session.sessionId);
      if (
        issued === undefined ||
        issued.expiresAt <= now ||
        !sameBytes(issued.challenge, input.challenge)
      )
        return yield* fail("bad_challenge", "Ask for a new key challenge on this connection.");
      const challenge = new Uint8Array(Buffer.from(input.challenge, "base64url"));
      yield* reconcileSessions(input.orgId);
      // Mobile keeps one DPoP key per install, so a repaired revocation must not lock it out.
      const proofKey = caller.session.proofKeyThumbprint;
      if (proofKey !== undefined) {
        const [seen] = yield* sql<{
          revoked: number;
        }>`SELECT ${proofKeyRevoked(sql, proofKey)} AS revoked`;
        if (seen?.revoked === 1)
          return yield* fail(
            "invalid_state",
            "This phone was signed out. Ask the owner to restore it, then try again.",
          );
      }

      const thumbprint = computeDpopJwkThumbprint(input.publicJwk) as KinKeyThumbprint;
      const result = yield* attest(input, challenge);
      if (!result.attested) {
        yield* Effect.logWarning("Kin approver key isn't attested; it can't be activated.", {
          platform: input.platform,
          reason: result.reason,
        });
      }
      const row: KeyRow = {
        thumbprint,
        org_id: input.orgId,
        public_jwk_json: stableStringify(input.publicJwk),
        human_id: person.personId,
        device_label: input.deviceLabel,
        platform: input.platform,
        hardware: result.attested ? result.hardware : "software",
        attested: result.attested ? 1 : 0,
        session_id: caller.session.sessionId,
        // Relay sessions renew hourly under a new id; this DPoP key stays (spec section 4).
        proof_key_thumbprint: caller.session.proofKeyThumbprint ?? null,
        state: "pending",
        created_at: now,
        confirmed_at: null,
        revoked_at: null,
        seal: null,
      };
      const key = yield* toKey(row);
      const code = kinKeyConfirmationCode(thumbprint, challenge);
      const target = result.attested
        ? yield* decodeTarget({
            _tag: "device_key",
            thumbprint,
            hardware: result.hardware,
            attested: true,
          })
        : undefined;
      const source = yield* decodeEventId(`approver_key:${thumbprint}:${input.challenge}`);
      const inserted = yield* sql.withTransaction(
        Effect.gen(function* () {
          // An attestation is bound to the challenge given when the key was made, so a key never
          // registers twice; refusing keeps anyone from rewriting a pending key's record.
          const fresh = yield* sql`INSERT INTO kin_approver_keys ${sql.insert(row)}
            ON CONFLICT (org_id, thumbprint) DO NOTHING RETURNING thumbprint`;
          if (fresh.length === 0 || target === undefined) return fresh.length > 0;
          // Only an attested key gets a code the host can confirm, first key or recovery.
          yield* store.saveConfirmation({
            row,
            sessionId: caller.session.sessionId,
            challenge,
            code,
            now,
          });
          if (!(yield* hasActiveKey(input.orgId))) return true;
          // Later keys need a grant from an existing key (spec section 4, step 3).
          yield* actions.create({
            orgId: input.orgId,
            kind: "register_approver_key",
            target,
            resolved: { _tag: "none" },
            targetDigest: kinTargetDigest("register_approver_key", target, { _tag: "none" }),
            reason: `Add approver key for "${input.deviceLabel}".`,
            requestedBy: SERVER_REQUESTER,
            provenance: {
              startedBy: { humanId: person.personId },
              // `KinIdentity.resolve` yields only the org owner until CHAT-11 adds roles (spec, Interfaces).
              startedByRole: "owner",
              chain: [{ kind: "approver_key", id: thumbprint, authorRole: "owner" }],
              ceilingBelowOwner: false,
            },
            source,
          });
          return true;
        }),
      );
      if (!inserted)
        return yield* fail(
          "invalid_state",
          "This key is already registered; make a new key on the phone.",
        );
      return { key, code };
    },
    Effect.catch(internal("ApproverKeys.registerKey")),
  );

  const listKeys = Effect.fn("ApproverKeys.listKeys")(
    function* (caller: KinKeyCaller, input: KinApprovalsOrgInput) {
      yield* personIn(caller, input.orgId);
      yield* reconcileSessions(input.orgId);
      const rows = yield* sql<KeyRow>`SELECT * FROM kin_approver_keys
        WHERE org_id = ${input.orgId} ORDER BY created_at, thumbprint`;
      // A new phone's card: the owner's active phone approves it from its Approvals screen.
      const pending = yield* sql<{ action_id: string; thumbprint: KinKeyThumbprint }>`
        SELECT a.action_id, k.thumbprint FROM kin_pending_actions a
        JOIN kin_approver_keys k ON k.org_id = a.org_id
          AND k.thumbprint = json_extract(a.target_json, '$.thumbprint')
        WHERE a.org_id = ${input.orgId} AND a.kind = 'register_approver_key'
          AND a.state = 'awaiting_approval' AND k.state = 'pending'
        ORDER BY a.created_at, a.action_id`;
      return {
        keys: yield* Effect.forEach(rows, toKey),
        enrolments: pending.flatMap((row) =>
          isActionId(row.action_id)
            ? [{ thumbprint: row.thumbprint, actionId: row.action_id }]
            : [],
        ),
      };
    },
    Effect.catch(internal("ApproverKeys.listKeys")),
  );

  const revokeKey = Effect.fn("ApproverKeys.revokeKey")(
    function* (caller: KinKeyCaller, input: KinApprovalsKeyInput) {
      const person = yield* personIn(caller, input.orgId);
      const row = yield* select(input);
      if (row === undefined) return yield* fail("not_found", "No such approver key.");
      if (row.human_id !== person.personId)
        return yield* fail("not_owner", "Only the key's owner can revoke it.");
      const revoked = yield* store.revokeRow(input, "key_revoked");
      return yield* toKey(revoked ?? row);
    },
    Effect.catch(internal("ApproverKeys.revokeKey")),
  );

  const get = Effect.fn("ApproverKeys.get")(
    function* (ref: KeyRef) {
      yield* reconcileSessions(ref.orgId);
      const row = yield* select(ref);
      return row === undefined ? Option.none() : Option.some(yield* toKey(row));
    },
    Effect.catch(internal("ApproverKeys.get")),
  );

  const requireActive = Effect.fn("ApproverKeys.requireActive")(function* (ref: KeyRef) {
    const key = yield* get(ref);
    if (Option.isNone(key) || key.value.state === "pending")
      return yield* fail("unknown_key", "No active approver key with this id.");
    if (key.value.state === "revoked")
      return yield* fail("revoked_key", "This approver key was revoked.");
    return key.value;
  });

  const activateByGrant = Effect.fn("ApproverKeys.activateByGrant")(
    function* (ref: KeyRef) {
      yield* reconcileSessions(ref.orgId);
      const now = yield* Clock.currentTimeMillis;
      const row = yield* select(ref);
      if (row === undefined || row.state !== "pending" || row.attested !== 1) return false;
      return (yield* store.activate(row, now, false)) !== undefined;
    },
    Effect.catch(internal("ApproverKeys.activateByGrant")),
  );

  const activeApprovers = Effect.fn("ApproverKeys.activeApprovers")(
    function* (orgId: KinOrgId) {
      yield* reconcileSessions(orgId);
      const rows = yield* sql<{ human_id: KinPersonId }>`SELECT DISTINCT human_id
        FROM kin_approver_keys WHERE org_id = ${orgId} AND state = 'active' ORDER BY human_id`;
      return rows.map((row) => row.human_id);
    },
    Effect.catch(internal("ApproverKeys.activeApprovers")),
  );

  yield* reconcileSessions(undefined).pipe(
    Effect.catch((error) => Effect.logError("Kin approver key reconciliation failed.", error)),
  );

  // Keys active before the seal shipped were activated by this server; seal them once. Later
  // starts never do, so a row written into SQLite afterwards stays unsealed.
  const adoptLegacyKeys = Effect.gen(function* () {
    const rows = yield* sql<KeyRow>`SELECT * FROM kin_approver_keys
      WHERE state = 'active' AND attested = 1 AND seal IS NULL ORDER BY org_id, thumbprint`;
    for (const row of rows) {
      yield* sql`UPDATE kin_approver_keys SET seal = ${seal.seal(sealFields(row))}
        WHERE org_id = ${row.org_id} AND thumbprint = ${row.thumbprint} AND seal IS NULL`;
    }
    return rows.length;
  });
  yield* seal
    .adoptOnce(adoptLegacyKeys)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          "Kin couldn't seal existing approver keys; it retries at the next start.",
          cause,
        ),
      ),
    );

  return ApproverKeys.of({
    keyChallenge,
    registerKey,
    listKeys,
    revokeKey,
    get,
    requireActive,
    activateByGrant,
    reconcileSessions,
    activeApprovers,
  });
});

export const layer = Layer.effect(ApproverKeys, make);
