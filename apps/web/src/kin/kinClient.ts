import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  KIN_CHAT_LABEL,
  KIN_INBOX_LABEL,
  kinInboxStream,
  makeKinChatStream,
  retryKinProbe,
} from "@t3tools/client-runtime/kin/kinStreams";
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
import { AtomRegistry, type AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

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

// Hosts that answered `kin.orgs.list` this run: their `unavailable` is an outage to wait out.
const knownKinHosts = new Set<EnvironmentId>();

/** A dropped connection can leave a read pending; "Load earlier" fails after this and offers Retry. */
const KIN_HISTORY_PAGE_TIMEOUT = Duration.seconds(20);

const chatStream = makeKinChatStream((input) =>
  readHistory(input).pipe(Effect.provideService(AtomRegistry.AtomRegistry, appAtomRegistry)),
);

/** Web's Kin reads and commands. Mobile's twin adds the device cache and push. */
export const kinClient = {
  orgs: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:orgs",
    execute: Effect.fn("KinWebClient.orgs")(function* (input: KinOrgsListInput) {
      const environmentId = yield* currentEnvironmentId;
      const result = yield* retryKinProbe(readOrgs(input), () => knownKinHosts.has(environmentId));
      knownKinHosts.add(environmentId);
      return result;
    }),
    staleTimeMs: 60_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  inbox: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: KIN_INBOX_LABEL,
    subscribe: kinInboxStream,
  }),
  chat: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: KIN_CHAT_LABEL,
    subscribe: chatStream,
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
  send: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:send",
    tag: KIN_CHAT_WS_METHODS.messagesSend,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientMessageId },
  }),
  leadInterrupt: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:interrupt",
    tag: "kin.lead.interrupt",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.wakeupId },
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
  react: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:react",
    tag: KIN_CHAT_WS_METHODS.messagesReact,
    concurrency: {
      mode: "singleFlight",
      key: ({ input }) => `${input.messageId}|${input.emoji}`,
    },
  }),
  memoryUndo: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:memory:undo",
    tag: "kin.memory.undo",
    concurrency: {
      mode: "singleFlight",
      key: ({ input }) => `${input.widgetId}:${input.itemId}`,
    },
  }),
};
