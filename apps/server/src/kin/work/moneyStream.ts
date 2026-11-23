import {
  KIN_MONEY_PARTS,
  type KinMoneyLive,
  type KinMoneyPart,
  type KinMoneySubscribeInput,
  type KinOrgId,
  type KinRefreshes,
  kinMoneyApply,
  kinMoneyDiff,
  kinMoneySettled,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshHub } from "../chat/KinRefreshHub.ts";
import { coalesced, hashedLive, viewHash } from "../hashedLive.ts";
import * as Goals from "./goals.ts";
import { KinRecords, type Tick } from "./KinRecords.ts";
import * as Money from "./ownerMoney.ts";
import * as MoneyAnswers from "./ownerMoneyAnswers.ts";
import { theOwner } from "./ownerWork.ts";

/**
 * `kin.money.subscribe`, a hashed live read (`hashedLive.ts`): each part is the owner's own read,
 * built again when something that can move it changes. Owner level only, checked before every build.
 */

/** The parts a burst asks to build again. */
export type MoneyDemand = ReadonlySet<KinMoneyPart>;

const ALL: ReadonlySet<KinMoneyPart> = new Set(KIN_MONEY_PARTS);
const NOTHING: MoneyDemand = new Set();
const START = "start" as const;

/**
 * What a Work change can move. A task is no money: it moves only the summary's coming-up count, a
 * goal that counts tasks and Work's open count among the lists. Anything else (an entry of a money list, a client's name, a change that names
 * nothing, someone's level) builds every part again.
 */
export const demandOfTick = (tick: Tick): MoneyDemand =>
  tick.registerId === "work" && tick.key !== undefined && tick.people === undefined
    ? new Set(["summary", "goals", "lists"])
    : ALL;

const TOPIC_PARTS: Partial<Record<keyof KinRefreshes, ReadonlyArray<KinMoneyPart>>> = {
  moneyStatements: ["cash", "outlook"],
  moneyBudgets: ["budgets"],
  workLists: ["lists"],
  pulse: ["goals"],
  timeZone: KIN_MONEY_PARTS,
  company: KIN_MONEY_PARTS,
  people: KIN_MONEY_PARTS,
  // A section switched leaves out or brings back what Money counts (invoices in the outlook).
  shell: KIN_MONEY_PARTS,
};

/** What a move of the refresh topics can move. */
export const demandOfTopics = (before: KinRefreshes, after: KinRefreshes): MoneyDemand => {
  const parts = new Set<KinMoneyPart>();
  for (const [topic, moves] of Object.entries(TOPIC_PARTS) as Array<
    [keyof KinRefreshes, ReadonlyArray<KinMoneyPart>]
  >)
    if (before[topic] !== after[topic]) for (const part of moves) parts.add(part);
  return parts;
};

const joined = (demands: ReadonlyArray<MoneyDemand>): MoneyDemand =>
  new Set(demands.flatMap((demand) => [...demand]));

/** Names what is held as `kinMoneySettled` compares it. */
const hashOf = (live: KinMoneyLive) =>
  viewHash(
    JSON.stringify(KIN_MONEY_PARTS.map((part) => kinMoneySettled(part, live[part]) ?? null)),
  );

const build = Effect.fn("KinMoneyStream.build")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
  part: KinMoneyPart,
) {
  switch (part) {
    case "summary":
      return { summary: yield* Money.money(people, { orgId, upcomingRows: false }) };
    case "cash":
      return { cash: yield* MoneyAnswers.cash(people, { orgId }) };
    case "outlook":
      return { outlook: yield* MoneyAnswers.outlook(people, { orgId }) };
    case "budgets":
      return { budgets: yield* MoneyAnswers.budgets(people, { orgId }) };
    case "receipts":
      return { receipts: yield* Money.receipts(people, { orgId }) };
    case "goals":
      return { goals: yield* Goals.list(people, orgId) };
    case "lists":
      return { lists: yield* Money.lists(people, { orgId }) };
  }
});

/**
 * Each part's last build per company, by what its screens had heard. Every owner-level person
 * reads Money alike (`KIN_OWNER_LEVEL`), so their screens share it; one server's KinRecords keys it.
 */
