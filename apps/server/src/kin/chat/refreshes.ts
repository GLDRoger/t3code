import {
  KinChatError,
  kinOwnerLevel,
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
import * as Money from "../work/ownerMoney.ts";
import { theOwner } from "../work/ownerWork.ts";
import { KinRefreshHub, KinRefreshObserver, type KinRevisions } from "./KinRefreshHub.ts";

const notFound = new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });

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
  a.workLists === b.workLists;

/**
 * The revisions this viewer may see, by their kind at each change. Owner-level people read every
 * topic. A member reads the time zone, profiles and Needs attention, and their own lead list and
 * work lists, which move only when what those show them (or their kind) changed, so a change they
 * can't read never reaches them.
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
      const changes = (yield* KinRefreshHub).changes(input.orgId);
      const kind = accessOf(person.orgId, person.personId).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const view = Effect.all([
        LeadProvision.profiles(person),
        LeadProvision.contacts(person),
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
      let heard: KinRevisions | undefined;
      let shown: string | null | undefined;
      let shownLists: string | null | undefined;
      let leads = 0;
      let lists = 0;
      return changes.pipe(
        Stream.mapEffect((now) =>
          Effect.gen(function* () {
            if (kinOwnerLevel(yield* kind)) {
              heard = undefined;
              return now satisfies KinRefreshes;
            }
            if (heard === undefined || heard.leads !== now.leads || heard.people !== now.people) {
              const next = yield* view;
              if (shown !== undefined && (next === null || next !== shown)) leads += 1;
              shown = next;
            }
            if (heard === undefined || heard.workLists !== now.workLists) {
              const next = yield* listsView;
              if (shownLists !== undefined && next !== shownLists) lists += 1;
              shownLists = next;
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
