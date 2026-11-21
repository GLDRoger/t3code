import type { EnvironmentId, KinAccessMeResult, KinOrgId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { kinAccessMeAtom } from "./kinAccess.ts";
import type { KinClient } from "./kinClient.ts";
import { kinPlaceReach } from "./kinJoin.ts";
import { KIN_MONEY_SUMMARY } from "./kinMoneyStream.ts";
import { kinDestinations, type KinDestination, type KinPlacesRefused } from "./kinNavigation.ts";
import { kinLiveOrPlain, type KinScreenTarget } from "./kinScreenReads.ts";
import {
  kinWorkFailuresOf,
  kinWorkHostClients,
  kinWorkRefused,
  kinWorkScreenState,
} from "./kinWork.ts";

export interface KinPlaces {
  readonly destinations: ReadonlyArray<KinDestination>;
  /** The host has said who this is (`kin.access.me`). */
  readonly answered: boolean;
}

const NONE: KinPlacesRefused = { money: false, clients: false, docs: false };
const idle = Atom.make(AsyncResult.initial<never, never>());
const refusedBy = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(result) && kinWorkFailuresOf(result.cause).some(kinWorkRefused);

/**
 * The destinations from what the host said of this viewer (`me`, null until it has); null from a
 * host older than `refused`, whose places each say for themselves.
 */
export function kinPlacesFromMe(input: {
  readonly me: KinAccessMeResult | null;
  readonly ownerLevel: boolean;
  readonly work: boolean;
}): KinPlaces | null {
  const { me } = input;
  if (me !== null && me.refused === undefined) return null;
  return {
    destinations: kinDestinations({
      work: input.work,
      ownerLevel: input.ownerLevel,
      refused: { ...NONE, ...me?.refused },
      reaches: kinPlaceReach(me),
    }),
    answered: me !== null,
  };
}

/**
 * The destinations this person has, for the nav, the palette, the shortcuts and the phone's dock:
 * from what the host's `kin.access.me` says it refuses. Only a host older than that answer is
 * asked through Work's, Money's and Docs' own streams; a newer one's stay shut outside the place.
 */
export function makeKinPlaces<R, ER>(input: {
  readonly kinClient: KinClient;
  readonly runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>;
  /** The app's own rule for whether this viewer runs the company here. */
  readonly ownerLevel: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
}) {
  const { kinClient, runtime } = input;
  const family = Atom.family((key: string) => {
    const [environmentId, orgId] = JSON.parse(key) as [EnvironmentId, KinOrgId];
    return Atom.make((get): KinPlaces => {
      const me = get(kinAccessMeAtom(runtime, environmentId));
      const ownerLevel = get(input.ownerLevel(environmentId));
      const allowed = get(kinClient.workRead.permissionStateAtom(environmentId));
      const fromMe = kinPlacesFromMe({ me, ownerLevel, work: allowed !== "refused" });
      if (fromMe !== null) return fromMe;
      // An older host: each place's own answer says whether it refuses this viewer.
      const live = get(
        allowed === "granted" ? kinClient.workLive({ environmentId, input: { orgId } }) : idle,
      );
      const work = kinWorkScreenState({ allowed, link: "connected", live });
      const ready = work._tag === "ready";
      // Money's line as the screens read it: its stream for the owner level, else a plain read.
      const where = kinLiveOrPlain(
        ownerLevel,
        get(kinClient.moneyStreamed({ environmentId, input: { orgId } })),
      );
      const moneyRefused =
        ready &&
        where !== "waiting" &&
        refusedBy(
          where === "live"
            ? get(
                kinClient.moneyLive({ environmentId, input: { orgId, parts: KIN_MONEY_SUMMARY } }),
              )
            : get(kinClient.workOwed({ environmentId, input: { orgId, upcomingRows: false } })),
        );
      const docsAllowed = get(kinClient.docsList.permissionStateAtom(environmentId));
      const docs = get(
        docsAllowed === "granted" ? kinClient.docsLive({ environmentId, input: { orgId } }) : idle,
      );
      const destinations = kinDestinations({
        work: work._tag !== "refused",
        ownerLevel,
        refused: {
          money: moneyRefused,
          // Only an answer from an older host takes Clients away, never one still on its way.
          clients: ready && !kinWorkHostClients(work.live.summary),
          docs: docsAllowed === "refused" || refusedBy(docs),
        },
        reaches: kinPlaceReach(me),
      });
      return { destinations, answered: true };
    }).pipe(Atom.withLabel(`kin:places:${environmentId}`));
  });
  return (target: KinScreenTarget) => family(JSON.stringify([target.environmentId, target.orgId]));
}
