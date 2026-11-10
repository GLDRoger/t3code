import {
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWaitingId,
  ThreadId,
  type KinChatMember,
  type KinChatSummary,
  type KinLeadProfile,
  type KinWaitingItem,
  type KinWaitingReason,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { KinChatsView } from "./KinChatsScreen";
import { KinLeadProfileView } from "./KinLeadScreen";
import type { KinInboxState } from "@t3tools/client-runtime/kin/kinInboxModel";
import type { KinDirectory, KinInboxScreenState } from "@t3tools/client-runtime/kin/kinScreenState";

const orgId = KinOrgId.make("org-catalog");
const owner = KinPersonId.make("person-owner");
const lead = KinAgentId.make("agent-lead");
const qa = KinAgentId.make("agent-qa");
const ravi = KinPersonId.make("person-ravi");
const environmentId = EnvironmentId.make("env-catalog");

const directory: KinDirectory = {
  agentNames: new Map([
    [lead, "Tech lead"],
    [qa, "QA"],
  ]),
  me: new Set([owner]),
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function member(chatId: KinChatId, principal: KinChatMember["principal"]): KinChatMember {
  const id = principal._tag === "person" ? principal.personId : principal.agentId;
  return {
    orgId,
    chatId,
    memberId: KinMemberId.make(`${chatId}:${id}`),
    principal,
    role: principal._tag === "person" && principal.personId === owner ? "owner" : "member",
    joinedAt: minutesAgo(10_000),
    leftAt: null,
    mutedUntil: null,
  };
}

function chat(input: {
  readonly id: string;
  readonly agent?: KinAgentId;
  /** A direct chat with another person instead of an agent. */
  readonly person?: KinPersonId;
  readonly title?: string;
  readonly body: string | null;
  readonly fromMe?: boolean;
  readonly minutes: number;
  readonly unread?: number;
  readonly working?: boolean;
}): KinChatSummary {
  const chatId = KinChatId.make(input.id);
  const sentAt = minutesAgo(input.minutes);
  const agent = input.agent ?? lead;
  return {
    orgId,
    chatId,
    kind: input.title === undefined || input.person !== undefined ? "direct" : "team_group",
    title: input.title ?? null,
    teamId: null,
    lastSeq: input.body === null ? 0 : 1,
    lastMessageAt: input.body === null ? null : sentAt,
    createdAt: minutesAgo(input.minutes + 60),
    archivedAt: null,
    members: [
      member(chatId, { _tag: "person", personId: owner }),
      member(
        chatId,
        input.person === undefined
          ? { _tag: "agent", agentId: agent }
          : { _tag: "person", personId: input.person },
      ),
    ],
    lastMessage:
      input.body === null
        ? null
        : {
            orgId,
            chatId,
            messageId: KinMessageId.make(`${input.id}:m1`),
            seq: 1,
            author: input.fromMe
              ? { _tag: "human", personId: owner, memberId: KinMemberId.make(`${chatId}:me`) }
              : {
                  _tag: "agent",
                  agentId: agent,
                  memberId: KinMemberId.make(`${chatId}:${agent}`),
                  ownerPersonId: owner,
                  threadId: ThreadId.make("thread-catalog"),
                },
            authorRole: input.fromMe ? "owner" : "member",
            kind: "text",
            body: input.body,
            intent: input.fromMe ? null : "answer",
            mentions: [],
            replyTo: null,
            widgetId: null,
            floorRunId: null,
            status: "posted",
            sentBy: null,
            createdAt: sentAt,
            editedAt: null,
          },
    unread: input.unread ?? 0,
    working: input.working ?? false,
  };
}

function waiting(id: string, chatId: string, reason: KinWaitingReason): KinWaitingItem {
  return {
    waitingId: KinWaitingId.make(id),
    orgId,
    personId: owner,
    chatId: KinChatId.make(chatId),
    messageId: null,
    widgetId: null,
    reason,
    createdAt: minutesAgo(30),
    resolvedAt: null,
    resolution: null,
  };
}

const typicalInbox: KinInboxState = {
  chats: [
    chat({ id: "lead", body: "Payments test fixed, PR 212 ready.", minutes: 12, unread: 3 }),
    chat({
      id: "qa",
      agent: qa,
      title: "Payments",
      body: "Ran the retry suite twice. **All green.**",
      minutes: 95,
    }),
    chat({
      id: "search",
      agent: qa,
      title: "Search",
      body: "Trying the cache on the staging index now.",
      minutes: 4,
      working: true,
    }),
    chat({
      id: "ravi",
      person: ravi,
      title: "Ravi Patel",
      body: "Ok, I'll look after lunch.",
      fromMe: true,
      minutes: 180,
    }),
  ],
  waiting: [waiting("w1", "lead", "approval"), waiting("w2", "lead", "decision")],
};

const manyInbox: KinInboxState = {
  chats: Array.from({ length: 40 }, (_, index) =>
    chat({
      id: `chat-${index}`,
      agent: index % 2 ? qa : lead,
      title: `Project ${index + 1}`,
      body:
        index % 3 === 0
          ? "Looks good to me. Shipping after the checks finish."
          : "Can you pick a caching option for the search endpoint before Monday?",
      fromMe: index % 4 === 1,
      minutes: index * 47,
      unread: index % 5 === 0 ? index + 1 : 0,
      working: index === 3 || index === 20,
    }),
  ),
  waiting: [
    waiting("w1", "chat-7", "approval"),
    waiting("w2", "chat-12", "question"),
    waiting("w3", "chat-12", "question"),
  ],
};

const ready = (
  value: KinInboxState,
  options: { readonly connected: boolean; readonly live: boolean },
): KinInboxScreenState => ({
  _tag: "ready",
  environmentId,
  connected: options.connected,
  inbox: { value, live: options.live, savedAt: options.live ? null : minutesAgo(25) },
});

const FIXTURES: ReadonlyArray<{ readonly label: string; readonly state: KinInboxScreenState }> = [
  { label: "Loaded", state: ready(typicalInbox, { connected: true, live: true }) },
  { label: "Loading", state: { _tag: "loading" } },
  { label: "Offline cached", state: ready(typicalInbox, { connected: false, live: false }) },
  { label: "Empty", state: ready({ chats: [], waiting: [] }, { connected: true, live: true }) },
  { label: "No Kin host", state: { _tag: "noHost" } },
  {
    label: "Error",
    state: { _tag: "error", message: "Kin didn't answer.", retry: "inbox" },
  },
  { label: "Not authorized", state: { _tag: "unauthorized" } },
  { label: "Many", state: ready(manyInbox, { connected: true, live: true }) },
  { label: "Offline, no cache", state: { _tag: "offline" } },
  { label: "No identity", state: { _tag: "noIdentity" } },
];

const LEAD_FIXTURE: KinLeadProfile = {
  orgId,
  agentId: lead,
  name: "Tech lead",
  domain: "engineering",
  charter:
    "Runs engineering. Turns requests into well-scoped tasks, follows them to a reviewed PR and says plainly what is done, blocked or needs a decision.",
  model: "claude-opus-5-5",
  ownerChatId: KinChatId.make("chat-lead"),
  working: true,
  tracking: [
    { kind: "work", title: "Fix the flaky checkout test", chatId: null },
    {
      kind: "reminder",
      title: "Renew the Apple developer account",
      dueAt: "2026-11-13T09:00:00.000Z",
      chatId: null,
    },
    {
      kind: "follow_up",
      title: "Check whether the billing migration PR was reviewed, and chase it if not",
      dueAt: "2026-11-11T14:30:00.000Z",
      chatId: null,
    },
    { kind: "scheduled", title: "Morning brief", chatId: null },
  ],
};

/** Dev fixtures for every chat list state, shown in the component catalog. */
export function KinChatsCatalog() {
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const fixture = FIXTURES[selected]!;
  return (
    <View className="gap-3">
      <AppText className="text-lg font-t3-semibold">Kin chat list</AppText>
      <View className="flex-row flex-wrap gap-2">
        {FIXTURES.map((item, index) => (
          <Chip
            key={item.label}
            label={item.label}
            size="small"
            selected={index === selected}
            onPress={() => {
              setSelected(index);
              setNote(null);
            }}
          />
        ))}
      </View>
      {note === null ? null : (
        <AppText textRole="footnote" className="text-foreground-muted">
          {note}
        </AppText>
      )}
      <View className="h-[600px] overflow-hidden rounded-[24px] border border-border bg-screen">
        <KinChatsView
          key={fixture.label}
          state={fixture.state}
          directory={directory}
          onRetry={() => setNote("Retry pressed")}
          onOpenWaiting={() => setNote("Opens Waiting on you")}
          onOpenChat={(chatId) => setNote(`Opens chat ${chatId}`)}
        />
      </View>
      <AppText className="text-lg font-t3-semibold">Kin lead details</AppText>
      <View className="gap-5 rounded-[24px] border border-border bg-screen p-4">
        <KinLeadProfileView lead={LEAD_FIXTURE} />
      </View>
    </View>
  );
}
