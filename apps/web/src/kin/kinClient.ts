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
import { KIN_DOCS_LABEL, kinDocsLiveStream } from "@t3tools/client-runtime/kin/kinDocsStream";
import { KIN_WORK_LABEL, kinWorkLiveStream } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinChatState } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
  environmentSessionGenerationAtom,
} from "@t3tools/client-runtime/state/runtime";
import {
  KIN_APPROVAL_WS_METHODS,
  KIN_CHAT_WS_METHODS,
  KIN_PEOPLE_WS_METHODS,
  type EnvironmentId,
  type KinApprovalsOrgInput,
  type KinChatHistoryInput,
  type KinChatId,
  type KinChatMembersInput,
  type KinCompanyProfileInput,
  type KinReceiptsInput,
  type KinRecipesInput,
  type KinListsInput,
  type KinMoneySummaryInput,
  type KinDocDiffInput,
  type KinDocGetInput,
  type KinDocsListInput,
  type KinDocsSubscribeInput,
  type KinMemoryListInput,
  type KinPeopleListInput,
  type KinLeadAccessInput,
  type KinLeadsListInput,
  type KinOrgsListInput,
  type KinOwnerTimeZoneGetInput,
  type KinOrgId,
  type KinPartyPageInput,
  type KinVisualHostsInput,
  type KinProjectPageInput,
  type KinWorkGetInput,
  type KinWorkSubscribeInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

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

const approverKeysRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:approver-keys:read",
  tag: KIN_APPROVAL_WS_METHODS.listKeys,
});
const readApproverKeys = guardedRead(approverKeysRead);

const leadsRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:leads:read",
  tag: "kin.leads.list",
});

const leadAccessRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:lead-access:read",
  tag: "kin.lead.access.list",
});
const readLeadAccess = guardedRead(leadAccessRead);

const visualHostsRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:visual-hosts:read",
  tag: "kin.visuals.hosts.list",
});
const readVisualHosts = guardedRead(visualHostsRead);

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
const invitesRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:invites:read",
  tag: KIN_PEOPLE_WS_METHODS.peopleListInvites,
});
const readInvites = guardedRead(invitesRead);

const memoryRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:memory:read",
  tag: "kin.memory.list",
});
const readMemory = guardedRead(memoryRead);

const workSummaryRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:summary:read",
  tag: "kin.work.summary",
});
const readWorkSummary = guardedRead(workSummaryRead);
const workListRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:list:read",
  tag: "kin.work.list",
});
const workItemRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:item:read",
  tag: "kin.work.get",
});
const readWorkItem = guardedRead(workItemRead);
const workZoneRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:zone:read",
  tag: "kin.triggers.getTimeZone",
});
const readWorkZone = guardedRead(workZoneRead);
const workClientsRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:clients:read",
  tag: "kin.work.parties",
});
const readWorkClients = guardedRead(workClientsRead);
const workClientRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:client:read",
  tag: "kin.work.party",
});
const readWorkClient = guardedRead(workClientRead);
const workProjectsRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:projects:read",
  tag: "kin.work.projects",
});
const readWorkProjects = guardedRead(workProjectsRead);
const workProjectRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:project:read",
  tag: "kin.work.project",
});
const readWorkProject = guardedRead(workProjectRead);
const workHistoryRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:history:read",
  tag: "kin.work.history",
});

const workListsRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:lists:read",
  tag: "kin.work.lists",
});
const readWorkLists = guardedRead(workListsRead);
const workMoneyRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:money:read",
  tag: "kin.work.money",
});
const readWorkMoney = guardedRead(workMoneyRead);
const workDatesRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:dates:read",
  tag: "kin.work.dates",
});
const companyProfileRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:company:read",
  tag: "kin.work.companyProfile",
});
const readCompanyProfile = guardedRead(companyProfileRead);
const receiptsRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:receipts:read",
  tag: "kin.work.receipts",
});
const readReceipts = guardedRead(receiptsRead);
const recipesRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:docs:recipes:read",
  tag: "kin.docs.recipes",
});
const readRecipes = guardedRead(recipesRead);

