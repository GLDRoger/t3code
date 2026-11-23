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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { bufferLatestLiveStream } from "../../orchestration-v2/LiveStreamBudget.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as KinShell from "../shell/KinShell.ts";
import { KinRecords, type Tick } from "./KinRecords.ts";
import { shownRecords, summaryOf, type Viewer, viewerOf } from "./ownerWork.ts";
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
const encodeSequences = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Number)));

/** One viewer's pending change, keyed for `bufferLatestLiveStream`: the latest per entry wins. */
type Pending = {
  readonly sequence: number;
  /** An entry's key, or `START`, `RESCAN`, `PLACES` or `GAP`. */
  readonly key: string;
  readonly list: string | null;
  readonly created: boolean;
  readonly dependents?: Tick["dependents"];
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
 * Each company's last owner-level counts, by the newest change number the screen that read them
 * had heard: every owner-level person counts Work alike, so their screens share one read. A
 * teammate's counts are their own and never kept here. One server's KinRecords keys it.
 */
type Counted = { readonly heard: number; readonly counted: ReturnType<typeof summaryOf> };
const lastCounted = new WeakMap<object, Map<KinOrgId, Counted>>();
/** Late and due-this-week move with the clock, so a shared read is kept no longer than this. */
const COUNTED_FOR = Duration.seconds(1);

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
  const allocated = sql<{ seq: number }>`SELECT seq FROM sqlite_sequence
    WHERE name = 'kin_record_changes'`.pipe(
    Effect.map(([row]) => row?.seq ?? 0),
    workFailure,
  );
  // A fresh view starts with the reservations already made before its subscription.
  const opening = !viewer.teammate && input.afterSeq === undefined ? yield* allocated : 0;
  let level = 0;
  const shared = lastCounted.get(records) ?? new Map<KinOrgId, Counted>();
  lastCounted.set(records, shared);
  /** The newest change number this session has heard; any read begun after it has its commit. */
  let newest = 0;
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
  let blockedAt: number | null = null;
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
    blockedAt = null;
  };
  /**
   * Where a burst may close. A teammate's own numbers run one by one, so a gap is a tick still on
   * its way. Owner-level numbers also skip other orgs' logged changes and reserve numbers for
   * announcements. A missing number could be an announcement that has yet to reach its burst.
   */
  const resumable = Effect.fn("KinWorkStream.resumable")(function* (top: number) {
    if (!viewer.teammate && top > heard && early.size > 0) {
      const from = heard;
      const received = [...early];
      const last = Math.max(...received);
      const encoded = yield* encodeSequences(received);
      const [unheard] = yield* sql<{ logged: number; late: number | null }>`SELECT
        COUNT(*) AS logged, MIN(CASE WHEN org_id = ${orgId} THEN seq END) AS late
        FROM kin_record_changes WHERE seq > ${from} AND seq <= ${last}
          AND seq NOT IN (SELECT value FROM json_each(${encoded}))`;
      if ((unheard?.logged ?? 0) !== last - from - received.length) {
        // Give a late announcement its own burst. A gap from another org may never send one here.
        if (blockedAt === from) return null;
        blockedAt = from;
        return Math.min(top, heard);
      }
      blockedAt = null;
      heard = Math.max(heard, unheard?.late == null ? last : unheard.late - 1);
      for (const n of early) if (n <= heard) early.delete(n);
    }
    return Math.min(top, heard);
  });

  const own = (v: Viewer) => v.person.personId as KinPersonId;
  /** Which numbering a cursor is in, so one never resumes in the other. */
  const team = () => (viewer.teammate ? { team: true as const } : {});
  const numberNow = (v: Viewer) =>
    v.teammate ? teamSeq(orgId, own(v)).pipe(workFailure) : records.seq(orgId);
  /** With `heard`, owner-level counts another screen read after hearing the same are reused. */
  const ownerLevelCounts = Effect.fn("KinWorkStream.ownerLevelCounts")(function* (heard: number) {
    const last = shared.get(orgId);
    if (last?.heard === heard) return yield* last.counted;
    const counted = yield* Effect.cachedWithTTL(summaryOf(viewer, { orgId }), COUNTED_FOR);
    shared.set(orgId, { heard, counted });
    return yield* counted;
  });
  const counts = Effect.fn("KinWorkStream.counts")(function* (seq: number, heard?: number) {
    const next =
      heard === undefined || viewer.teammate
        ? yield* summaryOf(viewer, { orgId })
        : yield* ownerLevelCounts(heard);
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
    // A restart can follow a committed switch before its cache invalidation callback runs.
    yield* KinShell.invalidate(orgId);
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
    const after = input.afterSeq;
    if (viewer.teammate) seen = yield* teamKeyLists(orgId, own(viewer)).pipe(workFailure);
    let seq = viewer.teammate ? yield* numberNow(viewer) : now;
    if (!viewer.teammate && after !== undefined) {
      // Announcements reserve numbers without change rows. Replay must check through the allocator.
      seq = Math.max(seq, yield* allocated);
    }
    heardFrom(Math.max(seq, opening));
    if (after === undefined) {
      const whole = yield* counts(seq);
      return whole === null ? [] : [whole];
    }
    // A number from before their level changed counts something else: start over.
    if ((input.afterTeam === true) !== viewer.teammate) return yield* restart(seq);
    // Their counts are as of `after`; ours drift with the clock, so the next counts are whole.
    if (after === seq) return [{ _tag: "synchronized", seq, ...team() } satisfies Out];
    // A teammate's own view is small: they read it again rather than replay a log of theirs.
    if (viewer.teammate || after > seq) return yield* restart(seq);
    const replay = yield* ownerLevelReplay(orgId, after, seq).pipe(workFailure);
    if (replay === null) return yield* restart(seq);
    const rows = yield* rowsNow(replay.map((one) => ({ ...one, created: false, level })));
    const whole = yield* counts(seq);
    return [...rows, whole ?? ({ _tag: "synchronized", seq, ...team() } satisfies Out)];
  });

  /** A tick as this viewer's pending change; none when it doesn't touch what they see. */
  const pendingOf = (tick: Tick): ReadonlyArray<Pending> => {
    newest = Math.max(newest, tick.seq);
    const base = { list: tick.registerId ?? null, created: tick.created === true, level };
    const mine = tick.people?.includes(viewer.person.personId) === true;
    if (!viewer.teammate) {
      // A people tick reuses a number, and a whole-view tick needs its snapshot sent first.
      if (tick.people === undefined && tick.key !== undefined) hear(tick.seq);
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
      ...(tick.key === undefined
        ? []
        : [{ ...base, sequence, key: tick.key, dependents: tick.dependents }]),
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
    const close = yield* resumable(top).pipe(workFailure);
    if (close === null) return yield* restart(top);
    const keyed = new Map(items.filter((one) => one.key !== RESCAN).map((one) => [one.key, one]));
    const at = { sequence: top, created: false, level };
    const add = (key: string, list: string) => {
      if (!keyed.has(key)) keyed.set(key, { ...at, key, list });
    };
    for (const one of items) for (const row of one.dependents ?? []) add(row.key, row.registerId);
    const place = (one: Pending) =>
      one.key !== RESCAN && (one.list === "clients" || one.list === "projects");
    // A place's own change can reach a burst apart from its rescan, so either one looks again.
    if (viewer.teammate && items.some((one) => one.key === RESCAN || place(one))) {
      // A label or a place shows or hides entries with no change of their own.
      const sees = yield* teamKeyLists(orgId, own(viewer)).pipe(workFailure);
      for (const [key, list] of seen) if (!sees.has(key)) add(key, list);
      for (const [key, list] of sees) if (!seen.has(key)) add(key, list);
      // Their entries under a client or project that moved read differently now: a task shows
      // its project once they see that project, and what they may do follows its lead.
      for (const one of items)
        if (place(one)) {
          const moved = yield* records.get(orgId, one.key);
          if (moved === undefined) continue;
          for (const row of yield* dependentRows(orgId, moved.recordId, moved.registerId).pipe(
            workFailure,
          ))
            if (sees.has(row.key)) add(row.key, row.registerId);
        }
    }
    const rows = yield* rowsNow([...keyed.values()]);
    const moved = yield* counts(close, newest);
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
      // Keep dependents in the parent's burst before its cursor, even if an ordinary tick follows.
      return bufferLatestLiveStream(pending, (one) =>
        one.dependents === undefined ? one.key : `*dependents:${one.key}`,
      ).pipe(
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
 * `kin.work.subscribe` without `acceptRows`, for an older phone: the row stream's session, tick by
 * tick, told as `changed`. The first is where things stand; a change names each entry the row
 * stream would send, and a fresh read is one that names none.
 */
export const subscribeChanged = (
  people: ReadonlyArray<PersonIdentity>,
  input: { readonly orgId: KinOrgId },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const records = yield* KinRecords;
      const session = yield* makeWorkStream(people, { orgId: input.orgId, acceptRows: true });
      let started = false;
      return records.changes(input.orgId).pipe(
        Stream.mapEffect((tick) =>
          Effect.gen(function* () {
            if (started) {
              const pending = session.pendingOf(tick);
              return pending.length === 0 ? NONE : changedOf(yield* session.batch(pending));
            }
            started = true;
            const opening = yield* session.start(tick.seq);
            return opening.slice(0, 1).map(({ seq }): Changed => ({ _tag: "changed", seq }));
          }),
        ),
        Stream.flattenIterable,
      );
    }),
  );

type Changed = Extract<Out, { readonly _tag: "changed" }>;
const NONE: ReadonlyArray<Changed> = [];
const changedOf = (events: ReadonlyArray<Out>): ReadonlyArray<Changed> => {
  const named = events.flatMap((event): ReadonlyArray<Changed> => {
    if (event._tag === "upsert")
      return [{ _tag: "changed", seq: event.seq, key: event.record.key, list: event.list }];
    if (event._tag === "removed")
      return [
        {
          _tag: "changed",
          seq: event.seq,
          key: event.key,
          ...(event.list === undefined ? {} : { list: event.list }),
        },
      ];
    return [];
  });
  if (named.length > 0) return named;
  const fresh = events.find((event) => event._tag === "snapshot-required");
  return fresh === undefined ? [] : [{ _tag: "changed", seq: fresh.seq }];
};

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
