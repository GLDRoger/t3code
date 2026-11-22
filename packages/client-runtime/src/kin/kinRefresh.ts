import type {
  EnvironmentId,
  KIN_STREAMS,
  KinOrgId,
  KinRefreshes,
  KinRefreshesSubscribeInput,
  KinRefreshTopic,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
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

/** A topic's last revision heard, in which run of the host, and how often it has moved since. */
interface KinRefreshMoves {
  readonly revision: number;
  readonly moves: number;
  readonly boot: string | undefined;
}

/**
 * Takes in a revision. The first one is where things stand, not a change; an unknown one (still
 * connecting, an older host, a topic the viewer can't read) changes nothing. A new run of the host
 * counts from zero again, so a revision heard in it moves whatever it reads.
 */
function kinRefreshMoved(
  held: KinRefreshMoves | undefined,
  revision: number | undefined,
  boot: string | undefined,
): KinRefreshMoves | undefined {
  if (revision === undefined) return held;
  if (held === undefined) return { revision, moves: 0, boot };
  if (held.boot !== boot) return { revision, moves: held.moves + 1, boot };
  return revision === held.revision ? held : { revision, moves: held.moves + 1, boot };
}

type Target = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly orgId: KinOrgId };
};

/**
 * Refresh signals for query atoms' `refreshTrigger`: a move of the read's topic. A host that names
 * its run (`boot`) resumes across a reconnect, so a new session alone moves nothing; an older one's
 * reads still follow each new session. What each signal has heard is kept outside its node, so a
 * read shown again after its screen was away still sees a move it missed.
 */
export function kinRefreshTriggers(
  revisions: (target: Target) => Atom.Atom<AsyncResult.AsyncResult<KinRefreshes, unknown>>,
  generation: (environmentId: EnvironmentId) => Atom.Atom<number>,
) {
  const heard = new Map<string, KinRefreshMoves>();
  /** Hosts that named their run: their reads resume across reconnects. Read only on a new session. */
  const resuming = new Set<EnvironmentId>();
  const parse = (key: string) => JSON.parse(key) as [EnvironmentId, KinOrgId, KinRefreshTopic];
  const moves = Atom.family((key: string) => {
    const [environmentId, orgId, topic] = parse(key);
    return Atom.make((get) => {
      const held = AsyncResult.getOrElse(
        get(revisions({ environmentId, input: { orgId } })),
        () => null,
      );
      if (held?.boot !== undefined) resuming.add(environmentId);
      const moved = kinRefreshMoved(heard.get(key), held?.[topic], held?.boot);
      if (moved !== undefined) heard.set(key, moved);
      return moved?.moves ?? 0;
    }).pipe(Atom.withLabel(`${KIN_REFRESHES_LABEL}:${topic}:moves:${environmentId}`));
  });
  /** Sessions after the first on a host that can't resume; 0 on one that can. */
  const unresumed = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const sessions = get(generation(environmentId));
      return resuming.has(environmentId) ? 0 : Math.max(0, sessions - 1);
    }).pipe(Atom.withLabel(`${KIN_REFRESHES_LABEL}:unresumed:${environmentId}`)),
  );
  const family = Atom.family((key: string) => {
    const [environmentId, , topic] = parse(key);
    return Atom.make((get) => `${get(unresumed(environmentId))}:${get(moves(key))}`).pipe(
      Atom.withLabel(`${KIN_REFRESHES_LABEL}:${topic}:${environmentId}`),
    );
  });
  const said = new Map<string, boolean>();
  /**
   * Whether the host streams `name` (`KinRefreshes.streams`); null until it has said. A reconnect
   * keeps its last answer, so the reads that hang on it keep what they hold.
   */
  const serves = Atom.family((key: string) => {
    const [environmentId, orgId, name] = parse(key);
    return Atom.make((get) => {
      const result = get(revisions({ environmentId, input: { orgId } }));
      const failed = AsyncResult.isFailure(result);
      const held = failed ? null : AsyncResult.getOrElse(result, () => null);
      // No revisions ever read: the reads that follow moves are all there is.
      const answer =
        held !== null
          ? (held.streams ?? []).includes(name)
          : (said.get(key) ?? (failed ? false : null));
      if (answer !== null) said.set(key, answer);
      return answer;
    }).pipe(Atom.withLabel(`${KIN_REFRESHES_LABEL}:serves:${name}:${environmentId}`));
  });
  const keyOf = (topic: string, target: Target) =>
    JSON.stringify([target.environmentId, target.input.orgId, topic]);
  return Object.assign(
    (topic: KinRefreshTopic) => (target: Target) => family(keyOf(topic, target)),
    {
      /** How often a topic has moved since this client first heard it; for a read over several orgs. */
      moves: (topic: KinRefreshTopic) => (target: Target) => moves(keyOf(topic, target)),
      unresumed,
      serves: (name: (typeof KIN_STREAMS)[number]) => (target: Target) =>
        serves(keyOf(name, target)),
    },
  );
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

/** The orgs the directory (`kin.orgs.list`) last named per environment; see `kinDirectoryTrigger`. */
export const kinDirectoryOrgsAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<ReadonlyArray<KinOrgId>>([]).pipe(Atom.keepAlive),
);

/** Notes the orgs a directory answer named, leaving the atom alone when they are the same. */
export function noteKinDirectoryOrgs(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  orgIds: ReadonlyArray<KinOrgId>,
) {
  const atom = kinDirectoryOrgsAtom(environmentId);
  const unique = [...new Set(orgIds)];
  if (unique.join("\n") !== registry.get(atom).join("\n")) registry.set(atom, unique);
}

/**
 * A read across the directory's orgs: a move of `topic` in any org it last named, or a new session
 * on a host that can't resume,
 * so an agent made or a person renamed on another device has its name here. Orgs being noted move
 * nothing.
 */
export function createKinDirectoryTrigger<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  topic: KinRefreshTopic = "leads",
) {
  const triggers = createKinRefreshTriggers(runtime);
  return ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    Atom.make((get) => {
      let moved = 0;
      for (const orgId of get(kinDirectoryOrgsAtom(environmentId)))
        moved += get(triggers.moves(topic)({ environmentId, input: { orgId } }));
      return `${get(triggers.unresumed(environmentId))}:${moved}`;
    });
}

/**
 * Moves when what the viewer may see could have changed: a person's access, places or projects
 * (`people`) or whose agents they may reach (`leads`), in any org the directory named.
 */
export function kinAccessMoves<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  registry: AtomRegistry.AtomRegistry,
) {
  const triggers = createKinRefreshTriggers(runtime);
  return (environmentId: EnvironmentId) =>
    AtomRegistry.toStream(
      registry,
      Atom.make((get) => {
        let moved = 0;
        for (const orgId of get(kinDirectoryOrgsAtom(environmentId)))
          for (const topic of ["people", "leads"] as const)
            moved += get(triggers.moves(topic)({ environmentId, input: { orgId } }));
        return String(moved);
      }),
    );
}