/** Work's change number and counts, kept current by the host's own announcements. */
const workLive = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: KIN_WORK_LABEL,
  subscribe: (input: KinWorkSubscribeInput) =>
    kinWorkLiveStream(input, (summaryInput) =>
      readWorkSummary(summaryInput).pipe(
        Effect.provideService(AtomRegistry.AtomRegistry, appAtomRegistry),
      ),
    ),
});

const workFilesRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:work:files:read",
  tag: "kin.work.files",
});
const docsListRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:docs:list:read",
  tag: "kin.docs.list",
});
const readDocsList = guardedRead(docsListRead);
const docRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:docs:doc:read",
  tag: "kin.docs.get",
});
const readDoc = guardedRead(docRead);
const docDiffRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:docs:diff:read",
  tag: "kin.docs.diff",
});
const readDocDiff = guardedRead(docDiffRead);

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

/** The same list with the owner's retired agents after the live ones. Only the owner asks. */
const withRetired = (orgId: KinOrgId): KinLeadsListInput => ({ orgId, includeRetired: true });

/** Both lead lists are read again: the one pickers use, and the owner's with retired agents. */
const refreshLeads = (environmentId: EnvironmentId, orgId: KinOrgId) => {
  appAtomRegistry.refresh(leads({ environmentId, input: { orgId } }));
  appAtomRegistry.refresh(leads({ environmentId, input: withRetired(orgId) }));
};

