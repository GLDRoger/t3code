// @effect-diagnostics nodeBuiltinImport:off -- synchronous hashing and constant-time invite verification.
import * as NodeCrypto from "node:crypto";
import {
  AuthKinChatScope,
  KIN_INVITE_DEFAULT_TTL_HOURS,
  KinChatError,
  KinInviteId,
  KinPerson,
  KinPersonId,
  KinWakeupId,
  type KinAgentId,
  type KinOrgId,
  type KinPeopleCreateInviteInput,
  type KinPeopleCreateInviteResult,
  type KinInviteAcceptRequest,
  type KinInviteAcceptResult,
  type KinPeopleListInvitesResult,
  type KinPeopleRevokeInviteInput,
  type KinPeopleListDevicesInput,
  type KinPeopleListDevicesResult,
  type KinPeopleRevokeDeviceInput,
  type KinPeopleRemoveAccessInput,
  type KinPeopleSetGithubLoginInput,
  type KinPeopleSetAccessInput,
  type KinPeopleSetPlacesInput,
  type KinPersonPlaces,
  type KinAccessMeInput,
  type KinAccessMeResult,
  type KinPeopleUpdateProfileInput,
  KinPersonProfile,
  KinPersonQuietHours,
  type KinPeopleSetOwnerNameInput,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { sessionUploadOwner } from "../../assets/AttachmentUpload.ts";
import { KinAttachmentStore } from "../chat/KinAttachmentStore.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinGroups } from "../chat/KinGroups.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { abortChatTurns } from "../lead/Audience.ts";
import { onPersonRemoved } from "../lead/ChatSharing.ts";
import { KinStop } from "../lead/KinStop.ts";
import { KinPresence, syncQueued } from "../reply/KinPresence.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { placesOf } from "../work/teamView.ts";
import { accessOf, accessSql, isOwnerHimself, mayActAsOwner, ownerLevel } from "./KinAccess.ts";
import { KIN_DEFAULT_QUIET_HOURS, stillAway } from "../triggers/quietHours.ts";
import { profileSets } from "./profileFields.ts";
import { reholdAfter, validZone } from "../triggers/quietHold.ts";
import { ownerZone } from "../work/recordRows.ts";

const isKinError = Schema.is(KinChatError);
const isSqlError = Schema.is(PersistenceSqlError);
const sqlError = (operation: string) => (e: unknown) =>
  isKinError(e) || isSqlError(e) ? e : toPersistenceSqlError(operation)(e);
type Failure = KinChatError | PersistenceSqlError;
const missing = new KinChatError({ reason: "not_found", message: "Kin record not found." });
const denied = new KinChatError({
  reason: "not_allowed",
  message: "This action requires the owner or a co-owner.",
});
const ownerOnly = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner changes who is a co-owner.",
});
const hash = (secret: string) => NodeCrypto.createHash("sha256").update(secret).digest();
const decodePersonRow = Schema.decodeUnknownSync(KinPerson);
const decodePerson = (row: Record<string, unknown>) => decodePersonRow(row);
const decodeProfileRow = Schema.decodeUnknownSync(KinPersonProfile);
const decodeQuiet = Schema.decodeUnknownOption(Schema.fromJsonString(KinPersonQuietHours));
const decodeProfile = (
  row: {
    readonly personId: string;
    readonly displayName: string;
    readonly handle: string;
    readonly pictureId: string | null;
    readonly roleTags: string;
    readonly skills: string;
    readonly timeZone: string | null;
    readonly workHours: string | null;
    readonly talkStyle: string;
    readonly quietHours: string | null;
    readonly hold: number | null;
    readonly away: string | null;
  },
  awayNow: (day: string, timeZone: string | null) => boolean,
) => {
  // An unset field stays off the wire, so the Team list's answer doesn't grow for nothing.
  const { talkStyle, quietHours, hold, away, ...rest } = row;
  return decodeProfileRow({
    ...rest,
    ...(away !== null && awayNow(away, row.timeZone) ? { awayUntil: away } : {}),
    ...(talkStyle === "" ? {} : { talkStyle }),
    ...(quietHours === null ? {} : { quietHours: JSON.parse(quietHours) }),
    ...(hold === null ? {} : { holdOutsideHours: hold === 1 }),
    roleTags: JSON.parse(row.roleTags),
    workHours: row.workHours === null ? null : JSON.parse(row.workHours),
  });
};

