import {
  kinApplyWorkCounts,
  kinApplyWorkRow,
  kinRestoreWorkList,
  kinWorkRowsStart,
  type EnvironmentId,
  type KinDocsListInput,
  type KinOrgId,
  type KinWorkEvent,
  type KinWorkListInput,
  type KinWorkRows,
  type KinWorkSubscribeInput,
  type KinWorkSummary,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { requestGuarded, subscribeDynamic } from "../rpc/index.ts";
import { environmentSessionGenerationAtom } from "../state/runtime.ts";
import { kinAccessMeAtom } from "./kinAccess.ts";
import { kinViewerReachKey } from "./kinJoin.ts";
import { resubscribeWhenKinReturns, retryWhileKinUnavailable } from "./kinStreams.ts";
import { kinWorkFailuresOf, kinWorkRefused } from "./kinWork.ts";

/** Work as the host last described it: its change number, and the counts read at that number. */
export interface KinWorkLive {
  /** The latest change number the host announced. A list or task read at a lower one is behind. */
  readonly seq: number;
  /** Null until the counts have been read once. */
  readonly summary: KinWorkSummary | null;
  /** The last read of the counts failed; what is held is older than `seq`. */
  readonly failed: boolean;
  /** The latest change number the host named each task with, for the tasks it named lately. */
  readonly changed: Readonly<Record<string, number>>;
  /**
   * The latest change number that came without a task's name and was news: something changed
   * while this was away, or the host is an older one that names nothing. 0 with none.
   */
  readonly unnamed: number;
  /** The latest change number the host named each list with, for changes since the first number. */
  readonly lists: Readonly<Record<string, number>>;
  /** The latest change number that named a task but not its list: an older host, or a label move. */
  readonly unlisted: number;
  /**
   * The tasks the host sent whole since the first number, for lists to apply without a read; null
   * from an older host, which names changes only.
   */
  readonly rows: KinWorkRows | null;
}

export const KIN_WORK_LABEL = "kin:work";
/** A burst of changes (a lead filing twenty tasks) settles for this long before one read. */
const KIN_WORK_SETTLE = Duration.millis(250);
const NOTHING: ReadonlyArray<KinWorkLive> = [];
/** How many tasks' latest change numbers are remembered; one open task needs only its own. */
const KIN_WORK_NAMED_CAP = 64;

/** Which tasks the host has said changed, and the last change it announced without saying which. */
export interface KinWorkNamed {
  /** The highest change number heard; null before the first. */
  readonly latest: number | null;
  readonly changed: KinWorkLive["changed"];
  readonly unnamed: number;
  readonly lists: KinWorkLive["lists"];
  readonly unlisted: number;
}

export const KIN_WORK_NOTHING_NAMED: KinWorkNamed = {
  latest: null,
  changed: {},
  unnamed: 0,
  lists: {},
  unlisted: 0,
};

/** Takes in one announcement. Returns `held` itself when it says nothing new about any task. */
export function kinWorkNote(
  held: KinWorkNamed,
  event: {
    readonly seq: number;
    readonly key?: string | undefined;
    readonly list?: string | undefined;
  },
): KinWorkNamed {
  const latest = Math.max(held.latest ?? 0, event.seq);
  if (event.key === undefined) {
    // The first number ever is where things stand, not a change.
    return held.latest === null || event.seq <= held.latest
      ? held.latest === latest
        ? held
        : { ...held, latest }
      : { ...held, latest, unnamed: event.seq };
  }
  const { key } = event;
  if ((held.changed[key] ?? 0) >= event.seq) return held;
  const others = Object.entries(held.changed).filter(([name]) => name !== key);
  const { list } = event;
  return {
    ...held,
    latest,
    changed: Object.fromEntries([...others.slice(1 - KIN_WORK_NAMED_CAP), [key, event.seq]]),
    ...(list === undefined
      ? { unlisted: Math.max(held.unlisted, event.seq) }
      : { lists: { ...held.lists, [list]: Math.max(held.lists[list] ?? 0, event.seq) } }),
  };
}

/** The lists a read covers: some, every one, or every one but some. */
export type KinWorkListsCovered =
  | ReadonlyArray<string>
  | "any"
  | { readonly except: ReadonlyArray<string> };

/**
 * Moves only when a change since the first number could touch a read over `lists`: a change named
 * with one of them, or one that said nothing of its list. `"any"` moves on every change.
 */
export function kinWorkListsMoved(
  live: Pick<KinWorkLive, "lists" | "unlisted" | "unnamed">,
  lists: KinWorkListsCovered,
): number {
  const named =
    lists === "any"
      ? Object.values(live.lists)
      : "except" in lists
        ? Object.entries(live.lists).flatMap(([list, seq]) =>
            lists.except.includes(list) ? [] : [seq],
          )
        : lists.map((l) => live.lists[l] ?? 0);
  return Math.max(live.unnamed, live.unlisted, ...named);
}

/**
 * What a task cannot move: Money, cash, outlook and budgets add up money lists, and the lists'
 * definitions count open entries only for lists people made. A client's name shows in Money.
 */
export const KIN_WORK_NOT_TASKS = { except: ["work"] } as const;

/** What a deal shows: its follow-ups, itself, its client, and its client's quotes. */
export const KIN_WORK_DEAL_LISTS = ["work", "deals", "clients", "quotes"] as const;

type KinWorkTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly orgId: KinOrgId };
};

