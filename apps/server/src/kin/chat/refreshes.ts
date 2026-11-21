import {
  KIN_STREAMS,
  KinChatError,
  kinOwnerLevel,
  type KinPersonAccess,
  type KinRefreshes,
  type KinRefreshesAnnounceInput,
  type KinRefreshesSubscribeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as LeadProvision from "../lead/KinLeadProvision.ts";
import { accessOf } from "../people/KinAccess.ts";
import { KinIdentity, type PersonIdentity } from "./KinIdentity.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { countryNeeded } from "../work/companyProfile.ts";
import * as Money from "../work/ownerMoney.ts";
import { theOwner } from "../work/ownerWork.ts";
import { KinRefreshHub, KinRefreshObserver, type KinRevisions } from "./KinRefreshHub.ts";

const notFound = new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });

type Reads = {
  readonly kind: Effect.Effect<KinPersonAccess | undefined>;
  readonly view: Effect.Effect<string | null>;
  readonly lists: Effect.Effect<string | null>;
};
/**
 * One person's reads for one settled burst, shared by their devices. A burst's revisions are a new
 * object (`KinRefreshHub`), and a change of role or of whom one leads moves `people` or `leads`, so
 * it is always a new burst and read afresh.
 */
const burstReads = new WeakMap<object, WeakMap<KinRevisions, Map<string, Reads>>>();

const same = (a: KinRefreshes, b: KinRefreshes) =>
  a.company === b.company &&
  a.recipes === b.recipes &&
  a.memory === b.memory &&
  a.people === b.people &&
  a.leads === b.leads &&
  a.timeZone === b.timeZone &&
  a.visualHosts === b.visualHosts &&
  a.workChoices === b.workChoices &&
  a.moneyBudgets === b.moneyBudgets &&
  a.moneyStatements === b.moneyStatements &&
  a.pulse === b.pulse &&
  a.budget === b.budget &&
  a.connections === b.connections &&
  a.workLists === b.workLists &&
  a.recommendations === b.recommendations &&
  a.imports === b.imports &&
  a.stop === b.stop &&
  a.boot === b.boot;

/**
 * The revisions this viewer may see. Owner-level people read every topic but the owner's own
 * recommendations. A member reads the time zone, profiles, Needs attention, the stop switch, their
 * lead list and work lists (moved only when what those show them changed) and, while a new company
 * waits on its country, the company topic.
 */
export const subscribeRefreshes = (
  people: ReadonlyArray<PersonIdentity>,
  input: KinRefreshesSubscribeInput,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const person = people.find((candidate) => candidate.orgId === input.orgId);
      if (person === undefined) return yield* notFound;
      const { owner } = yield* KinIdentity;
      if (person.orgId !== owner.orgId) return yield* notFound;
      const hub = yield* KinRefreshHub;
      const changes = hub.changes(input.orgId);
      const kind = accessOf(person.orgId, person.personId).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const view = Effect.all([
        LeadProvision.profiles(person),
        LeadProvision.contacts(person),
        LeadProvision.messageable(person),
        kind,
      ]).pipe(
        Effect.map((shown) => JSON.stringify(shown)),
        // An unreadable list counts as changed; the client's own read then reports the failure.
        Effect.orElseSucceed(() => null),
      );
      // Without the Money place the read is refused: null, and it stays null until that changes.
      const listsView = Money.lists([person], { orgId: input.orgId, archived: true }).pipe(
        Effect.map((shown) => JSON.stringify(shown)),
        Effect.orElseSucceed(() => null),
      );
      const bursts = burstReads.get(hub) ?? new WeakMap<KinRevisions, Map<string, Reads>>();
      burstReads.set(hub, bursts);
      const readsOf = Effect.fn("KinRefreshes.readsOf")(function* (now: KinRevisions) {
        const people = bursts.get(now) ?? new Map<string, Reads>();
        bursts.set(now, people);
        const key = `${input.orgId}:${person.personId}`;
        const held = people.get(key);
        if (held !== undefined) return held;
        const services = yield* Effect.context<
          Effect.Services<typeof kind> | Effect.Services<typeof view | typeof listsView>
        >();
        const reads: Reads = {
          kind: yield* Effect.cached(Effect.provide(kind, services)),
          view: yield* Effect.cached(Effect.provide(view, services)),
          lists: yield* Effect.cached(Effect.provide(listsView, services)),
        };
        people.set(key, reads);
        return reads;
      });
      const waiting = countryNeeded(input.orgId).pipe(Effect.orElseSucceed(() => false));
      // Counted per person for the run, so a reconnect with nothing moved reads the same numbers.
      const counter = (name: string) => `${input.orgId}:${person.personId}:${name}`;
      let heard: KinRevisions | undefined;
      let leads = 0;
      let lists = 0;
      let company = 0;
      let waited = false;
      return changes.pipe(
        Stream.mapEffect((now) =>
          Effect.gen(function* () {
            const reads = yield* readsOf(now);
            const access = yield* reads.kind;
            if (kinOwnerLevel(access)) {
              heard = undefined;
              // What Kin suggested is the owner's alone (`kin.recommendations.*`).
              const { recommendations: _ownerOnly, ...shared } = now;
              return {
                ...(access === "owner" ? now : shared),
                boot: hub.boot,
                streams: KIN_STREAMS,
              } satisfies KinRefreshes;
            }
            if (heard === undefined || heard.leads !== now.leads || heard.people !== now.people)
              leads = hub.counted(counter("leads"), yield* reads.view);
            if (heard === undefined || heard.workLists !== now.workLists)
              // A refusal that stands is no change.
              lists = hub.counted(counter("workLists"), (yield* reads.lists) ?? "refused");
            if (heard === undefined || heard.company !== now.company) {
              const still = yield* waiting;
              waited ||= still;
              company = hub.counted(counter("company"), String(still));
            }
            heard = now;
            // Everyone's profile is readable by the whole org. Pulse moves only say "read your
            // Needs attention again"; the read shows them only what they may see.
            return {
              timeZone: now.timeZone,
              people: now.people,
              leads,
              pulse: now.pulse,
              workLists: lists,
              stop: now.stop,
              // Only a company that waited on its country: no other gains a byte.
              ...(waited ? { company } : {}),
              boot: hub.boot,
              streams: KIN_STREAMS,
            } satisfies KinRefreshes;
          }),
        ),
        Stream.changesWith(same),
      );
    }),
  );

/**
 * The owner's announcement of writes the server didn't make, such as the `kin` CLI's, which commit
 * in another process: their topics move and Work's listeners read again, through the same hub.
 */
export const announceRefreshes = Effect.fn("KinRefreshes.announce")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinRefreshesAnnounceInput,
) {
  yield* theOwner(people, input.orgId);
  const observer = yield* KinRefreshObserver;
  for (const topic of new Set(input.topics)) yield* observer.touch(input.orgId, topic);
  if (input.records) yield* (yield* KinRecords).announce(input.orgId);
  return {};
});