export class KinPeople extends Context.Service<
  KinPeople,
  {
    readonly createInvite: (
      session: AuthenticatedSession,
      input: KinPeopleCreateInviteInput,
    ) => Effect.Effect<KinPeopleCreateInviteResult, Failure>;
    readonly listInvites: (
      session: AuthenticatedSession,
      orgId: KinOrgId,
    ) => Effect.Effect<KinPeopleListInvitesResult, Failure>;
    readonly revokeInvite: (
      session: AuthenticatedSession,
      input: KinPeopleRevokeInviteInput,
    ) => Effect.Effect<{ revoked: boolean }, Failure>;
    readonly accept: (
      input: KinInviteAcceptRequest,
    ) => Effect.Effect<KinInviteAcceptResult, Failure>;
    readonly list: (
      session: AuthenticatedSession,
      orgId: KinOrgId,
    ) => Effect.Effect<
      {
        people: ReadonlyArray<KinPerson>;
        joined: ReadonlyArray<KinPersonId>;
        /** Owner level only: a member reads names. */
        places?: ReadonlyArray<KinPersonPlaces>;
      },
      Failure
    >;
    readonly listDevices: (
      session: AuthenticatedSession,
      input: KinPeopleListDevicesInput,
    ) => Effect.Effect<KinPeopleListDevicesResult, Failure>;
    readonly revokeDevice: (
      session: AuthenticatedSession,
      input: KinPeopleRevokeDeviceInput,
    ) => Effect.Effect<{ revoked: boolean }, Failure>;
    readonly removeAccess: (
      session: AuthenticatedSession,
      input: KinPeopleRemoveAccessInput,
    ) => Effect.Effect<{ revoked: boolean }, Failure>;
    readonly setGithubLogin: (
      session: AuthenticatedSession,
      input: KinPeopleSetGithubLoginInput,
    ) => Effect.Effect<KinPerson, Failure>;
    /** The owner alone: makes someone a co-owner or a member; demoting stops their running turns. */
    readonly setAccess: (
      session: AuthenticatedSession,
      input: KinPeopleSetAccessInput,
    ) => Effect.Effect<KinPerson, Failure>;
    /** The owner or a co-owner switches the places a member sees beyond Tasks. */
    readonly setPlaces: (
      session: AuthenticatedSession,
      input: KinPeopleSetPlacesInput,
    ) => Effect.Effect<KinPersonPlaces, Failure>;
    readonly accessMe: (
      session: AuthenticatedSession,
      input: KinAccessMeInput,
    ) => Effect.Effect<KinAccessMeResult, Failure>;
    readonly profiles: (
      session: AuthenticatedSession,
      orgId: KinOrgId,
    ) => Effect.Effect<
      { profiles: ReadonlyArray<KinPersonProfile>; ownerPersonId: KinPersonId },
      Failure
    >;
    readonly updateProfile: (
      session: AuthenticatedSession,
      input: KinPeopleUpdateProfileInput,
    ) => Effect.Effect<KinPersonProfile, Failure>;
    /** The owner's own name: what agents call them and teammates see. */
    readonly setOwnerName: (
      session: AuthenticatedSession,
      input: KinPeopleSetOwnerNameInput,
    ) => Effect.Effect<KinPerson, Failure>;
  }