/**
 * `refreshTrigger`s from Work's own stream: a change to a list the read covers (`"any"`: every
 * list), a fresh start, a new session on a host that can't resume, or the viewer's places moving;
 * `also` adds a topic. Reads only while shown, and once on its next showing for a move it missed.
 */
export function createKinWorkRefreshTriggers<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  live: (target: KinWorkTarget) => Atom.Atom<AsyncResult.AsyncResult<KinWorkLive, unknown>>,
) {
  return (lists: KinWorkListsCovered, also?: (target: KinWorkTarget) => Atom.Atom<unknown>) =>
    (target: KinWorkTarget) => {
      let firstReach: string | undefined;
      return Atom.make((get) => {
        const { environmentId } = target;
        const held = AsyncResult.getOrElse(
          get(live({ environmentId, input: { orgId: target.input.orgId } })),
          () => null,
        );
        const moved = held === null ? 0 : kinWorkListsMoved(held, lists);
        const topic = also === undefined ? "" : String(get(also(target)));
        // A new epoch reads everything again, even where its number happens to match the old one.
        const epoch = held?.rows?.epoch ?? 0;
        // A host that streams rows resumes from its number; an older one's reads follow each session.
        const sessions = get(environmentSessionGenerationAtom(runtime, environmentId));
        const unresumed = held?.rows === null ? Math.max(0, sessions - 1) : 0;
        // A refused read stays refused until asked again, so a place switched on or off reads
        // again. Learning the viewer's reach the first time is no move.
        const me = get(kinAccessMeAtom(runtime, environmentId));
        const reach = me === null ? undefined : kinViewerReachKey(me);
        firstReach ??= reach;
        const moves = reach === firstReach ? "" : reach;
        return `${unresumed}:${epoch}:${moved}:${topic}:${moves}`;
      });
    };
}

/**
 * `kin.work.list` in its compact shape, restored to whole rows here, so every screen reads the
 * same `records` whichever shape the host answered in. An older host ignores the ask.
 */
export const kinWorkListLean = (input: KinWorkListInput) =>
  requestGuarded("kin.work.list", { ...input, acceptCompactRows: true }).pipe(
    Effect.map((result) => kinRestoreWorkList(result, input.orgId)),
  );

/** `kin.docs.list` with slim rows: what the row's line says of the latest version. */
export const kinDocsListLean = (input: KinDocsListInput) =>
  requestGuarded("kin.docs.list", { ...input, acceptSlimLatest: true });

/** Asks the counts stream to read again now, inside the running stream. */
export const KIN_WORK_RETRY = { _tag: "retry" } as const;

/** A read cut off with its connection can stay pending; past this it counts as failed. */
export const KIN_WORK_READ_TIMEOUT = Duration.seconds(20);

/**
 * Work as the host streams it: changed tasks whole, then the counts that moved. A host that only
 * names changes gets one read of the counts per burst instead. Reconnecting resumes from the last
 * number held, so nothing that stayed put is sent again. Fails only when the host refuses.
 */
export function kinWorkLiveStream<E, R, RR = never>(
  input: KinWorkSubscribeInput,
  readSummary: (input: KinWorkSubscribeInput) => Effect.Effect<KinWorkSummary, E, R>,
  /** Each one reads the counts again, keeping what is held: the retry after a failed read. */
  retries: Stream.Stream<unknown, never, RR> = Stream.never,
) {
  return Stream.suspend(() => {
    const resume: KinWorkResume = { at: null };
    return kinWorkLiveFold(
      Stream.merge(
        resubscribeWhenKinReturns(
          retryWhileKinUnavailable(
            subscribeDynamic("kin.work.subscribe", () =>
              Effect.sync(() => ({
                orgId: input.orgId,
                acceptRows: true,
                ...(resume.at === null
                  ? {}
                  : {
                      afterSeq: resume.at.seq,
                      ...(resume.at.team ? { afterTeam: true } : {}),
                    }),
              })),
            ),
          ),
          Stream.empty,
          Stream.empty,
        ),
        retries.pipe(Stream.map(() => KIN_WORK_RETRY)),
      ),
      () => readSummary(input),
      { orgId: input.orgId, resume },
    );
  });
}

