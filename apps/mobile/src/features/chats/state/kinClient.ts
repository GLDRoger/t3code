import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { createKinRpcCommand } from "@t3tools/client-runtime/kin/kinAccess";
import {
  createEnvironmentQueryAtomFamily,
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
  type KinCompanyProfileInput,
  type KinReceiptsInput,
  type KinRecipesInput,
  type KinListsInput,
  type KinMoneySummaryInput,
  type KinDocDiffInput,
  type KinDocGetInput,
  type KinDocsListInput,
  type KinDocsSubscribeInput,
  type KinPeopleListInput,
  type KinChatId,
  type KinChatsSubscribeInput,
  type KinAgentDefaultsInput,
  type KinAgentPageInput,
  type KinLeadAccessInput,
  type KinBudgetGetInput,
  type KinCheckInsInput,
  type KinGoalsInput,
  type KinPulseListInput,
  type KinMemoryListInput,
  type KinLeadsListInput,
  type KinVisualHostsInput,
  type KinConnectionCallsInput,
  type KinConnectionRef,
  type KinConnectionsInput,
  type KinGitHubInput,
  type KinOrgsListInput,
  type KinOwnerTimeZoneGetInput,
  type KinPushWatchInput,
  type KinOrgId,
  type KinPersonId,
  type KinPartyPageInput,
  type KinProjectPageInput,
  type KinWorkGetInput,
  type KinWorkSubscribeInput,
  type KinCashInput,
  type KinOutlookInput,
  type KinMoneyBudgetsInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
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
import { KIN_DOCS_LABEL, kinDocsLiveStream } from "@t3tools/client-runtime/kin/kinDocsStream";
import {
  createKinWorkRefreshTriggers,
  KIN_WORK_LABEL,
  KIN_WORK_NOT_TASKS,
  kinDocsListLean,
  kinWorkListLean,
  kinWorkLiveStream,
} from "@t3tools/client-runtime/kin/kinWorkStream";
import {
  createKinDirectoryTrigger,
  kinAccessMoves,
  createKinRefreshTriggers,
  noteKinDirectoryOrgs,
} from "@t3tools/client-runtime/kin/kinRefresh";

export type { KinSynced } from "@t3tools/client-runtime/kin/kinStreams";

const currentEnvironmentId = EnvironmentSupervisor.EnvironmentSupervisor.pipe(
  Effect.map((supervisor) => supervisor.target.environmentId),
);

// Kin reads are client-guarded too, so they go through the command's scope check.
const orgsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:orgs:read",
  tag: KIN_CHAT_WS_METHODS.orgsList,
});
const historyRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:history:read",
  tag: KIN_CHAT_WS_METHODS.chatHistory,
});
const sessionGeneration = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
  environmentSessionGenerationAtom(connectionAtomRuntime, environmentId);
/** A read refreshed on a new session and whenever the host says its topic changed. */
const kinRefreshOn = createKinRefreshTriggers(connectionAtomRuntime);

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
      // A caller's timeout abandons this promise without cancelling the request; the session bounds it.
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
const approvalRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:approval:read",
  tag: KIN_APPROVAL_WS_METHODS.get,
});
const readApproval = guardedRead(approvalRead);
const approverKeysRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:approver-keys:read",
  tag: KIN_APPROVAL_WS_METHODS.listKeys,
});
const readApproverKeys = guardedRead(approverKeysRead);
const leadsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:leads:read",
  tag: "kin.leads.list",
});
const readLeads = guardedRead(leadsRead);
const visualHostsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:visual-hosts:read",
  tag: "kin.visuals.hosts.list",
});
const readVisualHosts = guardedRead(visualHostsRead);

const connectionsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:connections:read",
  tag: "kin.connections.list",
});
const readConnections = guardedRead(connectionsRead);
const connectionRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:connection:read",
  tag: "kin.connections.get",
});
const readConnection = guardedRead(connectionRead);
const connectionCallsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:connection-calls:read",
  tag: "kin.connections.calls",
});
const readConnectionCalls = guardedRead(connectionCallsRead);
const githubRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:github:read",
  tag: "kin.github.connect.status",
});
const readGitHub = guardedRead(githubRead);
const leadAccessRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:lead-access:read",
  tag: "kin.lead.access.list",
});
const readLeadAccess = guardedRead(leadAccessRead);
const agentPageRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:agent-page:read",
  tag: "kin.lead.page",
});
const readAgentPage = guardedRead(agentPageRead);
const agentDefaultsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:agent-defaults:read",
  tag: "kin.agents.defaults",
});
const readAgentDefaults = guardedRead(agentDefaultsRead);
const membersRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:chat-members:read",
  tag: KIN_CHAT_WS_METHODS.chatMembers,
});
const readMembers = guardedRead(membersRead);
const peopleRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:people:read",
  tag: KIN_PEOPLE_WS_METHODS.peopleList,
});
const readPeople = guardedRead(peopleRead);
const invitesRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:invites:read",
  tag: KIN_PEOPLE_WS_METHODS.peopleListInvites,
});
const readInvites = guardedRead(invitesRead);
const profilesRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:profiles:read",
  tag: KIN_PEOPLE_WS_METHODS.peopleProfiles,
});
const readProfiles = guardedRead(profilesRead);
const memoryRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:memory:read",
  tag: "kin.memory.list",
});
const readMemory = guardedRead(memoryRead);
const budgetRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:budget:read",
  tag: "kin.budget.get",
});
const readBudget = guardedRead(budgetRead);
const checkInsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:checkIns:read",
  tag: "kin.checkIns.list",
});
const readCheckIns = guardedRead(checkInsRead);
const pulseRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:pulse:read",
  tag: "kin.pulse.read",
});
const readPulse = guardedRead(pulseRead);
const goalsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:goals:read",
  tag: "kin.goals.list",
});
const readGoals = guardedRead(goalsRead);

const workSummaryRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:summary:read",
  tag: "kin.work.summary",
});
const readWorkSummary = guardedRead(workSummaryRead);
const workListRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:list:read",
  tag: "kin.work.list",
  execute: kinWorkListLean,
});
const workItemRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:item:read",
  tag: "kin.work.get",
});
const readWorkItem = guardedRead(workItemRead);
const workZoneRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:zone:read",
  tag: "kin.triggers.getTimeZone",
});
const readWorkZone = guardedRead(workZoneRead);
const workClientsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:clients:read",
  tag: "kin.work.parties",
});
const readWorkClients = guardedRead(workClientsRead);
const workClientRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:client:read",
  tag: "kin.work.party",
});
const readWorkClient = guardedRead(workClientRead);
const workProjectsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:projects:read",
  tag: "kin.work.projects",
});
const readWorkProjects = guardedRead(workProjectsRead);
const workProjectRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:project:read",
  tag: "kin.work.project",
});
const readWorkProject = guardedRead(workProjectRead);
const docsListRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:docs:list:read",
  tag: "kin.docs.list",
  execute: kinDocsListLean,
});
const readDocsList = guardedRead(docsListRead);
const docRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:docs:doc:read",
  tag: "kin.docs.get",
});
const readDoc = guardedRead(docRead);
const docDiffRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:docs:diff:read",
  tag: "kin.docs.diff",
});
const readDocDiff = guardedRead(docDiffRead);
const workHistoryRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:history:read",
  tag: "kin.work.history",
});

const workListsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:lists:read",
  tag: "kin.work.lists",
});
const readWorkLists = guardedRead(workListsRead);
const workMoneyRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:money:read",
  tag: "kin.work.money",
});
const readWorkMoney = guardedRead(workMoneyRead);
const readWorkCash = guardedRead(
  createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:cash:read",
    tag: "kin.work.cash",
  }),
);
const readWorkOutlook = guardedRead(
  createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:outlook:read",
    tag: "kin.work.outlook",
  }),
);
const readWorkBudgets = guardedRead(
  createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:budgets:read",
    tag: "kin.work.budgets",
  }),
);
const workDatesRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:dates:read",
  tag: "kin.work.dates",
});
const companyProfileRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:company:read",
  tag: "kin.work.companyProfile",
});
const readCompanyProfile = guardedRead(companyProfileRead);
const receiptsRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:work:receipts:read",
  tag: "kin.work.receipts",
});
const readReceipts = guardedRead(receiptsRead);
const recipesRead = createKinRpcCommand(connectionAtomRuntime, {
  label: "kin:docs:recipes:read",
  tag: "kin.docs.recipes",
});
const readRecipes = guardedRead(recipesRead);

// One per host and org, so a retry reaches the running counts stream without restarting it.
const workRetries = new Map<string, PubSub.PubSub<void>>();
const workRetriesOf = (environmentId: EnvironmentId, orgId: KinOrgId) => {
  const key = JSON.stringify([environmentId, orgId]);
  let retries = workRetries.get(key);
  if (retries === undefined) {
    // Taps while a read runs fold into one more read.
    retries = Effect.runSync(PubSub.sliding<void>(1));
    workRetries.set(key, retries);
  }
  return retries;
};

/** Reads Work's counts again inside the running stream, keeping what it holds meanwhile. */
export const retryKinWorkLive = (environmentId: EnvironmentId, orgId: KinOrgId) =>
  Effect.runSync(PubSub.publish(workRetriesOf(environmentId, orgId), undefined));

