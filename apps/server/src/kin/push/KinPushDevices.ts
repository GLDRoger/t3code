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

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
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
    /** APNs said the token is dead (410, BadDeviceToken). */
    readonly forget: (orgId: KinOrgId, token: KinPushToken) => Effect.Effect<void, KinPushError>;
    /** Removes devices registered from a revoked T3 session. Returns how many. */
    readonly reconcileSessions: () => Effect.Effect<number, KinPushError>;
  }
>()("t3/kin/push/KinPushDevices") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const internal = (operation: string) => (cause: unknown) =>
    isKinPushError(cause)
      ? cause
      : new KinPushError({ reason: "unavailable", message: `${operation} failed.` });

  const personIn = (caller: KinPushCaller, orgId: KinOrgId) => {
    const person = caller.people.find((candidate) => candidate.orgId === orgId);
    return person === undefined
      ? fail("not_member", "Only a person in this org can get its notifications.")
      : Effect.succeed(person);
  };

  // T3 revokes sessions in SessionStore; reading its table keeps auth free of Kin hooks,
  // as ApproverKeys does. Runs before every send.
  const reconcileSessions = Effect.fn("KinPushDevices.reconcileSessions")(
    function* () {
      const removed = yield* sql`DELETE FROM kin_push_devices WHERE session_id IN (
          SELECT session_id FROM auth_sessions WHERE revoked_at IS NOT NULL)
        RETURNING token`;
      return removed.length;
    },
    Effect.mapError(internal("KinPushDevices.reconcileSessions")),
  );

  const register = Effect.fn("KinPushDevices.register")(
    function* (caller: KinPushCaller, input: KinPushRegisterDeviceInput) {
      const person = yield* personIn(caller, input.orgId);
      const now = yield* Clock.currentTimeMillis;
      // A phone re-registers on every connect, which also moves the row to its current session.
      yield* sql`INSERT INTO kin_push_devices ${sql.insert({
        org_id: input.orgId,
        token: input.token,
        person_id: person.personId,
        platform: input.platform,
        aps_environment: input.apsEnvironment,
        device_label: input.deviceLabel ?? null,
        session_id: caller.session.sessionId,
        created_at: now,
        updated_at: now,
      })}
        ON CONFLICT (org_id, token) DO UPDATE SET
          person_id = excluded.person_id,
          platform = excluded.platform,
          aps_environment = excluded.aps_environment,
          device_label = excluded.device_label,
          session_id = excluded.session_id,
          updated_at = excluded.updated_at`;
      return { deviceId: kinPushDeviceId(input.token) };
    },
    Effect.mapError(internal("KinPushDevices.register")),
  );

  const unregister = Effect.fn("KinPushDevices.unregister")(
    function* (caller: KinPushCaller, input: KinPushUnregisterDeviceInput) {
      const person = yield* personIn(caller, input.orgId);
      const removed = yield* sql`DELETE FROM kin_push_devices
        WHERE org_id = ${input.orgId} AND token = ${input.token} AND person_id = ${person.personId}
        RETURNING token`;
      return { removed: removed.length > 0 };
    },
    Effect.mapError(internal("KinPushDevices.unregister")),
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
    Effect.mapError(internal("KinPushDevices.forPeople")),
  );

  const forget = Effect.fn("KinPushDevices.forget")(
    function* (orgId: KinOrgId, token: KinPushToken) {
      yield* sql`DELETE FROM kin_push_devices WHERE org_id = ${orgId} AND token = ${token}`;
    },
    Effect.mapError(internal("KinPushDevices.forget")),
  );

  return KinPushDevices.of({ register, unregister, forPeople, forget, reconcileSessions });
});

export const layer = Layer.effect(KinPushDevices, make);
