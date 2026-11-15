import {
  KinChatError,
  kinOwnerLevel,
  type KinRefreshes,
  type KinRefreshesSubscribeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as LeadProvision from "../lead/KinLeadProvision.ts";
import { accessOf } from "../people/KinAccess.ts";
import { KinIdentity, type PersonIdentity } from "./KinIdentity.ts";
import { KinRefreshHub, type KinRevisions } from "./KinRefreshHub.ts";

const notFound = new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });

const same = (a: KinRefreshes, b: KinRefreshes) =>
  a.company === b.company &&
  a.recipes === b.recipes &&
  a.memory === b.memory &&
  a.people === b.people &&
  a.leads === b.leads &&
  a.timeZone === b.timeZone &&
  a.visualHosts === b.visualHosts;

/**
 * The revisions this viewer may see, by their kind at each change, so making someone a co-owner
 * or a member again moves what they hear at once. Owner-level people read every topic. A member
 * reads only the time zone and their own lead list, which moves only when what that list shows
 * them (or their own kind) changed, so a change to something they can't read never reaches them.
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
      let heard: KinRevisions | undefined;
      let shown: string | null | undefined;
      let leads = 0;
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
            heard = now;
            return { timeZone: now.timeZone, leads } satisfies KinRefreshes;
          }),
        ),
        Stream.changesWith(same),
      );
    }),
  );
