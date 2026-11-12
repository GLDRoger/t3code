// @effect-diagnostics nodeBuiltinImport:off -- constant-time compares.
import * as NodeCrypto from "node:crypto";

import {
  AuthKinChatScope,
  KIN_APPROVER_ENROLMENT_VERSION,
  KinApprovalError,
  type AuthSessionId,
  type KinActionId,
  type KinApprovalsKeyChallengeResult,
  type KinApprovalsKeyInput,
  type KinApprovalsListKeysResult,
  type KinApprovalsOrgInput,
  type KinApprovalsRegisterKeyInput,
  type KinApprovalsRegisterKeyResult,
  type KinApproverKey,
  type KinApproverKeyPlatform,
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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { proofKeyRevoked } from "../auth/ProofKeySessions.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import {
  MAX_ACTIVE_KEYS,
  internal,
  makeKeyStore,
  sealFields,
  type KeyRef,
  type KeyRow,
} from "./ApproverKeyStore.ts";
import { KinAudit } from "./Audit.ts";
import { KinKeyNotices, type KinKeyChange } from "./ExecutionNotices.ts";
import { KinOrgRoles } from "./GrantPorts.ts";
import { KinAttestationTrust } from "./attestation/AttestationTrust.ts";
import {
  verifyAndroidKeyAttestation,
  verifyAppleAppAttest,
  type AttestationResult,
} from "./attestation/verify.ts";
import { KinPendingActions } from "./PendingActions.ts";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Why the phone-to-phone requests from before one-step set-up closed. */
const PHONE_APPROVAL_RETIRED = "phone_approval_retired";
const ACTIVITY_SHOWN = 5;

export type KinKeyCaller = {
  readonly session: AuthenticatedSession;
  readonly people: ReadonlyArray<PersonIdentity>;
};

const fail = (reason: KinApprovalError["reason"], message: string) =>
  Effect.fail(new KinApprovalError({ reason, message }));

const sameBytes = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

const APP_NAME: Record<KinApproverKeyPlatform, string> = {
  ios: "KIN_IOS_APP_ID",
  android: "KIN_ANDROID_PACKAGE",
};