>()("t3/kin/people/KinPeople") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const sessions = yield* SessionStore;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const refresh = yield* KinRefreshObserver;
  const presence = yield* Effect.serviceOption(KinPresence);
  const stop = yield* Effect.serviceOption(KinStop);
  const store = yield* Effect.serviceOption(KinAttachmentStore);
  const chats = yield* Effect.serviceOption(KinChatService);
  const groups = yield* Effect.serviceOption(KinGroups);
  const records = yield* Effect.serviceOption(KinRecords);
  /** Work's live streams re-read what this person may see once the change commits. */
  const viewMoved = (orgId: KinOrgId, personId: KinPersonId) =>
    Option.isSome(records) ? records.value.peopleMoved(orgId, [personId]) : Effect.void;
  const level = (orgId: KinOrgId, personId: KinPersonId) =>
    ownerLevel(orgId, personId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  /** The caller, when owner-level here: the owner or a co-owner runs Team. */
  const owner = Effect.fn("KinPeople.requireOwnerLevel")(function* (
    session: AuthenticatedSession,
    orgId: KinOrgId,
  ) {
    if (orgId !== identity.owner.orgId) return yield* missing;
    const caller = (yield* identity.resolve(session)).find((p) => p.orgId === orgId);
    if (caller === undefined || !(yield* level(orgId, caller.personId))) return yield* denied;
    return caller;
  });
  /** A co-owner acts on members and on themself; another owner-level person is the owner's call. */
  const mayActOn = Effect.fn("KinPeople.mayActOn")(function* (
    caller: { readonly personId: KinPersonId },
    orgId: KinOrgId,
    personId: KinPersonId,
  ) {
    if (isOwnerHimself(identity.owner, personId)) return yield* denied;
    if (isOwnerHimself(identity.owner, caller.personId) || caller.personId === personId) return;
    if ((yield* level(orgId, personId)) || (yield* keptLevel(orgId, personId)))
      return yield* ownerOnly;
  });
  /** Removed, whether a new link would bring them back owner-level: then it is the owner's call. */
  const keptLevel = Effect.fn("KinPeople.keptLevel")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
  ) {
    const [row] = yield* sql<{ kept: string | null }>`SELECT
        json_extract(removed_access_json, '$.access') AS kept
      FROM kin_people WHERE org_id = ${orgId} AND person_id = ${personId}
        AND removed_at IS NOT NULL`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.keptLevel")),
    );
    return row?.kept === "co_owner";
  });
  const person = Effect.fn("KinPeople.person")(function* (orgId: KinOrgId, personId: KinPersonId) {
    const rows =
      yield* sql`SELECT person_id AS "personId", org_id AS "orgId", handle, display_name AS "displayName",
      github_login AS "githubLogin", ${sql.literal(accessSql("kin_people"))} AS access, created_at AS "createdAt" FROM kin_people
      WHERE org_id = ${orgId} AND person_id = ${personId} ORDER BY person_id`.pipe(
        Effect.mapError(toPersistenceSqlError("KinPeople.person")),
      );
    if (!rows[0]) return yield* missing;
    return decodePerson(rows[0]);
  });
  const uniqueHandle = Effect.fn("KinPeople.uniqueHandle")(function* (
    orgId: KinOrgId,
    base: string,
    now: number,
  ) {
    const rows = yield* sql<{
      handle: string;
    }>`SELECT handle FROM kin_people WHERE org_id = ${orgId}
      UNION SELECT handle FROM kin_people_invites WHERE org_id = ${orgId}
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${now} ORDER BY handle`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.uniqueHandle")),
    );
    const used = new Set(rows.map((row) => row.handle));
    let handle = base;
    for (let n = 2; used.has(handle); n++) {
      const suffix = `-${n}`;
      handle = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    }
    return handle;
  });
  const createInvite = Effect.fn("KinPeople.createInvite")(function* (
    session: AuthenticatedSession,
    input: KinPeopleCreateInviteInput,
  ) {
    const caller = yield* owner(session, input.orgId);
    if (input.personId !== undefined) yield* mayActOn(caller, input.orgId, input.personId);
    const now = (yield* DateTime.now).epochMilliseconds;
    const secret = NodeCrypto.randomBytes(32).toString("base64url");
    const inviteId = KinInviteId.make(NodeCrypto.randomUUID());
    let handle =
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
          if (isOwnerHimself(identity.owner, input.personId)) return yield* denied;
          if (input.personId) yield* person(input.orgId, input.personId);
          else handle = yield* uniqueHandle(input.orgId, handle, now);
          yield* sql`INSERT INTO kin_people_invites (invite_id, org_id, person_id, display_name, handle, secret_hash, created_at, expires_at)
        VALUES (${inviteId}, ${input.orgId}, ${input.personId ?? null}, ${input.displayName}, ${handle},
          ${hash(secret).toString("hex")}, ${now}, ${expiresAt})`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.createInvite")),
          );
          yield* refresh.touch(input.orgId, "people");
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
  /**
   * The same person let back in: the level, places, leads and chats their access was removed
   * from come back as they were, history included, and their tasks note who let them back.
   */
  const bringBack = Effect.fn("KinPeople.bringBack")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
  ) {
    const [gone] = yield* sql<{ removedAt: number | null }>`SELECT removed_at AS "removedAt"
      FROM kin_people WHERE org_id = ${orgId} AND person_id = ${personId}`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.back")),
    );
    yield* sql`UPDATE kin_people
      SET access = COALESCE(json_extract(removed_access_json, '$.access'), access),
        sees_clients = COALESCE(json_extract(removed_access_json, '$.clients'), sees_clients),
        sees_docs = COALESCE(json_extract(removed_access_json, '$.docs'), sees_docs),
        sees_money = COALESCE(json_extract(removed_access_json, '$.money'), sees_money),
        removed_access_json = NULL, removed_at = NULL
      WHERE org_id = ${orgId} AND person_id = ${personId}`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.back")),
    );
    const removedAt = gone?.removedAt ?? null;
    if (removedAt === null) return;
    // Removal stamps each with the same instant, so this undoes that removal and nothing older.
    yield* sql`UPDATE kin_lead_access SET revoked_at = NULL
      WHERE org_id = ${orgId} AND person_id = ${personId} AND revoked_at = ${removedAt}`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.backLeads")),
    );
    yield* sql`UPDATE kin_chat_members SET left_at = NULL
      WHERE org_id = ${orgId} AND principal_kind = 'person' AND person_id = ${personId}
        AND left_at = ${DateTime.formatIso(DateTime.makeUnsafe(removedAt))}`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.backChats")),
    );
    yield* viewMoved(orgId, personId);
    yield* refresh.touch(orgId, "leads");
    // A co-owner talks to every agent in their own chat with it, as `setAccess` opens them.
    if (Option.isSome(chats) && (yield* level(orgId, personId))) {
      const leads = yield* sql<{ agentId: KinAgentId }>`SELECT l.agent_id AS "agentId"
        FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE l.org_id = ${orgId} AND a.role = 'lead' AND a.retired_at IS NULL
        ORDER BY l.agent_id`.pipe(
        Effect.mapError(toPersistenceSqlError("KinPeople.backLeadChats")),
      );
      for (const lead of leads)
        yield* chats.value.createDirect(
          { _tag: "person", orgId, personId },
          { orgId, agentId: lead.agentId },
        );
    }
    if (Option.isSome(records))
      yield* noteTasks(records.value, personId, { orgId, personId }, "accessBack");
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
          WHERE org_id = ${orgId} AND invite_id = ${inviteId} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${now} ORDER BY invite_id`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.accept")),
          );
          const row = rows[0];
          if (
            !row ||
            isOwnerHimself(identity.owner, row.person_id) ||
            !/^[a-f0-9]{64}$/.test(row.secret_hash) ||
            !NodeCrypto.timingSafeEqual(hash(secret), Buffer.from(row.secret_hash, "hex"))
          )
            return yield* missing;
          const consumed = yield* sql`UPDATE kin_people_invites SET consumed_at = ${now}
        WHERE org_id = ${orgId} AND invite_id = ${inviteId} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${now} RETURNING invite_id`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.consume")),
          );
          if (!consumed.length) return yield* missing;
          const personId = KinPersonId.make(row.person_id ?? NodeCrypto.randomUUID());
          if (row.person_id) yield* bringBack(identity.owner.orgId, personId);
          if (!row.person_id) {
            const handle = yield* uniqueHandle(identity.owner.orgId, row.handle, now);
            // A new teammate starts with client names and shared docs; money stays off.
            yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
            sees_clients, sees_docs, sees_money)
          VALUES (${personId}, ${orgId}, ${handle}, ${row.display_name}, ${DateTime.formatIso(DateTime.makeUnsafe(now))}, 'member', 1, 1, 0)`.pipe(
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
          yield* refresh.touch(identity.owner.orgId, "people");
          if (Option.isSome(chats)) {
            const teamAgent = yield* LeadAccess.teamAgent(member.orgId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.mapError(toPersistenceSqlError("KinPeople.teamAgent")),
            );
            if (teamAgent !== null)
              yield* chats.value.createDirect(
                { _tag: "person", orgId: member.orgId, personId },
                { orgId: member.orgId, agentId: teamAgent },
              );
          }
          if (Option.isSome(groups)) yield* groups.value.joinCompany(member.orgId, personId);
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
    if (orgId !== identity.owner.orgId) return yield* missing;
    const caller = (yield* identity.resolve(session)).find((p) => p.orgId === orgId);
    if (caller === undefined) return yield* denied;
    const full = yield* level(orgId, caller.personId);
    const rows =
      yield* sql`SELECT person_id AS "personId", org_id AS "orgId", handle, display_name AS "displayName",
      github_login AS "githubLogin", ${sql.literal(accessSql("kin_people"))} AS access, created_at AS "createdAt" FROM kin_people WHERE org_id = ${orgId} ORDER BY handle, person_id`.pipe(
        Effect.mapError(toPersistenceSqlError("KinPeople.list")),
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    const joined = yield* sql<{
      personId: KinPersonId;
    }>`SELECT DISTINCT b.person_id AS "personId" FROM kin_session_bindings b
      JOIN auth_sessions a ON a.session_id = b.session_id
      WHERE b.org_id = ${orgId} AND b.revoked_at IS NULL AND a.revoked_at IS NULL
      AND a.expires_at > ${now} ORDER BY b.person_id`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.joined")),
    );
    // The owner opens Kin from their own session, never a teammate's binding, and is always there.
    const reachable = [
      ...new Set([identity.owner.personId, ...joined.map((row) => row.personId)]),
    ].toSorted();
    const people = rows.map(decodePerson);
    // A member reads who is on the team, as their profiles already say, and who the owner is;
    // everyone else's access and places stay the owner's.
    if (!full)
      return {
        people: people.map(({ access, ...one }) => ({
          ...one,
          ...(access === "owner" ? { access } : {}),
          githubLogin: null,
        })),
        joined: reachable,
      };
    const places = yield* Effect.forEach(people, (one) => placesFor(orgId, one.personId));
    return { people, joined: reachable, places };
  });
  const placesFor = Effect.fn("KinPeople.placesFor")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
  ) {
    const places = yield* placesOf(orgId, personId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(toPersistenceSqlError("KinPeople.places")),
    );
    return {
      personId,
      clients: places.clients,
      docs: places.docs,
      money: places.money,
      leads: places.leads,
    } satisfies KinPersonPlaces;
  });
  const listInvites = Effect.fn("KinPeople.listInvites")(function* (
    session: AuthenticatedSession,
    orgId: KinOrgId,
  ) {
    yield* owner(session, orgId);
    const now = (yield* DateTime.now).epochMilliseconds;
    const rows = yield* sql<{
      inviteId: KinInviteId;
      personId: KinPersonId | null;
      displayName: string;
      handle: string;
      createdAt: number;
      expiresAt: number;
    }>`SELECT invite_id AS "inviteId", person_id AS "personId", display_name AS "displayName", handle,
      created_at AS "createdAt", expires_at AS "expiresAt" FROM kin_people_invites WHERE org_id = ${orgId}
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${now} ORDER BY created_at, invite_id`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.listInvites")),
    );
    return {
      invites: rows.map((row) => ({
        ...row,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.createdAt)),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(row.expiresAt)),
      })),
    };
  });
  const revokeInvite = Effect.fn("KinPeople.revokeInvite")(function* (
    session: AuthenticatedSession,
    input: KinPeopleRevokeInviteInput,
  ) {
    yield* owner(session, input.orgId);
    const now = (yield* DateTime.now).epochMilliseconds;
    const rows = yield* sql`UPDATE kin_people_invites SET revoked_at = ${now}
      WHERE org_id = ${input.orgId} AND invite_id = ${input.inviteId} AND consumed_at IS NULL
      AND revoked_at IS NULL AND expires_at > ${now} RETURNING invite_id`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.revokeInvite")),
    );
    if (!rows.length) return yield* missing;
    yield* refresh.touch(input.orgId, "people");
    return { revoked: true };
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
    yield* mayActOn(yield* owner(session, input.orgId), input.orgId, input.personId);
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
          yield* refresh.touch(input.orgId, "people");
          return { revoked: true };
        }),
      )
      .pipe(Effect.mapError(sqlError("KinPeople.revokeDevice")));
  });
  /**
   * Takes away the person's access: links, sessions, every chat and lead they could reach, their
   * pushes, and every turn or event that answers them. Nothing else moves: their open tasks stay
   * in their name, each saying who removed them, and nothing is given to anyone. A new link for
   * the same person (`accept`) brings back exactly what they had.
   */
  const removeAccess = Effect.fn("KinPeople.removeAccess")(function* (
    session: AuthenticatedSession,
    input: KinPeopleRemoveAccessInput,
  ) {
    const caller = yield* owner(session, input.orgId);
    yield* mayActOn(caller, input.orgId, input.personId);
    const now = (yield* DateTime.now).epochMilliseconds;
    const leftAt = DateTime.formatIso(DateTime.makeUnsafe(now));
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* person(input.orgId, input.personId);
          // Removed, they hold no level anywhere; what they had is kept for a new link to restore.
          yield* sql`UPDATE kin_people SET removed_access_json = json_object('access', access,
              'clients', sees_clients, 'docs', sees_docs, 'money', sees_money),
              access = 'member', sees_clients = 1, sees_docs = 1, sees_money = 0,
              removed_at = ${now}
            WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.removeAccessReset")),
          );
          yield* viewMoved(input.orgId, input.personId);
          if (Option.isSome(records))
            yield* noteTasks(records.value, caller.personId, input, "accessRemoved");
          // An unused link would let them straight back in.
          yield* sql`UPDATE kin_people_invites SET revoked_at = ${now}
        WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND consumed_at IS NULL
        AND revoked_at IS NULL`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.removeAccessInvites")),
          );
          const rows = yield* sql<{
            session_id: AuthSessionId;
          }>`UPDATE kin_session_bindings SET revoked_at = ${now}
        WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND revoked_at IS NULL
        RETURNING session_id`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.removeAccess")),
          );
          yield* Effect.forEach(rows, (row) =>
            sessions
              .revoke(row.session_id)
              .pipe(Effect.mapError(toPersistenceSqlError("KinPeople.revokeSession"))),
          );
          yield* sql`DELETE FROM kin_push_devices
        WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.removeAccessPush")),
          );
          yield* sql`UPDATE kin_lead_access SET revoked_at = ${now}
        WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND revoked_at IS NULL`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.removeAccessLeads")),
          );
          yield* refresh.touch(input.orgId, "people");
          yield* refresh.touch(input.orgId, "leads");
          // Before leaving: their own chats with leads are found through their membership.
          const stopped = yield* onPersonRemoved(input).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(toPersistenceSqlError("KinPeople.removeAccessTurns")),
          );
          if (stopped.threads.length > 0)
            yield* sql.afterCommit(
              Effect.forEach(
                stopped.threads,
                (threadId) =>
                  identity.endAgentThread({ orgId: input.orgId, threadId }).pipe(Effect.ignore),
                { discard: true },
              ),
            );
          for (const member of yield* repo.listMembersByPerson(input)) {
            if (member.leftAt !== null) continue;
            for (const item of yield* repo.leaveChat({ ...member, leftAt }))
              yield* hub.publish({ type: "waiting.updated", orgId: input.orgId, item });
            const gone = yield* repo.getMember(member);
            if (Option.isSome(gone))
              yield* hub.publish({
                type: "member.removed",
                orgId: input.orgId,
                member: gone.value,
              });
          }
          if (stopped.expired.length > 0 && Option.isSome(presence)) {
            const line = presence.value;
            yield* sql.afterCommit(
              Effect.forEach(
                new Set(stopped.expired.map((row) => row.agentId)),
                (agentId) =>
                  syncQueued(line, input.orgId, agentId).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  ),
                { discard: true },
              ),
            );
          }
          if (stopped.turns.length > 0 && Option.isSome(stop))
            yield* sql.afterCommit(
              stop.value.abortTurns(
                input.orgId,
                stopped.turns.map((turn) => KinWakeupId.make(turn.wakeupId)),
              ),
            );
          return { revoked: true };
        }),
      )
      .pipe(Effect.mapError(sqlError("KinPeople.removeAccess")));
  });
  /**
   * Each open task the person holds says, in its history, that `by` removed their access or that
   * they came back; it stays theirs either way, so no agent starts on it because of either.
   */
  const noteTasks = Effect.fn("KinPeople.noteTasks")(function* (
    tasks: KinRecords["Service"],
    by: KinPersonId,
    input: { readonly orgId: KinOrgId; readonly personId: KinPersonId },
    field: "accessRemoved" | "accessBack",
  ) {
    const held = yield* sql<{ key: string }>`SELECT key FROM kin_records
      WHERE org_id = ${input.orgId} AND register_id = 'work' AND owner_kind = 'person'
        AND owner_id = ${input.personId} AND state NOT IN ('done', 'dropped')
      ORDER BY key`.pipe(Effect.mapError(toPersistenceSqlError("KinPeople.heldTasks")));
    const writer: Writer = { actor: { _tag: "person", personId: by }, via: "owner", askedBy: by };
    for (const task of held)
      yield* tasks.update(input.orgId, writer, task.key, {}, undefined, [
        { field, from: `person:${input.personId}`, to: null },
      ]);
  });
  const setGithubLogin = Effect.fn("KinPeople.setGithubLogin")(function* (
    session: AuthenticatedSession,
    input: KinPeopleSetGithubLoginInput,
  ) {
    const caller = (yield* identity.resolve(session)).find((p) => p.orgId === input.orgId);
    if (caller === undefined) return yield* missing;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* person(input.orgId, input.personId);
          if (caller.personId !== input.personId) {
            if (!(yield* level(input.orgId, caller.personId))) return yield* denied;
            yield* mayActOn(caller, input.orgId, input.personId);
          }

          if (input.githubLogin !== null) {
            const clashes =
              yield* sql`SELECT person_id FROM kin_people WHERE org_id = ${input.orgId}
              AND lower(github_login) = lower(${input.githubLogin}) AND person_id != ${input.personId} ORDER BY person_id`.pipe(
                Effect.mapError(toPersistenceSqlError("KinPeople.githubLoginClash")),
              );
            if (clashes.length)
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "That GitHub login is already linked to someone.",
              });
          }
          // This login routes review reminders; it never grants GitHub authority.
          yield* sql`UPDATE kin_people SET github_login = ${input.githubLogin} WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.setGithubLogin")),
          );
          yield* refresh.touch(input.orgId, "people");
          return yield* person(input.orgId, input.personId);
        }),
      )
      .pipe(Effect.mapError(sqlError("KinPeople.setGithubLogin")));
  });
  const setAccess = Effect.fn("KinPeople.setAccess")(function* (
    session: AuthenticatedSession,
    input: KinPeopleSetAccessInput,
  ) {
    const caller = yield* owner(session, input.orgId);
    if (!isOwnerHimself(identity.owner, caller.personId)) return yield* ownerOnly;
    if (isOwnerHimself(identity.owner, input.personId)) return yield* ownerOnly;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Removed, it is the level a new link brings back; the row stays a member's meanwhile.
          const kept = yield* sql`UPDATE kin_people
            SET removed_access_json = json_set(removed_access_json, '$.access', ${input.access})
            WHERE org_id = ${input.orgId} AND person_id = ${input.personId}
              AND removed_at IS NOT NULL AND removed_access_json IS NOT NULL
            RETURNING person_id`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.setAccess")),
          );
          if (kept.length > 0) {
            yield* refresh.touch(input.orgId, "people");
            return yield* person(input.orgId, input.personId);
          }
          const before = (yield* person(input.orgId, input.personId)).access;
          if (before === input.access) return yield* person(input.orgId, input.personId);
          yield* sql`UPDATE kin_people SET access = ${input.access}
            WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND access IS NOT 'owner'`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.setAccess")),
          );
          yield* viewMoved(input.orgId, input.personId);
          // A co-owner talks to every agent in their own chat with it, never in the owner's.
          if (input.access === "co_owner" && Option.isSome(chats)) {
            const leads = yield* sql<{ agentId: KinAgentId }>`SELECT l.agent_id AS "agentId"
              FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
              WHERE l.org_id = ${input.orgId} AND a.role = 'lead' AND a.retired_at IS NULL
              ORDER BY l.agent_id`.pipe(Effect.mapError(toPersistenceSqlError("KinPeople.leads")));
            for (const lead of leads)
              yield* chats.value.createDirect(
                { _tag: "person", orgId: input.orgId, personId: input.personId },
                { orgId: input.orgId, agentId: lead.agentId },
              );
          }
          // Their turns were built at the owner's level; none may finish at it.
          const turns: Array<{ agentId: string; wakeupId: string }> = [];
          if (input.access === "member")
            for (const member of yield* repo.listMembersByPerson(input)) {
              if (member.leftAt !== null) continue;
              turns.push(
                ...(yield* abortChatTurns({
                  orgId: input.orgId,
                  chatId: member.chatId,
                  personId: input.personId,
                }).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                  Effect.mapError(toPersistenceSqlError("KinPeople.setAccessTurns")),
                )),
              );
            }
          if (turns.length > 0 && Option.isSome(stop))
            yield* sql.afterCommit(
              stop.value.abortTurns(
                input.orgId,
                turns.map((turn) => KinWakeupId.make(turn.wakeupId)),
              ),
            );
          yield* refresh.touch(input.orgId, "people");
          yield* refresh.touch(input.orgId, "leads");
          return yield* person(input.orgId, input.personId);
        }),
      )
      .pipe(Effect.mapError(sqlError("KinPeople.setAccess")));
  });
  const accessMe = Effect.fn("KinPeople.accessMe")(function* (
    session: AuthenticatedSession,
    input: KinAccessMeInput,
  ) {
    const caller = (yield* identity.resolve(session)).find((p) => p.orgId === input.orgId);
    if (caller === undefined) return yield* missing;
    const access = yield* accessOf(input.orgId, caller.personId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (access === undefined) return yield* missing;
    const places = yield* placesFor(input.orgId, caller.personId);
    const all = access === "owner" || access === "co_owner";
    return {
      personId: caller.personId,
      access,
      places: all
        ? { clients: true, docs: true, money: true }
        : { clients: places.clients, docs: places.docs, money: places.money },
      leads: places.leads,
    };
  });
  const setPlaces = Effect.fn("KinPeople.setPlaces")(function* (
    session: AuthenticatedSession,
    input: KinPeopleSetPlacesInput,
  ) {
    yield* owner(session, input.orgId);
    if (yield* level(input.orgId, input.personId))
      return yield* new KinChatError({
        reason: "invalid_state",
        message: "The owner and co-owners see every place.",
      });
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const flag = (on: boolean | undefined) => (on === undefined ? null : on ? 1 : 0);
          // Removed, they are the places a new link brings back.
          const kept = yield* sql`UPDATE kin_people SET removed_access_json = json_set(
                removed_access_json,
                '$.clients', COALESCE(${flag(input.clients)}, json_extract(removed_access_json, '$.clients')),
                '$.docs', COALESCE(${flag(input.docs)}, json_extract(removed_access_json, '$.docs')),
                '$.money', COALESCE(${flag(input.money)}, json_extract(removed_access_json, '$.money')))
            WHERE org_id = ${input.orgId} AND person_id = ${input.personId}
              AND removed_at IS NOT NULL AND removed_access_json IS NOT NULL
            RETURNING person_id`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.setPlaces")),
          );
          if (kept.length > 0) {
            yield* refresh.touch(input.orgId, "people");
            return yield* placesFor(input.orgId, input.personId);
          }
          const changed = yield* sql`UPDATE kin_people SET
              sees_clients = COALESCE(${flag(input.clients)}, sees_clients),
              sees_docs = COALESCE(${flag(input.docs)}, sees_docs),
              sees_money = COALESCE(${flag(input.money)}, sees_money)
            WHERE org_id = ${input.orgId} AND person_id = ${input.personId}
            RETURNING person_id`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.setPlaces")),
          );
          if (changed.length === 0) return yield* missing;
          yield* viewMoved(input.orgId, input.personId);
          yield* refresh.touch(input.orgId, "people");
          // Their own screens read places from `kin.access.me`, which follows `leads`.
          yield* refresh.touch(input.orgId, "leads");
          return yield* placesFor(input.orgId, input.personId);
        }),
      )
      .pipe(Effect.mapError(sqlError("KinPeople.setPlaces")));
  });
  const profileRows = Effect.fn("KinPeople.profileRows")(
    function* (orgId: KinOrgId, personId?: KinPersonId) {
      const rows = yield* sql<Parameters<typeof decodeProfile>[0]>`SELECT person_id AS "personId",
        display_name AS "displayName", handle, avatar_attachment_id AS "pictureId",
        role_tags_json AS "roleTags", skills, time_zone AS "timeZone", work_hours_json AS "workHours",
        talk_style AS "talkStyle", quiet_hours_json AS "quietHours", hold_outside_hours AS hold,
        away_until AS away
      FROM kin_people WHERE org_id = ${orgId}
        ${personId === undefined ? sql`` : sql`AND person_id = ${personId}`}
      ORDER BY display_name, person_id`;
      const now = yield* Clock.currentTimeMillis;
      const company = rows.some((row) => row.away !== null)
        ? yield* ownerZone(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql))
        : "UTC";
      // Away ends on its day, on their own clock: the profile stops saying it then.
      return rows.map((row) =>
        decodeProfile(row, (day, zone) => stillAway(day, validZone(zone) ?? company, now)),
      );
    },
    Effect.mapError(toPersistenceSqlError("KinPeople.profiles")),
  );
  /** Everyone in the org, as they describe themselves. Any person of the org reads it. */
  const profiles = Effect.fn("KinPeople.profiles")(function* (
    session: AuthenticatedSession,
    orgId: KinOrgId,
  ) {
    const people = yield* identity.resolve(session);
    if (!people.some((p) => p.orgId === orgId)) return yield* missing;
    const rows = yield* profileRows(orgId);
    const person = people.find((p) => p.orgId === identity.owner.orgId);
    const ownerLevelReader =
      person !== undefined &&
      (yield* mayActAsOwner(orgId, person.personId, identity.owner).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ));
    const reader = people.find((p) => p.orgId === orgId);
    const [settings] = yield* sql<{ hours: string }>`SELECT quiet_hours_json AS hours
      FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.quietHours")),
    );
    const quietHours = Option.getOrElse(decodeQuiet(settings?.hours), () => ({
      ...KIN_DEFAULT_QUIET_HOURS,
    }));
    // Whose profile the reader may change: the same check `updateProfile` runs.
    const editable = new Set<string>();
    for (const row of rows)
      if (
        reader !== undefined &&
        (reader.personId === row.personId ||
          (ownerLevelReader &&
            (yield* mayActOn(reader, orgId, row.personId).pipe(Effect.isSuccess))))
      )
        editable.add(row.personId);
    const withEdit = <A extends { readonly personId: string }>(profile: A) => ({
      ...profile,
      canEdit: editable.has(profile.personId),
    });
    if (!ownerLevelReader)
      return {
        profiles: rows.map(withEdit),
        ownerPersonId: identity.owner.personId,
        quietHours,
      };
    // The Team list's open and late counts: owner-level, as people_read's load is.
    const now = yield* Clock.currentTimeMillis;
    const held = yield* sql<{ personId: string; open: number; late: number }>`SELECT
        owner_id AS "personId", COUNT(*) AS open,
        SUM(due_at IS NOT NULL AND due_at < ${now}) AS late
      FROM kin_records WHERE org_id = ${orgId} AND register_id = 'work' AND owner_kind = 'person'
        AND state NOT IN ('done', 'dropped')
      GROUP BY owner_id ORDER BY owner_id`.pipe(
      Effect.mapError(toPersistenceSqlError("KinPeople.load")),
    );
    const load = new Map(held.map((row) => [row.personId, row]));
    return {
      profiles: rows.map((profile) => ({
        ...withEdit(profile),
        load: {
          open: load.get(profile.personId)?.open ?? 0,
          late: load.get(profile.personId)?.late ?? 0,
        },
      })),
      ownerPersonId: identity.owner.personId,
      quietHours,
    };
  });
  /**
   * A person changes their own profile; the owner changes anyone's, a co-owner a member's. A new
   * picture is claimed from the caller's uploads before the write, and the old one is removed
   * after it commits.
   */
  const updateProfile = Effect.fn("KinPeople.updateProfile")(function* (
    session: AuthenticatedSession,
    input: KinPeopleUpdateProfileInput,
  ) {
    const people = yield* identity.resolve(session);
    const caller = people.find((p) => p.orgId === input.orgId);
    if (caller === undefined) return yield* missing;
    // Anyone edits their own; owner-level people edit whoever they may act on.
    if (caller.personId !== input.personId)
      yield* mayActOn(yield* owner(session, input.orgId), input.orgId, input.personId);
    if (caller.personId !== input.personId && input.talkStyle !== undefined)
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "Only they can say how they like to be spoken to.",
      });
    if (
      caller.personId !== input.personId &&
      (input.quietHours !== undefined || input.holdOutsideHours !== undefined)
    )
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "Only they can set when Kin holds messages for them.",
      });
    const picture = input.picture;
    if (picture != null && picture.type !== "image")
      return yield* new KinChatError({
        reason: "invalid_state",
        message: "A picture is an image.",
      });
    const claimed =
      picture == null
        ? undefined
        : Option.isNone(store)
          ? yield* new KinChatError({ reason: "unavailable", message: "Pictures can't be saved." })
          : yield* store.value.claim([picture], sessionUploadOwner(session));
    const pictureId =
      picture === undefined ? undefined : picture === null ? null : claimed?.attachments[0]?.id;
    if (picture != null && pictureId === undefined)
      return yield* new KinChatError({
        reason: "invalid_state",
        message: "The picture didn't upload.",
      });
    const written = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [before] = yield* sql<{ pictureId: string | null }>`
            SELECT avatar_attachment_id AS "pictureId" FROM kin_people
            WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.updateProfile")),
          );
          if (before === undefined) return yield* missing;
          const now = (yield* DateTime.now).epochMilliseconds;
          const set = [
            ...(yield* profileSets(input, now).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            )),
            ...(pictureId === undefined ? [] : [sql`avatar_attachment_id = ${pictureId}`]),
          ];
          yield* reholdAfter(
            input.orgId,
            input.personId,
            sql`UPDATE kin_people SET ${sql.csv(set)}
              WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`,
          ).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(toPersistenceSqlError("KinPeople.updateProfile")),
          );
          yield* refresh.touch(input.orgId, "people");
          const [profile] = yield* profileRows(input.orgId, input.personId);
          if (profile === undefined) return yield* missing;
          return { profile, replaced: pictureId === undefined ? null : before.pictureId };
        }),
      )
      .pipe(
        Effect.mapError(sqlError("KinPeople.updateProfile")),
        Effect.tapError(() =>
          claimed === undefined || Option.isNone(store)
            ? Effect.void
            : store.value.release(claimed),
        ),
      );
    if (written.replaced !== null && written.replaced !== pictureId && Option.isSome(store))
      yield* store.value.remove([written.replaced]);
    if (claimed !== undefined && Option.isSome(store) && picture != null)
      yield* store.value.discardPending([picture]);
    return written.profile;
  });
  const setOwnerName = Effect.fn("KinPeople.setOwnerName")(function* (
    session: AuthenticatedSession,
    input: KinPeopleSetOwnerNameInput,
  ) {
    const people = yield* identity.resolve(session);
    const owner = people.find(
      (p) => p.orgId === input.orgId && isOwnerHimself(identity.owner, p.personId),
    );
    if (owner === undefined)
      return yield* people.some((p) => p.orgId === input.orgId) ? denied : missing;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE kin_people SET display_name = ${input.displayName}
            WHERE org_id = ${input.orgId} AND person_id = ${owner.personId}`.pipe(
            Effect.mapError(toPersistenceSqlError("KinPeople.setOwnerName")),
          );
          yield* refresh.touch(input.orgId, "people");
          return yield* person(input.orgId, owner.personId);
        }),
      )
      .pipe(Effect.mapError(sqlError("KinPeople.setOwnerName")));
  });
  return KinPeople.of({
    setAccess,
    setPlaces,
    accessMe,
    profiles,
    updateProfile,
    listInvites,
    revokeInvite,
    createInvite,
    accept,
    list,
    listDevices,
    revokeDevice,
    removeAccess,
    setGithubLogin,
    setOwnerName,
  });
});
export const layer = Layer.effect(KinPeople, make);
