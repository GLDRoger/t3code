import {
  KinChatError,
  type KinOrgId,
  type KinPulseHandleInput,
  type KinPulseListInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { mayActAsOwner } from "../people/KinAccess.ts";
import { ownerZone, startOfDay } from "../work/recordRows.ts";
import * as KinPulse from "./KinPulse.ts";

/** "Needs attention" on people's screens: the same read and handling agents use, as that person. */

const SCREEN_CAP = 200;

/** A failed read of Kin's rows reaches a client as Kin being unavailable, logged here. */
const unavailableOn = (cause: unknown) =>
  Effect.logWarning("Kin pulse read failed", { cause }).pipe(
    Effect.andThen(
      Effect.fail(new KinChatError({ reason: "unavailable", message: "Kin is unavailable." })),
    ),
  );

const viewerIn = Effect.fn("KinPulsePeople.viewer")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const person = people.find((candidate) => candidate.orgId === orgId);
  if (person === undefined)
    return yield* new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });
  const { owner } = yield* KinIdentity;
  if (person.orgId !== owner.orgId)
    return yield* new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });
  // Owner-level people (the owner and co-owners) see everything; a member, what they may see.
  const viewer: KinPulse.Viewer = (yield* mayActAsOwner(orgId, person.personId, owner).pipe(
    Effect.mapError(
      () => new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
    ),
  ))
    ? { _tag: "owner" }
    : { _tag: "people", people: [person.personId] };
  return { person, viewer };
});

export const read = Effect.fn("KinPulsePeople.read")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPulseListInput,
) {
  const { viewer } = yield* viewerIn(people, input.orgId);
  return yield* KinPulse.read({
    orgId: input.orgId,
    at: yield* Clock.currentTimeMillis,
    viewer,
    includeHandled: input.includeHandled,
    limit: SCREEN_CAP,
  }).pipe(Effect.catchTags({ SqlError: unavailableOn }));
});

export const handle = Effect.fn("KinPulsePeople.handle")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPulseHandleInput,
) {
  const { person, viewer } = yield* viewerIn(people, input.orgId);
  return yield* KinPulse.handle({
    orgId: input.orgId,
    at: yield* Clock.currentTimeMillis,
    viewer,
    by: { _tag: "person", personId: person.personId },
    factKey: input.factKey,
    action: input.action,
    until:
      input.until === undefined
        ? undefined
        : startOfDay(input.until, yield* ownerZone(input.orgId)),
  }).pipe(Effect.catchTags({ SqlError: unavailableOn, SchemaError: unavailableOn }));
});