export class ApproverKeys extends Context.Service<
  ApproverKeys,
  {
    readonly keyChallenge: (
      caller: KinKeyCaller,
    ) => Effect.Effect<KinApprovalsKeyChallengeResult, KinApprovalError>;
    /** The owner's phone, proven genuine by attestation, can approve as soon as this returns. */
    readonly registerKey: (
      caller: KinKeyCaller,
      input: KinApprovalsRegisterKeyInput,
    ) => Effect.Effect<KinApprovalsRegisterKeyResult, KinApprovalError>;
    /** Owner only: the keys that can approve, and the latest changes. */
    readonly listKeys: (
      caller: KinKeyCaller,
      input: KinApprovalsOrgInput,
    ) => Effect.Effect<KinApprovalsListKeysResult, KinApprovalError>;
    /** Remove, from any of the owner's sessions. */
    readonly revokeKey: (
      caller: KinKeyCaller,
      input: KinApprovalsKeyInput,
    ) => Effect.Effect<KinApproverKey, KinApprovalError>;
    /** What grant verification and the executor trust: the key, after session revocations. */
    readonly get: (ref: KeyRef) => Effect.Effect<Option.Option<KinApproverKey>, KinApprovalError>;
    /** Grant check 2: an `active` key in the org, else `unknown_key` or `revoked_key`. */
    readonly requireActive: (ref: KeyRef) => Effect.Effect<KinApproverKey, KinApprovalError>;
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
  const roles = yield* KinOrgRoles;
  const audit = yield* KinAudit;
  const notices = yield* KinKeyNotices;
  const store = yield* makeKeyStore;
  const { sql, seal, toKey, select } = store;
  // Single-use, session-bound, short-lived: memory is enough, and a restart only means retrying.
  const challenges = new Map<
    AuthSessionId,
    { readonly challenge: string; readonly expiresAt: number }
  >();

  /**
   * Approver keys are the owner's alone in phase 1 (spec section 3), checked against stored rows.
   * Shared and guest sessions reach a person through the chat scope and never manage keys.
   */
  const ownerIn = Effect.fn("ApproverKeys.ownerIn")(function* (
    caller: KinKeyCaller,
    orgId: KinOrgId,
  ) {
    const person = caller.people.find((candidate) => candidate.orgId === orgId);
    if (
      person === undefined ||
      caller.session.scopes.includes(AuthKinChatScope) ||
      !(yield* roles.isOwner(person))
    )
      return yield* fail("not_owner", "Only the owner chooses the phones that approve for Kin.");
    return person;
  });

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
    const configured =
      input.platform === "android" ? loaded.androidApps.length > 0 : loaded.appleAppIds.length > 0;
    if (!configured)
      return yield* fail(
        "unattested",
        `This Kin host can't recognise the Kin app yet, so it can't add phones. Set ${APP_NAME[input.platform]} in the host's service.env, restart Kin, then try again.`,
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

  /** A lost answer retried from the same session gets the stored key; anything else is refused. */
  const retried = Effect.fn("ApproverKeys.retried")(function* (
    caller: KinKeyCaller,
    input: KinApprovalsRegisterKeyInput,
    row: KeyRow,
  ) {
    if (
      row.state === "active" &&
      row.session_id === caller.session.sessionId &&
      row.public_jwk_json === stableStringify(input.publicJwk) &&
      row.device_label === input.deviceLabel &&
      row.platform === input.platform
    )
      return row;
    return yield* fail(
      "invalid_state",
      "This key is already registered. Tap Set up approvals again to make a new one.",
    );
  });

  const notify = (row: KeyRow, change: KinKeyChange["change"], at: number, lastKey: boolean) =>
    notices.changed({
      orgId: row.org_id as KinOrgId,
      ownerPersonId: row.human_id as KinPersonId,
      thumbprint: row.thumbprint as KinKeyThumbprint,
      deviceLabel: row.device_label,
      platform: row.platform,
      change,
      at,
      lastKey,
    });

  const registerKey = Effect.fn("ApproverKeys.registerKey")(
    function* (caller: KinKeyCaller, input: KinApprovalsRegisterKeyInput) {
      // Older apps expect a code back and discard their key without one. They show the host's
      // text only for `unavailable`, up to 200 characters.
      if (input.enrolmentVersion !== KIN_APPROVER_ENROLMENT_VERSION)
        return yield* fail(
          "unavailable",
          "This version of the Kin app can't set up approvals any more. Please update the Kin app, then try again.",
        );
      // Answered early here; the write below checks again against the rows it commits with.
      yield* ownerIn(caller, input.orgId);
      const thumbprint = computeDpopJwkThumbprint(input.publicJwk) as KinKeyThumbprint;
      const stored = yield* select({ orgId: input.orgId, thumbprint });
      if (stored !== undefined) return { key: yield* toKey(yield* retried(caller, input, stored)) };

      const now = yield* Clock.currentTimeMillis;
      const issued = challenges.get(caller.session.sessionId);
      challenges.delete(caller.session.sessionId);
      if (
        issued === undefined ||
        issued.expiresAt <= now ||
        !sameBytes(issued.challenge, input.challenge)
      )
        return yield* fail("bad_challenge", "That took too long. Tap Set up approvals again.");
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
            "This phone was signed out of Kin. Pair it again, then set up approvals.",
          );
      }

      // Only the genuine Kin app on a real device passes this, so nothing on the host can enrol.
      const result = yield* attest(input, challenge);
      if (!result.attested) {
        yield* Effect.logWarning("Kin refused an approver key without trusted attestation.", {
          platform: input.platform,
          reason: result.reason,
        });
        return yield* fail(
          "unattested",
          "Kin couldn't confirm this is the Kin app on a real phone, so it didn't add this phone. Approvals need the Kin app from the App Store or Google Play, on a phone with Face ID or a fingerprint set up.",
        );
      }
      const hardware = result.hardware;

      const row = yield* sql.withTransaction(
        Effect.gen(function* () {
          const person = yield* ownerIn(caller, input.orgId);
          if ((yield* store.activeCount(input.orgId)) >= MAX_ACTIVE_KEYS)
            return yield* fail(
              "too_many_keys",
              `${MAX_ACTIVE_KEYS} phones can already approve. Remove one in Settings, then Approvals, and try again.`,
            );
          const unsealed: KeyRow = {
            thumbprint,
            org_id: input.orgId,
            public_jwk_json: stableStringify(input.publicJwk),
            human_id: person.personId,
            device_label: input.deviceLabel,
            platform: input.platform,
            hardware,
            attested: 1,
            session_id: caller.session.sessionId,
            // Relay sessions renew hourly under a new id; this DPoP key stays (spec section 4).
            proof_key_thumbprint: caller.session.proofKeyThumbprint ?? null,
            state: "active",
            created_at: now,
            confirmed_at: now,
            revoked_at: null,
            seal: null,
          };
          const sealed: KeyRow = { ...unsealed, seal: seal.seal(sealFields(unsealed)) };
          const [fresh] = yield* sql<KeyRow>`INSERT INTO kin_approver_keys ${sql.insert(sealed)}
            ON CONFLICT (org_id, thumbprint) DO NOTHING RETURNING *`;
          if (fresh === undefined) {
            const raced = yield* select({ orgId: input.orgId, thumbprint });
            if (raced === undefined)
              return yield* fail("invalid_state", "This key was already used. Try again.");
            return yield* retried(caller, input, raced);
          }
          yield* audit.append({
            orgId: input.orgId,
            event: "key_registered",
            keyThumbprint: thumbprint,
            deviceLabel: input.deviceLabel,
            sessionId: caller.session.sessionId,
            result: "set up on the phone; can approve",
          });
          yield* notify(fresh, "added", now, false);
          return fresh;
        }),
      );
      return { key: yield* toKey(row) };
    },
    Effect.catch(internal("ApproverKeys.registerKey")),
  );

  const listKeys = Effect.fn("ApproverKeys.listKeys")(
    function* (caller: KinKeyCaller, input: KinApprovalsOrgInput) {
      yield* ownerIn(caller, input.orgId);
      yield* reconcileSessions(input.orgId);
      const rows = yield* sql<KeyRow & { last_used_at: number | null }>`SELECT k.*,
          (SELECT MAX(g.accepted_at) FROM kin_grants g
            WHERE g.org_id = k.org_id AND g.key_thumbprint = k.thumbprint) AS last_used_at
        FROM kin_approver_keys k
        WHERE k.org_id = ${input.orgId} AND k.state = 'active'
        ORDER BY k.confirmed_at, k.thumbprint`;
      // Only keys that could approve: one closed before it ever could was never a change.
      const activity = yield* sql<{
        change: "added" | "removed";
        at: number;
        deviceLabel: string;
        platform: KinApproverKeyPlatform;
      }>`SELECT change, at, device_label AS "deviceLabel", platform FROM (
          SELECT 'added' AS change, confirmed_at AS at, device_label, platform, thumbprint
          FROM kin_approver_keys WHERE org_id = ${input.orgId} AND confirmed_at IS NOT NULL
          UNION ALL
          SELECT 'removed' AS change, revoked_at AS at, device_label, platform, thumbprint
          FROM kin_approver_keys WHERE org_id = ${input.orgId} AND confirmed_at IS NOT NULL
            AND revoked_at IS NOT NULL)
        ORDER BY at DESC, change DESC, thumbprint LIMIT ${ACTIVITY_SHOWN}`;
      return {
        keys: yield* Effect.forEach(rows, (row) => toKey(row, row.last_used_at)),
        activity: activity.map((entry) => ({ ...entry, at: DateTime.makeUnsafe(entry.at) })),
      };
    },
    Effect.catch(internal("ApproverKeys.listKeys")),
  );

  const revokeKey = Effect.fn("ApproverKeys.revokeKey")(
    function* (caller: KinKeyCaller, input: KinApprovalsKeyInput) {
      const row = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* ownerIn(caller, input.orgId);
          const found = yield* select(input);
          if (found === undefined) return yield* fail("not_found", "No such phone.");
          if (found.state === "revoked") return found;
          const revoked = yield* store.revokeRow(input, "key_revoked");
          if (revoked === undefined) return found;
          yield* audit.append({
            orgId: input.orgId,
            event: "key_revoked",
            keyThumbprint: input.thumbprint,
            deviceLabel: found.device_label,
            sessionId: caller.session.sessionId,
            result: "removed by the owner",
          });
          const lastKey = (yield* store.activeCount(input.orgId)) === 0;
          yield* notify(revoked, "removed", revoked.revoked_at ?? 0, lastKey);
          return revoked;
        }),
      );
      return yield* toKey(row);
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
    if (Option.isNone(key))
      return yield* fail("unknown_key", "No active approver key with this id.");
    if (key.value.state === "revoked")
      return yield* fail("revoked_key", "This approver key was revoked.");
    return key.value;
  });

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

  // A new phone used to be approved from another phone. Those requests close, audited, expired
  // or not; none are made any more, so later starts find nothing.
  const closePhoneApprovals = Effect.gen(function* () {
    // A startup scan across orgs, like `reconcileSessions(undefined)`.
    const rows = yield* sql<{ orgId: KinOrgId; actionId: KinActionId; revision: number }>`
      SELECT org_id AS "orgId", action_id AS "actionId", revision FROM kin_pending_actions
      WHERE kind = 'register_approver_key' AND state IN ('awaiting_approval', 'approved')
      ORDER BY org_id, action_id`;
    for (const row of rows) yield* actions.retire({ ...row, reason: PHONE_APPROVAL_RETIRED });
  });
  yield* closePhoneApprovals.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Kin couldn't close phone-to-phone key requests; retries next start.", cause),
    ),
  );

  // A key still waiting to be allowed in Settings never activates now: it ran out, audited, and
  // the phone simply sets up again. Later starts find nothing.
  const runOutWaitingKeys = Effect.gen(function* () {
    // A startup scan across orgs, like `reconcileSessions(undefined)`.
    const rows = yield* sql<{ orgId: KinOrgId; thumbprint: KinKeyThumbprint }>`
      SELECT org_id AS "orgId", thumbprint FROM kin_approver_keys WHERE state = 'pending'
      ORDER BY org_id, created_at, thumbprint`;
    for (const row of rows)
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const [closed] = yield* sql<{ device_label: string }>`UPDATE kin_approver_keys
            SET state = 'revoked', revoked_at = ${now}, seal = NULL
            WHERE org_id = ${row.orgId} AND thumbprint = ${row.thumbprint} AND state = 'pending'
            RETURNING device_label`;
          if (closed === undefined) return;
          yield* sql`DELETE FROM kin_approver_key_confirmations
            WHERE org_id = ${row.orgId} AND thumbprint = ${row.thumbprint}`;
          yield* audit.append({
            orgId: row.orgId,
            event: "key_revoked",
            keyThumbprint: row.thumbprint,
            deviceLabel: closed.device_label,
            result: "ran out: it waited to be allowed and never was; set up again on the phone",
          });
        }),
      );
  });
  yield* runOutWaitingKeys.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Kin couldn't close waiting approver keys; retries next start.", cause),
    ),
  );

  return ApproverKeys.of({
    keyChallenge,
    registerKey,
    listKeys,
    revokeKey,
    get,
    requireActive,
    reconcileSessions,
    activeApprovers,
  });
});

export const layer = Layer.effect(ApproverKeys, make);
