import { assert, it } from "@effect/vitest";
import { KinAgentId, KinChatId, KinMessageId } from "@t3tools/contracts";
import {
  decideFloor,
  FLOOR_BID_WINDOW_MS,
  noticeIntentAllowed,
  replyIntentAllowed,
  type FloorRun,
} from "./FloorManager.ts";

const lead = KinAgentId.make("lead");
const qa = KinAgentId.make("qa");
const release = KinAgentId.make("release");
const run: FloorRun = {
  runId: "run",
  chatId: KinChatId.make("chat"),
  openedBy: KinMessageId.make("human"),
  mentionQueue: [],
  agentTurns: 0,
  lastSpeaker: null,
  spoken: [],
  grant: null,
  state: "open",
};
const bids = [
  { agentId: lead, role: "lead", reason: "answer", intent: "answer", at: 10 },
  { agentId: qa, role: "qa", reason: "tests", intent: "evidence", at: 20 },
  { agentId: release, role: "release", reason: "release", intent: "decision", at: 30 },
] as const;
it.each([
  {
    name: "mentions precede bids",
    state: { mentionQueue: [release, qa] },
    text: "test",
    now: 0,
    expected: { _tag: "grant", agentId: release },
  },
  {
    name: "last speaker mention skipped",
    state: { mentionQueue: [lead, qa], lastSpeaker: lead },
    expected: { _tag: "grant", agentId: qa },
  },
  { name: "wait for bids", now: 1_999, expected: { _tag: "wait" } },
  { name: "plain question prefers chat lead", expected: { _tag: "grant", agentId: lead } },
  {
    name: "test words prefer QA",
    text: "Please test this bug",
    expected: { _tag: "grant", agentId: qa },
  },
  {
    name: "release words prefer release",
    text: "deploy release",
    expected: { _tag: "grant", agentId: release },
  },
  {
    name: "role ties use earliest bid",
    text: "test",
    bids: [{ ...bids[1], agentId: release, at: 25 }, bids[1]],
    expected: { _tag: "grant", agentId: qa },
  },
  {
    name: "last speaker bid skipped",
    state: { lastSpeaker: lead },
    expected: { _tag: "grant", agentId: qa },
  },
  {
    name: "six turns closes before mentions",
    state: { agentTurns: 6, mentionQueue: [qa] },
    expected: { _tag: "close", reason: "turn_budget" },
  },
  {
    name: "answer refused after first turn",
    state: { agentTurns: 1 },
    bids: [bids[0]],
    expected: { _tag: "close", reason: "nothing_to_add" },
  },
  {
    name: "question refused after first turn",
    state: { agentTurns: 1 },
    bids: [{ ...bids[0], intent: "question" }],
    expected: { _tag: "close", reason: "nothing_to_add" },
  },
  { name: "no bids closes", bids: [], expected: { _tag: "close", reason: "no_bids" } },
  {
    name: "late bids cannot win",
    bids: [{ ...bids[0], at: 2_001 }],
    expected: { _tag: "close", reason: "nothing_to_add" },
  },
] as const)("$name", (row) => {
  assert.deepStrictEqual(
    decideFloor({
      run: { ...run, ...("state" in row ? row.state : {}) },
      bids: "bids" in row ? row.bids : bids,
      text: "text" in row ? row.text : "Question?",
      leadAgentId: lead,
      bidWindowOpenedAt: 0,
      now: "now" in row ? row.now : FLOOR_BID_WINDOW_MS,
    }),
    row.expected,
  );
});
it.each(["answer", "question", "evidence", "objection", "decision"] as const)(
  "reply and notice intents: %s",
  (intent) => {
    assert.isTrue(replyIntentAllowed(0, intent));
    assert.strictEqual(
      replyIntentAllowed(1, intent),
      ["evidence", "objection", "decision"].includes(intent),
    );
    assert.strictEqual(
      noticeIntentAllowed(intent),
      ["evidence", "decision", "question"].includes(intent),
    );
  },
);
