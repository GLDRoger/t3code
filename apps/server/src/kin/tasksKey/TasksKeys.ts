import {
  AuthKinTasksScope,
  AuthSessionId,
  KIN_TASKS_KEY_LIMIT,
  KIN_TASKS_KEY_PATH,
  KinChatError,
  type KinOrgId,
  KinPersonId,
  kinIsLocalOnlyHost,
  type KinTasksKey,
  type KinTasksKeysIssueInput,
  type KinTasksKeysIssueResult,
  type KinTasksKeysListInput,
  type KinTasksKeysRevokeInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { EnvironmentAuth, type AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { CloudLink } from "../../cloud/CloudLink.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { isOwnerHimself, ownerLevel } from "../people/KinAccess.ts";
import { workFailure } from "../work/recordRows.ts";
import { isTasksKey, TasksKeyAudience } from "./audience.ts";

/** The subject every coding-agent key is issued under; the endpoint accepts no other. */
export const KIN_TASKS_KEY_SUBJECT = "kin-coding-agent";
const KEY_TTL = Duration.days(30);
// Last use is a time to show, not an audit log: one write a minute per key is plenty.
const LAST_USE_STEP_MS = 60_000;

/** The person a live key was issued to: the only one its endpoint acts as. */
export interface TasksKeyHolder {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly sessionId: AuthSessionId;
}

const missing = new KinChatError({ reason: "not_found", message: "No such coding agent key." });
const nobody = new KinChatError({
  reason: "not_allowed",
  message: "Sign in to Kin as yourself to manage your coding agent keys.",
});
const full = new KinChatError({
  reason: "limit",
  message: `You already have ${KIN_TASKS_KEY_LIMIT} coding agent keys. Remove one first.`,
});
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

type KeyRow = {
  readonly sessionId: string;
  readonly personId: string;
  readonly label: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt: number | null;
};
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const toKey = (row: KeyRow, canRevoke: boolean): KinTasksKey => ({
  sessionId: AuthSessionId.make(row.sessionId),
  personId: KinPersonId.make(row.personId),
  label: row.label,
  createdAt: iso(row.createdAt),
  expiresAt: iso(row.expiresAt),
  lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
  canRevoke,
});

/**
 * Live: made on a recorded device (so removing it ends the key), not revoked here or as a T3
 * session, not expired, and its person not removed.
 */
export const live = (sql: SqlClient.SqlClient, now: number) =>
  sql`k.revoked_at IS NULL AND k.expires_at > ${now} AND k.made_by_session_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM auth_sessions a WHERE a.session_id = k.session_id AND a.revoked_at IS NULL)
    AND EXISTS (SELECT 1 FROM kin_people p WHERE p.org_id = k.org_id AND p.person_id = k.person_id
      AND p.removed_at IS NULL)`;

const liveKeys = Effect.fn("KinTasksKeys.liveKeys")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<KeyRow>`SELECT k.session_id AS "sessionId", k.person_id AS "personId",
      k.label, k.created_at AS "createdAt", k.expires_at AS "expiresAt",
      k.last_used_at AS "lastUsedAt"
    FROM kin_tasks_keys k
    WHERE k.org_id = ${orgId} AND k.person_id = ${personId} AND ${live(sql, now)}
    ORDER BY k.created_at, k.session_id`;
});

/** Who may end a key: its holder, the owner for anyone, or a co-owner for a member's. */
const mayRevoke = Effect.fn("KinTasksKeys.mayRevoke")(function* (
  orgId: KinOrgId,
  by: KinPersonId,
  holder: KinPersonId,
) {
  const { owner } = yield* KinIdentity;
  return (
    holder === by ||
    isOwnerHimself(owner, by) ||
    ((yield* ownerLevel(orgId, by)) &&
      !isOwnerHimself(owner, holder) &&
      !(yield* ownerLevel(orgId, holder)))
  );
});

/**
 * The address anyone's coding agent can reach this host by: T3 Connect's tunnel while it serves
 * this host. A LAN, tailnet or relay connection gives the host no address of its own to name.
 */
