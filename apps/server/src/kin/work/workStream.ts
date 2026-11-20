import {
  KinChatError,
  type KinOrgId,
  type KinPersonId,
  type KinWorkEvent,
  type KinWorkSubscribeInput,
  type KinWorkSummary,
  kinCompactRecord,
  kinWorkCountsOf,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { bufferLatestLiveStream } from "../../orchestration-v2/LiveStreamBudget.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRecords, type Tick } from "./KinRecords.ts";
import { shownRecords, summary, type Viewer, viewerOf } from "./ownerWork.ts";
import { workFailure } from "./recordRows.ts";
import { dependentRows, teamKeyLists, teamSeq } from "./teamView.ts";

/**
 * `kin.work.subscribe` with `acceptRows`: T3's shell stream for Work. Each change goes to a viewer
 * as the entry itself, built by the read `kin.work.list` gives them (`shownRecords`), so it can't
 * say more than a fresh read; then the counts, if they moved. Numbered as `changed` is: a
 * teammate's own number moves only for what they see.
 */

/** As T3's shell (`ws.ts`): a burst is read once, at most this many changes at a time. */
const BATCH = 512;
const BATCH_WINDOW = Duration.millis(50);
/** As T3's thread resume (`ThreadStream.ts`): a longer gap gets `snapshot-required`. */
const REPLAY_LIMIT = 128;

/** One viewer's pending change, keyed for `bufferLatestLiveStream`: the latest per entry wins. */
type Pending = {
  readonly sequence: number;
  /** An entry's key, or `START`, `RESCAN`, `PLACES` or `GAP`. */
  readonly key: string;
  readonly list: string | null;
  readonly created: boolean;
  /** The level the tick was read for; one read before a level change is dropped. */
  readonly level: number;
};
/** The first tick: where things stand, read after subscribing, so nothing is missed. */
const START = "*start";
/** What this teammate sees may have changed shape: a label, a project's people, their places. */
const RESCAN = "*rescan";
/** Something moved that left no change to replay, such as an undo. */
const GAP = "*gap";
/**
 * This teammate's own places moved: everything they hold is read again (`snapshot-required`),
 * an open client page included, even where no row or count changed.
 */
const PLACES = "*places";

type Out = KinWorkEvent;

/**
 * One subscriber's side of the stream: where they start, what each tick means to them, and what a
 * burst of those sends. `subscribeRows` runs it over the live ticks; tests drive it tick by tick.
 */
export const makeWorkStream = Effect.fn("KinWorkStream.make")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkSubscribeInput,
) {
  const { orgId } = input;
  const records = yield* KinRecords;
  const sql = yield* SqlClient.SqlClient;
  let viewer = yield* viewerOf(people, orgId);
  let level = 0;
  /** A teammate's entries they were told of, and their lists: only these are ever removed. */
  let seen = new Map<string, string>();
  /** The counts the client holds; null when it holds none we know of. */
  let held: KinWorkSummary | null = null;
  /**
   * Every change numbered up to here has reached this session, so a client may resume from it.
   * Ticks publish after their commits release the lock, so one can overtake another: a client told
   * the later number, then cut off, would resume past the earlier change and never hear it.
   */
  let heard = 0;
  /** Numbers heard past `heard`, waiting on one before them. */
  const early = new Set<number>();
  const hear = (n: number) => {
    if (n <= heard) return;
    early.add(n);
    while (early.delete(heard + 1)) heard += 1;
  };
  const heardFrom = (n: number) => {
    heard = n;
    early.clear();
  };
  /**
   * Where a burst may close. A teammate's own numbers run one by one, so a gap is a tick still on
   * its way. The org's numbers are shared with every org: a gap is late only if this org's log has
   * a change there that hasn't arrived.
   */
  const resumable = Effect.fn("KinWorkStream.resumable")(function* (top: number) {
    if (!viewer.teammate && early.size > 0) {
      const last = Math.max(...early);
      const logged = yield* sql<{ seq: number }>`SELECT seq FROM kin_record_changes
        WHERE org_id = ${orgId} AND seq > ${heard} AND seq <= ${last} ORDER BY seq`;
      const late = logged.find((one) => !early.has(one.seq));
      heard = late === undefined ? last : late.seq - 1;
      for (const n of early) if (n <= heard) early.delete(n);
    }
    return Math.min(top, heard);
  });

  const own = (v: Viewer) => v.person.personId as KinPersonId;
  /** Which numbering a cursor is in, so one never resumes in the other. */
  const team = () => (viewer.teammate ? { team: true as const } : {});
  const numberNow = (v: Viewer) =>
    v.teammate ? teamSeq(orgId, own(v)).pipe(workFailure) : records.seq(orgId);
  const counts = Effect.fn("KinWorkStream.counts")(function* (seq: number) {
    const next = yield* summary(people, { orgId });
    const moved = kinWorkCountsOf(held, next);
    held = next;
    return moved === null
      ? null
      : ({ _tag: "counts", seq, ...team(), asOf: next.asOf, ...moved } satisfies Out);
  });
  /**
   * Everything held is dropped: read again from `seq`, with the counts whole. `gap` is the number
   * an owner-level announcement took (`KinRecords.announce`); no change row holds it, so the
   * client's number moves only if it is told this one.
   */
  const restart = Effect.fn("KinWorkStream.restart")(function* (gap = 0) {
    seen = viewer.teammate ? yield* teamKeyLists(orgId, own(viewer)).pipe(workFailure) : new Map();
    held = null;
    const seq = Math.max(yield* numberNow(viewer), viewer.teammate ? 0 : gap);
    heardFrom(seq);
    const whole = yield* counts(seq);
    return [
      { _tag: "snapshot-required", seq, ...team() } satisfies Out,
      ...(whole === null ? [] : [whole]),
    ];
  });

  /** The entries as this viewer's list read shows them now, or their removal. */
  const rowsNow = Effect.fn("KinWorkStream.rows")(function* (pending: ReadonlyArray<Pending>) {
    const at = yield* Clock.currentTimeMillis;
    // Rows are read as they are now, so they carry at least this number, not their tick's: a tick
    // that arrives late would otherwise send news the client drops as older than what it holds.
    const readAt = yield* numberNow(viewer);
    const lists = new Map<string, Array<string>>();
    for (const one of pending) {
      const list = one.list ?? "work";
      lists.set(list, [...(lists.get(list) ?? []), one.key]);
    }
    const found = new Map<string, Effect.Success<ReturnType<typeof shownRecords>>[number]>();
    for (const [list, keys] of lists)
      for (let i = 0; i < keys.length; i += 100) {
        const page = yield* records.query(orgId, {
          list,
          keys: keys.slice(i, i + 100),
          limit: 100,
          at,
          ...(viewer.teammate ? { team: own(viewer) } : {}),
        });
        const shown = yield* shownRecords(viewer, orgId, page.rows, at);
        for (const record of shown) found.set(record.key, record);
      }
    return pending
      .toSorted((a, b) => a.sequence - b.sequence)
      .flatMap((one): ReadonlyArray<Out> => {
        const list = one.list ?? "work";
        const record = found.get(one.key);
        if (record !== undefined) {
          const fresh = viewer.teammate ? !seen.has(one.key) : one.created;
          if (viewer.teammate) seen.set(one.key, list);
          return [
            {
              _tag: "upsert",
              seq: Math.max(one.sequence, readAt),
              list,
              record: kinCompactRecord(record),
              ...(fresh ? { fresh: true as const } : {}),
            },
          ];
        }
        // Never named to someone who wasn't told of it: they'd learn it exists.
        if (viewer.teammate && !seen.delete(one.key)) return [];
        return [{ _tag: "removed", seq: Math.max(one.sequence, readAt), key: one.key, list }];
      });
  });

  /** Where the client stands: the first counts, nothing missed, the gap, or a fresh read. */
  const start = Effect.fn("KinWorkStream.start")(function* (now: number) {
    if (viewer.teammate) seen = yield* teamKeyLists(orgId, own(viewer)).pipe(workFailure);
    const seq = viewer.teammate ? yield* numberNow(viewer) : now;
    heardFrom(seq);
    const after = input.afterSeq;
    if (after === undefined) {
      const whole = yield* counts(seq);
      return whole === null ? [] : [whole];
    }
    // A number from before their level changed counts something else: start over.
    if ((input.afterTeam === true) !== viewer.teammate) return yield* restart();
    // Their counts are as of `after`; ours drift with the clock, so the next counts are whole.
    if (after === seq) return [{ _tag: "synchronized", seq, ...team() } satisfies Out];
    // A teammate's own view is small: they read it again rather than replay a log of theirs.
    if (viewer.teammate || after > seq) return yield* restart();
    const replay = yield* ownerLevelReplay(orgId, after, seq).pipe(workFailure);
    if (replay === null) return yield* restart();
    const rows = yield* rowsNow(replay.map((one) => ({ ...one, created: false, level })));
    const whole = yield* counts(seq);
    return [...rows, whole ?? ({ _tag: "synchronized", seq, ...team() } satisfies Out)];
  });

  /** A tick as this viewer's pending change; none when it doesn't touch what they see. */
  const pendingOf = (tick: Tick): ReadonlyArray<Pending> => {
    const base = { list: tick.registerId ?? null, created: tick.created === true, level };
    const mine = tick.people?.includes(viewer.person.personId) === true;
    if (!viewer.teammate) {
      // A people tick reuses the latest change's number; it isn't that change arriving.
      if (tick.people === undefined) hear(tick.seq);
      // Someone else's places don't move what an owner-level viewer sees; their own level may.
      if (tick.people !== undefined)
        return mine ? [{ ...base, sequence: tick.seq, key: RESCAN }] : [];
      return [{ ...base, sequence: tick.seq, key: tick.key ?? GAP }];
    }
    if (tick.key === undefined && tick.people === undefined)
      return [{ ...base, sequence: tick.seq, key: GAP }];
    const sequence = tick.team?.get(viewer.person.personId);
    if (sequence === undefined) return [];
    hear(sequence);
    // A holder change inside a project moves it as its own change would, for whoever it touched.
    const projects = (tick.projects ?? []).map((key) => ({
      ...base,
      list: "projects",
      sequence,
      key,
    }));
    const rescan =
      mine || tick.registerId === "clients" || tick.registerId === "projects" || projects.length > 0
        ? [{ ...base, sequence, key: RESCAN }]
        : [];
    return [
      ...rescan,
      ...(mine ? [{ ...base, sequence, key: PLACES }] : []),
      ...projects,
      ...(tick.key === undefined ? [] : [{ ...base, sequence, key: tick.key }]),
    ];
  };

  const batch = Effect.fn("KinWorkStream.batch")(function* (all: ReadonlyArray<Pending>) {
    // The level is read for every burst: a co-owner made a member gets nothing more as one.
    const now = yield* viewerOf(people, orgId);
    if (now.teammate !== viewer.teammate) {
      viewer = now;
      level += 1;
      return yield* restart();
    }
    const items = all.filter((one) => one.level === level);
    if (items.length === 0) return [];
    const gaps = items.filter((one) => one.key === GAP);
    if (gaps.length > 0) return yield* restart(Math.max(...gaps.map((one) => one.sequence)));
    if (viewer.teammate && items.some((one) => one.key === PLACES)) return yield* restart();
    const top = Math.max(...items.map((one) => one.sequence));
    const keyed = items.filter((one) => one.key !== RESCAN);
    const place = (one: Pending) =>
      one.key !== RESCAN && (one.list === "clients" || one.list === "projects");
    // A place's own change can reach a burst apart from its rescan, so either one looks again.
    if (viewer.teammate && items.some((one) => one.key === RESCAN || place(one))) {
      // A label or a place shows or hides entries with no change of their own.
      const sees = yield* teamKeyLists(orgId, own(viewer)).pipe(workFailure);
      const named = new Set(keyed.map((one) => one.key));
      const at = { sequence: top, created: false, level };
      const add = (key: string, list: string) => {
        if (named.has(key)) return;
        named.add(key);
        keyed.push({ ...at, key, list });
      };
      for (const [key, list] of seen) if (!sees.has(key)) add(key, list);
      for (const [key, list] of sees) if (!seen.has(key)) add(key, list);
      // Their entries under a client or project that moved read differently now: a task shows
      // its project once they see that project, and what they may do follows its lead.
      for (const one of items)
        if (place(one)) {
          const moved = yield* records.get(orgId, one.key);
          if (moved === undefined) continue;
          for (const row of yield* dependentRows(orgId, moved.recordId).pipe(workFailure))
            if (sees.has(row.key)) add(row.key, row.registerId);
        }
    }
    const rows = yield* rowsNow(keyed);
    const close = yield* resumable(top).pipe(workFailure);
    const moved = yield* counts(close);
    if (rows.length === 0) return moved === null ? [] : [moved];
    return [...rows, moved ?? ({ _tag: "synchronized", seq: close, ...team() } satisfies Out)];
  });

  return { start, pendingOf, batch };
});

