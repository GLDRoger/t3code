// @effect-diagnostics nodeBuiltinImport:off -- synchronous SHA-256 and constant-time compares.
import * as NodeCrypto from "node:crypto";

import {
  KinActionTarget,
  KinAgentId,
  KinApprovalError,
  KinApproverKey,
  KinEventId,
  ThreadId,
  type AuthSessionId,
  type Hex64,
  type KinActionKind,
  type KinApprovalsConfirmKeyInput,
  type KinApprovalsKeyChallengeResult,
  type KinApprovalsKeyInput,
  type KinApprovalsListKeysResult,
  type KinApprovalsOrgInput,
  type KinApprovalsRegisterKeyInput,
  type KinApprovalsRegisterKeyResult,
  type KinKeyThumbprint,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import { computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
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
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { proofKeyRevoked, revokedBySession } from "../auth/ProofKeySessions.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinAttestationTrust } from "./attestation/AttestationTrust.ts";
import {
  verifyAndroidKeyAttestation,
  verifyAppleAppAttest,
  type AttestationResult,
} from "./attestation/verify.ts";
import { KIN_APPROVER_KEYS_REQUESTER, KinPendingActions } from "./PendingActions.ts";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
// The desktop app's own credential; CloudLink trusts the same subject as "this machine".
const DESKTOP_SUBJECT = "desktop-bootstrap";
const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "tailscale-user-login",
];

/** The live socket a call arrived on, read when the WS connection was set up. */
export type KinKeyConnection = {
  readonly remoteAddress: string | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
};

export type KinKeyCaller = {
  readonly session: AuthenticatedSession;
  readonly people: ReadonlyArray<PersonIdentity>;
  readonly connection: Option.Option<KinKeyConnection>;
};

type KeyRef = { readonly orgId: KinOrgId; readonly thumbprint: KinKeyThumbprint };

type KeyRow = {
  readonly thumbprint: string;
  readonly org_id: string;
  readonly public_jwk_json: string;
  readonly human_id: string;
  readonly device_label: string;
  readonly platform: string;
  readonly hardware: string;
  readonly attested: number;
  readonly session_id: string | null;
  readonly proof_key_thumbprint: string | null;
  readonly state: string;
  readonly created_at: number;
  readonly confirmed_at: number | null;
  readonly revoked_at: number | null;
};

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeKey = Schema.decodeUnknownEffect(KinApproverKey);
const decodeEventId = Schema.decodeEffect(KinEventId);
const decodeTarget = Schema.decodeUnknownEffect(KinActionTarget);
const isKinApprovalError = Schema.is(KinApprovalError);

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

/** `sha256(stableStringify({kind, target, headSha?, base?}))`, approvals spec section 3. */
const kinTargetDigest = (kind: KinActionKind, target: KinActionTarget): Hex64 =>
  NodeCrypto.createHash("sha256").update(stableStringify({ kind, target })).digest("hex");

const toKey = (row: KeyRow) =>
  decodeKey({
    orgId: row.org_id,
    thumbprint: row.thumbprint,
    publicJwk: JSON.parse(row.public_jwk_json),
    humanId: row.human_id,
    deviceLabel: row.device_label,
    platform: row.platform,
    hardware: row.hardware,
    attested: row.attested === 1,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    state: row.state,
    createdAt: iso(row.created_at),
    ...(row.confirmed_at === null ? {} : { confirmedAt: iso(row.confirmed_at) }),
    ...(row.revoked_at === null ? {} : { revokedAt: iso(row.revoked_at) }),
  });

/** Only `ws` connections from this machine with no proxy in between. */
const isLoopbackConnection = (connection: KinKeyConnection) =>
  connection.remoteAddress !== undefined &&
  isLocalLoopbackHost(connection.remoteAddress.replace(/^::ffff:/i, "")) &&
  FORWARDING_HEADERS.every((name) => connection.headers[name] === undefined);

export class ApproverKeys extends Context.Service<
  ApproverKeys,
  {
    readonly keyChallenge: (
      caller: KinKeyCaller,
    ) => Effect.Effect<KinApprovalsKeyChallengeResult, KinApprovalError>;
    readonly registerKey: (
      caller: KinKeyCaller,
      input: KinApprovalsRegisterKeyInput,
    ) => Effect.Effect<KinApprovalsRegisterKeyResult, KinApprovalError>;
    /** The first key in an org, on the desktop app on this machine, with the phone's code. */
    readonly confirmKey: (
      caller: KinKeyCaller,
      input: KinApprovalsConfirmKeyInput,
    ) => Effect.Effect<KinApproverKey, KinApprovalError>;
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
  const sql = yield* SqlClient.SqlClient;
  const trust = yield* KinAttestationTrust;
  const actions = yield* KinPendingActions;
  // Single-use, session-bound, short-lived: memory is enough, and a restart only means retrying.
  const challenges = new Map<
    AuthSessionId,
    { readonly challenge: string; readonly expiresAt: number }
  >();
  const confirmations = new Map<
    string,
    { readonly code: string; readonly expiresAt: number; attempts: number }
  >();
  const slot = (ref: KeyRef) => `${ref.orgId}\u0000${ref.thumbprint}`;

  // Callers see a plain refusal; the cause is logged through the persistence error shape.
  const internal = (operation: string) => (cause: unknown) =>
    isKinApprovalError(cause)
      ? Effect.fail(cause)
      : Effect.logWarning(`${operation} failed`, toPersistenceSqlError(operation)(cause)).pipe(
          Effect.andThen(
            Effect.fail(
              new KinApprovalError({ reason: "unavailable", message: `${operation} failed.` }),
            ),
          ),
        );

  const personIn = (caller: KinKeyCaller, orgId: KinOrgId) => {
    const person = caller.people.find((candidate) => candidate.orgId === orgId);
    return person === undefined
      ? fail("not_owner", "Only a person in this org can manage its approver keys.")
      : Effect.succeed(person);
  };

  const select = (ref: KeyRef) =>
    sql<KeyRow>`SELECT * FROM kin_approver_keys
      WHERE org_id = ${ref.orgId} AND thumbprint = ${ref.thumbprint}`.pipe(
      Effect.map((rows) => rows[0]),
    );

  const hasActiveKey = (orgId: KinOrgId) =>
    sql`SELECT 1 FROM kin_approver_keys WHERE org_id = ${orgId} AND state = 'active' LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  /** Sets `revoked`, voids approved actions this key signed, cancels its pending registration. */
  const revokeRow = (ref: KeyRef, reason: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const [row] = yield* sql<KeyRow>`UPDATE kin_approver_keys
          SET state = 'revoked', revoked_at = ${now}
          WHERE org_id = ${ref.orgId} AND thumbprint = ${ref.thumbprint} AND state != 'revoked'
          RETURNING *`;
        if (row === undefined) return undefined;
        yield* sql`UPDATE kin_pending_actions
          SET state = 'voided', state_reason = ${reason}, updated_at = ${now}
          WHERE org_id = ${ref.orgId} AND state = 'approved' AND EXISTS (
            SELECT 1 FROM kin_grants g
            WHERE g.action_id = kin_pending_actions.action_id
              AND g.revision = kin_pending_actions.revision
              AND g.key_thumbprint = ${ref.thumbprint} AND g.consumed_at IS NULL)`;
        yield* sql`UPDATE kin_pending_actions
          SET state = 'cancelled', state_reason = ${reason}, updated_at = ${now}
          WHERE org_id = ${ref.orgId} AND kind = 'register_approver_key'
            AND state = 'awaiting_approval'
            AND json_extract(target_json, '$.thumbprint') = ${ref.thumbprint}`;
        confirmations.delete(slot(ref));
        return row;
      }),
    );

  // T3 revokes sessions in SessionStore (revokeClient, revokeOtherClients, managed policy).
  // Reading its table here keeps auth free of Kin hooks, and runs before every key is trusted.
  // Relay sessions renew under new ids, so the DPoP key's own revocations count too (spec section 4).
  const reconcileSessions = Effect.fn("ApproverKeys.reconcileSessions")(
    function* (orgId: KinOrgId | undefined) {
      const rows = yield* sql<{ org_id: KinOrgId; thumbprint: KinKeyThumbprint }>`
        SELECT k.org_id, k.thumbprint FROM kin_approver_keys k
        WHERE k.state != 'revoked' AND ${orgId === undefined ? sql`1 = 1` : sql`k.org_id = ${orgId}`}
          AND ${revokedBySession(
            sql,
            { sessionId: sql`k.session_id`, proofKey: sql`k.proof_key_thumbprint` },
            { since: sql`k.created_at` },
          )}
        ORDER BY k.org_id, k.thumbprint`;
      for (const row of rows) {
        yield* revokeRow({ orgId: row.org_id, thumbprint: row.thumbprint }, "session_revoked");
      }
      return rows.length;
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
      const ref = { orgId: input.orgId, thumbprint };
      const result = yield* attest(input, challenge);
      if (!result.attested) {
        yield* Effect.logWarning("Kin approver key isn't attested; it can't be activated.", {
          platform: input.platform,
          reason: result.reason,
        });
      }
      const row = {
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
      };
      const key = yield* toKey(row);
      // An attestation is bound to the challenge given when the key was made, so a key never
      // registers twice; refusing keeps anyone from rewriting a pending key's record.
      const inserted = yield* sql`INSERT INTO kin_approver_keys ${sql.insert(row)}
        ON CONFLICT (org_id, thumbprint) DO NOTHING RETURNING thumbprint`;
      if (inserted.length === 0)
        return yield* fail(
          "invalid_state",
          "This key is already registered; make a new key on the phone.",
        );
      const code = kinKeyConfirmationCode(thumbprint, challenge);
      if (!result.attested) return { key, code };

      confirmations.set(slot(ref), { code, expiresAt: now + CONFIRM_TTL_MS, attempts: 0 });
      if (yield* hasActiveKey(input.orgId)) {
        // Later keys need a grant from an existing key (spec section 4, step 3).
        const target = yield* decodeTarget({
          _tag: "device_key",
          thumbprint,
          hardware: result.hardware,
          attested: true,
        });
        yield* actions.create({
          orgId: input.orgId,
          kind: "register_approver_key",
          target,
          resolved: { _tag: "none" },
          targetDigest: kinTargetDigest("register_approver_key", target),
          reason: `Add approver key for "${input.deviceLabel}".`,
          requestedBy: SERVER_REQUESTER,
          provenance: {
            startedBy: { humanId: person.personId },
            // `KinIdentity.resolve` yields only the org owner until CHAT-11 adds roles (spec, Interfaces).
            startedByRole: "owner",
            chain: [{ kind: "approver_key", id: thumbprint, authorRole: "owner" }],
            ceilingBelowOwner: false,
          },
          source: yield* decodeEventId(`approver_key:${thumbprint}:${input.challenge}`),
        });
      }
      return { key, code };
    },
    Effect.catch(internal("ApproverKeys.registerKey")),
  );

  const isLocalDesktop = Effect.fn("ApproverKeys.isLocalDesktop")(function* (caller: KinKeyCaller) {
    if (caller.session.subject !== DESKTOP_SUBJECT) return false;
    if (Option.isNone(caller.connection) || !isLoopbackConnection(caller.connection.value))
      return false;
    const [issued] = yield* sql<{ client_ip_address: string | null }>`
      SELECT client_ip_address FROM auth_sessions
      WHERE session_id = ${caller.session.sessionId} AND revoked_at IS NULL`;
    return (
      issued?.client_ip_address != null &&
      isLocalLoopbackHost(issued.client_ip_address.replace(/^::ffff:/i, ""))
    );
  });

  const confirmKey = Effect.fn("ApproverKeys.confirmKey")(
    function* (caller: KinKeyCaller, input: KinApprovalsConfirmKeyInput) {
      const person = yield* personIn(caller, input.orgId);
      if (!(yield* isLocalDesktop(caller)))
        return yield* fail(
          "not_local",
          "Confirm the first approver key in the desktop app on the Kin host.",
        );
      yield* reconcileSessions(input.orgId);
      const ref = { orgId: input.orgId, thumbprint: input.thumbprint };
      const row = yield* select(ref);
      if (row === undefined) return yield* fail("not_found", "No such approver key.");
      if (row.state !== "pending")
        return yield* fail("invalid_state", "This key isn't waiting for confirmation.");
      if (row.attested !== 1)
        return yield* fail(
          "unattested",
          "This device couldn't prove its key is in secure hardware.",
        );
      if (row.human_id !== person.personId)
        return yield* fail("not_owner", "Only the key's owner can confirm it.");
      if (yield* hasActiveKey(input.orgId))
        return yield* fail("invalid_state", "Approve this key from a device that already has one.");
      const now = yield* Clock.currentTimeMillis;
      const pending = confirmations.get(slot(ref));
      if (pending === undefined || pending.expiresAt <= now)
        return yield* fail("bad_code", "The code expired; make a new key on the phone.");
      if (!sameBytes(pending.code, input.code)) {
        pending.attempts += 1;
        if (pending.attempts >= MAX_CODE_ATTEMPTS) confirmations.delete(slot(ref));
        return yield* fail("bad_code", "The code doesn't match the phone.");
      }
      const [active] = yield* sql<KeyRow>`UPDATE kin_approver_keys
        SET state = 'active', confirmed_at = ${now}
        WHERE org_id = ${ref.orgId} AND thumbprint = ${ref.thumbprint}
          AND state = 'pending' AND attested = 1
          AND NOT EXISTS (SELECT 1 FROM kin_approver_keys
            WHERE org_id = ${ref.orgId} AND state = 'active')
        RETURNING *`;
      if (active === undefined)
        return yield* fail("invalid_state", "Another key was confirmed first.");
      confirmations.delete(slot(ref));
      return yield* toKey(active);
    },
    Effect.catch(internal("ApproverKeys.confirmKey")),
  );

  const listKeys = Effect.fn("ApproverKeys.listKeys")(
    function* (caller: KinKeyCaller, input: KinApprovalsOrgInput) {
      yield* personIn(caller, input.orgId);
      yield* reconcileSessions(input.orgId);
      const rows = yield* sql<KeyRow>`SELECT * FROM kin_approver_keys
        WHERE org_id = ${input.orgId} ORDER BY created_at, thumbprint`;
      return { keys: yield* Effect.forEach(rows, toKey) };
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
      const revoked = yield* revokeRow(input, "key_revoked");
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
      const rows = yield* sql`UPDATE kin_approver_keys
        SET state = 'active', confirmed_at = ${now}
        WHERE org_id = ${ref.orgId} AND thumbprint = ${ref.thumbprint}
          AND state = 'pending' AND attested = 1
        RETURNING thumbprint`;
      if (rows.length > 0) confirmations.delete(slot(ref));
      return rows.length > 0;
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

  return ApproverKeys.of({
    keyChallenge,
    registerKey,
    confirmKey,
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
