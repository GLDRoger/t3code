import {
  KIN_PULSE_LATER_SENSES,
  KinChatError,
  type KinOrgId,
  type KinPulseAsideInput,
  type KinPulseFact,
  type KinPulseHandleInput,
  type KinPulseListInput,
  type KinPulseScreenRead,
  type KinPulseSubscribeInput,
  kinPulseApply,
  kinPulseDiff,
  kinPulsePage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshHub } from "../chat/KinRefreshHub.ts";
import { coalesced, hashedLive, viewHash } from "../hashedLive.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { list as workList } from "../work/ownerWork.ts";
import { mayActAsOwner } from "../people/KinAccess.ts";
import { ownerZone, startOfDay } from "../work/recordRows.ts";
import * as KinPulse from "./KinPulse.ts";
import type { SensedFact } from "./senses/shared.ts";

/** "Needs attention" on people's screens: the same read and handling agents use, as that person. */

const SCREEN_CAP = 200;

/** A failed read of Kin's rows reaches a client as Kin being unavailable, logged here. */
const unavailableOn = (cause: unknown) =>
  Effect.logWarning("Kin pulse read failed", { cause }).pipe(
    Effect.andThen(
      Effect.fail(new KinChatError({ reason: "unavailable", message: "Kin is unavailable." })),
    ),
  );

export const viewerIn = Effect.fn("KinPulsePeople.viewer")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const person = people.find((candidate) => candidate.orgId === orgId);
  if (person === undefined)
    return yield* new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });
  const { owner } = yield* KinIdentity;
  if (person.orgId !== owner.orgId)
    return yield* new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });
  const sql = yield* SqlClient.SqlClient;
  // Asked on every build of a stream too, so a person removed while watching stops receiving.
  const removed = yield* sql<{ one: number }>`SELECT 1 AS one FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${person.personId} AND removed_at IS NOT NULL
    ORDER BY person_id`.pipe(
    Effect.mapError(
      () => new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
    ),
  );
  if (removed.length > 0)
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

/**
 * Screens show the consequence, which already says the measure; agents' reads keep it. A sense
 * newer than the client goes only to one that says it reads it.
 */
export const screenFacts = <F extends KinPulseFact>(
  facts: ReadonlyArray<F>,
  acceptSenses: ReadonlyArray<string> | undefined,
) => {
  const unread = new Set<string>(
    KIN_PULSE_LATER_SENSES.filter((sense) => !(acceptSenses ?? []).includes(sense)),
  );
  return facts
    .filter((fact) => !unread.has(fact.sense))
    .map(({ measure: _measure, ...fact }) => fact);
};

export const read = Effect.fn("KinPulsePeople.read")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPulseListInput,
  sensed?: ReadonlyArray<SensedFact>,
) {
  const { person, viewer } = yield* viewerIn(people, input.orgId);
  const read = yield* KinPulse.read({
    orgId: input.orgId,
    at: yield* Clock.currentTimeMillis,
    viewer,
    sensed,
    personId: person.personId,
    includeHandled: input.includeHandled,
    scope: input.scope,
    excludeOverflow: !input.acceptSenses?.includes("sense_overflow"),
    limit: SCREEN_CAP,
  }).pipe(Effect.catchTags({ SqlError: unavailableOn }));
  const facts = screenFacts(read.facts, input.acceptSenses);
  return input.limit === undefined
    ? { ...read, facts }
    : { ...read, ...kinPulsePage(facts, input.limit) };
});

/** Names a page by what a screen shows of it (not `asOf`). */
const pulseHash = (read: KinPulseScreenRead) =>
  viewHash(
    JSON.stringify(
      read.tasksNeedsYou === undefined
        ? [read.total, read.facts, read.outline ?? null]
        : [read.total, read.facts, read.outline ?? null, read.tasksNeedsYou],
    ),
  );

/** Tasks' Needs you count, read as the Tasks screen reads it. */
const tasksNeedsYou = (people: ReadonlyArray<PersonIdentity>, orgId: KinOrgId) =>
  workList(people, { orgId, open: true, byMove: true, limit: 1, acceptCompactRows: true }).pipe(
    Effect.map((page) => page.counts?.needsYou ?? 0),
  );

/** What a Work change asks of a pulse stream: its page sensed afresh, or only Tasks' count. */
const RESENSE = -1;
const RECOUNT = -2;

