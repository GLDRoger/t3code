import {
  KIN_PULSE_LATER_SENSES,
  KinChatError,
  type KinOrgId,
  type KinPulseEvent,
  type KinPulseHandleInput,
  type KinPulseListInput,
  type KinPulseScreenRead,
  type KinPulseSubscribeInput,
  kinPulseDiff,
  kinPulsePage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshHub } from "../chat/KinRefreshHub.ts";
import { KinRecords } from "../work/KinRecords.ts";
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
  const read = yield* KinPulse.read({
    orgId: input.orgId,
    at: yield* Clock.currentTimeMillis,
    viewer,
    includeHandled: input.includeHandled,
    scope: input.scope,
    limit: SCREEN_CAP,
  }).pipe(Effect.catchTags({ SqlError: unavailableOn }));
  // Screens show the consequence, which already says the measure; agents' reads keep it. A
  // sense newer than the client goes only to one that says it reads it.
  const unread = new Set<string>(
    KIN_PULSE_LATER_SENSES.filter((sense) => !(input.acceptSenses ?? []).includes(sense)),
  );
  const facts = read.facts
    .filter((fact) => !unread.has(fact.sense))
    .map(({ measure: _measure, ...fact }) => fact);
  return input.limit === undefined
    ? { ...read, facts }
    : { ...read, ...kinPulsePage(facts, input.limit) };
});

/** Names a page by what a screen shows of it (not `asOf`): cyrb53, as hex. */
const pulseHash = (read: KinPulseScreenRead) => {
  const text = JSON.stringify([read.total, read.facts, read.outline ?? null]);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
};

/**
 * `kin.pulse.subscribe`: the page `read` gives this viewer, then what moved in it, built by that
 * same read each time the pulse moves. A member's page also turns on the Work they may see, so
 * their Work changes read it again too. Nothing is sent when the page a screen shows stayed put.
 */
export const subscribe = (people: ReadonlyArray<PersonIdentity>, input: KinPulseSubscribeInput) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { person, viewer } = yield* viewerIn(people, input.orgId);
      const { held, ...listInput } = input;
      const pulse = (yield* KinRefreshHub).changes(input.orgId).pipe(
        Stream.map((now) => now.pulse ?? 0),
        Stream.changes,
      );
      const work =
        viewer._tag === "owner"
          ? Stream.empty
          : (yield* KinRecords).changes(input.orgId).pipe(
              // The first is where Work stands, not a change.
              Stream.drop(1),
              Stream.filter(
                (tick) =>
                  tick.key === undefined ||
                  tick.team?.has(person.personId) === true ||
                  tick.people?.includes(person.personId) === true,
              ),
              Stream.map(() => -1),
            );
      let sent: KinPulseScreenRead | null = null;
      return Stream.merge(pulse, work).pipe(
        // A burst during a read is one more read.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => read(people, listInput)),
        Stream.map((next): ReadonlyArray<KinPulseEvent> => {
          const hash = pulseHash(next);
          const before = sent;
          sent = next;
          if (before === null)
            return [
              held === hash ? { _tag: "current", hash } : { _tag: "snapshot", read: next, hash },
            ];
          const change = kinPulseDiff(before, next);
          return change === null ? [] : [{ _tag: "changed", ...change, hash }];
        }),
        Stream.flattenIterable,
      );
    }),
  );

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
