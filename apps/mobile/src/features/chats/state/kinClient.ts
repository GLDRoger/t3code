import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
  environmentSessionGenerationAtom,
} from "@t3tools/client-runtime/state/runtime";
import { KIN_CHAT_WS_METHODS, type EnvironmentId, type KinOrgsListInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { syncKinCacheIdentity } from "./kinCache";
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
// outage to wait out, not a sign Kin is absent.
const knownKinHosts = new Set<EnvironmentId>();
export const markKinHostKnown = (environmentId: EnvironmentId) => {
  knownKinHosts.add(environmentId);
};
const readHistory = guardedRead(historyRead);

export const kinClient = {
  /** Orgs, their agents, and the viewer's person per org. An empty `me` means no identity. */
  orgs: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:orgs",
    execute: Effect.fn("KinClient.orgs")(function* (input: KinOrgsListInput) {
      const environmentId = yield* currentEnvironmentId;
      const result = yield* retryKinProbe(readOrgs(input), () => knownKinHosts.has(environmentId));
      markKinHostKnown(environmentId);
      yield* syncKinCacheIdentity(environmentId, result.me[0]?.personId ?? null);
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
};