/** Work's change number and counts, kept current by the host's own announcements. */
const workLive = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: KIN_WORK_LABEL,
  subscribe: (input: KinWorkSubscribeInput) =>
    kinWorkLiveStream(
      input,
      (summaryInput) =>
        readWorkSummary(summaryInput).pipe(
          Effect.provideService(AtomRegistry.AtomRegistry, appAtomRegistry),
        ),
      Stream.unwrap(
        currentEnvironmentId.pipe(
          Effect.map((environmentId) =>
            Stream.fromPubSub(workRetriesOf(environmentId, input.orgId)),
          ),
        ),
      ),
    ),
});
const kinWorkRefreshOn = createKinWorkRefreshTriggers(connectionAtomRuntime, workLive);

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
  refreshTrigger: createKinDirectoryTrigger(connectionAtomRuntime, "people"),
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

const chatStream = makeKinChatStream(
  (input) =>
    readHistory(input).pipe(Effect.provideService(AtomRegistry.AtomRegistry, appAtomRegistry)),
  kinAccessMoves(connectionAtomRuntime, appAtomRegistry),
);

/** The viewer's own leads, and the leads of others they may message. */
const leads = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "kin:leads",
  execute: Effect.fn("KinClient.leads")(function* (input: KinLeadsListInput) {
    return yield* readLeads(input);
  }),
  staleTimeMs: 15_000,
  refreshTrigger: kinRefreshOn("leads"),
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
  // A new direct chat may be with an agent the directory hasn't named yet.
  appAtomRegistry.refresh(kinClient.orgs({ environmentId, input: {} }));
  for (const orgId of orgIds) refreshLeads(environmentId, orgId);
});

