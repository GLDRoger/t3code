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
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { KinChatHub } from "../chat/KinChatHub.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshHub } from "../chat/KinRefreshHub.ts";
import { coalesced, hashedLive, viewHash } from "../hashedLive.ts";
import * as KinPulse from "../pulse/KinPulse.ts";
import { viewerIn } from "../pulse/people.ts";
import type { SensedFact } from "../pulse/senses/shared.ts";
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
  sensed?: ReadonlyArray<SensedFact>,
) {
  const { person, viewer } = yield* viewerIn(people, input.orgId);
  const ownerLevel = viewer._tag === "owner";
  return yield* KinOpen.compute({
    orgId: input.orgId,
    viewer: { personId: person.personId, ownerLevel },
    at: yield* Clock.currentTimeMillis,
    acceptSenses: input.acceptSenses,
    // Only owner level reuses a tick's facts; a teammate's are sensed afresh, as before.
    sensed: ownerLevel ? sensed : undefined,
  }).pipe(
    Effect.catchTags({
      SqlError: unavailable,
      PersistenceSqlError: unavailable,
      PersistenceDecodeError: unavailable,
    }),
  );
});

/** When the first approval waiting on this person after `at` lapses, the only row time alone ends. */
const nextLapse = Effect.fn("KinOpenPeople.nextLapse")(function* (
  orgId: KinOpenReadInput["orgId"],
  personId: PersonIdentity["personId"],
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ at: number | null }>`SELECT MIN(pa.expires_at) AS at
    FROM kin_waiting w
      JOIN kin_widgets g ON g.org_id = w.org_id AND g.widget_id = w.widget_id
      JOIN kin_pending_actions pa ON pa.org_id = w.org_id
        AND pa.action_id = json_extract(g.state_json, '$.actionId')
    WHERE w.org_id = ${orgId} AND w.person_id = ${personId} AND w.resolved_at IS NULL
      AND w.reason = 'approval' AND pa.state = 'awaiting_approval' AND pa.expires_at > ${at}`;
  return row?.at ?? undefined;
});

/** Names a list by what a screen shows of it (not `asOf`). */
const openHash = (read: KinOpenRead) => viewHash(JSON.stringify([read.counts, read.rows]));

/**
 * `kin.open.subscribe`: the list `read` gives this person, then what moved in it, built by that
 * same read each time a source may have moved: the pulse, Work, their waiting cards, the turn of
 * their day, and the moment an approval waiting on them lapses. Chat events only wake a build;
 * nothing of theirs is sent. Unchanged, nothing is.
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
      // Each build sets the next lapse; a newer one replaces the timer waiting before it.
      const lapses = yield* Queue.sliding<number | undefined>(1);
      const lapsed = Stream.fromQueue(lapses).pipe(
        Stream.switchMap((at) =>
          at === undefined
            ? Stream.empty
            : Stream.fromEffect(
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis;
                  yield* Effect.sleep(Duration.millis(Math.max(0, at - now)));
                  return -4;
                }),
              ),
        ),
      );
      const live = hashedLive({
        held,
        hash: openHash,
        snapshot: (list: KinOpenRead, hash) => ({ _tag: "snapshot", read: list, hash }) as const,
        diff: kinOpenDiff,
        apply: kinOpenApply,
      });
      // Owner level, it shows what the last tick sensed if no older than what it shows; a Work
      // change or a day's turn is sensed afresh, so it shows at once.
      let shownAt: number | undefined;
      return coalesced(
        Stream.mergeAll([pulse, work, waiting, dayTurns, lapsed], { concurrency: 5 }),
        (asked) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            const tick = KinPulse.lastTick(input.orgId);
            const reuse =
              !member &&
              !asked.includes(-1) &&
              !asked.includes(-3) &&
              shownAt !== undefined &&
              tick !== undefined &&
              tick.at >= shownAt;
            shownAt = reuse ? tick.at : at;
            const list = yield* read(people, readInput, reuse ? tick.facts : undefined);
            yield* Queue.offer(
              lapses,
              yield* nextLapse(input.orgId, person.personId, at).pipe(
                Effect.orElseSucceed(() => undefined),
              ),
            );
            return live.next(list);
          }),
      );
    }),
  );
