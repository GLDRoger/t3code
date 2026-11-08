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

const eventSamples = {
  "chat.message": {
    ...event,
    _tag: "chat.message",
    chatId: "chat-1",
    messageId: "message-1",
    provenance: { _tag: "human", personId: "person-1", memberId: "member-1" },
  },
  "widget.action": {
    ...event,
    _tag: "widget.action",
    chatId: "chat-1",
    messageId: "message-1",
    actionId: "approve",
  },
  github: {
    ...event,
    _tag: "github",
    deliveryId: "delivery-1",
    eventName: "push",
    repo: "example/project",
    summary: "Push",
    scheduledTaskId: "task-1",
    webhookDeliveryId: "webhook-1",
    dedupeKey: "delivery-1",
  },
  "deferral.due": {
    ...event,
    _tag: "deferral.due",
    subject: { type: "deferral", itemId: "item-1", phase: "heads_up" },
    lateByMs: 0,
  },
  routine: { ...event, _tag: "routine", routine: "morning_brief" },
  watchdog: { ...event, _tag: "watchdog", finding: "Stale", itemIds: ["item-1"] },
  "worker.report": { ...event, _tag: "worker.report", workerId: "worker-1", report },
  "action.resolved": {
    ...event,
    _tag: "action.resolved",
    pendingActionId: "action-1",
    outcome: "executed",
  },
  resume: { ...event, _tag: "resume", pausedAt: at },
} satisfies Record<Kin.KinEvent["_tag"], unknown>;

const samples = {
  KinEventId: { schema: Kin.KinEventId, values: ["event-1"] },
  KinWorkerId: { schema: Kin.KinWorkerId, values: ["worker-1"] },
  KinMemoryItemId: { schema: Kin.KinMemoryItemId, values: ["item-1"] },
  KinLead: { schema: Kin.KinLead, values: [lead, { ...lead, threadId: "thread-1" }] },
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
        due: "2026-11-13T09:00+05:30",
        recorded_at: "2026-11-10T16:20+05:30",
        valid_from: "2026-11-10T16:20+05:30",
        review_by: "2026-11-13",
      },
    ],
  },
  MemoryItemHead: {
    schema: Kin.MemoryItemHead,
    values: [{ ...item, orgId: "org-1", path: "deferrals/item-1.md" }],
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
      ...Object.values(eventSamples),
      ...[
        { type: "deferral", itemId: "item-1", phase: "due" },
        { type: "reminder", itemId: "item-1" },
        { type: "followup", itemId: "item-1", person: "person-1" },
      ].map((subject) => ({ ...eventSamples["deferral.due"], subject, lateByMs: 100 })),
    ],
  },
  KinBudgetLimits: {
    schema: Kin.KinBudgetLimits,
    values: [limits, { leadUnits: 0, workerUnits: 0 }],
  },
  KinBudget: {
    schema: Kin.KinBudget,
    values: [
      budget,
      ...["2024-02-29", "2000-02-29", "0000-01-01", "9999-12-31"].map((day) => ({
        ...budget,
        day,
      })),
    ],
  },
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
} satisfies Record<string, { schema: Schema.Codec<unknown>; values: ReadonlyArray<unknown> }>;

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
    { schema: Kin.KinLead, value: { ...lead, levelSince: "yesterday" } },
    { schema: Kin.KinLead, value: { ...lead, levelSince: "2026-11-07T05:30:00.000+05:30" } },
    ...[
      "tomorrow",
      "2026-13-45",
      "2026-02-30",
      "2026-02-29",
      "1900-02-29",
      "2026-00-01",
      "2026-01-00",
      "2026-04-31",
      "2026-1-01",
    ].map((day) => ({ schema: Kin.KinBudget, value: { ...budget, day } })),
    { schema: Kin.KinBudget, value: { ...budget, leadUnits: Infinity } },
    { schema: Kin.KinBudgetLimits, value: { ...limits, workerUnits: Infinity } },
    { schema: Kin.KinBudgetLimits, value: { ...limits, leadUnits: Number.MAX_SAFE_INTEGER + 1 } },
    { schema: Kin.KinOrgState, value: { ...state, paused: true } },
    {
      schema: Kin.KinOrgState,
      value: { orgId: "org-1", paused: true, pausedBy: "person-1", reason: null },
    },
    { schema: Kin.KinEvent, value: { ...eventSamples.routine, routine: "weekly_check" } },
    { schema: Kin.KinBudgetLimits, value: { leadUnits: -1, workerUnits: 0 } },
    { schema: Kin.KinBudgetLimits, value: { leadUnits: 0, workerUnits: 0.5 } },
    { schema: Kin.KinBudget, value: { ...budget, leadUnits: -0.1 } },
    {
      schema: Kin.KinEvent,
      value: { ...eventSamples["deferral.due"], lateByMs: -1 },
    },
  ])("rejects invalid payload $value", ({ schema, value }) => {
    const codec: Schema.Codec<unknown> = schema;
    expect(() => Schema.decodeSync(codec)(value)).toThrow();
  });
});