export const kinClient = {
  /** Orgs, their agents, and the viewer's person per org. An empty `me` means no identity. */
  orgs: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:orgs",
    execute: Effect.fn("KinClient.orgs")(function* (input: KinOrgsListInput) {
      const environmentId = yield* currentEnvironmentId;
      const result = yield* retryKinProbe(readOrgs(input), () => knownKinHosts.has(environmentId));
      markKinHostKnown(environmentId);
      noteKinDirectoryOrgs(
        appAtomRegistry,
        environmentId,
        result.orgs.map((org) => org.orgId),
      );
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
    // A failed probe reruns when the next session comes up, not only after the stale time; agent
    // names come from here, so it is read again when an org's agents change too.
    refreshTrigger: createKinDirectoryTrigger(connectionAtomRuntime),
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
  createDirect: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:create-direct",
    tag: KIN_CHAT_WS_METHODS.chatsCreateDirect,
  }),
  send: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:send",
    tag: KIN_CHAT_WS_METHODS.messagesSend,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientMessageId },
  }),
  /** Owner-only Stop on a lead's current wake-up, from its presence line. */
  leadInterrupt: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:interrupt",
    tag: "kin.lead.interrupt",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.wakeupId },
  }),
  leads,
  leadCreate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:create",
    tag: "kin.lead.create",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.name}|${input.domain}` },
  }),
  leadUpdate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:update",
    tag: "kin.lead.update",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
  }),
  /** The owner's agents with the retired ones last. Read only where `leadRetire` is permitted. */
  agents: (target: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) =>
    leads({ environmentId: target.environmentId, input: withRetired(target.orgId) }),
  /** Stops the agent's work and holds its timers; its chats, memory and tasks stay. */
  leadRetire: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:retire",
    tag: "kin.lead.retire",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
  }),
  leadRestore: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:restore",
    tag: "kin.lead.restore",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
  }),
  /** Who besides the owner may message one of the owner's leads. */
  /** One agent's whole page, for owner-level people. */
  agentPage: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:agent-page",
    execute: Effect.fn("KinClient.agentPage")(function* (input: KinAgentPageInput) {
      return yield* readAgentPage(input);
    }),
    staleTimeMs: 15_000,
    refreshTrigger: kinRefreshOn("leads"),
  }),
  agentDefaults: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:agent-defaults",
    execute: Effect.fn("KinClient.agentDefaults")(function* (input: KinAgentDefaultsInput) {
      return yield* readAgentDefaults(input);
    }),
    staleTimeMs: 15_000,
    refreshTrigger: kinRefreshOn("leads"),
  }),
  characterSet: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:character",
    tag: "kin.lead.character.set",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
  }),
  agentDefaultsSet: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:agent-defaults:set",
    tag: "kin.agents.defaults.set",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
  }),
  leadPause: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:pause",
    tag: "kin.lead.pause",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
  }),
  leadResume: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:lead:resume",
    tag: "kin.lead.resume",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
  }),
  leadAccess: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:lead-access",
    execute: Effect.fn("KinClient.leadAccess")(function* (input: KinLeadAccessInput) {
      return yield* readLeadAccess(input);
    }),
    staleTimeMs: 15_000,
    refreshTrigger: kinRefreshOn("leads"),
  }),
  leadAllow: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:lead-access:allow",
    tag: "kin.lead.access.grant",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.agentId}:${input.personId}` },
  }),
  leadDisallow: createKinRpcCommand(connectionAtomRuntime, {
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
    refreshTrigger: kinRefreshOn("people"),
  }),
  /** Everyone's profile; any person of the org reads them. */
  profiles: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:profiles",
    execute: Effect.fn("KinClient.profiles")(function* (input: KinPeopleListInput) {
      return yield* readProfiles(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("people"),
  }),
  profileUpdate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:profile:update",
    tag: KIN_PEOPLE_WS_METHODS.peopleUpdateProfile,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
  }),
  teamAgentSet: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:team-agent:set",
    tag: KIN_PEOPLE_WS_METHODS.orgSetTeamAgent,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
  }),
  /** The invite links nobody has opened yet. The owner's Team page reads them. */
  invites: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:invites",
    execute: Effect.fn("KinClient.invites")(function* (input: KinPeopleListInput) {
      return yield* readInvites(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("people"),
  }),
  /** Makes a teammate's link. The answer carries the secret once; nothing here keeps it. */
  inviteCreate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:invite:create",
    tag: KIN_PEOPLE_WS_METHODS.peopleCreateInvite,
  }),
  inviteCancel: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:invite:cancel",
    tag: KIN_PEOPLE_WS_METHODS.peopleRevokeInvite,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.inviteId },
  }),
  personRemoveAccess: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:person:remove-access",
    tag: KIN_PEOPLE_WS_METHODS.peopleRemoveAccess,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
  }),
  /** The owner makes someone a co-owner or a member again. */
  /** The owner turns a member's Clients, Docs and Money on or off. */
  personSetPlaces: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:person:set-places",
    tag: KIN_PEOPLE_WS_METHODS.peopleSetPlaces,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
  }),
  personSetAccess: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:person:set-access",
    tag: KIN_PEOPLE_WS_METHODS.peopleSetAccess,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
  }),
  chatWithPerson: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:chat:with-person",
    tag: "kin.chats.withPerson",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
  }),
  groupCreate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:group:create",
    tag: "kin.groups.create",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.title}` },
  }),
  groupAddMember: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:group:add-member",
    tag: "kin.groups.addMember",
  }),
  groupRemoveMember: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:group:remove-member",
    tag: "kin.groups.removeMember",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.memberId },
  }),
  groupSetLead: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:group:set-lead",
    tag: "kin.groups.setLead",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
  }),
  groupRename: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:group:rename",
    tag: "kin.groups.rename",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
  }),
  groupSetCompany: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:group:set-company",
    tag: "kin.groups.setCompany",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
  }),
  groupDelete: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:group:delete",
    tag: "kin.groups.delete",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
  }),
  /** Mutes or unmutes this chat's pushes for the viewer; one in flight per chat. */
  mute: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:mute",
    tag: KIN_CHAT_WS_METHODS.chatsMute,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
  }),
  /** Empties this chat for everyone in it, for good; one in flight per chat. */
  clear: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:clear",
    tag: KIN_CHAT_WS_METHODS.chatsClear,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
  }),
  /** What a clear would leave, asked when its confirm opens; changes nothing. */
  clearPreview: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:clear-preview",
    tag: KIN_CHAT_WS_METHODS.chatsClear,
    concurrency: { mode: "singleFlight", key: ({ input }) => `preview:${input.chatId}` },
  }),
  markRead: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:mark-read",
    tag: KIN_CHAT_WS_METHODS.messagesMarkRead,
  }),
  widgetAction: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:widget-action",
    tag: KIN_CHAT_WS_METHODS.widgetsAct,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientActionId },
  }),
  /** Toggles the viewer's reaction; one in flight per message and emoji. */
  react: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:react",
    tag: KIN_CHAT_WS_METHODS.messagesReact,
    concurrency: {
      mode: "singleFlight",
      key: ({ input }) => `${input.messageId}|${input.emoji}`,
    },
  }),
  /** The owner's connections to outside services, live on the host's `connections` topic. */
  connections: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:connections",
    execute: Effect.fn("KinClient.connections")(function* (input: KinConnectionsInput) {
      return yield* readConnections(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("connections"),
  }),
  connection: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:connection",
    execute: Effect.fn("KinClient.connection")(function* (input: KinConnectionRef) {
      return yield* readConnection(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("connections"),
  }),
  connectionCalls: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:connection-calls",
    execute: Effect.fn("KinClient.connectionCalls")(function* (input: KinConnectionCallsInput) {
      return yield* readConnectionCalls(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("connections"),
  }),
  /** The owner's own GitHub login on the host; live on the `connections` topic. */
  github: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:github",
    execute: Effect.fn("KinClient.github")(function* (input: KinGitHubInput) {
      return yield* readGitHub(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("connections"),
  }),
  /** Starts the code sign-in, or connects with a pasted token, which travels once, redacted. */
  githubStart: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:github:start",
    tag: "kin.github.connect.start",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:github` },
  }),
  githubCancel: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:github:cancel",
    tag: "kin.github.connect.cancel",
  }),
  githubDisconnect: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:github:disconnect",
    tag: "kin.github.disconnect",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:github` },
  }),
  /** Adds a connection; the key travels once, redacted, and is never sent back. */
  connectionAdd: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:add",
    tag: "kin.connections.add",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:add` },
  }),
  connectionSetKey: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:setKey",
    tag: "kin.connections.setKey",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
  }),
  connectionRefresh: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:refreshTools",
    tag: "kin.connections.refreshTools",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
  }),
  connectionSetToolModes: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:setToolModes",
    tag: "kin.connections.setToolModes",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
  }),
  connectionAccept: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:acceptToolChanges",
    tag: "kin.connections.acceptToolChanges",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
  }),
  connectionUpdate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:update",
    tag: "kin.connections.update",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
  }),
  connectionSetReach: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:setReach",
    tag: "kin.connections.setReach",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
  }),
  connectionRemove: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:remove",
    tag: "kin.connections.remove",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
  }),
  connectionSignInStart: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:signInStart",
    tag: "kin.connections.signInStart",
  }),
  connectionSignInFinish: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:signInFinish",
    tag: "kin.connections.signInFinish",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:signIn` },
  }),
  connectionSetSignInClient: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:setSignInClient",
    tag: "kin.connections.setSignInClient",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:client` },
  }),
  /** The owner switches an open send card's From before Confirm. */
  connectionSetSendFrom: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:connection:setSendFrom",
    tag: "kin.connections.setSendFrom",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.widgetId },
  }),
  /** The outside hosts the owner lets visuals load from. Owner only. */
  visualHosts: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:visual-hosts",
    execute: Effect.fn("KinClient.visualHosts")(function* (input: KinVisualHostsInput) {
      return yield* readVisualHosts(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("visualHosts"),
  }),
  /** Owner-only: lets every visual in the org load from one more host. */
  visualHostAllow: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:visual-host:allow",
    tag: "kin.visuals.hosts.allow",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.host}` },
  }),
  visualHostRemove: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:visual-host:remove",
    tag: "kin.visuals.hosts.remove",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.host}` },
  }),
  /** Owner-only Undo of one line on a memory change card. */
  /** A locked statement's password, once and redacted; never a message the lead reads. */
  statementUnlock: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:unlock",
    tag: "kin.work.statementUnlock",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
  }),
  statementForgetPassword: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:forget-password",
    tag: "kin.work.statementForgetPassword",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
  }),
  /** One tap on a review card, in order: the server keeps the selection Confirm applies. */
  statementSelect: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:select",
    tag: "kin.work.statementSelect",
    concurrency: { mode: "serial", key: ({ input }) => input.statementId },
  }),
  /** More of a section's rows than the card carries. */
  statementRows: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:rows",
    tag: "kin.work.statementRows",
    concurrency: {
      mode: "singleFlight",
      key: ({ input }) => `${input.statementId}:${input.section}:${input.offset}`,
    },
  }),
  /** Applies the selection the server keeps for this review, at the revision the owner saw. */
  statementApply: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:apply",
    tag: "kin.work.statementApply",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
  }),
  statementUndo: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:undo",
    tag: "kin.work.statementUndo",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
  }),
  statementReread: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:statement:reread",
    tag: "kin.work.statementReread",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
  }),
  memoryUndo: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:memory:undo",
    tag: "kin.memory.undo",
    concurrency: {
      mode: "singleFlight",
      key: ({ input }) => `${input.widgetId}:${input.itemId}`,
    },
  }),
  /** What the owner's leads remember, and who may know each thing. Never saved on the device. */
  memory: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:memory",
    execute: Effect.fn("KinClient.memory")(function* (input: KinMemoryListInput) {
      return yield* readMemory(input);
    }),
    staleTimeMs: 60_000,
    refreshTrigger: kinRefreshOn("memory"),
  }),
  /** Docs are never saved on the device either: a doc may be private to the owner. */
  docsLive: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: KIN_DOCS_LABEL,
    subscribe: (input: KinDocsSubscribeInput) => kinDocsLiveStream(input),
  }),
  /** One page of docs; the list's controller decides when. Its `permissionAtom` gates Docs. */
  docsList: docsListRead,
  /** The docs linked to one client or one project, on that client's or project's page. */
  docsUnder: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:docs:under",
    execute: Effect.fn("KinClient.docsUnder")(function* (input: KinDocsListInput) {
      return yield* readDocsList(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: sessionGeneration,
  }),
  /**
   * How many docs there are and how many changed since `since`: the list's own totals, without
   * its rows. The caller reads again when the docs' change number passes `seq`.
   */
  docsCounts: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:docs:counts",
    execute: Effect.fn("KinClient.docsCounts")(function* (input: {
      readonly orgId: KinOrgId;
      readonly since: string;
    }) {
      const [all, changed] = yield* Effect.all(
        [
          readDocsList({ orgId: input.orgId, limit: 1 }),
          readDocsList({ orgId: input.orgId, limit: 1, changedSince: input.since }),
        ],
        { concurrency: 2 },
      );
      return { total: all.total, changed: changed.total, seq: Math.min(all.seq, changed.seq) };
    }),
    staleTimeMs: 30_000,
    refreshTrigger: sessionGeneration,
  }),
  /** A doc at one version, with its outline. */
  doc: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:docs:doc",
    execute: Effect.fn("KinClient.doc")(function* (input: KinDocGetInput) {
      return yield* readDoc(input);
    }),
    staleTimeMs: 30_000,
    // Read again on reconnecting; between those, the reader's watch reads only when it changed.
    refreshTrigger: sessionGeneration,
  }),
  /** What differs between two versions, as a patch. Versions never change, so neither does this. */
  docDiff: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:docs:diff",
    execute: Effect.fn("KinClient.docDiff")(function* (input: KinDocDiffInput) {
      return yield* readDocDiff(input);
    }),
    staleTimeMs: 5 * 60_000,
    refreshTrigger: sessionGeneration,
  }),
  /** A page of a doc's versions, newest first. */
  docHistory: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:history:read",
    tag: "kin.docs.history",
  }),
  docRestore: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:restore",
    tag: "kin.docs.restore",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  /** One search over tasks, clients, contacts, projects and docs. */
  search: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:search",
    tag: "kin.search",
  }),
  /** Work is never saved on the device: it is the owner's alone, and old counts would mislead. */
  workLive,
  /** Its `permissionAtom` says whether this session may read Work at all. */
  workRead: workSummaryRead,
  /** One page of a filter; the list's controller decides when. */
  workList: workListRead,
  /** One task with its links and history. */
  workItem: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:item",
    execute: Effect.fn("KinClient.workItem")(function* (input: KinWorkGetInput) {
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
    execute: Effect.fn("KinClient.workZone")(function* (input: KinOwnerTimeZoneGetInput) {
      return yield* readWorkZone(input);
    }),
    staleTimeMs: 5 * 60_000,
    refreshTrigger: kinRefreshOn("timeZone"),
  }),
  /** One page of the clients list, or of the projects list; each list's controller decides when. */
  workClients: workClientsRead,
  workProjects: workProjectsRead,
  /** A page of a client's or project's history. */
  workHistory: workHistoryRead,
  /** A client with what is owed each way, its contacts and its projects. */
  workClient: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:client",
    execute: Effect.fn("KinClient.workClient")(function* (input: KinPartyPageInput) {
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
    execute: Effect.fn("KinClient.workProject")(function* (input: KinProjectPageInput) {
      return yield* readWorkProject(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  }),
  /** How many clients and open projects there are: the lists' own totals, without their rows. */
  workCounts: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:counts",
    execute: Effect.fn("KinClient.workCounts")(function* (input: { readonly orgId: KinOrgId }) {
      const [clients, projects] = yield* Effect.all(
        [
          readWorkClients({ orgId: input.orgId, limit: 1 }),
          readWorkProjects({ orgId: input.orgId, limit: 1 }),
        ],
        { concurrency: 2 },
      );
      return { clients: clients.total, projects: projects.total };
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinWorkRefreshOn(["clients", "projects"], kinRefreshOn("workChoices")),
  }),
  /** The active clients and open projects a task or a project can be put under, by name. */
  workChoices: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:choices",
    execute: Effect.fn("KinClient.workChoices")(function* (input: { readonly orgId: KinOrgId }) {
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
    // Clients shows each project's task counts from these rows, so any change can move them.
    refreshTrigger: kinWorkRefreshOn("any", kinRefreshOn("workChoices")),
  }),
  /** One teammate's open projects, and the open projects they could be put on, by name. */
  teammateProjects: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:teammate-projects",
    execute: Effect.fn("KinClient.teammateProjects")(function* (input: {
      readonly orgId: KinOrgId;
      readonly person: KinPersonId;
    }) {
      const [theirs, open] = yield* Effect.all(
        [
          readWorkProjects({ orgId: input.orgId, person: input.person, limit: 100 }),
          readWorkProjects({ orgId: input.orgId, limit: 100 }),
        ],
        { concurrency: 2 },
      );
      return { theirs: theirs.projects, open: open.projects };
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinWorkRefreshOn(["projects"], kinRefreshOn("workChoices")),
  }),
  workClientCreate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:client:create",
    tag: "kin.work.createParty",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workClientUpdate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:client:update",
    tag: "kin.work.updateParty",
  }),
  workContactCreate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:contact:create",
    tag: "kin.work.createContact",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workContactUpdate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:contact:update",
    tag: "kin.work.updateContact",
  }),
  workTouchLog: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:touch:log",
    tag: "kin.work.logTouch",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workTouchRemove: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:touch:remove",
    tag: "kin.work.removeTouch",
  }),
  workProjectCreate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:project:create",
    tag: "kin.work.createProject",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workProjectUpdate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:project:update",
    tag: "kin.work.updateProject",
  }),
  /** Who is on a project; the owner, a co-owner or its lead (the page's `can.people`). */
  workProjectPeople: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:project:people",
    tag: "kin.work.projectPeople",
  }),
  workCreate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:create",
    tag: "kin.work.create",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workAssign: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:assign",
    tag: "kin.work.assign",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  workUpdate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:update",
    tag: "kin.work.update",
  }),
  /** The holder gives a task back to whoever gave it. */
  workHandBack: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:handBack",
    tag: "kin.work.handBack",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  /** The owner shares tasks with the team, or takes them back. */
  workShare: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:share",
    tag: "kin.work.share",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.keys.join(",") },
  }),
  workConfirm: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:confirm",
    tag: "kin.work.confirm",
  }),
  workDecline: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:decline",
    tag: "kin.work.decline",
  }),
  /** Every list an agent set up, as its definition: fields, statuses, categories. */
  workLists: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:lists",
    execute: Effect.fn("KinClient.workLists")(function* (input: KinListsInput) {
      return yield* readWorkLists(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinWorkRefreshOn(KIN_WORK_NOT_TASKS, kinRefreshOn("workLists")),
  }),
  /** Money's own screen: its coming-up count includes tasks, so any change reads it again. */
  workMoney: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:money",
    execute: Effect.fn("KinClient.workMoney")(function* (input: KinMoneySummaryInput) {
      return yield* readWorkMoney(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinWorkRefreshOn("any"),
  }),
  /** The same read for a line of what is owed, which no task moves. */
  workOwed: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:owed",
    execute: Effect.fn("KinClient.workOwed")(function* (input: KinMoneySummaryInput) {
      return yield* readWorkMoney(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinWorkRefreshOn(KIN_WORK_NOT_TASKS),
  }),
  /** Bank balances from confirmed statements; read again when a statement or Work changes. */
  workCash: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:cash",
    execute: Effect.fn("KinClient.workCash")(function* (input: KinCashInput) {
      return yield* readWorkCash(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinWorkRefreshOn(KIN_WORK_NOT_TASKS, kinRefreshOn("moneyStatements")),
  }),
  /** What is expected in and out in the next 30 days, and runway. */
  workOutlook: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:outlook",
    execute: Effect.fn("KinClient.workOutlook")(function* (input: KinOutlookInput) {
      return yield* readWorkOutlook(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinWorkRefreshOn(KIN_WORK_NOT_TASKS, kinRefreshOn("moneyStatements")),
  }),
  workBudgets: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:budgets",
    execute: Effect.fn("KinClient.workBudgets")(function* (input: KinMoneyBudgetsInput) {
      return yield* readWorkBudgets(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinWorkRefreshOn(KIN_WORK_NOT_TASKS, kinRefreshOn("moneyBudgets")),
  }),
  workSetBudget: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:budget:set",
    tag: "kin.work.setBudget",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workEntryLines: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:entry-lines:read",
    tag: "kin.work.entryLines",
  }),
  workInvoiceFromQuote: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:invoice-from-quote",
    tag: "kin.work.invoiceFromQuote",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  /** One page of everything dated in a window; the Dates screen decides when. */
  workDates: workDatesRead,
  /** The files in the owner's chats, to keep one on an entry; read as its picker is typed in. */
  workFiles: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:files:read",
    tag: "kin.work.files",
  }),
  workListUpdate: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:list:update",
    tag: "kin.work.updateList",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.list}` },
  }),
  workPaymentRecord: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:payment:record",
    tag: "kin.work.recordPayment",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  workPaymentVoid: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:payment:void",
    tag: "kin.work.voidPayment",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.paymentId },
  }),
  /** Its `permissionAtom` says whether this phone may read company details at all. */
  companyRead: companyProfileRead,
  companyProfile: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:company",
    execute: Effect.fn("KinClient.companyProfile")(function* (input: KinCompanyProfileInput) {
      return yield* readCompanyProfile(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("company"),
  }),
  companyProfileSet: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:company:set",
    tag: "kin.work.setCompanyProfile",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
  }),
  workIssue: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:issue",
    tag: "kin.work.issue",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  workVoid: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:void",
    tag: "kin.work.void",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  workUnvoid: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:unvoid",
    tag: "kin.work.unvoid",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  /** The number Issue would give now; read when its confirmation opens. */
  workNextNumber: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:next-number",
    tag: "kin.work.nextNumber",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  /** Money's receipts, newest first. Its `permissionAtom` gates the section. */
  receiptsRead,
  receipts: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:work:receipts",
    execute: Effect.fn("KinClient.receipts")(function* (input: KinReceiptsInput) {
      return yield* readReceipts(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinWorkRefreshOn("any"),
  }),
  makeReceipt: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:work:receipt:make",
    tag: "kin.work.makeReceipt",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  /** The company's document templates. */
  recipes: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:docs:recipes",
    execute: Effect.fn("KinClient.recipes")(function* (input: KinRecipesInput) {
      return yield* readRecipes(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("recipes"),
  }),
  docRender: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:render",
    tag: "kin.docs.render",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
  }),
  undoRecipe: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:undo-recipe",
    tag: "kin.docs.undoRecipe",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.recipe}` },
  }),
  labelRecipe: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:label-recipe",
    tag: "kin.docs.labelRecipe",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.recipe}` },
  }),
  setDefaultRecipe: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:set-default-recipe",
    tag: "kin.docs.setDefaultRecipe",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
  }),
  docLabel: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:label",
    tag: "kin.docs.label",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  docFile: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:docs:file",
    tag: "kin.docs.file",
    concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
  }),
  memorySetVisibility: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:memory:set-visibility",
    tag: "kin.memory.setVisibility",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.itemId },
  }),
  memoryConfirm: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:memory:confirm",
    tag: "kin.memory.confirmSuggestions",
  }),
  memoryForget: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:memory:forget",
    tag: "kin.memory.forget",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.itemId },
  }),
  memoryRestore: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:memory:restore",
    tag: "kin.memory.restore",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.itemId },
  }),
  /** The owner's daily limit. The host announces no change to it, so a set re-reads it here. */
  /** What needs attention, handled ones included; read again whenever the host's facts move. */
  attention: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:pulse",
    execute: Effect.fn("KinClient.attention")(function* (input: KinPulseListInput) {
      return yield* readPulse(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("pulse"),
  }),
  attentionHandle: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:pulse:handle",
    tag: "kin.pulse.handle",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.factKey },
  }),
  /** The company's goals with progress; Work's changes re-read it too (`useKinGoals`). */
  goals: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:goals",
    execute: Effect.fn("KinClient.goals")(function* (input: KinGoalsInput) {
      return yield* readGoals(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinWorkRefreshOn("any", kinRefreshOn("pulse")),
  }),
  goalSave: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:goals:save",
    tag: "kin.goals.save",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.key ?? input.clientRequestId },
  }),
  /** The company's check-ins in the owner's time, for Settings. */
  checkIns: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:checkIns",
    execute: Effect.fn("KinClient.checkIns")(function* (input: KinCheckInsInput) {
      return yield* readCheckIns(input);
    }),
    staleTimeMs: 30_000,
  }),
  checkInSave: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:checkIns:save",
    tag: "kin.checkIns.save",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.scheduleId ?? "new" },
  }),
  checkInAct: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:checkIns:act",
    tag: "kin.checkIns.act",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.scheduleId },
  }),
  budget: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:budget",
    execute: Effect.fn("KinClient.budget")(function* (input: KinBudgetGetInput) {
      return yield* readBudget(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: kinRefreshOn("budget"),
  }),
  budgetSet: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:budget:set",
    tag: "kin.budget.set",
    concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
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
  /** The org's keys that can approve, and recent changes; this phone finds its own by thumbprint. */
  approverKeys: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:approver-keys",
    execute: Effect.fn("KinClient.approverKeys")(function* (input: KinApprovalsOrgInput) {
      return yield* readApproverKeys(input);
    }),
    staleTimeMs: 10_000,
  }),
  approverKeysRead,
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
  revokeKey: createKinRpcCommand(connectionAtomRuntime, {
    label: "kin:approver-key:revoke",
    tag: KIN_APPROVAL_WS_METHODS.revokeKey,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.thumbprint },
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

/** After an agent is retired, restored or renamed: who is retired, and both lists of agents. */
export function refreshKinAgents(environmentId: EnvironmentId, orgId: KinOrgId) {
  appAtomRegistry.refresh(kinClient.orgs({ environmentId, input: {} }));
  refreshLeads(environmentId, orgId);
}
