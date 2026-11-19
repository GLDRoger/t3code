import {
  KIN_PULSE_LATER_SENSES,
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
  type KinCashInput,
  type KinOutlookInput,
  type KinMoneyBudgetsInput,
  type KinRecipesInput,
  type KinListsInput,
  type KinMoneySummaryInput,
  type KinDocDiffInput,
  type KinDocGetInput,
  type KinDocsListInput,
  type KinDocsSubscribeInput,
  type KinBudgetGetInput,
  type KinGoalsInput,
  type KinCheckInsInput,
  type KinOpenReadInput,
  type KinPulseListInput,
  type KinMemoryListInput,
  type KinPeopleListInput,
  type KinPeopleListDevicesInput,
  type KinAgentDefaultsInput,
  type KinAgentPageInput,
  type KinLeadAccessInput,
  type KinLeadsListInput,
  type KinOrgsListInput,
  type KinOrgsListResult,
  type KinOwnerTimeZoneGetInput,
  type KinOrgId,
  type KinPersonId,
  type KinPartyPageInput,
  type KinVisualHostsInput,
  type KinConnectionCallsInput,
  type KinConnectionRef,
  type KinConnectionsInput,
  type KinTasksKeysListInput,
  type KinRecommendationsInput,
  type KinSocialInput,
  type KinGitHubInput,
  type KinProjectPageInput,
  type KinWorkGetInput,
  type KinWorkSubscribeInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "../state/runtime.ts";
import { createKinQueryAtomFamily, createKinRpcCommand, retryKinAccess } from "./kinAccess.ts";
import { KIN_DOCS_LABEL, kinDocsLiveStream } from "./kinDocsStream.ts";
import type { KinChatState } from "./kinInboxModel.ts";
import { KIN_MONEY_LIVE_LABEL, kinMoneyLiveStream } from "./kinMoneyStream.ts";
import { KIN_PULSE_LIVE_LABEL, kinPulseLiveStream } from "./kinPulseStream.ts";
import { KIN_OPEN_LIVE_LABEL, kinOpenLiveStream } from "./kinOpenStream.ts";
import {
  createKinDirectoryTrigger,
  createKinRefreshTriggers,
  kinAccessMoves,
  noteKinDirectoryOrgs,
} from "./kinRefresh.ts";
import {
  KIN_CHAT_LABEL,
  KIN_INBOX_LABEL,
  kinInboxStream,
  makeKinChatStream,
  onKinDirectChatsChange,
  retryKinProbe,
  type KinSynced,
} from "./kinStreams.ts";
import { createKinOwnerTimeZoneSync } from "./kinTimeZone.ts";
import {
  createKinWorkRefreshTriggers,
  KIN_WORK_LABEL,
  KIN_WORK_NOT_TASKS,
  kinDocsListLean,
  kinWorkListLean,
  kinWorkLiveStream,
} from "./kinWorkStream.ts";
import { KIN_PERSON_TASKS, kinTasksMostUrgent } from "./kinTasksList.ts";

/** A dropped connection can leave a read pending; "Load earlier" fails after this and offers Retry. */
const KIN_HISTORY_PAGE_TIMEOUT = Duration.seconds(20);

const currentEnvironmentId = EnvironmentSupervisor.EnvironmentSupervisor.pipe(
  Effect.map((supervisor) => supervisor.target.environmentId),
);

/** A Kin read as an effect, through the command's scope check, on the session's own host. */
export function kinGuardedRead<Input, A, E>(command: {
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

/** What one app adds to the shared Kin client. Everything else is the same on web and phone. */
export interface KinClientPlatform<R> {
  /**
   * The device cache the chat list and each chat load from and save to (the phone's). Nothing else
   * is kept on a device: memory, docs and Work may be the owner's alone, and old counts mislead.
   */
  readonly cacheStream?: <A, E, R2>(stream: Stream.Stream<A, E, R2>) => Stream.Stream<A, E, R2 | R>;
  /** After each directory answer: the phone keeps it, and its identity, on the device. */
  readonly onOrgs?: (
    environmentId: EnvironmentId,
    result: KinOrgsListResult,
  ) => Effect.Effect<void, never, R>;
  /** The phone's Clients shows each project's task counts from `workChoices`, so any change moves it. */
  readonly choicesFollowTasks?: boolean;
}

/**
 * Kin's reads and commands for one app: atoms, refresh triggers and single-flight keys, made once
 * on that app's connection runtime and registry. The host decides every permission; a command's
 * `permissionAtom` only hides what it would refuse.
 */
export function makeKinClient<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  registry: AtomRegistry.AtomRegistry,
  platform: KinClientPlatform<R> = {},
) {
  // Kin reads are client-guarded too, so they go through the command's scope check.
  const orgsRead = createKinRpcCommand(runtime, {
    label: "kin:orgs:read",
    tag: KIN_CHAT_WS_METHODS.orgsList,
  });
  const historyRead = createKinRpcCommand(runtime, {
    label: "kin:history:read",
    tag: KIN_CHAT_WS_METHODS.chatHistory,
  });

  const approverKeysRead = createKinRpcCommand(runtime, {
    label: "kin:approver-keys:read",
    tag: KIN_APPROVAL_WS_METHODS.listKeys,
  });
  const readApproverKeys = kinGuardedRead(approverKeysRead);

  const leadsRead = createKinRpcCommand(runtime, {
    label: "kin:leads:read",
    tag: "kin.leads.list",
  });

  const leadAccessRead = createKinRpcCommand(runtime, {
    label: "kin:lead-access:read",
    tag: "kin.lead.access.list",
  });
  const readLeadAccess = kinGuardedRead(leadAccessRead);

  const agentPageRead = createKinRpcCommand(runtime, {
    label: "kin:agent-page:read",
    tag: "kin.lead.page",
  });
  const readAgentPage = kinGuardedRead(agentPageRead);

  const agentDefaultsRead = createKinRpcCommand(runtime, {
    label: "kin:agent-defaults:read",
    tag: "kin.agents.defaults",
  });
  const readAgentDefaults = kinGuardedRead(agentDefaultsRead);

  const visualHostsRead = createKinRpcCommand(runtime, {
    label: "kin:visual-hosts:read",
    tag: "kin.visuals.hosts.list",
  });
  const readVisualHosts = kinGuardedRead(visualHostsRead);

  const connectionsRead = createKinRpcCommand(runtime, {
    label: "kin:connections:read",
    tag: "kin.connections.list",
  });
  const readConnections = kinGuardedRead(connectionsRead);
  const connectionRead = createKinRpcCommand(runtime, {
    label: "kin:connection:read",
    tag: "kin.connections.get",
  });
  const readConnection = kinGuardedRead(connectionRead);
  const connectionCallsRead = createKinRpcCommand(runtime, {
    label: "kin:connection-calls:read",
    tag: "kin.connections.calls",
  });
  const readConnectionCalls = kinGuardedRead(connectionCallsRead);
  const githubRead = createKinRpcCommand(runtime, {
    label: "kin:github:read",
    tag: "kin.github.connect.status",
  });
  const readGitHub = kinGuardedRead(githubRead);
  const githubReposRead = createKinRpcCommand(runtime, {
    label: "kin:github-repos:read",
    tag: "kin.github.repos",
  });
  const readGitHubRepos = kinGuardedRead(githubReposRead);
  const socialRead = createKinRpcCommand(runtime, {
    label: "kin:social:read",
    tag: "kin.social.list",
  });
  const readSocial = kinGuardedRead(socialRead);

  const membersRead = createKinRpcCommand(runtime, {
    label: "kin:chat-members:read",
    tag: KIN_CHAT_WS_METHODS.chatMembers,
  });
  const readMembers = kinGuardedRead(membersRead);
  const peopleRead = createKinRpcCommand(runtime, {
    label: "kin:people:read",
    tag: KIN_PEOPLE_WS_METHODS.peopleList,
  });
  const readPeople = kinGuardedRead(peopleRead);
  const invitesRead = createKinRpcCommand(runtime, {
    label: "kin:invites:read",
    tag: KIN_PEOPLE_WS_METHODS.peopleListInvites,
  });
  const readInvites = kinGuardedRead(invitesRead);
  const devicesRead = createKinRpcCommand(runtime, {
    label: "kin:devices:read",
    tag: KIN_PEOPLE_WS_METHODS.peopleListDevices,
  });
  const readDevices = kinGuardedRead(devicesRead);
  const profilesRead = createKinRpcCommand(runtime, {
    label: "kin:profiles:read",
    tag: KIN_PEOPLE_WS_METHODS.peopleProfiles,
  });
  const readProfiles = kinGuardedRead(profilesRead);
  const tasksKeysRead = createKinRpcCommand(runtime, {
    label: "kin:tasks-keys:read",
    tag: "kin.tasksKeys.list",
  });
  const readTasksKeys = kinGuardedRead(tasksKeysRead);
  const recommendationsRead = createKinRpcCommand(runtime, {
    label: "kin:recommendations:read",
    tag: "kin.recommendations.list",
  });
  const readRecommendations = kinGuardedRead(recommendationsRead);

  const memoryRead = createKinRpcCommand(runtime, {
    label: "kin:memory:read",
    tag: "kin.memory.list",
  });
  const readMemory = kinGuardedRead(memoryRead);
  const budgetRead = createKinRpcCommand(runtime, {
    label: "kin:budget:read",
    tag: "kin.budget.get",
  });
  const readBudget = kinGuardedRead(budgetRead);
  const pulseRead = createKinRpcCommand(runtime, {
    label: "kin:pulse:read",
    tag: "kin.pulse.read",
  });
  const readPulse = kinGuardedRead(pulseRead);
  const goalsRead = createKinRpcCommand(runtime, {
    label: "kin:goals:read",
    tag: "kin.goals.list",
  });
  const readGoals = kinGuardedRead(goalsRead);
  const checkInsRead = createKinRpcCommand(runtime, {
    label: "kin:checkIns:read",
    tag: "kin.checkIns.list",
  });
  const readCheckIns = kinGuardedRead(checkInsRead);

  const workSummaryRead = createKinRpcCommand(runtime, {
    label: "kin:work:summary:read",
    tag: "kin.work.summary",
  });
  const readWorkSummary = kinGuardedRead(workSummaryRead);
  const workListRead = createKinRpcCommand(runtime, {
    label: "kin:work:list:read",
    tag: "kin.work.list",
    execute: kinWorkListLean,
  });
  const readWorkList = kinGuardedRead(workListRead);
  const workItemRead = createKinRpcCommand(runtime, {
    label: "kin:work:item:read",
    tag: "kin.work.get",
  });
  const readWorkItem = kinGuardedRead(workItemRead);
  const workZoneRead = createKinRpcCommand(runtime, {
    label: "kin:work:zone:read",
    tag: "kin.triggers.getTimeZone",
  });
  const readWorkZone = kinGuardedRead(workZoneRead);
  const workClientsRead = createKinRpcCommand(runtime, {
    label: "kin:work:clients:read",
    tag: "kin.work.parties",
  });
  const readWorkClients = kinGuardedRead(workClientsRead);
  const workClientRead = createKinRpcCommand(runtime, {
    label: "kin:work:client:read",
    tag: "kin.work.party",
  });
  const readWorkClient = kinGuardedRead(workClientRead);
  const workProjectsRead = createKinRpcCommand(runtime, {
    label: "kin:work:projects:read",
    tag: "kin.work.projects",
  });
  const readWorkProjects = kinGuardedRead(workProjectsRead);
  const workProjectRead = createKinRpcCommand(runtime, {
    label: "kin:work:project:read",
    tag: "kin.work.project",
  });
  const readWorkProject = kinGuardedRead(workProjectRead);
  const workHistoryRead = createKinRpcCommand(runtime, {
    label: "kin:work:history:read",
    tag: "kin.work.history",
  });

  const workListsRead = createKinRpcCommand(runtime, {
    label: "kin:work:lists:read",
    tag: "kin.work.lists",
  });
  const readWorkLists = kinGuardedRead(workListsRead);
  const workMoneyRead = createKinRpcCommand(runtime, {
    label: "kin:work:money:read",
    tag: "kin.work.money",
  });
  const readWorkMoney = kinGuardedRead(workMoneyRead);
  const workCashRead = createKinRpcCommand(runtime, {
    label: "kin:work:cash:read",
    tag: "kin.work.cash",
  });
  const readWorkCash = kinGuardedRead(workCashRead);
  const workOutlookRead = createKinRpcCommand(runtime, {
    label: "kin:work:outlook:read",
    tag: "kin.work.outlook",
  });
  const readWorkOutlook = kinGuardedRead(workOutlookRead);
  const workBudgetsRead = createKinRpcCommand(runtime, {
    label: "kin:work:budgets:read",
    tag: "kin.work.budgets",
  });
  const readWorkBudgets = kinGuardedRead(workBudgetsRead);
  const workDatesRead = createKinRpcCommand(runtime, {
    label: "kin:work:dates:read",
    tag: "kin.work.dates",
  });
  const companyProfileRead = createKinRpcCommand(runtime, {
    label: "kin:company:read",
    tag: "kin.work.companyProfile",
  });
  const readCompanyProfile = kinGuardedRead(companyProfileRead);
  const receiptsRead = createKinRpcCommand(runtime, {
    label: "kin:work:receipts:read",
    tag: "kin.work.receipts",
  });
  const readReceipts = kinGuardedRead(receiptsRead);
  const recipesRead = createKinRpcCommand(runtime, {
    label: "kin:docs:recipes:read",
    tag: "kin.docs.recipes",
  });
  const readRecipes = kinGuardedRead(recipesRead);

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
  const retryKinWorkLive = (environmentId: EnvironmentId, orgId: KinOrgId) =>
    Effect.runSync(PubSub.publish(workRetriesOf(environmentId, orgId), undefined));

  /** Work's change number and counts, kept current by the host's own announcements. */
  const workLive = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: KIN_WORK_LABEL,
    subscribe: (input: KinWorkSubscribeInput) =>
      kinWorkLiveStream(
        input,
        (summaryInput) =>
          readWorkSummary(summaryInput).pipe(
            Effect.provideService(AtomRegistry.AtomRegistry, registry),
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
  const kinWorkRefreshOn = createKinWorkRefreshTriggers(runtime, workLive);

  const workFilesRead = createKinRpcCommand(runtime, {
    label: "kin:work:files:read",
    tag: "kin.work.files",
  });
  const docsListRead = createKinRpcCommand(runtime, {
    label: "kin:docs:list:read",
    tag: "kin.docs.list",
    execute: kinDocsListLean,
  });
  const readDocsList = kinGuardedRead(docsListRead);
  const docRead = createKinRpcCommand(runtime, {
    label: "kin:docs:doc:read",
    tag: "kin.docs.get",
  });
  const readDoc = kinGuardedRead(docRead);
  const docDiffRead = createKinRpcCommand(runtime, {
    label: "kin:docs:diff:read",
    tag: "kin.docs.diff",
  });
  const readDocDiff = kinGuardedRead(docDiffRead);

  /** A read refreshed whenever the host says its topic changed; a reconnect resumes it. */
  const kinRefreshOn = createKinRefreshTriggers(runtime);
  const syncKinOwnerTimeZone = createKinOwnerTimeZoneSync(runtime);
  const readOrgs = kinGuardedRead(orgsRead);
  const readLeads = kinGuardedRead(leadsRead);
  const readHistory = kinGuardedRead(historyRead);

  // Hosts that answered `kin.orgs.list` this run, plus a saved host. Their `unavailable` is an
  // outage to wait out; `disabled` is how a host says Kin is off.
  const knownKinHosts = new Set<EnvironmentId>();
  const markKinHostKnown = (environmentId: EnvironmentId) => {
    knownKinHosts.add(environmentId);
  };
  const cached = platform.cacheStream ?? (<A, E, R2>(stream: Stream.Stream<A, E, R2>) => stream);

  /** Who is in a chat, by name: a group's authors, mentions and details. */
  const chatMembers = createKinQueryAtomFamily(runtime, {
    label: "kin:chat-members",
    execute: Effect.fn("KinClient.chatMembers")(function* (input: KinChatMembersInput) {
      return yield* readMembers(input);
    }),
    staleTimeMs: 30_000,
    refreshTrigger: createKinDirectoryTrigger(runtime, "people"),
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
                registry.refresh(chatMembers({ environmentId, input: { chatId } }));
              }),
            ),
          );
        }),
      );

  const chatStream = makeKinChatStream(
    (input) => readHistory(input).pipe(Effect.provideService(AtomRegistry.AtomRegistry, registry)),
    kinAccessMoves(runtime, registry),
  );

  /** The viewer's own leads, and the leads of others they may message. */
  const leads = createKinQueryAtomFamily(runtime, {
    label: "kin:leads",
    execute: Effect.fn("KinClient.leads")(function* (input: KinLeadsListInput) {
      return yield* readLeads(input);
    }),
    staleTimeMs: 30_000,
    // A lead's In hand line reads its tracked tasks, which move with Work, not with `leads`.
    refreshTrigger: kinWorkRefreshOn(["work"], kinRefreshOn("leads")),
  });

  /** The same list with the owner's retired agents after the live ones. Only the owner asks. */
  const withRetired = (orgId: KinOrgId): KinLeadsListInput => ({ orgId, includeRetired: true });

  /** Both lead lists are read again: the one pickers use, and the owner's with retired agents. */
  const refreshLeads = (environmentId: EnvironmentId, orgId: KinOrgId) => {
    registry.refresh(leads({ environmentId, input: { orgId } }));
    registry.refresh(leads({ environmentId, input: withRetired(orgId) }));
  };

  /** Being let message a lead, or losing that, changes what `kin.leads.list` answers. */
  const rereadLeadsOnChange = onKinDirectChatsChange((environmentId, orgIds) => {
    // A new direct chat may be with an agent the directory hasn't named yet.
    registry.refresh(kinClient.orgs({ environmentId, input: {} }));
    for (const orgId of orgIds) refreshLeads(environmentId, orgId);
  });

  /** Web's Kin reads and commands. Mobile's twin adds the device cache and push. */
  const kinClient = {
    orgs: createKinQueryAtomFamily(runtime, {
      label: "kin:orgs",
      execute: Effect.fn("KinClient.orgs")(function* (input: KinOrgsListInput) {
        const environmentId = yield* currentEnvironmentId;
        const result = yield* retryKinProbe(readOrgs(input), () =>
          knownKinHosts.has(environmentId),
        );
        markKinHostKnown(environmentId);
        noteKinDirectoryOrgs(
          registry,
          environmentId,
          result.orgs.map((org) => org.orgId),
        );
        if (platform.onOrgs !== undefined) yield* platform.onOrgs(environmentId, result);
        syncKinOwnerTimeZone(
          registry,
          environmentId,
          result.me.map((me) => me.orgId),
        );
        return result;
      }),
      staleTimeMs: 60_000,
      // A failed probe reruns when the next session comes up, not only after the stale time; agent
      // names come from here, so it is read again when an org's agents change too.
      refreshTrigger: createKinDirectoryTrigger(runtime),
    }),
    leads,
    /** The org's keys that can approve, and recent changes; a phone finds its own by thumbprint. */
    approverKeys: createEnvironmentQueryAtomFamily(runtime, {
      label: "kin:approver-keys",
      execute: Effect.fn("KinClient.approverKeys")(function* (input: KinApprovalsOrgInput) {
        return yield* readApproverKeys(input);
      }),
      staleTimeMs: 10_000,
      // Not kept across sessions: a reconnect reads it again once, by itself.
    }),
    approverKeysRead,
    approverKeyRevoke: createKinRpcCommand(runtime, {
      label: "kin:approver-key:revoke",
      tag: KIN_APPROVAL_WS_METHODS.revokeKey,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.thumbprint },
    }),
    leadCreate: createKinRpcCommand(runtime, {
      label: "kin:lead:create",
      tag: "kin.lead.create",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.name}` },
    }),
    leadUpdate: createKinRpcCommand(runtime, {
      label: "kin:lead:update",
      tag: "kin.lead.update",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
    }),
    /** The owner's agents with the retired ones last. Read only where `leadRetire` is permitted. */
    agents: (target: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) =>
      leads({ environmentId: target.environmentId, input: withRetired(target.orgId) }),
    /** Stops the agent's work and holds its timers; its chats, memory and tasks stay. */
    leadRetire: createKinRpcCommand(runtime, {
      label: "kin:lead:retire",
      tag: "kin.lead.retire",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
    }),
    leadRestore: createKinRpcCommand(runtime, {
      label: "kin:lead:restore",
      tag: "kin.lead.restore",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
    }),
    /** One agent's whole page, for owner-level people. */
    agentPage: createKinQueryAtomFamily(runtime, {
      label: "kin:agent-page",
      execute: Effect.fn("KinClient.agentPage")(function* (input: KinAgentPageInput) {
        return yield* readAgentPage(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinWorkRefreshOn(["work"], kinRefreshOn("leads")),
    }),
    agentDefaults: createKinQueryAtomFamily(runtime, {
      label: "kin:agent-defaults",
      execute: Effect.fn("KinClient.agentDefaults")(function* (input: KinAgentDefaultsInput) {
        return yield* readAgentDefaults(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("leads"),
    }),
    agentDefaultsSet: createKinRpcCommand(runtime, {
      label: "kin:agent-defaults:set",
      tag: "kin.agents.defaults.set",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
    }),
    characterSet: createKinRpcCommand(runtime, {
      label: "kin:lead:character",
      tag: "kin.lead.character.set",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
    }),
    leadPause: createKinRpcCommand(runtime, {
      label: "kin:lead:pause",
      tag: "kin.lead.pause",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
    }),
    leadResume: createKinRpcCommand(runtime, {
      label: "kin:lead:resume",
      tag: "kin.lead.resume",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.agentId },
    }),
    /** Who besides the owner may message one of the owner's leads. */
    leadAccess: createKinQueryAtomFamily(runtime, {
      label: "kin:lead-access",
      execute: Effect.fn("KinClient.leadAccess")(function* (input: KinLeadAccessInput) {
        return yield* readLeadAccess(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("leads"),
    }),
    /** The owner's connections to outside services, live on the host's `connections` topic. */
    connections: createKinQueryAtomFamily(runtime, {
      label: "kin:connections",
      execute: Effect.fn("KinClient.connections")(function* (input: KinConnectionsInput) {
        return yield* readConnections(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("connections"),
    }),
    connection: createKinQueryAtomFamily(runtime, {
      label: "kin:connection",
      execute: Effect.fn("KinClient.connection")(function* (input: KinConnectionRef) {
        return yield* readConnection(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("connections"),
    }),
    connectionCalls: createKinQueryAtomFamily(runtime, {
      label: "kin:connection-calls",
      execute: Effect.fn("KinClient.connectionCalls")(function* (input: KinConnectionCallsInput) {
        return yield* readConnectionCalls(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("connections"),
    }),
    /** The owner's own GitHub login on the host; live on the `connections` topic. */
    github: createKinQueryAtomFamily(runtime, {
      label: "kin:github",
      execute: Effect.fn("KinClient.github")(function* (input: KinGitHubInput) {
        return yield* readGitHub(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("connections"),
    }),
    /** The repos Kin watches with that login, each with the owner's switch. */
    githubRepos: createEnvironmentQueryAtomFamily(runtime, {
      label: "kin:github-repos",
      execute: Effect.fn("KinClient.githubRepos")(function* (input: KinGitHubInput) {
        return yield* readGitHubRepos(input);
      }),
      staleTimeMs: 30_000,
    }),
    githubReposSet: createKinRpcCommand(runtime, {
      label: "kin:github-repos:set",
      tag: "kin.github.repos.set",
    }),
    githubAppCreate: createKinRpcCommand(runtime, {
      label: "kin:github-app:create",
      tag: "kin.github.app.create",
    }),
    githubAppDisconnect: createKinRpcCommand(runtime, {
      label: "kin:github-app:disconnect",
      tag: "kin.github.app.disconnect",
    }),
    githubAppReposSet: createKinRpcCommand(runtime, {
      label: "kin:github-app-repos:set",
      tag: "kin.github.app.repos.set",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:github-app` },
    }),
    githubGuardSet: createKinRpcCommand(runtime, {
      label: "kin:github-guard:set",
      tag: "kin.github.guard.set",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:github-guard` },
    }),
    /** Starts the code sign-in, or connects with a pasted token, which travels once, redacted. */
    githubStart: createKinRpcCommand(runtime, {
      label: "kin:github:start",
      tag: "kin.github.connect.start",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:github` },
    }),
    githubCancel: createKinRpcCommand(runtime, {
      label: "kin:github:cancel",
      tag: "kin.github.connect.cancel",
    }),
    githubDisconnect: createKinRpcCommand(runtime, {
      label: "kin:github:disconnect",
      tag: "kin.github.disconnect",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:github` },
    }),
    /** The company's and clients' social accounts; owner-level only. */
    social: createKinQueryAtomFamily(runtime, {
      label: "kin:social",
      execute: Effect.fn("KinClient.social")(function* (input: KinSocialInput) {
        return yield* readSocial(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("connections"),
    }),
    /** Reads what a pasted key reaches; the key travels once, redacted, and Kin holds it until Confirm. */
    socialCheck: createKinRpcCommand(runtime, {
      label: "kin:social:check",
      tag: "kin.social.check",
    }),
    socialConnect: createKinRpcCommand(runtime, {
      label: "kin:social:connect",
      tag: "kin.social.connect",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:social` },
    }),
    socialRefresh: createKinRpcCommand(runtime, {
      label: "kin:social:refresh",
      tag: "kin.social.refresh",
    }),
    socialRemove: createKinRpcCommand(runtime, {
      label: "kin:social:remove",
      tag: "kin.social.remove",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:social` },
    }),
    socialLink: createKinRpcCommand(runtime, {
      label: "kin:social:link",
      tag: "kin.social.link",
    }),
    /** Adds a connection; the key travels once, redacted, and is never sent back. */
    connectionAdd: createKinRpcCommand(runtime, {
      label: "kin:connection:add",
      tag: "kin.connections.add",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:add` },
    }),
    connectionSetKey: createKinRpcCommand(runtime, {
      label: "kin:connection:setKey",
      tag: "kin.connections.setKey",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
    }),
    connectionRefresh: createKinRpcCommand(runtime, {
      label: "kin:connection:refreshTools",
      tag: "kin.connections.refreshTools",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
    }),
    connectionSetToolModes: createKinRpcCommand(runtime, {
      label: "kin:connection:setToolModes",
      tag: "kin.connections.setToolModes",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
    }),
    connectionAccept: createKinRpcCommand(runtime, {
      label: "kin:connection:acceptToolChanges",
      tag: "kin.connections.acceptToolChanges",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
    }),
    connectionUpdate: createKinRpcCommand(runtime, {
      label: "kin:connection:update",
      tag: "kin.connections.update",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
    }),
    connectionSetReach: createKinRpcCommand(runtime, {
      label: "kin:connection:setReach",
      tag: "kin.connections.setReach",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
    }),
    connectionRemove: createKinRpcCommand(runtime, {
      label: "kin:connection:remove",
      tag: "kin.connections.remove",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.connectionId },
    }),
    /** Starts a sign-in; the host keeps the secret half and answers with the page to open. */
    connectionSignInStart: createKinRpcCommand(runtime, {
      label: "kin:connection:signInStart",
      tag: "kin.connections.signInStart",
    }),
    connectionSignInFinish: createKinRpcCommand(runtime, {
      label: "kin:connection:signInFinish",
      tag: "kin.connections.signInFinish",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:signIn` },
    }),
    connectionSetSignInClient: createKinRpcCommand(runtime, {
      label: "kin:connection:setSignInClient",
      tag: "kin.connections.setSignInClient",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:client` },
    }),
    /** A person sends a mail card's mail with their own edits, as a Confirm. */
    connectionSendEdited: createKinRpcCommand(runtime, {
      label: "kin:connection:sendEdited",
      tag: "kin.connections.sendEdited",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.widgetId },
    }),
    /** A person keeps their edits on a mail card without sending, or puts the agent's draft back. */
    connectionSaveEdited: createKinRpcCommand(runtime, {
      label: "kin:connection:saveEdited",
      tag: "kin.connections.saveEdited",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.widgetId },
    }),
    /** The owner switches an open send card's From before Confirm. */
    connectionSetSendFrom: createKinRpcCommand(runtime, {
      label: "kin:connection:setSendFrom",
      tag: "kin.connections.setSendFrom",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.widgetId },
    }),
    /** The outside hosts the owner lets visuals load from. Owner only. */
    visualHosts: createKinQueryAtomFamily(runtime, {
      label: "kin:visual-hosts",
      execute: Effect.fn("KinClient.visualHosts")(function* (input: KinVisualHostsInput) {
        return yield* readVisualHosts(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("visualHosts"),
    }),
    visualHostAllow: createKinRpcCommand(runtime, {
      label: "kin:visual-hosts:allow",
      tag: "kin.visuals.hosts.allow",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.host}` },
    }),
    visualHostRemove: createKinRpcCommand(runtime, {
      label: "kin:visual-hosts:remove",
      tag: "kin.visuals.hosts.remove",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.host}` },
    }),
    leadAllow: createKinRpcCommand(runtime, {
      label: "kin:lead-access:allow",
      tag: "kin.lead.access.grant",
      concurrency: {
        mode: "singleFlight",
        key: ({ input }) => `${input.agentId}:${input.personId}`,
      },
    }),
    leadDisallow: createKinRpcCommand(runtime, {
      label: "kin:lead-access:disallow",
      tag: "kin.lead.access.revoke",
      concurrency: {
        mode: "singleFlight",
        key: ({ input }) => `${input.agentId}:${input.personId}`,
      },
    }),
    chatMembers,
    /** The people of the org, for choosing who joins a group or may message a lead. */
    people: createKinQueryAtomFamily(runtime, {
      label: "kin:people",
      execute: Effect.fn("KinClient.people")(function* (input: KinPeopleListInput) {
        return yield* readPeople(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("people"),
    }),
    /** Everyone's profile; any person of the org reads them. */
    profiles: createKinQueryAtomFamily(runtime, {
      label: "kin:profiles",
      execute: Effect.fn("KinClient.profiles")(function* (input: KinPeopleListInput) {
        return yield* readProfiles(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("people"),
    }),
    profileUpdate: createKinRpcCommand(runtime, {
      label: "kin:profile:update",
      tag: KIN_PEOPLE_WS_METHODS.peopleUpdateProfile,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
    }),
    /** A person's live coding agent keys: their own, or anyone's for the owner level. */
    tasksKeys: createKinQueryAtomFamily(runtime, {
      label: "kin:tasks-keys",
      execute: Effect.fn("KinClient.tasksKeys")(function* (input: KinTasksKeysListInput) {
        return yield* readTasksKeys(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("people"),
    }),
    /**
     * What Kin suggested to the owner and what came of each: his alone. Read again when a
     * suggestion moves, or a setting a done row reads live does: an agent, the limit, a connection.
     */
    recommendations: createKinQueryAtomFamily(runtime, {
      label: "kin:recommendations",
      execute: Effect.fn("KinClient.recommendations")(function* (input: KinRecommendationsInput) {
        return yield* readRecommendations(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: KinRecommendationsInput;
      }) =>
        Atom.make(
          (get) =>
            `${get(kinRefreshOn("recommendations")(target))}|${get(kinRefreshOn("leads")(target))}|${get(kinRefreshOn("budget")(target))}|${get(kinRefreshOn("connections")(target))}`,
        ),
    }),
    /** Its `permissionAtom` is whether Settings shows Recommendations at all. */
    recommendationAskAgain: createKinRpcCommand(runtime, {
      label: "kin:recommendation:ask-again",
      tag: "kin.recommendations.askAgain",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.recId },
    }),
    /** Makes a key for the caller. The answer carries the secret once; nothing here keeps it. */
    tasksKeyIssue: createKinRpcCommand(runtime, {
      label: "kin:tasks-key:issue",
      tag: "kin.tasksKeys.issue",
    }),
    tasksKeyRevoke: createKinRpcCommand(runtime, {
      label: "kin:tasks-key:revoke",
      tag: "kin.tasksKeys.revoke",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.sessionId },
    }),
    teamAgentSet: createKinRpcCommand(runtime, {
      label: "kin:team-agent:set",
      tag: KIN_PEOPLE_WS_METHODS.orgSetTeamAgent,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
    }),
    /** The invite links nobody has opened yet. The owner's Team page reads them. */
    invites: createKinQueryAtomFamily(runtime, {
      label: "kin:invites",
      execute: Effect.fn("KinClient.invites")(function* (input: KinPeopleListInput) {
        return yield* readInvites(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("people"),
    }),
    /** A person's signed-in devices: their own, or a teammate's for the owner level. */
    devices: createKinQueryAtomFamily(runtime, {
      label: "kin:devices",
      execute: Effect.fn("KinClient.devices")(function* (input: KinPeopleListDevicesInput) {
        return yield* readDevices(input);
      }),
      staleTimeMs: 15_000,
      refreshTrigger: kinRefreshOn("people"),
    }),
    deviceRemove: createKinRpcCommand(runtime, {
      label: "kin:device:remove",
      tag: KIN_PEOPLE_WS_METHODS.peopleRevokeDevice,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.sessionId },
    }),
    /** A code and link for one more of your own devices; shown once, kept nowhere. */
    deviceLink: createKinRpcCommand(runtime, {
      label: "kin:device:link",
      tag: KIN_PEOPLE_WS_METHODS.peopleLinkDevice,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
    }),
    /** Makes a teammate's link. The answer carries the secret once; nothing here keeps it. */
    inviteCreate: createKinRpcCommand(runtime, {
      label: "kin:invite:create",
      tag: KIN_PEOPLE_WS_METHODS.peopleCreateInvite,
    }),
    inviteCancel: createKinRpcCommand(runtime, {
      label: "kin:invite:cancel",
      tag: KIN_PEOPLE_WS_METHODS.peopleRevokeInvite,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.inviteId },
    }),
    personRemoveAccess: createKinRpcCommand(runtime, {
      label: "kin:person:remove-access",
      tag: KIN_PEOPLE_WS_METHODS.peopleRemoveAccess,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
    }),
    /** The owner makes someone a co-owner or a member again. */
    personSetAccess: createKinRpcCommand(runtime, {
      label: "kin:person:set-access",
      tag: KIN_PEOPLE_WS_METHODS.peopleSetAccess,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
    }),
    /** The owner turns a member's Clients, Docs and Money on or off. */
    personSetPlaces: createKinRpcCommand(runtime, {
      label: "kin:person:set-places",
      tag: KIN_PEOPLE_WS_METHODS.peopleSetPlaces,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
    }),
    chatWithPerson: createKinRpcCommand(runtime, {
      label: "kin:chat:with-person",
      tag: "kin.chats.withPerson",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.personId },
    }),
    groupCreate: createKinRpcCommand(runtime, {
      label: "kin:group:create",
      tag: "kin.groups.create",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.title}` },
    }),
    groupAddMember: createKinRpcCommand(runtime, {
      label: "kin:group:add-member",
      tag: "kin.groups.addMember",
    }),
    groupRemoveMember: createKinRpcCommand(runtime, {
      label: "kin:group:remove-member",
      tag: "kin.groups.removeMember",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.memberId },
    }),
    groupSetLead: createKinRpcCommand(runtime, {
      label: "kin:group:set-lead",
      tag: "kin.groups.setLead",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
    }),
    groupRename: createKinRpcCommand(runtime, {
      label: "kin:group:rename",
      tag: "kin.groups.rename",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
    }),
    groupSetCompany: createKinRpcCommand(runtime, {
      label: "kin:group:set-company",
      tag: "kin.groups.setCompany",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
    }),
    groupDelete: createKinRpcCommand(runtime, {
      label: "kin:group:delete",
      tag: "kin.groups.delete",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
    }),
    mute: createKinRpcCommand(runtime, {
      label: "kin:mute",
      tag: KIN_CHAT_WS_METHODS.chatsMute,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
    }),
    /** Empties this chat for everyone in it, for good; one in flight per chat. */
    clear: createKinRpcCommand(runtime, {
      label: "kin:clear",
      tag: KIN_CHAT_WS_METHODS.chatsClear,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.chatId },
    }),
    /** What a clear would leave, asked when its confirm opens; changes nothing. */
    clearPreview: createKinRpcCommand(runtime, {
      label: "kin:clear-preview",
      tag: KIN_CHAT_WS_METHODS.chatsClear,
      concurrency: { mode: "singleFlight", key: ({ input }) => `preview:${input.chatId}` },
    }),
    inbox: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: KIN_INBOX_LABEL,
      subscribe: (input: Parameters<typeof kinInboxStream>[0]) =>
        cached(kinInboxStream(input)).pipe(rereadLeadsOnChange),
    }),
    chat: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: KIN_CHAT_LABEL,
      subscribe: (input: { readonly chatId: KinChatId }) =>
        cached(chatStream(input)).pipe(rereadMembersOnChange(input.chatId)),
    }),
    /** One "Load earlier" page, read fresh every time so a retry after a failure refetches. */
    readHistoryPage: (environmentId: EnvironmentId, input: KinChatHistoryInput) =>
      Effect.runPromiseExit(
        Effect.promise(() => historyRead.run(registry, { environmentId, input })).pipe(
          Effect.flatMap((result) =>
            result._tag === "Success"
              ? Effect.succeed(result.value)
              : Effect.failCause(result.cause),
          ),
          Effect.timeout(KIN_HISTORY_PAGE_TIMEOUT),
        ),
      ),
    send: createKinRpcCommand(runtime, {
      label: "kin:send",
      tag: KIN_CHAT_WS_METHODS.messagesSend,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientMessageId },
    }),
    leadInterrupt: createKinRpcCommand(runtime, {
      label: "kin:lead:interrupt",
      tag: "kin.lead.interrupt",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.wakeupId },
    }),
    markRead: createKinRpcCommand(runtime, {
      label: "kin:mark-read",
      tag: KIN_CHAT_WS_METHODS.messagesMarkRead,
    }),
    widgetAction: createKinRpcCommand(runtime, {
      label: "kin:widget-action",
      tag: KIN_CHAT_WS_METHODS.widgetsAct,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientActionId },
    }),
    react: createKinRpcCommand(runtime, {
      label: "kin:react",
      tag: KIN_CHAT_WS_METHODS.messagesReact,
      concurrency: {
        mode: "singleFlight",
        key: ({ input }) => `${input.messageId}|${input.emoji}`,
      },
    }),
    /** A locked statement's password, once and redacted; never a message the lead reads. */
    statementUnlock: createKinRpcCommand(runtime, {
      label: "kin:statement:unlock",
      tag: "kin.work.statementUnlock",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
    }),
    statementForgetPassword: createKinRpcCommand(runtime, {
      label: "kin:statement:forget-password",
      tag: "kin.work.statementForgetPassword",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
    }),
    /** One tap on a review card, in order: the server keeps the selection Confirm applies. */
    statementSelect: createKinRpcCommand(runtime, {
      label: "kin:statement:select",
      tag: "kin.work.statementSelect",
      concurrency: { mode: "serial", key: ({ input }) => input.statementId },
    }),
    /** More of a section's rows than the card carries. */
    statementRows: createKinRpcCommand(runtime, {
      label: "kin:statement:rows",
      tag: "kin.work.statementRows",
      concurrency: {
        mode: "singleFlight",
        key: ({ input }) => `${input.statementId}:${input.section}:${input.offset}`,
      },
    }),
    /** Applies the selection the server keeps for this review, at the revision the owner saw. */
    statementApply: createKinRpcCommand(runtime, {
      label: "kin:statement:apply",
      tag: "kin.work.statementApply",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
    }),
    statementUndo: createKinRpcCommand(runtime, {
      label: "kin:statement:undo",
      tag: "kin.work.statementUndo",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
    }),
    statementReread: createKinRpcCommand(runtime, {
      label: "kin:statement:reread",
      tag: "kin.work.statementReread",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.statementId },
    }),
    memoryUndo: createKinRpcCommand(runtime, {
      label: "kin:memory:undo",
      tag: "kin.memory.undo",
      concurrency: {
        mode: "singleFlight",
        key: ({ input }) => `${input.widgetId}:${input.itemId}`,
      },
    }),
    /** What the owner's leads remember, and who may know each thing. */
    memory: createKinQueryAtomFamily(runtime, {
      label: "kin:memory",
      execute: Effect.fn("KinClient.memory")(function* (input: KinMemoryListInput) {
        return yield* readMemory(input);
      }),
      staleTimeMs: 60_000,
      refreshTrigger: kinRefreshOn("memory"),
    }),
    memorySetVisibility: createKinRpcCommand(runtime, {
      label: "kin:memory:set-visibility",
      tag: "kin.memory.setVisibility",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.itemId },
    }),
    memoryConfirm: createKinRpcCommand(runtime, {
      label: "kin:memory:confirm",
      tag: "kin.memory.confirmSuggestions",
    }),
    memoryForget: createKinRpcCommand(runtime, {
      label: "kin:memory:forget",
      tag: "kin.memory.forget",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.itemId },
    }),
    memoryRestore: createKinRpcCommand(runtime, {
      label: "kin:memory:restore",
      tag: "kin.memory.restore",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.itemId },
    }),
    /** Whether agents use team memory in chats with teammates; its `permissionAtom` gates the switch. */
    memorySetTeamMemory: createKinRpcCommand(runtime, {
      label: "kin:memory:team",
      tag: "kin.memory.setTeamMemory",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
    }),
    /** The owner's daily limit. The host announces no change to it, so a set re-reads it here. */
    /** What needs attention, handled ones included; read again whenever the host's facts move. */
    attention: createKinQueryAtomFamily(runtime, {
      label: "kin:pulse",
      execute: Effect.fn("KinClient.attention")(function* (input: KinPulseListInput) {
        return yield* readPulse({ ...input, acceptSenses: KIN_PULSE_LATER_SENSES });
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("pulse"),
    }),
    /** `attention` as the host streams it, for a host that does (`attentionStreamed`). */
    attentionLive: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: KIN_PULSE_LIVE_LABEL,
      subscribe: (input: KinPulseListInput) =>
        kinPulseLiveStream({ ...input, acceptSenses: KIN_PULSE_LATER_SENSES }),
    }),
    /** Whether the host streams Needs attention; null until its refreshes say. */
    attentionStreamed: kinRefreshOn.serves("pulse"),
    /** Everything open for the viewer as the host streams it (`kin.open.subscribe`). */
    openLive: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: KIN_OPEN_LIVE_LABEL,
      subscribe: (input: KinOpenReadInput) =>
        kinOpenLiveStream({ ...input, acceptSenses: KIN_PULSE_LATER_SENSES }),
    }),
    /** Whether the host streams the open list; null until its refreshes say. */
    openStreamed: kinRefreshOn.serves("open"),
    /** Money's parts as the host streams them to the owner level (`useKinMoneyLive`). */
    moneyLive: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: KIN_MONEY_LIVE_LABEL,
      subscribe: kinMoneyLiveStream,
    }),
    /** Whether the host streams Money; null until its refreshes say. */
    moneyStreamed: kinRefreshOn.serves("money"),
    attentionHandle: createKinRpcCommand(runtime, {
      label: "kin:pulse:handle",
      tag: "kin.pulse.handle",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.factKey },
    }),
    /** The company's goals with progress; Work's changes re-read it too (`useKinGoals`). */
    goals: createKinQueryAtomFamily(runtime, {
      label: "kin:goals",
      execute: Effect.fn("KinClient.goals")(function* (input: KinGoalsInput) {
        return yield* readGoals(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinWorkRefreshOn("any", kinRefreshOn("pulse")),
    }),
    goalSave: createKinRpcCommand(runtime, {
      label: "kin:goals:save",
      tag: "kin.goals.save",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.key ?? input.clientRequestId },
    }),
    /** The company's check-ins in the owner's time, for Settings. */
    checkIns: createEnvironmentQueryAtomFamily(runtime, {
      label: "kin:checkIns",
      execute: Effect.fn("KinClient.checkIns")(function* (input: KinCheckInsInput) {
        return yield* readCheckIns(input);
      }),
      staleTimeMs: 30_000,
    }),
    checkInSave: createKinRpcCommand(runtime, {
      label: "kin:checkIns:save",
      tag: "kin.checkIns.save",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.scheduleId ?? "new" },
    }),
    checkInAct: createKinRpcCommand(runtime, {
      label: "kin:checkIns:act",
      tag: "kin.checkIns.act",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.scheduleId },
    }),
    budget: createKinQueryAtomFamily(runtime, {
      label: "kin:budget",
      execute: Effect.fn("KinClient.budget")(function* (input: KinBudgetGetInput) {
        return yield* readBudget(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("budget"),
    }),
    budgetSet: createKinRpcCommand(runtime, {
      label: "kin:budget:set",
      tag: "kin.budget.set",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
    }),
    workLive,
    /** Its `permissionAtom` says whether this session may read Work at all. */
    workRead: workSummaryRead,
    /** One page of a filter; the list's controller decides when. */
    workList: workListRead,
    /** One task with its links and history. */
    workItem: createKinQueryAtomFamily(runtime, {
      label: "kin:work:item",
      execute: Effect.fn("KinClient.workItem")(function* (input: KinWorkGetInput) {
        return yield* readWorkItem(input);
      }),
      staleTimeMs: 30_000,
      // Reads again when the host can't say what changed; the screen's watch follows named changes.
      refreshTrigger: kinWorkRefreshOn([]),
    }),
    /** Where the owner's days begin and end, so an all-day due date reads as the day it was set. */
    workZone: createKinQueryAtomFamily(runtime, {
      label: "kin:work:zone",
      execute: Effect.fn("KinClient.workZone")(function* (input: KinOwnerTimeZoneGetInput) {
        return yield* readWorkZone(input);
      }),
      staleTimeMs: 5 * 60_000,
      refreshTrigger: kinRefreshOn("timeZone"),
    }),
    /** Stores the company's time zone; the owner and co-owners may. */
    timeZoneSet: createKinRpcCommand(runtime, {
      label: "kin:time-zone:set",
      tag: "kin.triggers.setTimeZone",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
    }),
    /** One page of the clients list, or of the projects list; each list's controller decides when. */
    workClients: workClientsRead,
    workProjects: workProjectsRead,
    /** A page of a client's or project's history. */
    workHistory: workHistoryRead,
    /** A client with what is owed each way, its contacts and its projects. */
    workClient: createKinQueryAtomFamily(runtime, {
      label: "kin:work:client",
      execute: Effect.fn("KinClient.workClient")(function* (input: KinPartyPageInput) {
        return yield* readWorkClient(input);
      }),
      staleTimeMs: 30_000,
      // Reads again when the host can't say what changed; the screen's watch follows named changes.
      refreshTrigger: kinWorkRefreshOn([]),
    }),
    /** A project with its health, what is blocked and what changed this week. */
    workProject: createKinQueryAtomFamily(runtime, {
      label: "kin:work:project",
      execute: Effect.fn("KinClient.workProject")(function* (input: KinProjectPageInput) {
        return yield* readWorkProject(input);
      }),
      staleTimeMs: 30_000,
      // Reads again when the host can't say what changed; the screen's watch follows named changes.
      refreshTrigger: kinWorkRefreshOn([]),
    }),
    /** How many clients and open projects there are: the lists' own totals, without their rows. */
    workCounts: createKinQueryAtomFamily(runtime, {
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
    /**
     * The active clients and open projects a task or a project can be put under, by name, and the
     * done projects a late task can still be filed under.
     */
    workChoices: createKinQueryAtomFamily(runtime, {
      label: "kin:work:choices",
      execute: Effect.fn("KinClient.workChoices")(function* (input: { readonly orgId: KinOrgId }) {
        const [clients, projects, done] = yield* Effect.all(
          [
            readWorkClients({ orgId: input.orgId, limit: 100 }),
            readWorkProjects({ orgId: input.orgId, limit: 100 }),
            readWorkProjects({ orgId: input.orgId, state: "done", limit: 100 }),
          ],
          { concurrency: 3 },
        );
        return {
          clients: clients.parties,
          projects: projects.projects,
          doneProjects: done.projects,
        };
      }),
      staleTimeMs: 30_000,
      // Pickers show only names, kinds and states from these rows, which only their own lists move.
      refreshTrigger: kinWorkRefreshOn(
        platform.choicesFollowTasks === true ? "any" : ["clients", "projects"],
        kinRefreshOn("workChoices"),
      ),
    }),
    /** One teammate's open projects, and the open projects they could be put on, by name. */
    teammateProjects: createKinQueryAtomFamily(runtime, {
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
    /**
     * A person's open tasks as the reader may see them, most urgent first, for their page. The
     * host lists by soonest due, so the first page holds the most urgent ones.
     */
    personTasks: createKinQueryAtomFamily(runtime, {
      label: "kin:work:person-tasks",
      execute: Effect.fn("KinClient.personTasks")(function* (input: {
        readonly orgId: KinOrgId;
        readonly person: KinPersonId;
      }) {
        const page = yield* readWorkList({
          orgId: input.orgId,
          owner: { _tag: "person", personId: input.person },
          open: true,
          limit: 20,
        });
        return {
          total: page.total,
          records: kinTasksMostUrgent(page.records, KIN_PERSON_TASKS.shown),
        };
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinWorkRefreshOn(["work"]),
    }),
    workClientCreate: createKinRpcCommand(runtime, {
      label: "kin:work:client:create",
      tag: "kin.work.createParty",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    workClientUpdate: createKinRpcCommand(runtime, {
      label: "kin:work:client:update",
      tag: "kin.work.updateParty",
    }),
    workContactCreate: createKinRpcCommand(runtime, {
      label: "kin:work:contact:create",
      tag: "kin.work.createContact",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    workContactUpdate: createKinRpcCommand(runtime, {
      label: "kin:work:contact:update",
      tag: "kin.work.updateContact",
    }),
    workTouchLog: createKinRpcCommand(runtime, {
      label: "kin:work:touch:log",
      tag: "kin.work.logTouch",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    workTouchRemove: createKinRpcCommand(runtime, {
      label: "kin:work:touch:remove",
      tag: "kin.work.removeTouch",
    }),
    workProjectCreate: createKinRpcCommand(runtime, {
      label: "kin:work:project:create",
      tag: "kin.work.createProject",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    workProjectUpdate: createKinRpcCommand(runtime, {
      label: "kin:work:project:update",
      tag: "kin.work.updateProject",
    }),
    /** Who is on a project; the owner, a co-owner or its lead (the page's `can.people`). */
    workProjectPeople: createKinRpcCommand(runtime, {
      label: "kin:work:project:people",
      tag: "kin.work.projectPeople",
    }),
    /** Docs' change number, kept current by the host's own announcements. */
    docsLive: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: KIN_DOCS_LABEL,
      subscribe: (input: KinDocsSubscribeInput) => kinDocsLiveStream(input),
    }),
    /** One page of docs; the list's controller decides when. Its `permissionAtom` gates Docs. */
    docsList: docsListRead,
    /** The docs linked to one client or one project, on that client's or project's page. */
    docsUnder: createKinQueryAtomFamily(runtime, {
      label: "kin:docs:under",
      execute: Effect.fn("KinClient.docsUnder")(function* (input: KinDocsListInput) {
        return yield* readDocsList(input);
      }),
      staleTimeMs: 30_000,
    }),
    /**
     * How many docs there are and how many changed since `since`: the list's own totals, without
     * its rows. The caller reads again when the docs' change number passes `seq`.
     */
    docsCounts: createKinQueryAtomFamily(runtime, {
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
    }),
    /** A doc at one version, with its outline. */
    doc: createKinQueryAtomFamily(runtime, {
      label: "kin:docs:doc",
      execute: Effect.fn("KinClient.doc")(function* (input: KinDocGetInput) {
        return yield* readDoc(input);
      }),
      staleTimeMs: 30_000,
    }),
    /** What differs between two versions, as a patch. Versions never change, so neither does this. */
    docDiff: createKinQueryAtomFamily(runtime, {
      label: "kin:docs:diff",
      execute: Effect.fn("KinClient.docDiff")(function* (input: KinDocDiffInput) {
        return yield* readDocDiff(input);
      }),
      staleTimeMs: 5 * 60_000,
    }),
    /** A page of a doc's versions, newest first. */
    docHistory: createKinRpcCommand(runtime, {
      label: "kin:docs:history:read",
      tag: "kin.docs.history",
    }),
    docRestore: createKinRpcCommand(runtime, {
      label: "kin:docs:restore",
      tag: "kin.docs.restore",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
    /** One search over tasks, clients, contacts, projects and docs. */
    search: createKinRpcCommand(runtime, {
      label: "kin:search",
      tag: "kin.search",
    }),
    workCreate: createKinRpcCommand(runtime, {
      label: "kin:work:create",
      tag: "kin.work.create",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    workAssign: createKinRpcCommand(runtime, {
      label: "kin:work:assign",
      tag: "kin.work.assign",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
    workUpdate: createKinRpcCommand(runtime, {
      label: "kin:work:update",
      tag: "kin.work.update",
    }),
    /** The holder gives a task back to whoever gave it. */
    workHandBack: createKinRpcCommand(runtime, {
      label: "kin:work:handBack",
      tag: "kin.work.handBack",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
    /** Asks the person holding a task where it stands; once a day per task (`kin.work.nudge`). */
    workNudge: createKinRpcCommand(runtime, {
      label: "kin:work:nudge",
      tag: "kin.work.nudge",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
    /** A note on a task from anyone who sees it, with files they just uploaded. */
    workComment: createKinRpcCommand(runtime, {
      label: "kin:work:comment",
      tag: "kin.work.comment",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    /** Its author takes a comment back, or the owner level any. */
    workCommentRemove: createKinRpcCommand(runtime, {
      label: "kin:work:commentRemove",
      tag: "kin.work.commentRemove",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.commentId },
    }),
    /** A task's comments before the first its sheet carries. */
    workComments: createKinRpcCommand(runtime, {
      label: "kin:work:comments",
      tag: "kin.work.comments",
    }),
    /** "Add a link" on an entry: a web page, by whoever may edit it. */
    workLinkAdd: createKinRpcCommand(runtime, {
      label: "kin:work:linkAdd",
      tag: "kin.work.linkAdd",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.key}:${input.url}` },
    }),
    /** Takes a web page's link off an entry. */
    workLinkRemove: createKinRpcCommand(runtime, {
      label: "kin:work:linkRemove",
      tag: "kin.work.linkRemove",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.key}:${input.url}` },
    }),
    /** Sets or clears a project's note for every task. */
    workProjectNote: createKinRpcCommand(runtime, {
      label: "kin:work:projectNote",
      tag: "kin.work.projectNote",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    /** Every open task someone holds, to someone else; `dryRun` counts them first. */
    workHandOver: createKinRpcCommand(runtime, {
      label: "kin:work:handOver",
      tag: "kin.work.handOver",
    }),
    /** Puts back one change an agent made, from its page. */
    agentUndoChange: createKinRpcCommand(runtime, {
      label: "kin:agent:undoChange",
      tag: "kin.lead.undoChange",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.agentId}:${input.seq}` },
    }),
    /** The owner shares tasks with the team, or takes them back. */
    workShare: createKinRpcCommand(runtime, {
      label: "kin:work:share",
      tag: "kin.work.share",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.keys.join(",") },
    }),
    workConfirm: createKinRpcCommand(runtime, {
      label: "kin:work:confirm",
      tag: "kin.work.confirm",
    }),
    workDecline: createKinRpcCommand(runtime, {
      label: "kin:work:decline",
      tag: "kin.work.decline",
    }),
    /** Every list an agent set up, as its definition: fields, statuses, categories. */
    workLists: createKinQueryAtomFamily(runtime, {
      label: "kin:work:lists",
      execute: Effect.fn("KinClient.workLists")(function* (input: KinListsInput) {
        return yield* readWorkLists(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinWorkRefreshOn(KIN_WORK_NOT_TASKS, kinRefreshOn("workLists")),
    }),
    /** Money's own screen: its coming-up count includes tasks, so any change reads it again. */
    workMoney: createKinQueryAtomFamily(runtime, {
      label: "kin:work:money",
      execute: Effect.fn("KinClient.workMoney")(function* (input: KinMoneySummaryInput) {
        return yield* readWorkMoney(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinWorkRefreshOn("any"),
    }),
    /** The same read for a line of what is owed, which no task moves. */
    workOwed: createKinQueryAtomFamily(runtime, {
      label: "kin:work:owed",
      execute: Effect.fn("KinClient.workOwed")(function* (input: KinMoneySummaryInput) {
        return yield* readWorkMoney(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinWorkRefreshOn(KIN_WORK_NOT_TASKS),
    }),
    /** Bank balances from confirmed statements; read again when a statement or Work changes. */
    workCash: createKinQueryAtomFamily(runtime, {
      label: "kin:work:cash",
      execute: Effect.fn("KinClient.workCash")(function* (input: KinCashInput) {
        return yield* readWorkCash(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinWorkRefreshOn(KIN_WORK_NOT_TASKS, kinRefreshOn("moneyStatements")),
    }),
    /** What is expected in and out in the next 30 days, and runway. */
    workOutlook: createKinQueryAtomFamily(runtime, {
      label: "kin:work:outlook",
      execute: Effect.fn("KinClient.workOutlook")(function* (input: KinOutlookInput) {
        return yield* readWorkOutlook(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinWorkRefreshOn(KIN_WORK_NOT_TASKS, kinRefreshOn("moneyStatements")),
    }),
    workBudgets: createKinQueryAtomFamily(runtime, {
      label: "kin:work:budgets",
      execute: Effect.fn("KinClient.workBudgets")(function* (input: KinMoneyBudgetsInput) {
        return yield* readWorkBudgets(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinWorkRefreshOn(KIN_WORK_NOT_TASKS, kinRefreshOn("moneyBudgets")),
    }),
    workSetBudget: createKinRpcCommand(runtime, {
      label: "kin:work:budget:set",
      tag: "kin.work.setBudget",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    workEntryLines: createKinRpcCommand(runtime, {
      label: "kin:work:entry-lines:read",
      tag: "kin.work.entryLines",
    }),
    workInvoiceFromQuote: createKinRpcCommand(runtime, {
      label: "kin:work:invoice-from-quote",
      tag: "kin.work.invoiceFromQuote",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
    /** One page of everything dated in a window; the Dates view decides when. */
    workDates: workDatesRead,
    workListUpdate: createKinRpcCommand(runtime, {
      label: "kin:work:list:update",
      tag: "kin.work.updateList",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.list}` },
    }),
    workPaymentRecord: createKinRpcCommand(runtime, {
      label: "kin:work:payment:record",
      tag: "kin.work.recordPayment",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    workPaymentVoid: createKinRpcCommand(runtime, {
      label: "kin:work:payment:void",
      tag: "kin.work.voidPayment",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.paymentId },
    }),
    /** One page of the files in the owner's chats, for keeping one on an entry. */
    workFiles: workFilesRead,
    /** Its `permissionAtom` says whether this session may read company details at all. */
    companyRead: companyProfileRead,
    companyProfile: createKinQueryAtomFamily(runtime, {
      label: "kin:company",
      execute: Effect.fn("KinClient.companyProfile")(function* (input: KinCompanyProfileInput) {
        return yield* readCompanyProfile(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("company"),
    }),
    exportLink: createKinRpcCommand(runtime, {
      label: "kin:export",
      tag: "kin.work.exportLink",
    }),
    companyProfileSet: createKinRpcCommand(runtime, {
      label: "kin:company:set",
      tag: "kin.work.setCompanyProfile",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
    }),
    workIssue: createKinRpcCommand(runtime, {
      label: "kin:work:issue",
      tag: "kin.work.issue",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
    workVoid: createKinRpcCommand(runtime, {
      label: "kin:work:void",
      tag: "kin.work.void",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
    workUnvoid: createKinRpcCommand(runtime, {
      label: "kin:work:unvoid",
      tag: "kin.work.unvoid",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
    /** The number Issue would give now; read when its confirmation opens. */
    workNextNumber: createKinRpcCommand(runtime, {
      label: "kin:work:next-number",
      tag: "kin.work.nextNumber",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
    /** Money's receipts, newest first. Its `permissionAtom` gates the section. */
    receiptsRead,
    receipts: createKinQueryAtomFamily(runtime, {
      label: "kin:work:receipts",
      execute: Effect.fn("KinClient.receipts")(function* (input: KinReceiptsInput) {
        return yield* readReceipts(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinWorkRefreshOn("any"),
    }),
    makeReceipt: createKinRpcCommand(runtime, {
      label: "kin:work:receipt:make",
      tag: "kin.work.makeReceipt",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    /** The company's document templates. */
    recipes: createKinQueryAtomFamily(runtime, {
      label: "kin:docs:recipes",
      execute: Effect.fn("KinClient.recipes")(function* (input: KinRecipesInput) {
        return yield* readRecipes(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: kinRefreshOn("recipes"),
    }),
    docRender: createKinRpcCommand(runtime, {
      label: "kin:docs:render",
      tag: "kin.docs.render",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.clientRequestId },
    }),
    undoRecipe: createKinRpcCommand(runtime, {
      label: "kin:docs:undo-recipe",
      tag: "kin.docs.undoRecipe",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.recipe}` },
    }),
    labelRecipe: createKinRpcCommand(runtime, {
      label: "kin:docs:label-recipe",
      tag: "kin.docs.labelRecipe",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.recipe}` },
    }),
    setDefaultRecipe: createKinRpcCommand(runtime, {
      label: "kin:docs:set-default-recipe",
      tag: "kin.docs.setDefaultRecipe",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.orgId },
    }),
    docLabel: createKinRpcCommand(runtime, {
      label: "kin:docs:label",
      tag: "kin.docs.label",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
    docFile: createKinRpcCommand(runtime, {
      label: "kin:docs:file",
      tag: "kin.docs.file",
      concurrency: { mode: "singleFlight", key: ({ input }) => `${input.orgId}:${input.key}` },
    }),
  };

  /** After an agent is retired, restored or renamed: who is retired, and both lists of agents. */
  const refreshKinAgents = (environmentId: EnvironmentId, orgId: KinOrgId) => {
    registry.refresh(kinClient.orgs({ environmentId, input: {} }));
    refreshLeads(environmentId, orgId);
  };

  const retryAccess = (environmentId: EnvironmentId) =>
    retryKinAccess(runtime, registry, environmentId);

  return { kinClient, refreshKinAgents, markKinHostKnown, retryKinWorkLive, retryAccess };
}

export type KinClient = ReturnType<typeof makeKinClient>["kinClient"];