/** Where a new session picks the stream up: the last number the counts were current at. */
export interface KinWorkResume {
  at: { readonly seq: number; readonly team: boolean } | null;
}

let kinWorkFolds = 0;
const KIN_WORK_FOLD_EPOCHS = 1_000_000;

/** `kinWorkLiveStream` over any source of changes and retries. */
export function kinWorkLiveFold<E, R, EE, RR>(
  events: Stream.Stream<KinWorkEvent | typeof KIN_WORK_RETRY, EE, RR>,
  readSummary: () => Effect.Effect<KinWorkSummary, E, R>,
  rowsOf?: { readonly orgId: KinOrgId; readonly resume?: KinWorkResume },
) {
  return Stream.suspend(() => {
    let held: KinWorkSummary | null = null;
    let first = true;
    let named = KIN_WORK_NOTHING_NAMED;
    let last: KinWorkLive | null = null;
    let rows: KinWorkRows | null = null;
    // Each fold numbers its own epochs, so a page held from an earlier one never patches from this.
    let epoch = (kinWorkFolds += KIN_WORK_FOLD_EPOCHS);
    return events.pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const emit = (
            live: Pick<KinWorkLive, "seq" | "summary" | "failed">,
          ): ReadonlyArray<KinWorkLive> => [
            (last = {
              ...live,
              changed: named.changed,
              unnamed: named.unnamed,
              lists: named.lists,
              unlisted: named.unlisted,
              rows,
            }),
          ];
          const resumeAt = (at: { readonly seq: number; readonly team?: true | undefined }) => {
            if (rowsOf?.resume !== undefined)
              rowsOf.resume.at = { seq: at.seq, team: at.team === true };
          };
          switch (event._tag) {
            case "upsert":
            case "removed": {
              if (rowsOf === undefined) return NOTHING;
              rows = kinApplyWorkRow(rows ?? kinWorkRowsStart(0, epoch), event, rowsOf.orgId);
              const key = event._tag === "upsert" ? event.record.key : event.key;
              named = kinWorkNote(named, { seq: event.seq, key, list: event.list });
              // The burst's `counts` or `synchronized` follows and shows it all at once.
              return NOTHING;
            }
            case "snapshot-required":
              // The host can't say what changed: every list and read starts over, at a new epoch.
              epoch += 1;
              rows = kinWorkRowsStart(event.seq, epoch);
              named = {
                ...named,
                latest: Math.max(named.latest ?? 0, event.seq),
                unnamed: Math.max(named.unnamed, event.seq),
              };
              resumeAt(event);
              return NOTHING;
            case "synchronized": {
              resumeAt(event);
              rows ??= kinWorkRowsStart(event.seq, epoch);
              named = { ...named, latest: Math.max(named.latest ?? 0, event.seq) };
              const seq = Math.max(last?.seq ?? 0, event.seq);
              return last !== null && last.seq === seq && last.rows === rows
                ? NOTHING
                : emit({ seq, summary: held, failed: last?.failed ?? false });
            }
            case "counts": {
              resumeAt(event);
              rows ??= kinWorkRowsStart(event.seq, epoch);
              named = { ...named, latest: Math.max(named.latest ?? 0, event.seq) };
              const next = kinApplyWorkCounts(held, event);
              if (next !== null) {
                held = next;
                first = false;
                return emit({ seq: event.seq, summary: next, failed: false });
              }
              // Moved counts with none held to move: only a read says where they stand.
              break;
            }
          }
          // The host's own events are tagged `changed`, so only this tag means a retry.
          const retry = event._tag === "retry";
          if (retry && named.latest === null) return NOTHING;
          const seq = event._tag === "retry" ? (named.latest ?? 0) : event.seq;
          const before = named;
          if (event._tag === "changed") named = kinWorkNote(before, event);
          const news = named !== before;
          // Counts read during a burst already cover this number; only which task it was is new.
          if (event._tag === "changed" && held !== null && held.seq >= seq)
            return news && last !== null ? emit(last) : NOTHING;
          if (!first && event._tag === "changed") yield* Effect.sleep(KIN_WORK_SETTLE);
          first = false;
          // A dropped socket interrupts the read in flight, or leaves it pending. Either is a failed
          // read, not the stream's end, or the next session is never subscribed to.
          const read = yield* Effect.exit(
            readSummary().pipe(Effect.timeout(KIN_WORK_READ_TIMEOUT)),
          );
          if (read._tag === "Failure") {
            const refusal = kinWorkFailuresOf(read.cause).find(kinWorkRefused);
            if (refusal !== undefined) return yield* Effect.fail(refusal);
            return emit({ seq, summary: held, failed: true });
          }
          held = read.value;
          return emit({ seq: Math.max(seq, held.seq), summary: held, failed: false });
        }),
      ),
      Stream.flattenIterable,
    );
  });
}
