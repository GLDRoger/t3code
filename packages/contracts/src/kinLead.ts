import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KinAgentId,
  KinAuthor,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
} from "./kinChat.ts";
import { ModelSelection } from "./modelSelection.ts";

export const KinEventId = TrimmedNonEmptyString.pipe(Schema.brand("KinEventId"));
export type KinEventId = typeof KinEventId.Type;
export const KinWorkerId = TrimmedNonEmptyString.pipe(Schema.brand("KinWorkerId"));
export type KinWorkerId = typeof KinWorkerId.Type;
export const KinMemoryItemId = TrimmedNonEmptyString.pipe(Schema.brand("KinMemoryItemId"));
export type KinMemoryItemId = typeof KinMemoryItemId.Type;

export const KinLevel = Schema.Literals(["L0", "L1", "L2", "L3"]);
export type KinLevel = typeof KinLevel.Type;
export const KinLead = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: TrimmedNonEmptyString,
  level: KinLevel,
  levelSince: IsoDateTime,
  threadId: Schema.NullOr(ThreadId),
  models: Schema.Struct({ strong: ModelSelection, cheap: ModelSelection }),
  workerProjects: Schema.Array(ProjectId),
  ownerChatId: KinChatId,
});
export type KinLead = typeof KinLead.Type;

export const MemoryItemKind = Schema.Literals([
  "objective",
  "commitment",
  "deferral",
  "decision",
  "person",
  "claim",
]);
export type MemoryItemKind = typeof MemoryItemKind.Type;
export const MemoryTrust = Schema.Literals(["owner", "member", "external", "agent"]);
export type MemoryTrust = typeof MemoryTrust.Type;
export const MemoryItemFrontMatter = Schema.Struct({
  orgId: KinOrgId,
  id: KinMemoryItemId,
  kind: MemoryItemKind,
  title: Schema.String,
  status: Schema.Literals(["open", "done", "cancelled", "superseded"]),
  due: Schema.NullOr(IsoDateTime),
  on_due: Schema.optional(Schema.Literals(["remind", "start", "ask", "chase"])),
  owner: Schema.optional(TrimmedNonEmptyString),
  recorded_at: IsoDateTime,
  valid_from: IsoDateTime,
  invalid_at: Schema.NullOr(IsoDateTime),
  superseded_by: Schema.NullOr(KinMemoryItemId),
  review_by: Schema.NullOr(IsoDateTime),
  source: Schema.String,
  said_by: TrimmedNonEmptyString,
  trust: MemoryTrust,
  links: Schema.Array(Schema.String),
});
export type MemoryItemFrontMatter = typeof MemoryItemFrontMatter.Type;

export const WorkerReport = Schema.Struct({
  orgId: KinOrgId,
  result: Schema.Literals(["done", "blocked", "needs_decision"]),
  summary: Schema.String.check(Schema.isMaxLength(800)),
  evidence: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals([
        "pr",
        "commit",
        "ci_run",
        "test_output",
        "screenshot",
        "file",
        "link",
      ]),
      ref: Schema.String,
      note: Schema.optional(Schema.String),
    }),
  ),
  openQuestions: Schema.Array(Schema.String),
  memorySuggestions: Schema.Array(
    Schema.Struct({
      kind: MemoryItemKind,
      title: Schema.String,
      body: Schema.String,
      links: Schema.Array(Schema.String),
    }),
  ),
  misleadingMemory: Schema.Array(Schema.Struct({ itemId: KinMemoryItemId, why: Schema.String })),
  parsed: Schema.Boolean,
});
export type WorkerReport = typeof WorkerReport.Type;

const EventBase = {
  orgId: KinOrgId,
  eventId: KinEventId,
  agentId: KinAgentId,
  receivedAt: IsoDateTime,
  dedupeKey: Schema.NullOr(TrimmedNonEmptyString),
  provenance: KinAuthor,
};
export const KinEvent = Schema.Union([
  Schema.TaggedStruct("chat.message", { ...EventBase, chatId: KinChatId, messageId: KinMessageId }),
  Schema.TaggedStruct("widget.action", {
    ...EventBase,
    chatId: KinChatId,
    messageId: KinMessageId,
    actionId: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("github", {
    ...EventBase,
    deliveryId: TrimmedNonEmptyString,
    eventName: TrimmedNonEmptyString,
    repo: TrimmedNonEmptyString,
    summary: Schema.String,
    payloadRef: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("deferral.due", {
    ...EventBase,
    itemId: KinMemoryItemId,
    firedLateBy: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.TaggedStruct("routine", {
    ...EventBase,
    routine: Schema.Literals(["morning", "evening", "weekly_check"]),
  }),
  Schema.TaggedStruct("watchdog", {
    ...EventBase,
    finding: Schema.String,
    itemIds: Schema.Array(KinMemoryItemId),
  }),
  Schema.TaggedStruct("worker.report", {
    ...EventBase,
    workerId: KinWorkerId,
    report: WorkerReport,
  }),
  Schema.TaggedStruct("action.resolved", {
    ...EventBase,
    pendingActionId: TrimmedNonEmptyString,
    outcome: Schema.Literals(["executed", "rejected", "expired", "failed"]),
  }),
  Schema.TaggedStruct("resume", { ...EventBase, pausedAt: IsoDateTime }),
]);
export type KinEvent = typeof KinEvent.Type;

export const KinBudgetLimits = Schema.Struct({
  leadUnits: NonNegativeInt,
  workerUnits: NonNegativeInt,
});
export type KinBudgetLimits = typeof KinBudgetLimits.Type;
export const KinBudget = Schema.Struct({
  orgId: KinOrgId,
  day: TrimmedNonEmptyString,
  leadUnits: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  workerUnits: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  limits: KinBudgetLimits,
});
export type KinBudget = typeof KinBudget.Type;
export const KinBudgetGetInput = Schema.Struct({ orgId: KinOrgId });
export type KinBudgetGetInput = typeof KinBudgetGetInput.Type;
export const KinBudgetSetInput = Schema.Struct({ orgId: KinOrgId, limits: KinBudgetLimits });
export type KinBudgetSetInput = typeof KinBudgetSetInput.Type;

export const KinOrgState = Schema.Struct({
  orgId: KinOrgId,
  paused: Schema.Boolean,
  pausedAt: Schema.NullOr(IsoDateTime),
  pausedBy: Schema.NullOr(KinPersonId),
  reason: Schema.NullOr(Schema.String),
});
export type KinOrgState = typeof KinOrgState.Type;
export const KinOrgPauseInput = Schema.Struct({
  orgId: KinOrgId,
  reason: Schema.optional(Schema.String),
});
export type KinOrgPauseInput = typeof KinOrgPauseInput.Type;
export const KinOrgResumeInput = Schema.Struct({ orgId: KinOrgId });
export type KinOrgResumeInput = typeof KinOrgResumeInput.Type;