export const subscribeRows = (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkSubscribeInput,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const records = yield* KinRecords;
      const session = yield* makeWorkStream(people, input);
      let started = false;
      const pending = records.changes(input.orgId).pipe(
        Stream.map((tick): ReadonlyArray<Pending> => {
          if (started) return session.pendingOf(tick);
          started = true;
          return [{ sequence: tick.seq, key: START, list: null, created: false, level: 0 }];
        }),
        Stream.flattenIterable,
      );
      return bufferLatestLiveStream(pending, (one) => one.key).pipe(
        Stream.groupedWithin(BATCH, BATCH_WINDOW),
        Stream.mapEffect((group) => {
          const first = group.find((one) => one.key === START);
          if (first === undefined) return session.batch(group);
          return Effect.gen(function* () {
            const opening = yield* session.start(first.sequence);
            const rest = group.filter((one) => one !== first);
            return rest.length === 0 ? opening : [...opening, ...(yield* session.batch(rest))];
          });
        }),
        Stream.flattenIterable,
        Stream.catchTags({
          LiveStreamBufferError: () =>
            Stream.fail(
              new KinChatError({
                reason: "unavailable",
                message: "Too many changes waiting. Resume from the last received number.",
              }),
            ),
        }),
      );
    }),
  );

/**
 * The entries changed after `after` up to `seq`, each at its newest number, or null when the gap
 * is longer than a replay or has a hole an undo left (`announce`). Owner-level only.
 */
const ownerLevelReplay = Effect.fn("KinWorkStream.replay")(function* (
  orgId: KinOrgId,
  after: number,
  seq: number,
) {
  const sql = yield* SqlClient.SqlClient;
  // Numbers are shared by every org: a hole is a number no row holds, in any org.
  const [all] = yield* sql<{ n: number; mine: number }>`SELECT COUNT(*) AS n,
      SUM(org_id = ${orgId}) AS mine
    FROM kin_record_changes WHERE seq > ${after} AND seq <= ${seq}`;
  if ((all?.n ?? 0) !== seq - after || (all?.mine ?? 0) > REPLAY_LIMIT) return null;
  return yield* sql<{ key: string; list: string; sequence: number }>`SELECT r.key,
      r.register_id AS list, MAX(c.seq) AS sequence
    FROM kin_record_changes c JOIN kin_records r ON r.org_id = c.org_id
      AND r.record_id = c.record_id
    WHERE c.org_id = ${orgId} AND c.seq > ${after} AND c.seq <= ${seq}
    GROUP BY r.key, r.register_id ORDER BY sequence`;
});
