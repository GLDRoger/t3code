import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
  environmentSessionGenerationAtom,
} from "@t3tools/client-runtime/state/runtime";
import { persistQuery } from "@t3tools/client-runtime/state/query-persistence";
import { watchKinChatForPush } from "@t3tools/client-runtime/kin-push";
import {
  KIN_CHAT_WS_METHODS,
  KIN_PUSH_WS_METHODS,
  KinOrgsListResult,
  type EnvironmentId,
  type KinOrgsListInput,
  type KinPushWatchInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { syncKinCacheIdentity, withKinCache } from "./kinCache";
import {
  KIN_CHAT_LABEL,
  KIN_INBOX_LABEL,
  kinInboxStream,
  makeKinChatStream,
  retryKinProbe,
} from "./kinStreams";

export type { KinSynced } from "./kinStreams";

const currentEnvironmentId = EnvironmentSupervisor.EnvironmentSupervisor.pipe(
  Effect.map((supervisor) => supervisor.target.environmentId),
);

// Kin reads are client-guarded too, so they go through the command's scope check.
const orgsRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:orgs:read",
  tag: KIN_CHAT_WS_METHODS.orgsList,
});
const historyRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:history:read",
  tag: KIN_CHAT_WS_METHODS.chatHistory,
});
const sessionGeneration = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
  environmentSessionGenerationAtom(connectionAtomRuntime, environmentId);

function guardedRead<Input, A, E>(command: {
  readonly run: (
    registry: AtomRegistry.AtomRegistry,
    target: { readonly environmentId: EnvironmentId; readonly input: Input },
  ) => Promise<AsyncResult.AsyncResult<A, E>>;
}) {
  return (input: Input) =>
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry;
      const environmentId = yield* currentEnvironmentId;
      const result = yield* Effect.promise(() => command.run(registry, { environmentId, input }));
      return yield* result._tag === "Success"
        ? Effect.succeed(result.value)
        : result._tag === "Failure"
          ? Effect.failCause(result.cause)
          : Effect.never;
    });
}

const readOrgs = guardedRead(orgsRead);

// Hosts that answered `kin.orgs.list` this run, plus the saved host. Their `unavailable` is an
// outage to wait out; `disabled` is how a host says Kin is off.
const knownKinHosts = new Set<EnvironmentId>();
export const markKinHostKnown = (environmentId: EnvironmentId) => {
  knownKinHosts.add(environmentId);
};
const readHistory = guardedRead(historyRead);

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

export const kinClient = {
  /** Orgs, their agents, and the viewer's person per org. An empty `me` means no identity. */
  orgs: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:orgs",
    execute: Effect.fn("KinClient.orgs")(function* (input: KinOrgsListInput) {
      const environmentId = yield* currentEnvironmentId;
      const result = yield* retryKinProbe(readOrgs(input), () => knownKinHosts.has(environmentId));
      markKinHostKnown(environmentId);
      yield* syncKinCacheIdentity(environmentId, result.me[0]?.personId ?? null);
      yield* withKinCache(orgsCache.save(environmentId, ORGS_CACHE_KEY, result));
      appAtomRegistry.refresh(kinCachedOrgsAtom(environmentId));
      return result;
    }),
    staleTimeMs: 60_000,
    // A failed probe reruns when the next session comes up, not only after the stale time.
    refreshTrigger: sessionGeneration,
  }),
  /** Chat list plus Waiting on you. Reconnecting replaces it with the host's fresh snapshot. */
  inbox: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: KIN_INBOX_LABEL,
    subscribe: kinInboxStream,
  }),
  chat: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: KIN_CHAT_LABEL,
    subscribe: makeKinChatStream((input) =>
      readHistory(input).pipe(Effect.provideService(AtomRegistry.AtomRegistry, appAtomRegistry)),
    ),
  }),
  history: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:history",
    execute: readHistory,
    staleTimeMs: Number.POSITIVE_INFINITY,
  }),
  createDirect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:create-direct",
    tag: KIN_CHAT_WS_METHODS.chatsCreateDirect,
  }),
  send: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:send",
    tag: KIN_CHAT_WS_METHODS.messagesSend,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientMessageId },
  }),
  markRead: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:mark-read",
    tag: KIN_CHAT_WS_METHODS.messagesMarkRead,
  }),
  widgetAction: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:widget-action",
    tag: KIN_CHAT_WS_METHODS.widgetsAct,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientActionId },
  }),
  registerPush: createEnvironmentRpcCommand(connectionAtomRuntime, {
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
