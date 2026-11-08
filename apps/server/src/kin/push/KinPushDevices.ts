// @effect-diagnostics nodeBuiltinImport:off -- synchronous SHA-256 for device ids.
import * as NodeCrypto from "node:crypto";

import {
  KinPushError,
  type AuthSessionId,
  type KinApsEnvironment,
  type KinOrgId,
  type KinPersonId,
  type KinPushRegisterDeviceInput,
  type KinPushToken,
  type KinPushUnregisterDeviceInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { revokedBySession } from "../auth/ProofKeySessions.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";

export type KinPushCaller = {
  readonly session: AuthenticatedSession;
  readonly people: ReadonlyArray<PersonIdentity>;
};

export type KinPushDevice = {
  readonly orgId: KinOrgId;
  readonly token: KinPushToken;
  readonly personId: KinPersonId;
  readonly apsEnvironment: KinApsEnvironment;
  readonly sessionId: AuthSessionId;
};

/** What logs and clients see instead of a token: 12 hex characters of its SHA-256. */
export const kinPushDeviceId = (token: string) =>
  NodeCrypto.createHash("sha256").update(token).digest("hex").slice(0, 12);

/** Past this, registering a token drops the person's least recently registered one. */
export const KIN_PUSH_DEVICES_PER_PERSON = 10;

const isKinPushError = Schema.is(KinPushError);
const fail = (reason: KinPushError["reason"], message: string) =>
  Effect.fail(new KinPushError({ reason, message }));

export class KinPushDevices extends Context.Service<
  KinPushDevices,
  {
    readonly register: (
      caller: KinPushCaller,
      input: KinPushRegisterDeviceInput,
    ) => Effect.Effect<{ readonly deviceId: string }, KinPushError>;
    readonly unregister: (
      caller: KinPushCaller,
      input: KinPushUnregisterDeviceInput,
    ) => Effect.Effect<{ readonly removed: boolean }, KinPushError>;
    /** Devices of these people in the org, after dropping those whose session was revoked. */
    readonly forPeople: (
      orgId: KinOrgId,
      people: ReadonlyArray<KinPersonId>,
    ) => Effect.Effect<ReadonlyArray<KinPushDevice>, KinPushError>;
    /**
     * APNs said the token is dead. With `invalidSince` (a 410's timestamp), a row registered
     * after it survives, because the phone has since handed it to us again.
     */
    readonly forget: (
      orgId: KinOrgId,
      token: KinPushToken,
      invalidSince?: number,
    ) => Effect.Effect<void, KinPushError>;
    /** Removes devices registered from a revoked T3 session. Returns how many. */
    readonly reconcileSessions: () => Effect.Effect<number, KinPushError>;
  }
>()("t3/kin/push/KinPushDevices") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Callers see a plain refusal; the cause is logged through the persistence error shape.
  const internal = (operation: string) => (cause: unknown) =>
    isKinPushError(cause)
      ? Effect.fail(cause)
      : Effect.logWarning(`${operation} failed`, toPersistenceSqlError(operation)(cause)).pipe(
          Effect.andThen(
            Effect.fail(
              new KinPushError({ reason: "unavailable", message: `${operation} failed.` }),
            ),
          ),
        );

  const personIn = (caller: KinPushCaller, orgId: KinOrgId) => {
    const person = caller.people.find((candidate) => candidate.orgId === orgId);
    return person === undefined
      ? fail("not_member", "Only a person in this org can get its notifications.")
      : Effect.succeed(person);
  };

  // T3 revokes sessions in SessionStore; reading its table keeps auth free of Kin hooks,
  // as ApproverKeys does. Runs before every send. Expired sessions stay: a live socket outlives
  // the session it registered under. A repaired proof key keeps its pushes; the phone
  // re-registers on connect anyway (mobile spec).
  const revoked = revokedBySession(sql, {
    sessionId: sql`kin_push_devices.session_id`,
    proofKey: sql`kin_push_devices.proof_key_thumbprint`,
  });
  const reconcileSessions = Effect.fn("KinPushDevices.reconcileSessions")(
    function* () {
      // No org filter: sessions are environment-local, so a revoked one is revoked in every org.
      const removed = yield* sql`DELETE FROM kin_push_devices WHERE ${revoked} RETURNING token`;
      return removed.length;
    },
    Effect.catch(internal("KinPushDevices.reconcileSessions")),
  );

  const register = Effect.fn("KinPushDevices.register")(
    function* (caller: KinPushCaller, input: KinPushRegisterDeviceInput) {
      const person = yield* personIn(caller, input.orgId);
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          // A phone re-registers on every connect, which also moves the row to its current session.
          // Someone else's token moves only once reconcile would drop it, or its session is gone.
          const saved = yield* sql`INSERT INTO kin_push_devices ${sql.insert({
            org_id: input.orgId,
            token: input.token,
            person_id: person.personId,
            platform: input.platform,
            aps_environment: input.apsEnvironment,
            device_label: input.deviceLabel ?? null,
            session_id: caller.session.sessionId,
            proof_key_thumbprint: caller.session.proofKeyThumbprint ?? null,
            created_at: now,
            updated_at: now,
          })}
        ON CONFLICT (org_id, token) DO UPDATE SET
          person_id = excluded.person_id,
          platform = excluded.platform,
          aps_environment = excluded.aps_environment,
          device_label = excluded.device_label,
          session_id = excluded.session_id,
          proof_key_thumbprint = excluded.proof_key_thumbprint,
          updated_at = excluded.updated_at
        WHERE kin_push_devices.person_id = excluded.person_id OR ${revoked} OR NOT EXISTS (
          SELECT 1 FROM auth_sessions WHERE session_id = kin_push_devices.session_id)
        RETURNING token`;
          if (saved.length === 0)
            return yield* fail("not_member", "This device is registered to someone else.");
          yield* sql`DELETE FROM kin_push_devices
        WHERE org_id = ${input.orgId} AND person_id = ${person.personId} AND token != ${input.token}
          AND token NOT IN (
            SELECT token FROM kin_push_devices
            WHERE org_id = ${input.orgId} AND person_id = ${person.personId}
              AND token != ${input.token}
            ORDER BY updated_at DESC, token LIMIT ${KIN_PUSH_DEVICES_PER_PERSON - 1})`;
          return { deviceId: kinPushDeviceId(input.token) };
        }),
      );
    },
    Effect.catch(internal("KinPushDevices.register")),
  );

  const unregister = Effect.fn("KinPushDevices.unregister")(
    function* (caller: KinPushCaller, input: KinPushUnregisterDeviceInput) {
      const person = yield* personIn(caller, input.orgId);
      const removed = yield* sql`DELETE FROM kin_push_devices
        WHERE org_id = ${input.orgId} AND token = ${input.token} AND person_id = ${person.personId}
        RETURNING token`;
      return { removed: removed.length > 0 };
    },
    Effect.catch(internal("KinPushDevices.unregister")),
  );

  const forPeople = Effect.fn("KinPushDevices.forPeople")(
    function* (orgId: KinOrgId, people: ReadonlyArray<KinPersonId>) {
      if (people.length === 0) return [];
      yield* reconcileSessions();
      const rows = yield* sql<{
        token: KinPushToken;
        person_id: KinPersonId;
        aps_environment: KinApsEnvironment;
        session_id: AuthSessionId;
      }>`SELECT token, person_id, aps_environment, session_id FROM kin_push_devices
        WHERE org_id = ${orgId} AND person_id IN ${sql.in(people)}
        ORDER BY person_id, token`;
      return rows.map((row): KinPushDevice => ({
        orgId,
        token: row.token,
        personId: row.person_id,
        apsEnvironment: row.aps_environment,
        sessionId: row.session_id,
      }));
    },
    Effect.catch(internal("KinPushDevices.forPeople")),
  );

  const forget = Effect.fn("KinPushDevices.forget")(
    function* (orgId: KinOrgId, token: KinPushToken, invalidSince?: number) {
      yield* sql`DELETE FROM kin_push_devices WHERE org_id = ${orgId} AND token = ${token}
        ${invalidSince === undefined ? sql`` : sql`AND updated_at < ${invalidSince}`}`;
    },
    Effect.catch(internal("KinPushDevices.forget")),
  );

  return KinPushDevices.of({ register, unregister, forPeople, forget, reconcileSessions });
});

export const layer = Layer.effect(KinPushDevices, make);
