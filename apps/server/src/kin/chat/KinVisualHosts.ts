import {
  KinChatError,
  type KinOrgId,
  type KinVisualHostInput,
  type KinVisualHosts as Hosts,
  type KinVisualHostsInput,
} from "@t3tools/contracts";
import { KIN_VISUAL_MAX_HOSTS, kinVisualHost } from "@t3tools/shared/kinVisual";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import { isOrgOwner } from "../lead/orgState.ts";
import type { PersonIdentity } from "./KinIdentity.ts";

type HostsError = KinChatError | PersistenceSqlError;

const notFound = new KinChatError({ reason: "not_found", message: "Kin organization not found." });
const notAllowed = new KinChatError({
  reason: "not_allowed",
  message: "Only the organization owner can choose where visuals may load from.",
});
const invalid = new KinChatError({
  reason: "invalid_state",
  message: "Enter a host name such as tiles.example.com: no address, port or path.",
});
const full = new KinChatError({
  reason: "limit",
  message: `Visuals can load from at most ${KIN_VISUAL_MAX_HOSTS} hosts. Remove one first.`,
});
const isChatError = Schema.is(KinChatError);
const mapError = (cause: unknown): HostsError =>
  isChatError(cause) ? cause : toPersistenceSqlError("KinVisualHosts")(cause);

/**
 * Where an org's visuals may load images, fonts, styles, media and data from besides Kin itself.
 * Empty until the owner adds a host. Only a person who owns the org reads or changes it: no
 * agent, tool or teammate has a path here.
 */
export class KinVisualHosts extends Context.Service<
  KinVisualHosts,
  {
    readonly list: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinVisualHostsInput,
    ) => Effect.Effect<Hosts, HostsError>;
    readonly allow: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinVisualHostInput,
    ) => Effect.Effect<Hosts, HostsError>;
    readonly remove: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinVisualHostInput,
    ) => Effect.Effect<Hosts, HostsError>;
    /** For the route that serves a visual: the policy it sends is built from this. */
    readonly served: (orgId: KinOrgId) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
  }
>()("t3/kin/chat/KinVisualHosts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const owner = Effect.fn("KinVisualHosts.owner")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const person = people.find((candidate) => candidate.orgId === orgId);
    if (person === undefined) return yield* notFound;
    const allowed = yield* isOrgOwner(orgId, person.personId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (!allowed) return yield* notAllowed;
    return person;
  });
  const read = Effect.fn("KinVisualHosts.read")(function* (orgId: KinOrgId) {
    const rows = yield* sql<{
      host: string;
    }>`SELECT host FROM kin_visual_hosts WHERE org_id = ${orgId} ORDER BY host`;
    // Stored rows are checked again: a row that is not a bare host never reaches a policy.
    return rows.flatMap((row) => (kinVisualHost(row.host) === row.host ? [row.host] : []));
  });
  const view = (orgId: KinOrgId) =>
    read(orgId).pipe(Effect.map((hosts): Hosts => ({ orgId, hosts })));

  return KinVisualHosts.of({
    list: Effect.fn("KinVisualHosts.list")(function* (people, input) {
      yield* owner(people, input.orgId);
      return yield* view(input.orgId);
    }, Effect.mapError(mapError)),
    allow: Effect.fn("KinVisualHosts.allow")(
      function* (people, input) {
        const person = yield* owner(people, input.orgId);
        const host = kinVisualHost(input.host);
        if (host === null) return yield* invalid;
        const hosts = yield* read(input.orgId);
        if (!hosts.includes(host) && hosts.length >= KIN_VISUAL_MAX_HOSTS) return yield* full;
        const createdAt = (yield* DateTime.now).epochMilliseconds;
        yield* sql`INSERT INTO kin_visual_hosts (org_id, host, added_by, created_at)
          VALUES (${input.orgId}, ${host}, ${person.personId}, ${createdAt})
          ON CONFLICT DO NOTHING`;
        return yield* view(input.orgId);
      },
      sql.withTransaction,
      Effect.mapError(mapError),
    ),
    remove: Effect.fn("KinVisualHosts.remove")(function* (people, input) {
      yield* owner(people, input.orgId);
      // Compared as stored, so a row that would no longer pass the check can still be removed.
      const host = input.host.trim().toLowerCase();
      yield* sql`DELETE FROM kin_visual_hosts WHERE org_id = ${input.orgId} AND host = ${host}`;
      return yield* view(input.orgId);
    }, Effect.mapError(mapError)),
    served: Effect.fn("KinVisualHosts.served")(
      (orgId) => read(orgId),
      Effect.mapError(toPersistenceSqlError("KinVisualHosts.served")),
    ),
  });
});

export const layer = Layer.effect(KinVisualHosts, make);