type Built = Map<string, { readonly heard: string; readonly built: ReturnType<typeof build> }>;
const lastBuilt = new WeakMap<object, Built>();

/**
 * One subscriber's side: `start` builds what they asked for, `apply` builds again what a burst
 * can move and says only what differs. `subscribe` runs it over the live changes; tests drive it.
 */
export const makeMoneyStream = Effect.fn("KinMoneyStream.make")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinMoneySubscribeInput,
) {
  const { orgId } = input;
  const asked = new Set(input.parts);
  yield* theOwner(people, orgId);
  const records = yield* KinRecords;
  const built: Built = lastBuilt.get(records) ?? new Map();
  lastBuilt.set(records, built);
  const live = hashedLive({
    held: input.held,
    hash: hashOf,
    snapshot: (held: KinMoneyLive, hash) => ({ _tag: "snapshot", live: held, hash }) as const,
    diff: kinMoneyDiff,
    apply: (held, change) => kinMoneyApply(held, { ...change, _tag: "changed", hash: "" }),
  });

  /** With `heard`, a part another screen built after hearing the same is reused. */
  const shared = Effect.fn("KinMoneyStream.shared")(function* (part: KinMoneyPart, heard: string) {
    const key = `${orgId}:${part}`;
    const last = built.get(key);
    if (last?.heard === heard) return yield* last.built;
    const once = yield* Effect.cached(build(people, orgId, part));
    built.set(key, { heard, built: once });
    return yield* once;
  });
  const buildAll = (parts: ReadonlyArray<KinMoneyPart>, heard?: string) =>
    Effect.forEach(
      parts,
      (part) => (heard === undefined ? build(people, orgId, part) : shared(part, heard)),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((each): KinMoneyLive => Object.assign({}, ...each)));

  const start = Effect.fn("KinMoneyStream.start")(function* () {
    return live.first(yield* buildAll(KIN_MONEY_PARTS.filter((part) => asked.has(part))));
  });

  const apply = Effect.fn("KinMoneyStream.apply")(function* (demand: MoneyDemand, heard?: string) {
    const parts = KIN_MONEY_PARTS.filter((part) => asked.has(part) && demand.has(part));
    if (parts.length === 0) return [];
    // Someone no longer owner level gets nothing more; their client subscribes again and is refused.
    yield* theOwner(people, orgId);
    return live.next(yield* buildAll(parts, heard));
  });

  return { start, apply };
});

/** Changes this close together are built once. */
const BATCH_WINDOW = Duration.millis(50);

export const subscribe = (people: ReadonlyArray<PersonIdentity>, input: KinMoneySubscribeInput) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const records = yield* KinRecords;
      const hub = yield* KinRefreshHub;
      const session = yield* makeMoneyStream(people, input);
      let started = false;
      let seq = 0;
      // The first tick is where Work stands, read after subscribing: the build that starts from it
      // misses nothing.
      const ticks = records.changes(input.orgId).pipe(
        Stream.map((tick) => {
          seq = Math.max(seq, tick.seq);
          if (started) return demandOfTick(tick);
          started = true;
          return START;
        }),
      );
      let topics: KinRefreshes | null = null;
      const moved = hub.changes(input.orgId).pipe(
        Stream.map((now) => {
          const before = topics;
          topics = now;
          return before === null ? NOTHING : demandOfTopics(before, now);
        }),
      );
      return coalesced(
        Stream.merge(ticks, moved).pipe(
          Stream.filter((one) => one === START || (started && one.size > 0)),
        ),
        (asked) =>
          asked.includes(START)
            ? session.start().pipe(Effect.map((event) => [event]))
            : session.apply(
                joined(asked.filter((one): one is MoneyDemand => one !== START)),
                // Read after the burst's wait, so a build kept under what was heard is no older.
                JSON.stringify([seq, topics]),
              ),
        // The first build answers at once; a change waits a moment for the rest of its burst.
        (asked) => (asked.includes(START) ? undefined : BATCH_WINDOW),
      );
    }),
  );
