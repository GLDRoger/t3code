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
  KIN_APPROVAL_WS_METHODS,
  KIN_CHAT_WS_METHODS,
  KIN_PEOPLE_WS_METHODS,
  KIN_PUSH_WS_METHODS,
  KinOrgsListResult,
  type EnvironmentId,
  type KinApprovalsActionInput,
  type KinApprovalsOrgInput,
  type KinChatHistoryInput,
  type KinChatMembersInput,
  type KinPeopleListInput,
  type KinChatId,
  type KinChatsSubscribeInput,
  type KinLeadAccessInput,
  type KinLeadsListInput,
  type KinOrgsListInput,
  type KinPushWatchInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { syncKinCacheIdentity, withKinCache, withKinCacheStream } from "./kinCache";
import { syncKinOwnerTimeZone } from "./kinTimeZone";
import {
  KIN_CHAT_LABEL,
  KIN_INBOX_LABEL,
  kinInboxStream,
  onKinDirectChatsChange,
  makeKinChatStream,
  retryKinProbe,
  type KinSynced,
} from "@t3tools/client-runtime/kin/kinStreams";
import type { KinChatState } from "@t3tools/client-runtime/kin/kinInboxModel";

export type { KinSynced } from "@t3tools/client-runtime/kin/kinStreams";

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
const approvalRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:approval:read",
  tag: KIN_APPROVAL_WS_METHODS.get,
});
const readApproval = guardedRead(approvalRead);
const approverKeysRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:approver-keys:read",
  tag: KIN_APPROVAL_WS_METHODS.listKeys,
});
const readApproverKeys = guardedRead(approverKeysRead);
const leadsRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:leads:read",
  tag: "kin.leads.list",
});
const readLeads = guardedRead(leadsRead);
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

/** A dropped connection can leave a read pending; "Load earlier" fails after this and offers Retry. */
export const KIN_HISTORY_PAGE_TIMEOUT = Duration.seconds(20);

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

/** Who is in a chat, by name: a group's authors, mentions and details. */
const chatMembers = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "kin:chat-members",
  execute: Effect.fn("KinClient.chatMembers")(function* (input: KinChatMembersInput) {
    return yield* readMembers(input);
  }),
  staleTimeMs: 30_000,
  refreshTrigger: sessionGeneration,
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
  execute: Effect.fn("KinClient.leads")(function* (input: KinLeadsListInput) {
    return yield* readLeads(input);
  }),
  staleTimeMs: 15_000,
  refreshTrigger: sessionGeneration,
});
/** Being let message a lead, or losing that, changes what `kin.leads.list` answers. */
const rereadLeadsOnChange = onKinDirectChatsChange((environmentId, orgIds) => {
  for (const orgId of orgIds) appAtomRegistry.refresh(leads({ environmentId, input: { orgId } }));
});

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
      syncKinOwnerTimeZone(
        appAtomRegistry,
        environmentId,
        result.me.map((me) => me.orgId),
      );
      return result;
    }),
    staleTimeMs: 60_000,
    // A failed probe reruns when the next session comes up, not only after the stale time.
    refreshTrigger: sessionGeneration,
  }),
  /** Chat list plus Waiting on you. Reconnecting replaces it with the host's fresh snapshot. */
  inbox: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: KIN_INBOX_LABEL,
    subscribe: (input: KinChatsSubscribeInput) =>
      withKinCacheStream(kinInboxStream(input)).pipe(rereadLeadsOnChange),
  }),
  chat: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: KIN_CHAT_LABEL,
    subscribe: (input: { readonly chatId: KinChatId }) =>
      withKinCacheStream(chatStream(input)).pipe(rereadMembersOnChange(input.chatId)),
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
  /** Owner-only Stop on a lead's current wake-up, from its presence line. */
  leadInterrupt: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:interrupt",
    tag: "kin.lead.interrupt",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.wakeupId },
  }),
  leads,
  leadCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:create",
    tag: "kin.lead.create",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.name}|${input.domain}` },
  }),
  leadUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:update",
    tag: "kin.lead.update",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
  }),
  /** Who besides the owner may message one of the owner's leads. */
  leadAccess: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:lead-access",
    execute: Effect.fn("KinClient.leadAccess")(function* (input: KinLeadAccessInput) {
      return yield* readLeadAccess(input);
    }),
    staleTimeMs: 15_000,
    refreshTrigger: sessionGeneration,
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
    execute: Effect.fn("KinClient.people")(function* (input: KinPeopleListInput) {
      return yield* readPeople(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: sessionGeneration,
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
  /** Mutes or unmutes this chat's pushes for the viewer; one in flight per chat. */
  mute: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:mute",
    tag: KIN_CHAT_WS_METHODS.chatsMute,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
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
  /** Toggles the viewer's reaction; one in flight per message and emoji. */
  react: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:react",
    tag: KIN_CHAT_WS_METHODS.messagesReact,
    concurrency: {
      mode: "singleFlight",
      key: ({ input }) => `${input.messageId}|${input.emoji}`,
    },
  }),
  /** Owner-only Undo of one line on a memory change card. */
  memoryUndo: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:memory:undo",
    tag: "kin.memory.undo",
    concurrency: {
      mode: "singleFlight",
      key: ({ input }) => `${input.widgetId}:${input.itemId}`,
    },
  }),
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
  /** The org's approver keys; this phone finds its own by the thumbprint it saved. */
  approverKeys: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:approver-keys",
    execute: Effect.fn("KinClient.approverKeys")(function* (input: KinApprovalsOrgInput) {
      return yield* readApproverKeys(input);
    }),
    staleTimeMs: 10_000,
  }),
  approverKeysRead,
  approvalChallenge: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:approval:challenge",
    tag: KIN_APPROVAL_WS_METHODS.challenge,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.actionId },
  }),
  submitGrant: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:approval:submit",
    tag: KIN_APPROVAL_WS_METHODS.submitGrant,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.compact },
  }),
  declineAction: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:approval:decline",
    tag: KIN_APPROVAL_WS_METHODS.reject,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.actionId },
  }),
  keyChallenge: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:approver-key:challenge",
    tag: KIN_APPROVAL_WS_METHODS.keyChallenge,
  }),
  registerKey: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:approver-key:register",
    tag: KIN_APPROVAL_WS_METHODS.registerKey,
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