/**
 * `kin.pulse.subscribe`: `read`'s page, then what moved in it. A member's page also turns on the
 * Work they see, and follows their level as it changes. With `tasksNeedsYou`, Tasks' count rides
 * along, counted again as their tasks move. Nothing is sent when the page stayed put.
 */
export const subscribe = (people: ReadonlyArray<PersonIdentity>, input: KinPulseSubscribeInput) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { person, viewer } = yield* viewerIn(people, input.orgId);
      const { held, tasksNeedsYou: counting, ...listInput } = input;
      const pulse = (yield* KinRefreshHub).changes(input.orgId).pipe(
        Stream.map((now) => now.pulse ?? 0),
        Stream.changes,
      );
      let member = viewer._tag !== "owner";
      const work = (yield* KinRecords).changes(input.orgId).pipe(
        // The first is where Work stands, not a change.
        Stream.drop(1),
        Stream.mapEffect((tick) => {
          // Their level or places moved: what their page shows may have, whatever they were.
          if (tick.people?.includes(person.personId) === true)
            return viewerIn(people, input.orgId).pipe(
              Effect.map((now) => {
                member = now.viewer._tag !== "owner";
                return RESENSE;
              }),
              // Gone from the org: the read says so and ends the stream.
              Effect.orElseSucceed(() => RESENSE),
            );
          if (member && (tick.key === undefined || tick.team?.has(person.personId) === true))
            return Effect.succeed(RESENSE);
          return Effect.succeed(
            counting === true &&
              !member &&
              (tick.registerId === undefined || tick.registerId === "work")
              ? RECOUNT
              : null,
          );
        }),
        Stream.filter((moved) => moved !== null),
      );
      const live = hashedLive({
        held,
        hash: pulseHash,
        snapshot: (page: KinPulseScreenRead, hash) =>
          ({ _tag: "snapshot", read: page, hash }) as const,
        diff: kinPulseDiff,
        apply: kinPulseApply,
      });
      // Moved by the pulse, it shows what the last tick sensed, if no older than what it shows; a
      // member's Work change is sensed afresh, so it shows at once.
      let shownAt: number | undefined;
      let count: number | undefined;
      return coalesced(Stream.merge(pulse, work), (asked) =>
        Effect.gen(function* () {
          const tick = KinPulse.lastTick(input.orgId);
          const reuse =
            !asked.includes(RESENSE) &&
            shownAt !== undefined &&
            tick !== undefined &&
            tick.at >= shownAt;
          shownAt = reuse ? tick.at : yield* Clock.currentTimeMillis;
          const page = yield* read(people, listInput, reuse ? tick.facts : undefined);
          if (counting !== true) return live.next(page);
          if (count === undefined || asked.includes(RESENSE) || asked.includes(RECOUNT))
            count = yield* tasksNeedsYou(people, input.orgId);
          return live.next({ ...page, tasksNeedsYou: count });
        }),
      );
    }),
  );

/** An owner-level person's hold is the company's; a teammate's hides it for them alone. */
const holdingOf = (viewer: KinPulse.Viewer, person: PersonIdentity): KinPulse.Holding => ({
  _tag: "may",
  forPersonId: viewer._tag === "owner" ? null : person.personId,
  onWordOf: null,
});

export const handle = Effect.fn("KinPulsePeople.handle")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPulseHandleInput,
) {
  const { person, viewer } = yield* viewerIn(people, input.orgId);
  return yield* KinPulse.handle({
    holding: holdingOf(viewer, person),
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

/** `kin.pulse.aside`: a record set aside, or its hold lifted, by the person asking. */
export const aside = Effect.fn("KinPulsePeople.aside")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPulseAsideInput,
) {
  const { person, viewer } = yield* viewerIn(people, input.orgId);
  const held = yield* KinPulse.aside({
    orgId: input.orgId,
    at: yield* Clock.currentTimeMillis,
    viewer,
    by: { _tag: "person", personId: person.personId },
    recordKey: input.record,
    action: input.action,
    until:
      input.until === undefined || input.action === "lift"
        ? null
        : startOfDay(input.until, yield* ownerZone(input.orgId)),
    note: null,
    holding: holdingOf(viewer, person),
  }).pipe(Effect.catchTags({ SqlError: unavailableOn }));
  return { aside: held };
});
