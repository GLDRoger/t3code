import {
  KinChatError,
  type KinRefreshes,
  type KinRefreshesSubscribeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as LeadProvision from "../lead/KinLeadProvision.ts";
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
 * The revisions this viewer may see. The owner reads every topic. A teammate reads only the time
 * zone and their own lead list, which moves only when what that list shows them changed, so a
 * change to something they can't read never reaches them, not even as a moved number.
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
      const changes = (yield* KinRefreshHub).changes(input.orgId);
      if (person.orgId === owner.orgId && person.personId === owner.personId)
        return changes.pipe(Stream.changesWith(same));
      const view = Effect.all([
        LeadProvision.profiles(person),
        LeadProvision.contacts(person),
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
