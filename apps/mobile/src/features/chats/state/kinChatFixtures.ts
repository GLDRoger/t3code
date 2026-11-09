import type {
  KinAgentId,
  KinChatHistoryInput,
  KinChatHistoryResult,
  KinChatId,
  KinChatStreamEvent,
  KinMemberId,
  KinMessage,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinPresence,
  KinWakeupId,
  ThreadId,
} from "@t3tools/contracts";

/** Dev-only chat id that renders the fixture feed instead of a stream (`kin/dev/dev/chats/dev-fixture`). */
export const KIN_FIXTURE_CHAT_ID = "dev-fixture" as KinChatId;
export const KIN_FIXTURE_OWNER = "fixture-owner" as KinPersonId;
export const KIN_FIXTURE_AGENT = "fixture-lead" as KinAgentId;
export const KIN_FIXTURE_QA = "fixture-qa" as KinAgentId;

const ORG = "fixture-org" as KinOrgId;
const START = Date.parse("2026-11-08T08:00:00.000Z");

const OWNER_LINES = [
  "Can you check why the payments test is flaky?",
  "Ship it once checks pass.",
  "What changed in the retry logic?",
  "Thanks. Let's keep the **fixed timeout** for now.",
];
const AGENT_LINES = [
  "Looking at it now. The flake comes from a shared clock in `payments.test.ts`.",
  "Fixed and pushed. PR #212 is ready:\n\n- freezes the clock per test\n- drops the 2 s sleep",
  "Retries now back off from 200 ms to 3 s, capped at 5 attempts.",
  "Here's the plan:\n\n```ts\nconst timeout = Duration.seconds(10);\n```\n\nI'll start after lunch.",
];

function fixtureMessage(seq: number): KinMessage {
  const base = {
    orgId: ORG,
    chatId: KIN_FIXTURE_CHAT_ID,
    messageId: `fixture-${seq}` as KinMessageId,
    seq,
    kind: "text" as const,
    mentions: [],
    replyTo: null,
    widgetId: null,
    status: "posted" as const,
    createdAt: new Date(START + seq * 60_000).toISOString(),
    editedAt: null,
  };
  // Every 25th pair is a three-message agent run, which folds.
  const inRun = seq % 25;
  if (inRun >= 22) {
    const qa = inRun === 23;
    return {
      ...base,
      author: {
        _tag: "agent",
        agentId: qa ? KIN_FIXTURE_QA : KIN_FIXTURE_AGENT,
        memberId: (qa ? "member-qa" : "member-lead") as KinMemberId,
        ownerPersonId: KIN_FIXTURE_OWNER,
        threadId: "fixture-thread" as ThreadId,
      },
      authorRole: "member",
      body:
        inRun === 24
          ? "Settled on a fixed timeout."
          : qa
            ? "Retries hide the real failure; I'd rather fail fast."
            : "Retries keep the flaky upstream from paging us.",
      intent: inRun === 24 ? "decision" : inRun === 23 ? "objection" : "evidence",
      floorRunId: `run-${Math.floor(seq / 25)}`,
      sentBy: null,
    };
  }
  const fromOwner = seq % 2 === 1;
  return fromOwner
    ? {
        ...base,
        author: {
          _tag: "human",
          personId: KIN_FIXTURE_OWNER,
          memberId: "member-owner" as KinMemberId,
        },
        authorRole: "owner",
        body: OWNER_LINES[seq % OWNER_LINES.length]!,
        intent: null,
        floorRunId: null,
        sentBy: KIN_FIXTURE_OWNER,
      }
    : {
        ...base,
        author: {
          _tag: "agent",
          agentId: KIN_FIXTURE_AGENT,
          memberId: "member-lead" as KinMemberId,
          ownerPersonId: KIN_FIXTURE_OWNER,
          threadId: "fixture-thread" as ThreadId,
        },
        authorRole: "member",
        body: AGENT_LINES[seq % AGENT_LINES.length]!,
        intent: "answer",
        floorRunId: null,
        sentBy: null,
      };
}

/** Messages with seqs 1..count. */
export function makeKinFixtureMessages(count: number): ReadonlyArray<KinMessage> {
  return Array.from({ length: count }, (_, index) => fixtureMessage(index + 1));
}

/** `kin.chat.history` over a fixture feed. */
export function readKinFixtureHistory(
  all: ReadonlyArray<KinMessage>,
  input: KinChatHistoryInput,
): KinChatHistoryResult {
  const older = all.filter((message) => message.seq < input.beforeSeq);
  const messages = older.slice(-input.limit);
  return { messages, widgets: [], hasMore: older.length > messages.length };
}

const FIXTURE_REPLY =
  "Found it. The flake is the shared clock in `payments.test.ts`: two tests advance it at once.\n\n- freeze the clock per test\n- drop the 2 s sleep\n\nI'll open the PR once checks pass.";

/**
 * A scripted lead turn for the fixture chat, as the reply bridge would stream it after `seq`:
 * presence through thinking, a tool label and writing, the reply in 250 ms deltas, its durable
 * message, then a stall that offers Stop.
 */
export function kinFixtureReplyScript(
  seq: number,
  startMs: number,
): ReadonlyArray<{ readonly atMs: number; readonly event: KinChatStreamEvent }> {
  const iso = (ms: number) => new Date(startMs + ms).toISOString();
  const wakeupId = `fixture-wakeup-${seq}` as KinWakeupId;
  const draftId = `fixture-item-${seq}`;
  const presence = (atMs: number, state: KinPresence["state"], label: string | null = null) => ({
    atMs,
    event: {
      _tag: "presence",
      agentId: KIN_FIXTURE_AGENT,
      presence: {
        agentId: KIN_FIXTURE_AGENT,
        wakeupId,
        state,
        label,
        startedAt: iso(0),
        since: iso(atMs),
      },
    } as const,
  });
  const words = FIXTURE_REPLY.split(/(?<=\s)/);
  const deltas = [];
  let offset = 0;
  for (let index = 0; index < words.length; index += 3) {
    const text = words.slice(index, index + 3).join("");
    deltas.push({
      atMs: 4_000 + deltas.length * 250,
      event: { _tag: "draft", draftId, agentId: KIN_FIXTURE_AGENT, offset, text } as const,
    });
    offset += text.length;
  }
  const doneMs = 4_000 + deltas.length * 250 + 500;
  const message: KinMessage = {
    ...fixtureMessage(seq + 1),
    messageId: `fixture-reply-${seq}` as KinMessageId,
    clientMessageId: `reply:${draftId}`,
    body: FIXTURE_REPLY,
    createdAt: iso(doneMs),
  };
  return [
    presence(0, "thinking"),
    presence(1_500, "working", "Checking memory"),
    presence(3_500, "writing"),
    ...deltas,
    { atMs: doneMs, event: { _tag: "message", message } },
    {
      atMs: doneMs,
      event: {
        _tag: "draft",
        draftId,
        agentId: KIN_FIXTURE_AGENT,
        offset,
        text: "",
        end: { messageId: message.messageId },
      },
    },
    presence(doneMs + 1_000, "stalled"),
  ];
}