const publicOrigin = Effect.fn("KinTasksKeys.publicOrigin")(function* () {
  const cloud = yield* Effect.serviceOption(CloudLink);
  if (Option.isNone(cloud)) return undefined;
  const state = yield* cloud.value.linkState().pipe(Effect.option);
  if (Option.isNone(state)) return undefined;
  const { linked, linkRevoked, tunnelHostname } = state.value;
  if (!linked || linkRevoked || tunnelHostname === undefined) return undefined;
  if (!URL.canParse(`https://${tunnelHostname}`)) return undefined;
  const url = new URL(`https://${tunnelHostname}`);
  return kinIsLocalOnlyHost(url.hostname) ? undefined : url.origin;
});

/** The person signed in on this app session, never a key: who a key is made for and by. */
const caller = Effect.fn("KinTasksKeys.caller")(function* (
  session: AuthenticatedSession,
  orgId: KinOrgId,
) {
  const identity = yield* KinIdentity;
  if (orgId !== identity.owner.orgId) return yield* missing;
  if (isTasksKey(session.scopes)) return yield* nobody;
  const person = (yield* identity.resolve(session)).find((one) => one.orgId === orgId);
  if (person === undefined) return yield* nobody;
  return person;
});

/**
 * Makes a key for the caller and no one else, at most `KIN_TASKS_KEY_LIMIT` live at once. Count,
 * session and key row commit together, so two at once can't make one too many; the secret is
 * returned this once and kept nowhere.
 */
export const issue = Effect.fn("KinTasksKeys.issue")(function* (
  session: AuthenticatedSession,
  input: KinTasksKeysIssueInput,
) {
  const person = yield* caller(session, input.orgId);
  const auth = yield* EnvironmentAuth;
  const sql = yield* SqlClient.SqlClient;
  const refresh = yield* KinRefreshObserver;
  const label = input.label ?? "Coding agent";
  const origin = yield* publicOrigin();
  return yield* Effect.gen(function* () {
    // Moves only once this commits: a refusal below announces nothing.
    yield* refresh.touch(person.orgId, "people");
    const now = yield* Clock.currentTimeMillis;
    // A removal may have committed since `caller`: the issuer is read again where the key is made.
    const issuer = yield* sql`SELECT 1 FROM auth_sessions a
      JOIN kin_people p ON p.org_id = ${person.orgId} AND p.person_id = ${person.personId}
        AND p.removed_at IS NULL
      WHERE a.session_id = ${session.sessionId} AND a.revoked_at IS NULL
        AND a.expires_at > ${iso(now)}`;
    if (issuer.length === 0) return yield* nobody;
    if ((yield* liveKeys(person.orgId, person.personId, now)).length >= KIN_TASKS_KEY_LIMIT)
      return yield* full;
    const issued = yield* auth
      .issueSession({
        ttl: KEY_TTL,
        subject: KIN_TASKS_KEY_SUBJECT,
        scopes: [AuthKinTasksScope],
        label,
      })
      .pipe(Effect.mapError(() => unavailable));
    const row: KeyRow = {
      sessionId: issued.sessionId,
      personId: person.personId,
      label,
      createdAt: now,
      expiresAt: issued.expiresAt.epochMilliseconds,
      lastUsedAt: null,
    };
    // Made from this app session: removing that device ends the key (see revokeLinkedDevices).
    yield* sql`INSERT INTO kin_tasks_keys (session_id, org_id, person_id, label, created_at,
        expires_at, made_by_session_id)
      VALUES (${row.sessionId}, ${person.orgId}, ${row.personId}, ${label}, ${now}, ${row.expiresAt},
        ${session.sessionId})`;
    const result: KinTasksKeysIssueResult = {
      key: toKey(row, true),
      secret: issued.token,
      path: KIN_TASKS_KEY_PATH,
      ...(origin === undefined ? {} : { origin }),
    };
    return result;
  }).pipe(sql.withTransaction, workFailure);
});

