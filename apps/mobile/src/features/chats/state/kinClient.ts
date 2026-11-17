import { kinGuardedRead, makeKinClient } from "@t3tools/client-runtime/kin/kinClient";
import { makeKinScreenReads } from "@t3tools/client-runtime/kin/kinScreenReads";
import { createKinRpcCommand } from "@t3tools/client-runtime/kin/kinAccess";
import { watchKinChatForPush } from "@t3tools/client-runtime/kin-push";
import { persistQuery } from "@t3tools/client-runtime/state/query-persistence";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  KIN_APPROVAL_WS_METHODS,
  KIN_PUSH_WS_METHODS,
  KinOrgsListResult,
  type EnvironmentId,
  type KinApprovalsActionInput,
  type KinPushWatchInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { syncKinCacheIdentity, withKinCache, withKinCacheStream } from "./kinCache";

export type { KinSynced } from "@t3tools/client-runtime/kin/kinStreams";

// Saved with the chats it names, and cleared with them when the identity changes.
const orgsCache = persistQuery(KinOrgsListResult);
const ORGS_CACHE_KEY = "orgs";

/** The directory from a host's last `kin.orgs.list` answer, for reading its cache offline. */
export const kinCachedOrgsAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(
      Effect.gen(function* () {
        const cached = yield* withKinCache(orgsCache.load(environmentId, ORGS_CACHE_KEY));
        return Option.getOrNull(cached);
      }),
    )
    .pipe(Atom.withLabel(`kin:orgs-cache:${environmentId}`)),
);

/** The shared Kin client, with this phone's device cache for the directory, chat list and chats. */
const kin = makeKinClient(connectionAtomRuntime, appAtomRegistry, {
  cacheStream: withKinCacheStream,
  onOrgs: Effect.fn("KinCache.saveDirectory")(function* (
    environmentId: EnvironmentId,
    result: KinOrgsListResult,
  ) {
    yield* syncKinCacheIdentity(environmentId, result.me[0]?.personId ?? null);
    yield* withKinCache(orgsCache.save(environmentId, ORGS_CACHE_KEY, result));
    appAtomRegistry.refresh(kinCachedOrgsAtom(environmentId));
  }),
  choicesFollowTasks: true,
});

export const markKinHostKnown = kin.markKinHostKnown;
export const retryKinWorkLive = kin.retryKinWorkLive;
export const refreshKinAgents = kin.refreshKinAgents;

const approvalRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:approval:read",
  tag: KIN_APPROVAL_WS_METHODS.get,
});
const readApproval = kinGuardedRead(approvalRead);

/** Approving with Face ID and push are the phone's own; the rest is the shared client. */
export const kinClient = {
  ...kin.kinClient,
  /**
   * One pending action as this viewer may see it. `revision` is the card's own, only a cache key:
   * a redrawn card reads the action again.
   */
  approval: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:approval",
    execute: Effect.fn("KinClient.approval")(function* (
      input: KinApprovalsActionInput & { readonly revision: number },
    ) {
      return yield* readApproval({ actionId: input.actionId });
    }),
    staleTimeMs: 5_000,
  }),
  approvalRead,
  approvalChallenge: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:approval:challenge",
    tag: KIN_APPROVAL_WS_METHODS.challenge,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.actionId },
  }),
  submitGrant: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:approval:submit",
    tag: KIN_APPROVAL_WS_METHODS.submitGrant,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.compact },
  }),
  declineAction: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:approval:decline",
    tag: KIN_APPROVAL_WS_METHODS.reject,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.actionId },
  }),
  keyChallenge: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:approver-key:challenge",
    tag: KIN_APPROVAL_WS_METHODS.keyChallenge,
  }),
  registerKey: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:approver-key:register",
    tag: KIN_APPROVAL_WS_METHODS.registerKey,
  }),
  registerPush: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:register-push",
    tag: KIN_PUSH_WS_METHODS.registerDevice,
  }),
  /** Mounted while a chat is on screen: the host skips this device's pushes for it. */
  pushWatch: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "kin:push-watch",
    subscribe: ({ chatId }: KinPushWatchInput) => Stream.fromEffect(watchKinChatForPush(chatId)),
    idleTtlMs: 0,
  }),
};

/** Which atom each data hook reads, and what a change reads again. */
export const kinReads = makeKinScreenReads(kin.kinClient, appAtomRegistry);
