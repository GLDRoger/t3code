// @effect-diagnostics nodeBuiltinImport:off -- synchronous hashing and constant-time invite verification.
import * as NodeCrypto from "node:crypto";
import {
  AuthKinChatScope,
  KIN_INVITE_DEFAULT_TTL_HOURS,
  KinChatError,
  KinInviteId,
  KinPerson,
  KinPersonId,
  type KinOrgId,
  type KinPeopleCreateInviteInput,
  type KinPeopleCreateInviteResult,
  type KinInviteAcceptRequest,
  type KinInviteAcceptResult,
  type KinPeopleListDevicesInput,
  type KinPeopleListDevicesResult,
  type KinPeopleRevokeDeviceInput,
  type KinPeopleSetGithubLoginInput,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";

const isKinError = Schema.is(KinChatError);
const isSqlError = Schema.is(PersistenceSqlError);
const sqlError = (operation: string) => (e: unknown) =>
  isKinError(e) || isSqlError(e) ? e : toPersistenceSqlError(operation)(e);
type Failure = KinChatError | PersistenceSqlError;
const missing = new KinChatError({ reason: "not_found", message: "Kin record not found." });
const denied = new KinChatError({
  reason: "not_allowed",
  message: "This action requires the owner.",
});
const hash = (secret: string) => NodeCrypto.createHash("sha256").update(secret).digest();
const decodePersonRow = Schema.decodeUnknownSync(KinPerson);
const decodePerson = (row: Record<string, unknown>) => decodePersonRow(row);

export class KinPeople extends Context.Service<
  KinPeople,
  {
    readonly createInvite: (
      session: AuthenticatedSession,
      input: KinPeopleCreateInviteInput,
    ) => Effect.Effect<KinPeopleCreateInviteResult, Failure>;
    readonly accept: (
      input: KinInviteAcceptRequest,
    ) => Effect.Effect<KinInviteAcceptResult, Failure>;
    readonly list: (
      session: AuthenticatedSession,
      orgId: KinOrgId,
    ) => Effect.Effect<{ people: ReadonlyArray<KinPerson> }, Failure>;
    readonly listDevices: (
      session: AuthenticatedSession,
      input: KinPeopleListDevicesInput,
    ) => Effect.Effect<KinPeopleListDevicesResult, Failure>;
    readonly revokeDevice: (
      session: AuthenticatedSession,
      input: KinPeopleRevokeDeviceInput,
    ) => Effect.Effect<{ revoked: boolean }, Failure>;
    readonly setGithubLogin: (
      session: AuthenticatedSession,
      input: KinPeopleSetGithubLoginInput,
    ) => Effect.Effect<KinPerson, Failure>;
  }
>()("t3/kin/people/KinPeople") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const sessions = yield* SessionStore;
  const owner = Effect.fn("KinPeople.requireOwner")(function* (
    session: AuthenticatedSession,
    orgId: KinOrgId,
  ) {
    if (orgId !== identity.owner.orgId) return yield* missing;
    const people = yield* identity.resolve(session);
    if (!people.some((p) => p.orgId === orgId && p.personId === identity.owner.personId))
      return yield* denied;
  });
  const person = Effect.fn("KinPeople.person")(function* (orgId: KinOrgId, personId: KinPersonId) {
    const rows =
      yield* sql`SELECT person_id AS "personId", org_id AS "orgId", handle, display_name AS "displayName",
      github_login AS "githubLogin", created_at AS "createdAt" FROM kin_people
      WHERE org_id = ${orgId} AND person_id = ${personId}`.pipe(
        Effect.mapError(toPersistenceSqlError("KinPeople.person")),
      );
    if (!rows[0]) return yield* missing;
    return decodePerson(rows[0]);
  });
  const createInvite = Effect.fn("KinPeople.createInvite")(function* (
    session: AuthenticatedSession,
    input: KinPeopleCreateInviteInput,
  ) {
    yield* owner(session, input.orgId);
    const now = (yield* DateTime.now).epochMilliseconds;
    const secret = NodeCrypto.randomBytes(32).toString("base64url");
    const inviteId = KinInviteId.make(NodeCrypto.randomUUID());
    const handle =
      input.handle ??
      (input.displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") ||
        "member");
    const expiresAt = now + (input.ttlHours ?? KIN_INVITE_DEFAULT_TTL_HOURS) * 3600000;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (input.personId) yield* person(input.orgId, input.personId);
          yield* sql`INSERT INTO kin_people_invites (invite_id, org_id, person_id, display_name, handle, secret_hash, created_at, expires_at)
        VALUES (${inviteId}, ${input.orgId}, ${input.personId ?? null}, ${input.displayName}, ${handle},
          ${hash(secret).toString("hex")}, ${now}, ${expiresAt})`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.createInvite")),
          );
        }),
      )
      .pipe(Effect.mapError(sqlError("KinPeople.createInvite")));
    return {
      inviteId,
      secret: `${input.orgId}.${inviteId}.${secret}`,
      displayName: input.displayName,
      handle,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
    };
  });
  const accept = Effect.fn("KinPeople.accept")(function* (input: KinInviteAcceptRequest) {
    const parts = input.secret.split(".");
    if (parts.length !== 3 || parts[0] !== identity.owner.orgId) return yield* missing;
    const [orgId, inviteId, secret] = parts as [string, string, string];
    const now = (yield* DateTime.now).epochMilliseconds;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            person_id: string | null;
            display_name: string;
            handle: string;
            secret_hash: string;
          }>`SELECT person_id, display_name, handle, secret_hash FROM kin_people_invites
          WHERE org_id = ${orgId} AND invite_id = ${inviteId} AND consumed_at IS NULL AND expires_at > ${now}`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.accept")),
          );
          const row = rows[0];
          if (
            !row ||
            !/^[a-f0-9]{64}$/.test(row.secret_hash) ||
            !NodeCrypto.timingSafeEqual(hash(secret), Buffer.from(row.secret_hash, "hex"))
          )
            return yield* missing;
          const consumed = yield* sql`UPDATE kin_people_invites SET consumed_at = ${now}
        WHERE org_id = ${orgId} AND invite_id = ${inviteId} AND consumed_at IS NULL AND expires_at > ${now} RETURNING invite_id`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.consume")),
          );
          if (!consumed.length) return yield* missing;
          const personId = KinPersonId.make(row.person_id ?? NodeCrypto.randomUUID());
          if (!row.person_id) {
            yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES (${personId}, ${orgId}, ${row.handle}, ${row.display_name}, ${now})`.pipe(
              Effect.mapError(toPersistenceSqlError("KinPeople.insertPerson")),
            );
          }
          const member = yield* person(identity.owner.orgId, personId);
          const issued = yield* sessions
            .issue({
              scopes: [AuthKinChatScope],
              subject: "kin-member",
              ttl: Duration.days(30),
              client: { label: input.label ?? row.display_name, deviceType: "mobile" },
            })
            .pipe(Effect.mapError(toPersistenceSqlError("KinPeople.issue")));
          yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES (${issued.sessionId}, ${orgId}, ${personId}, ${now})`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.bind")),
          );
          return {
            orgId: member.orgId,
            person: member,
            sessionId: issued.sessionId,
            accessToken: issued.token,
            expiresAt: DateTime.formatIso(issued.expiresAt),
          };
        }),
      )
      .pipe(Effect.mapError(sqlError("KinPeople.accept")));
  });
  const list = Effect.fn("KinPeople.list")(function* (
    session: AuthenticatedSession,
    orgId: KinOrgId,
  ) {
    yield* owner(session, orgId);
    const rows =
      yield* sql`SELECT person_id AS "personId", org_id AS "orgId", handle, display_name AS "displayName",
      github_login AS "githubLogin", created_at AS "createdAt" FROM kin_people WHERE org_id = ${orgId} ORDER BY handle, person_id`.pipe(
        Effect.mapError(toPersistenceSqlError("KinPeople.list")),
      );
    return { people: rows.map(decodePerson) };
  });
  const listDevices = Effect.fn("KinPeople.listDevices")(function* (
    session: AuthenticatedSession,
    input: KinPeopleListDevicesInput,
  ) {
    yield* owner(session, input.orgId);
    yield* person(input.orgId, input.personId);
    const rows = yield* sql<{
      session_id: AuthSessionId;
      bound_at: number;
      revoked_at: number | null;
      client_label: string | null;
      client_device_type: string | null;
      expires_at: string | null;
    }>`SELECT b.session_id, b.bound_at, b.revoked_at, a.client_label, a.client_device_type, a.expires_at FROM kin_session_bindings b
        LEFT JOIN auth_sessions a ON a.session_id = b.session_id
        WHERE b.org_id = ${input.orgId} AND b.person_id = ${input.personId} ORDER BY b.bound_at, b.session_id`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.listDevices")),
    );
    return {
      devices: rows.map((r) => ({
        sessionId: r.session_id,
        label: r.client_label,
        deviceType: r.client_device_type,
        boundAt: DateTime.formatIso(DateTime.makeUnsafe(r.bound_at)),
        expiresAt: r.expires_at,
        revokedAt:
          r.revoked_at === null ? null : DateTime.formatIso(DateTime.makeUnsafe(r.revoked_at)),
      })),
    };
  });
  const revokeDevice = Effect.fn("KinPeople.revokeDevice")(function* (
    session: AuthenticatedSession,
    input: KinPeopleRevokeDeviceInput,
  ) {
    yield* owner(session, input.orgId);
    const now = (yield* DateTime.now).epochMilliseconds;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* person(input.orgId, input.personId);
          const rows = yield* sql`UPDATE kin_session_bindings SET revoked_at = ${now}
        WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND session_id = ${input.sessionId}
        AND revoked_at IS NULL RETURNING session_id`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.revoke")),
          );
          if (!rows.length) return yield* missing;
          yield* sessions
            .revoke(input.sessionId)
            .pipe(Effect.mapError(toPersistenceSqlError("KinPeople.revokeSession")));
          return { revoked: true };
        }),
      )
      .pipe(Effect.mapError(sqlError("KinPeople.revokeDevice")));
  });
  const setGithubLogin = Effect.fn("KinPeople.setGithubLogin")(function* (
    session: AuthenticatedSession,
    input: KinPeopleSetGithubLoginInput,
  ) {
    const people = yield* identity.resolve(session);
    if (!people.some((p) => p.orgId === input.orgId)) return yield* missing;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* person(input.orgId, input.personId);
          if (
            !people.some(
              (p) =>
                p.orgId === input.orgId &&
                (p.personId === input.personId || p.personId === identity.owner.personId),
            )
          )
            return yield* denied;

          yield* sql`UPDATE kin_people SET github_login = ${input.githubLogin} WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.setGithubLogin")),
          );
          return yield* person(input.orgId, input.personId);
        }),
      )
      .pipe(Effect.mapError(sqlError("KinPeople.setGithubLogin")));
  });
  return KinPeople.of({ createInvite, accept, list, listDevices, revokeDevice, setGithubLogin });
});
export const layer = Layer.effect(KinPeople, make);