/** The caller's own live keys; the owner level may read anyone's. */
export const list = Effect.fn("KinTasksKeys.list")(function* (
  session: AuthenticatedSession,
  input: KinTasksKeysListInput,
) {
  const person = yield* caller(session, input.orgId);
  const whose = input.personId ?? person.personId;
  if (whose !== person.personId && !(yield* ownerLevel(input.orgId, person.personId)))
    return yield* missing;
  const now = yield* Clock.currentTimeMillis;
  const canRevoke = yield* mayRevoke(input.orgId, person.personId, whose);
  const origin = yield* publicOrigin();
  return {
    keys: (yield* liveKeys(input.orgId, whose, now)).map((row) => toKey(row, canRevoke)),
    ...(origin === undefined ? {} : { origin }),
  };
}, workFailure);

/**
 * Ends a key at once, for every connection using it: its holder, the owner for anyone, or a
 * co-owner for a member. Anyone else is told there is no such key.
 */
export const revoke = Effect.fn("KinTasksKeys.revoke")(function* (
  session: AuthenticatedSession,
  input: KinTasksKeysRevokeInput,
) {
  const person = yield* caller(session, input.orgId);
  const auth = yield* EnvironmentAuth;
  const sql = yield* SqlClient.SqlClient;
  const refresh = yield* KinRefreshObserver;
  return yield* Effect.gen(function* () {
    const [row] = yield* sql<{ personId: string }>`SELECT person_id AS "personId"
      FROM kin_tasks_keys WHERE org_id = ${input.orgId} AND session_id = ${input.sessionId}
        AND revoked_at IS NULL`;
    if (row === undefined) return yield* missing;
    if (!(yield* mayRevoke(input.orgId, person.personId, KinPersonId.make(row.personId))))
      return yield* missing;
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE kin_tasks_keys SET revoked_at = ${now}
      WHERE org_id = ${input.orgId} AND session_id = ${input.sessionId} AND revoked_at IS NULL`;
    yield* auth.revokeSession(input.sessionId).pipe(Effect.mapError(() => unavailable));
    yield* refresh.touch(input.orgId, "people");
    return { revoked: true };
  }).pipe(sql.withTransaction, workFailure);
});

/** In the caller's transaction: who a key still acts as, or none once it is revoked or expired. */
export const holderOf = Effect.fn("KinTasksKeys.holderOf")(function* (sessionId: AuthSessionId) {
  const sql = yield* SqlClient.SqlClient;
  const { owner } = yield* KinIdentity;
  const now = yield* Clock.currentTimeMillis;
  const [row] = yield* sql<{ personId: string }>`SELECT k.person_id AS "personId"
    FROM kin_tasks_keys k
    WHERE k.org_id = ${owner.orgId} AND k.session_id = ${sessionId} AND ${live(sql, now)}`;
  return row === undefined
    ? Option.none<TasksKeyHolder>()
    : Option.some({ orgId: owner.orgId, personId: KinPersonId.make(row.personId), sessionId });
});

/**
 * The holder of a coding-agent key presented as a bearer token: a T3 session issued for exactly
 * this, with no other scope, and a live key row. Records the use. Anything else is none.
 */
export const admit = Effect.fn("KinTasksKeys.admit")(function* (token: string) {
  if (token === "") return Option.none<TasksKeyHolder>();
  const sessions = yield* SessionStore;
  const verified = yield* sessions
    .verify(token)
    .pipe(Effect.provideService(TasksKeyAudience, true), Effect.option);
  if (Option.isNone(verified)) return Option.none<TasksKeyHolder>();
  const session = verified.value;
  if (
    session.subject !== KIN_TASKS_KEY_SUBJECT ||
    session.method !== "bearer-access-token" ||
    session.proofKeyThumbprint !== undefined ||
    session.scopes.length !== 1 ||
    session.scopes[0] !== AuthKinTasksScope
  )
    return Option.none<TasksKeyHolder>();
  const holder = yield* holderOf(session.sessionId);
  if (Option.isNone(holder)) return holder;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  // Bookkeeping only: a failed write never refuses a key that was verified and is live.
  yield* sql`UPDATE kin_tasks_keys SET last_used_at = ${now}
    WHERE org_id = ${holder.value.orgId} AND session_id = ${session.sessionId}
      AND (last_used_at IS NULL OR last_used_at <= ${now - LAST_USE_STEP_MS})`.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Kin couldn't record a coding agent key's use", error),
    ),
  );
  return holder;
}, workFailure);
