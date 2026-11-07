import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as Kin from "./kinLead.ts";

const at = "2026-11-07T00:00:00.000Z";
const model = { instanceId: "codex", model: "example-model" };
const lead = {
  orgId: "org-1",
  agentId: "agent-1",
  name: "tech-lead",
  level: "L0",
  levelSince: at,
  threadId: null,
  models: { strong: model, cheap: model },
  workerProjects: ["project-1"],
  ownerChatId: "chat-1",
};
const item = {
  orgId: "org-1",
  id: "item-1",
  kind: "deferral",
  title: "Rate limiting",
  status: "open",
  due: at,
  recorded_at: at,
  valid_from: at,
  invalid_at: null,
  superseded_by: null,
  review_by: null,
  source: "kin-chat://org-1/chat-1/message-1",
  said_by: "person-1",
  trust: "owner",
  links: [],
};
const report = {
  orgId: "org-1",
  result: "done",
  summary: "Built contracts",
  evidence: [{ kind: "commit", ref: "abc", note: "Verified" }],
  openQuestions: [],
  memorySuggestions: [{ kind: "decision", title: "Identity", body: "Use agentId", links: [] }],
  misleadingMemory: [{ itemId: "item-1", why: "Outdated" }],
  parsed: true,
};
const event = {
  orgId: "org-1",
  agentId: "agent-1",
  eventId: "event-1",
  receivedAt: at,
  dedupeKey: null,
  provenance: { _tag: "system" },
};
const limits = { leadUnits: 2_000_000, workerUnits: 6_000_000 };
const budget = { orgId: "org-1", day: "2026-11-07", leadUnits: 0.1, workerUnits: 4, limits };
const state = { orgId: "org-1", paused: false, pausedAt: null, pausedBy: null, reason: null };

type SchemaName = {
  [K in keyof typeof Kin]: (typeof Kin)[K] extends Schema.Top ? K : never;
}[keyof typeof Kin];

const samples = {
  KinEventId: { schema: Kin.KinEventId, values: ["event-1"] },
  KinWorkerId: { schema: Kin.KinWorkerId, values: ["worker-1"] },
  KinMemoryItemId: { schema: Kin.KinMemoryItemId, values: ["item-1"] },
  KinLevel: { schema: Kin.KinLevel, values: Kin.KinLevel.literals },
  KinLead: { schema: Kin.KinLead, values: [lead, { ...lead, threadId: "thread-1" }] },
  MemoryItemKind: { schema: Kin.MemoryItemKind, values: Kin.MemoryItemKind.literals },
  MemoryTrust: { schema: Kin.MemoryTrust, values: Kin.MemoryTrust.literals },
  MemoryItemFrontMatter: {
    schema: Kin.MemoryItemFrontMatter,
    values: [
      item,
      {
        ...item,
        on_due: "ask",
        owner: "person-1",
        invalid_at: at,
        superseded_by: "item-2",
        review_by: at,
      },
    ],
  },
  WorkerReport: {
    schema: Kin.WorkerReport,
    values: [
      report,
      { ...report, parsed: false, result: "blocked", evidence: [{ kind: "link", ref: "thread" }] },
      { ...report, result: "needs_decision" },
    ],
  },
  KinEvent: {
    schema: Kin.KinEvent,
    values: [
      {
        ...event,
        _tag: "chat.message",
        chatId: "chat-1",
        messageId: "message-1",
        provenance: { _tag: "human", personId: "person-1", memberId: "member-1" },
      },
      {
        ...event,
        _tag: "widget.action",
        chatId: "chat-1",
        messageId: "message-1",
        actionId: "approve",
      },
      {
        ...event,
        _tag: "github",
        deliveryId: "delivery-1",
        eventName: "push",
        repo: "GLDRoger/t3code",
        summary: "Push",
        payloadRef: "delivery-1",
        dedupeKey: "github:delivery-1",
      },
      { ...event, _tag: "deferral.due", itemId: "item-1", firedLateBy: null },
      { ...event, _tag: "deferral.due", itemId: "item-1", firedLateBy: 100 },
      ...["morning", "evening", "weekly_check"].map((routine) => ({
        ...event,
        _tag: "routine",
        routine,
      })),
      { ...event, _tag: "watchdog", finding: "Stale", itemIds: ["item-1"] },
      { ...event, _tag: "worker.report", workerId: "worker-1", report },
      ...["executed", "rejected", "expired", "failed"].map((outcome) => ({
        ...event,
        _tag: "action.resolved",
        pendingActionId: "action-1",
        outcome,
      })),
      { ...event, _tag: "resume", pausedAt: at },
    ],
  },
  KinBudgetLimits: {
    schema: Kin.KinBudgetLimits,
    values: [limits, { leadUnits: 0, workerUnits: 0 }],
  },
  KinBudget: { schema: Kin.KinBudget, values: [budget] },
  KinBudgetGetInput: { schema: Kin.KinBudgetGetInput, values: [{ orgId: "org-1" }] },
  KinBudgetSetInput: { schema: Kin.KinBudgetSetInput, values: [{ orgId: "org-1", limits }] },
  KinOrgState: {
    schema: Kin.KinOrgState,
    values: [state, { ...state, paused: true, pausedAt: at, pausedBy: "person-1", reason: "Stop" }],
  },
  KinOrgPauseInput: {
    schema: Kin.KinOrgPauseInput,
    values: [{ orgId: "org-1" }, { orgId: "org-1", reason: "Stop" }],
  },
  KinOrgResumeInput: { schema: Kin.KinOrgResumeInput, values: [{ orgId: "org-1" }] },
} satisfies Record<SchemaName, { schema: Schema.Codec<unknown>; values: ReadonlyArray<unknown> }>;

describe("Kin lead contracts", () => {
  it.each(Object.entries(samples))("round-trips %s", (_name, { schema, values }) => {
    const codec: Schema.Codec<unknown> = schema;
    const decode = Schema.decodeUnknownSync(codec);
    const encode = Schema.encodeUnknownSync(codec);
    for (const wire of values) {
      const decoded = decode(wire);
      expect(encode(decoded)).toEqual(wire);
      expect(decode(encode(decoded))).toEqual(decoded);
    }
  });

  it.each([Kin.KinEventId, Kin.KinWorkerId, Kin.KinMemoryItemId])("rejects blank ids", (schema) => {
    const codec: Schema.Codec<unknown> = schema;
    expect(() => Schema.decodeSync(codec)(" \n ")).toThrow();
  });

  it.each([
    { schema: Kin.WorkerReport, value: { ...report, summary: "x".repeat(801) } },
    { schema: Kin.WorkerReport, value: { ...report, orgId: "" } },
    { schema: Kin.MemoryItemFrontMatter, value: { ...item, orgId: "" } },
    { schema: Kin.KinBudgetLimits, value: { leadUnits: -1, workerUnits: 0 } },
    { schema: Kin.KinBudgetLimits, value: { leadUnits: 0, workerUnits: 0.5 } },
    { schema: Kin.KinBudget, value: { ...budget, leadUnits: -0.1 } },
    {
      schema: Kin.KinEvent,
      value: { ...event, _tag: "deferral.due", itemId: "item-1", firedLateBy: -1 },
    },
  ])("rejects invalid payload $value", ({ schema, value }) => {
    const codec: Schema.Codec<unknown> = schema;
    expect(() => Schema.decodeSync(codec)(value)).toThrow();
  });
});
