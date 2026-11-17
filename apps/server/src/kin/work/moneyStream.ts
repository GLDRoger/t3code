import {
  KIN_MONEY_PARTS,
  type KinMoneyEvent,
  type KinMoneyLive,
  type KinMoneyPart,
  type KinMoneySubscribeInput,
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
import { viewHash } from "../pulse/people.ts";
import * as Goals from "./goals.ts";
import { KinRecords, type Tick } from "./KinRecords.ts";
import * as Money from "./ownerMoney.ts";
import * as MoneyAnswers from "./ownerMoneyAnswers.ts";
import { theOwner } from "./ownerWork.ts";

/**
 * `kin.money.subscribe`: T3's skip-unchanged for derived state. Each part is the owner's own read,
 * built again when something that can move it changes and sent only when it differs from what this
 * viewer last got. Owner level only, checked again before every build.
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
};

/** What a move of the refresh topics can move. */
const demandOfTopics = (before: KinRefreshes, after: KinRefreshes): MoneyDemand => {
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
  let sent: KinMoneyLive = {};

  const build = Effect.fn("KinMoneyStream.build")(function* (part: KinMoneyPart) {
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
  const buildAll = (parts: ReadonlyArray<KinMoneyPart>) =>
    Effect.forEach(parts, build).pipe(
      Effect.map((built): KinMoneyLive => Object.assign({}, ...built)),
    );

  const start = Effect.fn("KinMoneyStream.start")(function* (): Effect.fn.Return<
    KinMoneyEvent,
    Effect.Error<ReturnType<typeof buildAll>>,
    Effect.Services<ReturnType<typeof buildAll>>
  > {
    sent = yield* buildAll(KIN_MONEY_PARTS.filter((part) => asked.has(part)));
    const hash = hashOf(sent);
    return input.held === hash
      ? ({ _tag: "current", hash } satisfies KinMoneyEvent)
      : ({ _tag: "snapshot", live: sent, hash } satisfies KinMoneyEvent);
  });

  const apply = Effect.fn("KinMoneyStream.apply")(function* (demand: MoneyDemand) {
    const parts = KIN_MONEY_PARTS.filter((part) => asked.has(part) && demand.has(part));
    const none: ReadonlyArray<KinMoneyEvent> = [];
    if (parts.length === 0) return none;
    // Someone no longer owner level gets nothing more; their client subscribes again and is refused.
    yield* theOwner(people, orgId);
    const next = yield* buildAll(parts);
    const change = kinMoneyDiff(sent, next);
    if (change === null) return none;
    const event = { _tag: "changed", ...change, hash: "" } as const;
    sent = kinMoneyApply(sent, event);
    const out: ReadonlyArray<KinMoneyEvent> = [{ ...event, hash: hashOf(sent) }];
    return out;
  });

  return { start, apply };
});

/** As Work's stream: changes this close together are built once. */
const BATCH = 512;
const BATCH_WINDOW = Duration.millis(50);

export const subscribe = (people: ReadonlyArray<PersonIdentity>, input: KinMoneySubscribeInput) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const records = yield* KinRecords;
      const hub = yield* KinRefreshHub;
      const session = yield* makeMoneyStream(people, input);
      let started = false;
      // The first tick is where Work stands, read after subscribing: the build that starts from it
      // misses nothing.
      const ticks = records.changes(input.orgId).pipe(
        Stream.map((tick) => {
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
      let pending: Array<MoneyDemand | typeof START> = [];
      return Stream.merge(ticks, moved).pipe(
        Stream.filter((one) => one === START || (started && one.size > 0)),
        Stream.groupedWithin(BATCH, BATCH_WINDOW),
        Stream.map((group) => {
          pending.push(...group);
        }),
        // A burst during a build is one more build, of everything it asked for.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => {
          const taken = pending;
          pending = [];
          if (taken.includes(START))
            return session.start().pipe(Effect.map((one): ReadonlyArray<KinMoneyEvent> => [one]));
          return session.apply(joined(taken.filter((one): one is MoneyDemand => one !== START)));
        }),
        Stream.flattenIterable,
      );
    }),
  );
