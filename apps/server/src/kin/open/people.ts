import {
  KinChatError,
  type KinOpenRead,
  type KinOpenReadInput,
  type KinOpenSubscribeInput,
  kinOpenApply,
  kinOpenDiff,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { KinChatHub } from "../chat/KinChatHub.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshHub } from "../chat/KinRefreshHub.ts";
import { coalesced, hashedLive, viewHash } from "../hashedLive.ts";
import { viewerIn } from "../pulse/people.ts";
import { KinRecords } from "../work/KinRecords.ts";
import * as KinOpen from "./KinOpen.ts";

/** The open list on people's screens: `KinOpen.compute` as the session's person, each time. */

const HOUR_MS = 3_600_000;
/** Chat events that can move what waits on someone; their data is never forwarded. */
const WAITING_EVENTS = new Set(["waiting.updated", "widget.updated", "member.removed"]);

const unavailable = (cause: unknown) =>
  Effect.logWarning("Kin open list read failed", { cause }).pipe(
    Effect.andThen(
      Effect.fail(new KinChatError({ reason: "unavailable", message: "Kin is unavailable." })),
    ),
  );

export const read = Effect.fn("KinOpenPeople.read")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinOpenReadInput,
) {
  const { person, viewer } = yield* viewerIn(people, input.orgId);
  return yield* KinOpen.compute({
    orgId: input.orgId,
    viewer: { personId: person.personId, ownerLevel: viewer._tag === "owner" },
    at: yield* Clock.currentTimeMillis,
    acceptSenses: input.acceptSenses,
  }).pipe(
    Effect.catchTags({
      SqlError: unavailable,
      PersistenceSqlError: unavailable,
      PersistenceDecodeError: unavailable,
    }),
  );
});

/** Names a list by what a screen shows of it (not `asOf`). */
const openHash = (read: KinOpenRead) => viewHash(JSON.stringify([read.counts, read.rows]));

/**
 * `kin.open.subscribe`: the list `read` gives this person, then what moved in it, built by that
 * same read each time a source may have moved: the pulse, Work, their waiting cards, and the turn
 * of their day. Chat events only wake a build; nothing of theirs is sent. Unchanged, nothing is.
 */
export const subscribe = (people: ReadonlyArray<PersonIdentity>, input: KinOpenSubscribeInput) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { person, viewer } = yield* viewerIn(people, input.orgId);
      const { held, ...readInput } = input;
      const pulse = (yield* KinRefreshHub).changes(input.orgId).pipe(
        Stream.map((now) => now.pulse ?? 0),
        Stream.changes,
      );
      let member = viewer._tag !== "owner";
      const work = (yield* KinRecords).changes(input.orgId).pipe(
        // The first is where Work stands, not a change.
        Stream.drop(1),
        Stream.mapEffect((tick) => {
          if (tick.people?.includes(person.personId) === true)
            return viewerIn(people, input.orgId).pipe(
              Effect.map((now) => {
                member = now.viewer._tag !== "owner";
                return true;
              }),
              // Gone from the org: the read says so and ends the stream.
              Effect.orElseSucceed(() => true),
            );
          // Their own tasks are Work too: owner level hears every change, a member theirs.
          return Effect.succeed(
            !member || tick.key === undefined || tick.team?.has(person.personId) === true,
          );
        }),
        Stream.filter((moved) => moved),
        Stream.map(() => -1),
      );
      const waiting = (yield* (yield* KinChatHub).subscribeForViewer(person)).pipe(
        Stream.filter((event) => WAITING_EVENTS.has(event.type)),
        Stream.map(() => -2),
        Stream.catch(() => Stream.make(-2)),
      );
      const dayTurns = Stream.fromEffectRepeat(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const end = yield* KinOpen.dayEndFor(input.orgId, person.personId, now).pipe(
            Effect.orElseSucceed(() => now + HOUR_MS),
          );
          yield* Effect.sleep(Duration.millis(Math.max(1, end - now)));
          return -3;
        }),
      );
      const live = hashedLive({
        held,
        hash: openHash,
        snapshot: (list: KinOpenRead, hash) => ({ _tag: "snapshot", read: list, hash }) as const,
        diff: kinOpenDiff,
        apply: kinOpenApply,
      });
      return coalesced(Stream.mergeAll([pulse, work, waiting, dayTurns], { concurrency: 4 }), () =>
        read(people, readInput).pipe(Effect.map(live.next)),
      );
    }),
  );