/** Being let message a lead, or losing that, changes what `kin.leads.list` answers. */
const rereadLeadsOnChange = onKinDirectChatsChange((environmentId, orgIds) => {
  for (const orgId of orgIds) refreshLeads(environmentId, orgId);
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
  /** The phones that can approve, and the latest changes to them. */
  approverKeys: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:approver-keys",
    execute: Effect.fn("KinWebClient.approverKeys")(function* (input: KinApprovalsOrgInput) {
      return yield* readApproverKeys(input);
    }),
    staleTimeMs: 10_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  approverKeyRevoke: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:approver-key:revoke",
    tag: KIN_APPROVAL_WS_METHODS.revokeKey,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.thumbprint },
  }),
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
  /** The owner's agents with the retired ones last. Read only where `leadRetire` is permitted. */
  agents: (target: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) =>
    leads({ environmentId: target.environmentId, input: withRetired(target.orgId) }),
  /** Stops the agent's work and holds its timers; its chats, memory and tasks stay. */
  leadRetire: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:retire",
    tag: "kin.lead.retire",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
  }),
  leadRestore: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:restore",
    tag: "kin.lead.restore",
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
  /** The outside hosts the owner lets visuals load from. Owner only. */
  visualHosts: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:visual-hosts",
    execute: Effect.fn("KinWebClient.visualHosts")(function* (input: KinVisualHostsInput) {
      return yield* readVisualHosts(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  visualHostAllow: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:visual-hosts:allow",
    tag: "kin.visuals.hosts.allow",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.host}` },
  }),
  visualHostRemove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:visual-hosts:remove",
    tag: "kin.visuals.hosts.remove",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.host}` },
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
  /** The invite links nobody has opened yet. The owner's Team page reads them. */
  invites: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:invites",
    execute: Effect.fn("KinWebClient.invites")(function* (input: KinPeopleListInput) {
      return yield* readInvites(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** Makes a teammate's link. The answer carries the secret once; nothing here keeps it. */
  inviteCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:invite:create",
    tag: KIN_PEOPLE_WS_METHODS.peopleCreateInvite,
  }),
  inviteCancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:invite:cancel",
    tag: KIN_PEOPLE_WS_METHODS.peopleRevokeInvite,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.inviteId },
  }),
  personRemoveAccess: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:person:remove-access",
    tag: KIN_PEOPLE_WS_METHODS.peopleRemoveAccess,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
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
  /** What a clear would leave, asked when its confirm opens; changes nothing. */
  clearPreview: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:clear-preview",
    tag: KIN_CHAT_WS_METHODS.chatsClear,
    concurrency: { mode: "singleFlight", key: ({ input }) => `preview:${input.chatId}` },
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
  /** A locked statement's password, once and redacted; never a message the lead reads. */
  statementUnlock: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:unlock",
    tag: "kin.work.statementUnlock",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
  }),
  statementForgetPassword: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:forget-password",
    tag: "kin.work.statementForgetPassword",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
  }),
  /** One tap on a review card, in order: the server keeps the selection Confirm applies. */
  statementSelect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:select",
    tag: "kin.work.statementSelect",
    concurrency: { mode: "serial", key: ({ input }) => input.statementId },
  }),
  /** More of a section's rows than the card carries. */
  statementRows: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:rows",
    tag: "kin.work.statementRows",
    concurrency: {
      mode: "singleFlight",
      key: ({ input }) => `${input.statementId}:${input.section}:${input.offset}`,
    },
  }),
  /** Applies the selection the server keeps for this review, at the revision the owner saw. */
  statementApply: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:apply",
    tag: "kin.work.statementApply",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
  }),
  statementUndo: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:undo",
    tag: "kin.work.statementUndo",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
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
  memoryForget: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:memory:forget",
    tag: "kin.memory.forget",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.itemId },
  }),
  workLive,
  /** Its `permissionAtom` says whether this browser may read Work at all. */
  workRead: workSummaryRead,
  /** One page of a filter; the list's controller decides when. */
  workList: workListRead,
  /** One task with its links and history. */
  workItem: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:item",
    execute: Effect.fn("KinWebClient.workItem")(function* (input: KinWorkGetInput) {
      return yield* readWorkItem(input);
    }),
    staleTimeMs: 30_000,
    // Read again on reconnecting; between those, the screen's watch reads only when this task changed.
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** Where the owner's days begin and end, so an all-day due date reads as the day it was set. */
  workZone: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:zone",
    execute: Effect.fn("KinWebClient.workZone")(function* (input: KinOwnerTimeZoneGetInput) {
      return yield* readWorkZone(input);
    }),
    staleTimeMs: 5 * 60_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** One page of the clients list, or of the projects list; each list's controller decides when. */
  workClients: workClientsRead,
  workProjects: workProjectsRead,
  /** A page of a client's or project's history. */
  workHistory: workHistoryRead,
  /** A client with what is owed each way, its contacts and its projects. */
  workClient: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:client",
    execute: Effect.fn("KinWebClient.workClient")(function* (input: KinPartyPageInput) {
      return yield* readWorkClient(input);
    }),
    staleTimeMs: 30_000,
    // Read again on reconnecting; between those, the page's watch reads only when it is behind.
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** A project with its health, what is blocked and what changed this week. */
  workProject: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:project",
    execute: Effect.fn("KinWebClient.workProject")(function* (input: KinProjectPageInput) {
      return yield* readWorkProject(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** The active clients and open projects a task or a project can be put under, by name. */
  workChoices: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:choices",
    execute: Effect.fn("KinWebClient.workChoices")(function* (input: { readonly orgId: KinOrgId }) {
      const [clients, projects] = yield* Effect.all(
        [
          readWorkClients({ orgId: input.orgId, limit: 100 }),
          readWorkProjects({ orgId: input.orgId, limit: 100 }),
        ],
        { concurrency: 2 },
      );
      return { clients: clients.parties, projects: projects.projects };
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  workClientCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:client:create",
    tag: "kin.work.createParty",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workClientUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:client:update",
    tag: "kin.work.updateParty",
  }),
  workContactCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:contact:create",
    tag: "kin.work.createContact",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workContactUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:contact:update",
    tag: "kin.work.updateContact",
  }),
  workProjectCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:project:create",
    tag: "kin.work.createProject",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workProjectUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:project:update",
    tag: "kin.work.updateProject",
  }),
  /** Docs' change number, kept current by the host's own announcements. */
  docsLive: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: KIN_DOCS_LABEL,
    subscribe: (input: KinDocsSubscribeInput) => kinDocsLiveStream(input),
  }),
  /** One page of docs; the list's controller decides when. Its `permissionAtom` gates Docs. */
  docsList: docsListRead,
  /** The docs linked to one client or one project, on that client's or project's page. */
  docsUnder: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:docs:under",
    execute: Effect.fn("KinWebClient.docsUnder")(function* (input: KinDocsListInput) {
      return yield* readDocsList(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** A doc at one version, with its outline. */
  doc: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:docs:doc",
    execute: Effect.fn("KinWebClient.doc")(function* (input: KinDocGetInput) {
      return yield* readDoc(input);
    }),
    staleTimeMs: 30_000,
    // Read again on reconnecting; between those, the reader's watch reads only when it changed.
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** What differs between two versions, as a patch. Versions never change, so neither does this. */
  docDiff: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:docs:diff",
    execute: Effect.fn("KinWebClient.docDiff")(function* (input: KinDocDiffInput) {
      return yield* readDocDiff(input);
    }),
    staleTimeMs: 5 * 60_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** A page of a doc's versions, newest first. */
  docHistory: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:history:read",
    tag: "kin.docs.history",
  }),
  docRestore: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:restore",
    tag: "kin.docs.restore",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  /** One search over tasks, clients, contacts, projects and docs. */
  search: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:search",
    tag: "kin.search",
  }),
  workCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:create",
    tag: "kin.work.create",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workAssign: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:assign",
    tag: "kin.work.assign",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  workUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:update",
    tag: "kin.work.update",
  }),
  workConfirm: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:confirm",
    tag: "kin.work.confirm",
  }),
  workDecline: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:decline",
    tag: "kin.work.decline",
  }),
  /** Every list an agent set up, as its definition: fields, statuses, categories. */
  workLists: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:lists",
    execute: Effect.fn("KinWebClient.workLists")(function* (input: KinListsInput) {
      return yield* readWorkLists(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** Owed, received, spent and what is due, added up by the host per currency. */
  workMoney: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:money",
    execute: Effect.fn("KinWebClient.workMoney")(function* (input: KinMoneySummaryInput) {
      return yield* readWorkMoney(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** One page of everything dated in a window; the Dates view decides when. */
  workDates: workDatesRead,
  workListUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:list:update",
    tag: "kin.work.updateList",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.list}` },
  }),
  workPaymentRecord: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:payment:record",
    tag: "kin.work.recordPayment",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workPaymentVoid: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:payment:void",
    tag: "kin.work.voidPayment",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.paymentId },
  }),
  /** One page of the files in the owner's chats, for keeping one on an entry. */
  workFiles: workFilesRead,
  /** Its `permissionAtom` says whether this browser may read company details at all. */
  companyRead: companyProfileRead,
  companyProfile: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:company",
    execute: Effect.fn("KinWebClient.companyProfile")(function* (input: KinCompanyProfileInput) {
      return yield* readCompanyProfile(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  companyProfileSet: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:company:set",
    tag: "kin.work.setCompanyProfile",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
  }),
  workIssue: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:issue",
    tag: "kin.work.issue",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  workVoid: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:void",
    tag: "kin.work.void",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  workUnvoid: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:unvoid",
    tag: "kin.work.unvoid",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  /** The number Issue would give now; read when its confirmation opens. */
  workNextNumber: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:next-number",
    tag: "kin.work.nextNumber",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  /** Money's receipts, newest first. Its `permissionAtom` gates the section. */
  receiptsRead,
  receipts: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:receipts",
    execute: Effect.fn("KinWebClient.receipts")(function* (input: KinReceiptsInput) {
      return yield* readReceipts(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  makeReceipt: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:work:receipt:make",
    tag: "kin.work.makeReceipt",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  /** The company's document templates. */
  recipes: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:docs:recipes",
    execute: Effect.fn("KinWebClient.recipes")(function* (input: KinRecipesInput) {
      return yield* readRecipes(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  docRender: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:render",
    tag: "kin.docs.render",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  undoRecipe: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:undo-recipe",
    tag: "kin.docs.undoRecipe",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.recipe}` },
  }),
  labelRecipe: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:label-recipe",
    tag: "kin.docs.labelRecipe",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.recipe}` },
  }),
  setDefaultRecipe: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:set-default-recipe",
    tag: "kin.docs.setDefaultRecipe",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
  }),
  docLabel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:label",
    tag: "kin.docs.label",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
};

/** After an agent is retired, restored or renamed: who is retired, and both lists of agents. */
export function refreshKinAgents(environmentId: EnvironmentId, orgId: KinOrgId) {
  appAtomRegistry.refresh(kinClient.orgs({ environmentId, input: {} }));
  refreshLeads(environmentId, orgId);
}
