import {
  KinChatError,
  KinOwnerTimeZone as OwnerTimeZone,
  type KinOrgId,
  type KinOwnerTimeZoneGetInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { isOrgOwner } from "../lead/orgState.ts";
import type * as Routines from "./routines.ts";

type TimeZoneError = KinChatError | PersistenceSqlError;

const notFound = new KinChatError({ reason: "not_found", message: "Kin organization not found." });
const notAllowed = new KinChatError({
  reason: "not_allowed",
  message: "Only the organization owner can read or set Kin's time zone.",
});
const invalid = new KinChatError({ reason: "invalid_state", message: "Invalid Kin time zone." });
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const isChatError = Schema.is(KinChatError);
const isPersistenceError = Schema.is(PersistenceSqlError);
const mapError = (cause: unknown): TimeZoneError =>
  isSqlError(cause)
    ? toPersistenceSqlError("KinOwnerTimeZone")(cause)
    : isChatError(cause) || isPersistenceError(cause)
      ? cause
      : invalid;
const decode = Schema.decodeUnknownEffect(OwnerTimeZone);

/** The owner's zone. Writes go through the lead runtime's routines, which reschedule triggers. */
export class KinOwnerTimeZone extends Context.Service<
  KinOwnerTimeZone,
  {
    readonly get: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinOwnerTimeZoneGetInput,
    ) => Effect.Effect<OwnerTimeZone, TimeZoneError>;
    readonly set: (
      people: ReadonlyArray<PersonIdentity>,
      input: OwnerTimeZone,
    ) => Effect.Effect<OwnerTimeZone, TimeZoneError>;
    readonly attach: (
      routines: Routines.KinRoutines["Service"],
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/triggers/ownerTimeZone/KinOwnerTimeZone") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let attached: Routines.KinRoutines["Service"] | undefined;

  const owner = Effect.fn("KinOwnerTimeZone.owner")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const person = people.find((candidate) => candidate.orgId === orgId);
    if (person === undefined) return yield* notFound;
    const member =
      yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId} AND person_id = ${person.personId} ORDER BY person_id`;
    if (member.length === 0) return yield* notFound;
    const allowed = yield* isOrgOwner(orgId, person.personId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (!allowed) return yield* notAllowed;
  });
  const read = Effect.fn("KinOwnerTimeZone.read")(function* (orgId: KinOrgId) {
    const [row] = yield* sql<{
      time_zone: string;
    }>`SELECT time_zone FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`;
    return yield* decode({ orgId, timeZone: row?.time_zone ?? "UTC" });
  });

  return KinOwnerTimeZone.of({
    get: Effect.fn("KinOwnerTimeZone.get")(function* (people, input) {
      yield* owner(people, input.orgId);
      return yield* read(input.orgId);
    }, Effect.mapError(mapError)),
    set: Effect.fn("KinOwnerTimeZone.set")(function* (people, input) {
      const { orgId, timeZone } = yield* decode(input);
      yield* owner(people, orgId);
      if (attached === undefined) return yield* unavailable;
      yield* attached.setTimeZone(orgId, timeZone).pipe(
        Effect.tapError((cause) => Effect.logWarning("Kin time zone not saved", { orgId, cause })),
        Effect.mapError(() => unavailable),
      );
      return yield* read(orgId);
    }, Effect.mapError(mapError)),
    attach: Effect.fn("KinOwnerTimeZone.attach")(function* (next) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          attached = next;
        }),
        () =>
          Effect.sync(() => {
            if (attached === next) attached = undefined;
          }),
      );
    }),
  });
});

export const layer = Layer.effect(KinOwnerTimeZone, make);
