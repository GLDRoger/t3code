import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
  environmentSessionGenerationAtom,
} from "@t3tools/client-runtime/state/runtime";
import {
  KIN_CHAT_WS_METHODS,
  type EnvironmentId,
  type KinChatHistoryInput,
  type KinOrgsListInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { syncKinCacheIdentity } from "./kinCache";
import { KIN_CHAT_LABEL, KIN_INBOX_LABEL, kinInboxStream, makeKinChatStream } from "./kinStreams";

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
const readHistory = guardedRead(historyRead);

/** A dropped connection can leave a read pending; "Load earlier" fails after this and offers Retry. */
export const KIN_HISTORY_PAGE_TIMEOUT = Duration.seconds(20);

export const kinClient = {
  /** Orgs, their agents, and the viewer's person per org. An empty `me` means no identity. */
  orgs: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:orgs",
    execute: (input: KinOrgsListInput) =>
      readOrgs(input).pipe(
        Effect.tap((result) =>
          currentEnvironmentId.pipe(
            Effect.flatMap((environmentId) =>
              syncKinCacheIdentity(environmentId, result.me[0]?.personId ?? null),
            ),
          ),
        ),
      ),
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
  /** One "Load earlier" page, read fresh every time so a retry after a failure refetches. */
  readHistoryPage: (environmentId: EnvironmentId, input: KinChatHistoryInput) =>
    Effect.runPromiseExit(
      Effect.promise(() => historyRead.run(appAtomRegistry, { environmentId, input })).pipe(
        Effect.flatMap((result) =>
          result._tag === "Success" ? Effect.succeed(result.value) : Effect.failCause(result.cause),
        ),
        Effect.timeout(KIN_HISTORY_PAGE_TIMEOUT),
      ),
    ),
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
