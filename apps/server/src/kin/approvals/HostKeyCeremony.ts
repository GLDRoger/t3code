import {
  AuthSessionId,
  KinApprovalError,
  type KinApproverKey,
  type KinKeyThumbprint,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { KinAudit } from "./Audit.ts";
import {
  MAX_CODE_ATTEMPTS,
  internal,
  makeKeyStore,
  sealFields,
  type ConfirmationRow,
  type KeyRow,
} from "./ApproverKeyStore.ts";

/** A phone waiting for the host to confirm its key, with what the owner checks it against. */
export type KinPendingEnrolment = {
  readonly orgId: KinOrgId;
  readonly thumbprint: KinKeyThumbprint;
  readonly humanId: string;
  readonly deviceLabel: string;
  readonly platform: string;
  readonly hardware: string;
  readonly sessionId: AuthSessionId;
  readonly sessionSubject: string | null;
  readonly sessionClient: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly attemptsLeft: number;
  /** The org already has an active key: only `--recover` confirms this one here. */
  readonly needsRecovery: boolean;
};

export type KinHostConfirmInput = {
  readonly orgId: KinOrgId;
  readonly thumbprint: KinKeyThumbprint;
  readonly sessionId: AuthSessionId;
  readonly code: string;
  /** Lost-device recovery: revoke this person's other keys, then activate this one. */
  readonly recover: boolean;
};

export type KinHostConfirmResult = {
  readonly key: KinApproverKey;
  readonly revoked: ReadonlyArray<KinKeyThumbprint>;
};

const refuse = (reason: KinApprovalError["reason"], message: string) =>
  new KinApprovalError({ reason, message });

type Attempt =
  | { readonly _tag: "refused"; readonly error: KinApprovalError }
  | { readonly _tag: "confirmed"; readonly row: KeyRow; readonly revoked: ReadonlyArray<KeyRow> };

/**
 * The host-side bootstrap ceremony behind `t3 kin approvals confirm-key`: the owner, in a shell
 * on the Kin host, types the code the phone shows. No RPC reaches it, so no remote session,
 * agent or model can confirm a key; the code only proves the owner is looking at that phone.
 */
export class KinHostKeyCeremony extends Context.Service<
  KinHostKeyCeremony,
  {
    readonly listPending: () => Effect.Effect<ReadonlyArray<KinPendingEnrolment>, KinApprovalError>;
    readonly confirm: (
      input: KinHostConfirmInput,
    ) => Effect.Effect<KinHostConfirmResult, KinApprovalError>;
  }
>()("t3/kin/approvals/HostKeyCeremony/KinHostKeyCeremony") {}

const make = Effect.gen(function* () {
  const store = yield* makeKeyStore;
  const audit = yield* KinAudit;
  const { sql, seal } = store;

  const listPending = Effect.fn("KinHostKeyCeremony.listPending")(
    function* () {
      yield* store.reconcileSessions(undefined);
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<
        KeyRow & {
          org_id: KinOrgId;
          thumbprint: KinKeyThumbprint;
          session_id: string;
          subject: string | null;
          client: string | null;
          expires_at: number;
          attempts: number;
          has_active: number;
        }
      >`SELECT k.*, s.subject, s.client_label AS client, c.expires_at, c.attempts,
          EXISTS (SELECT 1 FROM kin_approver_keys a
            WHERE a.org_id = k.org_id AND a.state = 'active') AS has_active
        FROM kin_approver_key_confirmations c
        JOIN kin_approver_keys k ON k.org_id = c.org_id AND k.thumbprint = c.thumbprint
        LEFT JOIN auth_sessions s ON s.session_id = c.session_id
        WHERE k.state = 'pending' AND k.attested = 1 AND k.session_id = c.session_id
          AND c.expires_at > ${now} AND c.attempts < ${MAX_CODE_ATTEMPTS}
        ORDER BY k.org_id, k.created_at, k.thumbprint`;
      // A row whose pending seal doesn't verify was never vouched for by registration.
      return rows.filter(store.pendingVouched).map((row): KinPendingEnrolment => ({
        orgId: row.org_id,
        thumbprint: row.thumbprint,
        humanId: row.human_id,
        deviceLabel: row.device_label,
        platform: row.platform,
        hardware: row.hardware,
        sessionId: AuthSessionId.make(row.session_id),
        sessionSubject: row.subject,
        sessionClient: row.client,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        attemptsLeft: MAX_CODE_ATTEMPTS - row.attempts,
        needsRecovery: row.has_active === 1,
      }));
    },
    Effect.catch(internal("KinHostKeyCeremony.listPending")),
  );

  const othersOf = (input: KinHostConfirmInput) =>
    sql<KeyRow>`SELECT * FROM kin_approver_keys
      WHERE org_id = ${input.orgId} AND thumbprint != ${input.thumbprint} AND state != 'revoked'
      ORDER BY created_at, thumbprint`;
  const needsRecover = (others: ReadonlyArray<KeyRow>, input: KinHostConfirmInput) =>
    others.some((key) => key.state === "active") && !input.recover;
  const alreadyActive = refuse(
    "invalid_state",
    "This org already has an approver key. Approve the new phone from that one, or pass --recover if it's lost.",
  );

  /** One transaction: count the try, check the code against the exact tuple, then activate. */
  const attempt = (input: KinHostConfirmInput, now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const refused = (error: KinApprovalError): Attempt => ({ _tag: "refused", error });
        const ref = { orgId: input.orgId, thumbprint: input.thumbprint };
        // A write first, so this transaction holds SQLite's write lock before it reads anything.
        const [counted] = yield* sql<ConfirmationRow>`UPDATE kin_approver_key_confirmations
          SET attempts = attempts + 1
          WHERE org_id = ${input.orgId} AND thumbprint = ${input.thumbprint}
            AND attempts < ${MAX_CODE_ATTEMPTS} AND expires_at > ${now}
          RETURNING *`;
        if (counted === undefined) {
          yield* store.deleteConfirmation(ref);
          return refused(
            refuse(
              "bad_code",
              "No code is waiting for that key: it expired, had too many tries, or was used. Make a new key on the phone.",
            ),
          );
        }
        const row = yield* store.select(ref);
        if (row === undefined || row.state !== "pending")
          return refused(refuse("not_found", "No phone is waiting with that key."));
        if (row.attested !== 1)
          return refused(
            refuse("unattested", "This phone couldn't prove its key is in secure hardware."),
          );
        const matches =
          counted.session_id === input.sessionId &&
          row.session_id === input.sessionId &&
          seal.verifyConfirmation(
            {
              ...sealFields(row),
              sessionId: input.sessionId,
              challengeSha256: counted.challenge_sha256,
              code: input.code,
            },
            counted.verifier,
          );
        if (!matches) {
          if (counted.attempts >= MAX_CODE_ATTEMPTS) yield* store.deleteConfirmation(ref);
          return refused(refuse("bad_code", "That code doesn't match this phone's key."));
        }
        if (!store.pendingVouched(row)) {
          yield* store.deleteConfirmation(ref);
          return refused(
            refuse(
              "unattested",
              "Kin can't vouch for this key's record. Make a new key on the phone.",
            ),
          );
        }
        const others = yield* othersOf(input);
        if (needsRecover(others, input)) return refused(alreadyActive);
        // Recovery: the lost phone's keys, and this person's other pending ones, stop counting first.
        const revoked: Array<KeyRow> = [];
        if (input.recover) {
          for (const other of others.filter((key) => key.human_id === row.human_id)) {
            const thumbprint = other.thumbprint as KinKeyThumbprint;
            const done = yield* store.revokeRow(
              { orgId: input.orgId, thumbprint },
              "key_recovered",
            );
            if (done === undefined) continue;
            revoked.push(done);
            yield* audit.append({
              orgId: input.orgId,
              event: "key_revoked",
              keyThumbprint: thumbprint,
              deviceLabel: other.device_label,
              result: `host recovery for ${row.thumbprint}`,
            });
          }
        }
        const active = yield* store.activate(row, now, !input.recover);
        if (active === undefined)
          return refused(refuse("invalid_state", "Another key was confirmed first."));
        yield* store.cancelEnrolment(ref, "confirmed_on_host", now);
        yield* audit.append({
          orgId: input.orgId,
          event: "key_confirmed",
          keyThumbprint: input.thumbprint,
          deviceLabel: row.device_label,
          sessionId: input.sessionId,
          result: input.recover ? "host recovery" : "host confirmation",
        });
        return { _tag: "confirmed", row: active, revoked } satisfies Attempt;
      }),
    );

  const confirm = Effect.fn("KinHostKeyCeremony.confirm")(
    function* (input: KinHostConfirmInput) {
      if (!/^\d{6}$/.test(input.code))
        return yield* refuse("bad_code", "The code is the 6 digits the phone shows.");
      yield* store.reconcileSessions(input.orgId);
      // Checked again inside the transaction; this only spares a try on a missing --recover.
      if (needsRecover(yield* othersOf(input), input)) return yield* alreadyActive;
      const result = yield* attempt(input, yield* Clock.currentTimeMillis);
      if (result._tag === "refused") return yield* result.error;
      return {
        key: yield* store.toKey(result.row),
        revoked: result.revoked.map((row) => row.thumbprint as KinKeyThumbprint),
      };
    },
    Effect.catch(internal("KinHostKeyCeremony.confirm")),
  );

  return KinHostKeyCeremony.of({ listPending, confirm });
});

export const layer = Layer.effect(KinHostKeyCeremony, make);
