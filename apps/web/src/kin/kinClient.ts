import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  KIN_CHAT_LABEL,
  KIN_INBOX_LABEL,
  kinInboxStream,
  makeKinChatStream,
  onKinDirectChatsChange,
  retryKinProbe,
  type KinSynced,
} from "@t3tools/client-runtime/kin/kinStreams";
import type { KinChatState } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
  environmentSessionGenerationAtom,
} from "@t3tools/client-runtime/state/runtime";
import {
  KIN_CHAT_WS_METHODS,
  KIN_PEOPLE_WS_METHODS,
  type EnvironmentId,
  type KinChatHistoryInput,
  type KinChatId,
  type KinChatMembersInput,
  type KinMemoryListInput,
  type KinPeopleListInput,
  type KinLeadAccessInput,
  type KinLeadsListInput,
  type KinOrgsListInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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

const leadsRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:leads:read",
  tag: "kin.leads.list",
});

const leadAccessRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:lead-access:read",
  tag: "kin.lead.access.list",
});
const readLeadAccess = guardedRead(leadAccessRead);

const membersRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:chat-members:read",
  tag: KIN_CHAT_WS_METHODS.chatMembers,
});
const readMembers = guardedRead(membersRead);
const peopleRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:people:read",
  tag: KIN_PEOPLE_WS_METHODS.peopleList,
});
const readPeople = guardedRead(peopleRead);

const memoryRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:memory:read",
  tag: "kin.memory.list",
});
const readMemory = guardedRead(memoryRead);

const readOrgs = guardedRead(orgsRead);
const readLeads = guardedRead(leadsRead);
const readHistory = guardedRead(historyRead);

// Hosts that answered `kin.orgs.list` this run: their `unavailable` is an outage to wait out.
const knownKinHosts = new Set<EnvironmentId>();

/** A dropped connection can leave a read pending; "Load earlier" fails after this and offers Retry. */
const KIN_HISTORY_PAGE_TIMEOUT = Duration.seconds(20);

/** Who is in a chat, by name: a group's authors, mentions and details. */
const chatMembers = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "kin:chat-members",
  execute: Effect.fn("KinWebClient.chatMembers")(function* (input: KinChatMembersInput) {
    return yield* readMembers(input);
  }),
  staleTimeMs: 30_000,
  refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
});

/** Reads a chat's members again whenever its stream says who is in it, its name or lead changed. */
const rereadMembersOnChange =
  (chatId: KinChatId) =>
  <E, R>(stream: Stream.Stream<KinSynced<KinChatState>, E, R>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const environmentId = yield* currentEnvironmentId;
        let seen = 0;
        return stream.pipe(
          Stream.tap((view) =>
            Effect.sync(() => {
              if (view.value.memberChanges === seen) return;
              seen = view.value.memberChanges;
              appAtomRegistry.refresh(chatMembers({ environmentId, input: { chatId } }));
            }),
          ),
        );
      }),
    );

const chatStream = makeKinChatStream((input) =>
  readHistory(input).pipe(Effect.provideService(AtomRegistry.AtomRegistry, appAtomRegistry)),
);

/** The viewer's own leads, and the leads of others they may message. */
const leads = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "kin:leads",
  execute: Effect.fn("KinWebClient.leads")(function* (input: KinLeadsListInput) {
    return yield* readLeads(input);
  }),
  staleTimeMs: 30_000,
  refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
});

/** Being let message a lead, or losing that, changes what `kin.leads.list` answers. */
const rereadLeadsOnChange = onKinDirectChatsChange((environmentId, orgIds) => {
  for (const orgId of orgIds) appAtomRegistry.refresh(leads({ environmentId, input: { orgId } }));
});

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
  leads,
  leadCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:create",
    tag: "kin.lead.create",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.name}` },
  }),
  leadUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:update",
    tag: "kin.lead.update",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
  }),
  /** Who besides the owner may message one of the owner's leads. */
  leadAccess: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:lead-access",
    execute: Effect.fn("KinWebClient.leadAccess")(function* (input: KinLeadAccessInput) {
      return yield* readLeadAccess(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  leadAllow: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:lead-access:allow",
    tag: "kin.lead.access.grant",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.agentId}:${input.personId}` },
  }),
  leadDisallow: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:lead-access:disallow",
    tag: "kin.lead.access.revoke",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.agentId}:${input.personId}` },
  }),
  chatMembers,
  /** The people of the org, for choosing who joins a group or may message a lead. */
  people: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:people",
    execute: Effect.fn("KinWebClient.people")(function* (input: KinPeopleListInput) {
      return yield* readPeople(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  groupCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:group:create",
    tag: "kin.groups.create",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.title}` },
  }),
  groupAddMember: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:group:add-member",
    tag: "kin.groups.addMember",
  }),
  groupRemoveMember: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:group:remove-member",
    tag: "kin.groups.removeMember",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.memberId },
  }),
  groupSetLead: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:group:set-lead",
    tag: "kin.groups.setLead",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
  }),
  groupRename: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:group:rename",
    tag: "kin.groups.rename",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
  }),
  groupDelete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:group:delete",
    tag: "kin.groups.delete",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
  }),
  mute: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:mute",
    tag: KIN_CHAT_WS_METHODS.chatsMute,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
  }),
  /** Empties this chat for everyone in it, for good; one in flight per chat. */
  clear: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:clear",
    tag: KIN_CHAT_WS_METHODS.chatsClear,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
  }),
  inbox: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: KIN_INBOX_LABEL,
    subscribe: (input: Parameters<typeof kinInboxStream>[0]) =>
      kinInboxStream(input).pipe(rereadLeadsOnChange),
  }),
  chat: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: KIN_CHAT_LABEL,
    subscribe: (input: { readonly chatId: KinChatId }) =>
      chatStream(input).pipe(rereadMembersOnChange(input.chatId)),
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
  /** What the owner's leads remember, and who may know each thing. */
  memory: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:memory",
    execute: Effect.fn("KinWebClient.memory")(function* (input: KinMemoryListInput) {
      return yield* readMemory(input);
    }),
    staleTimeMs: 60_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  memorySetVisibility: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:memory:set-visibility",
    tag: "kin.memory.setVisibility",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.itemId },
  }),
  memoryConfirm: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:memory:confirm",
    tag: "kin.memory.confirmSuggestions",
  }),
};
