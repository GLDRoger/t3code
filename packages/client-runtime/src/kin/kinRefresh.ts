import type {
  EnvironmentId,
  KinOrgId,
  KinRefreshes,
  KinRefreshesSubscribeInput,
  KinRefreshTopic,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { subscribe } from "../rpc/index.ts";
import {
  createEnvironmentSubscriptionAtomFamily,
  environmentSessionGenerationAtom,
} from "../state/runtime.ts";
import { resubscribeWhenKinReturns, retryWhileKinUnavailable } from "./kinStreams.ts";

const KIN_REFRESHES_LABEL = "kin:refreshes";

/** The host's revisions for the Kin reads Work and Docs don't announce. Nothing is read here. */
const kinRefreshesStream = (input: KinRefreshesSubscribeInput) =>
  resubscribeWhenKinReturns(
    retryWhileKinUnavailable(subscribe("kin.refreshes.subscribe", input)),
    Stream.empty,
    Stream.empty,
  );

/** A topic's last revision heard, and how often it has moved since this client first heard it. */
interface KinRefreshMoves {
  readonly revision: number;
  readonly moves: number;
}

/**
 * Takes in a revision. The first one is where things stand, not a change; an unknown one (still
 * connecting, an older host, a topic the viewer can't read) changes nothing.
 */
function kinRefreshMoved(
  held: KinRefreshMoves | undefined,
  revision: number | undefined,
): KinRefreshMoves | undefined {
  if (revision === undefined) return held;
  if (held === undefined) return { revision, moves: 0 };
  return revision === held.revision ? held : { revision, moves: held.moves + 1 };
}

type Target = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly orgId: KinOrgId };
};

/**
 * Refresh signals for query atoms' `refreshTrigger`: a new session, or a move of the read's topic.
 * What each signal has heard is kept outside its node, so a read shown again after its screen was
 * away still sees a move it missed, as `refreshTrigger` reads expect.
 */
export function kinRefreshTriggers(
  revisions: (target: Target) => Atom.Atom<AsyncResult.AsyncResult<KinRefreshes, unknown>>,
  generation: (environmentId: EnvironmentId) => Atom.Atom<number>,
) {
  const heard = new Map<string, KinRefreshMoves>();
  const family = Atom.family((key: string) => {
    const [environmentId, orgId, topic] = JSON.parse(key) as [
      EnvironmentId,
      KinOrgId,
      KinRefreshTopic,
    ];
    return Atom.make((get) => {
      const session = get(generation(environmentId));
      const held = AsyncResult.getOrElse(
        get(revisions({ environmentId, input: { orgId } })),
        () => null,
      );
      const moved = kinRefreshMoved(heard.get(key), held?.[topic]);
      if (moved !== undefined) heard.set(key, moved);
      return `${session}:${moved?.moves ?? 0}`;
    }).pipe(Atom.withLabel(`${KIN_REFRESHES_LABEL}:${topic}:${environmentId}`));
  });
  return (topic: KinRefreshTopic) => (target: Target) =>
    family(JSON.stringify([target.environmentId, target.input.orgId, topic]));
}

const triggersByRuntime = new WeakMap<object, ReturnType<typeof kinRefreshTriggers>>();

/** One `kin.refreshes.subscribe` per environment and org on a runtime, shared by every read. */
export function createKinRefreshTriggers<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  const existing = triggersByRuntime.get(runtime);
  if (existing !== undefined) return existing;
  const revisions = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: KIN_REFRESHES_LABEL,
    subscribe: kinRefreshesStream,
  });
  const triggers = kinRefreshTriggers(revisions, (environmentId) =>
    environmentSessionGenerationAtom(runtime, environmentId),
  );
  triggersByRuntime.set(runtime, triggers);
  return triggers;
}
