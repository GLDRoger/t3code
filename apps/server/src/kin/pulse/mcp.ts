import {
  KinChatError,
  KinDay,
  KinPulseFact,
  KinPulseFamily,
  KinPulseHandleAction,
  KinPulseRead,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { SHARED_REFUSAL, effectiveAudience, turnPeople } from "../lead/Audience.ts";
import { type Lead, leadTool } from "../work/leadWork.ts";
import { ownerZone, startOfDay } from "../work/recordRows.ts";
import * as KinPulse from "./KinPulse.ts";

export const PulseReadInput = Schema.Struct({
  project: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).annotate({
    description: "Only facts on this project: its key (P-2) or exact name.",
  }),
  client: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).annotate({
    description: "Only facts on this client: its key (C-3) or exact name.",
  }),
  family: Schema.optional(KinPulseFamily).annotate({
    description:
      "work (tasks), money (invoices, quotes, renewals, budgets) or system (workers, held work).",
  }),
  includeHandled: Schema.optional(Schema.Boolean).annotate({
    description: "Also show facts someone already has in hand. Default false.",
  }),
});
export const PulseHandleInput = Schema.Struct({
  factKey: TrimmedNonEmptyString.check(Schema.isMaxLength(300)).annotate({
    description: "The fact's key, exactly as pulse_read or the Pulse section gave it.",
  }),
  action: Schema.optional(KinPulseHandleAction).annotate({
    description:
      "got_it (default): you or someone has it in hand; it comes back after until, or 3 days. not_a_problem: drop it until what it is about changes. undo: take either back.",
  }),
  until: Schema.optional(
    Schema.Union([
      KinDay,
      Schema.String.check(
        Schema.isPattern(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/,
        ),
      ),
    ]),
  ).annotate({
    description: "For got_it: hide it until this day (owner's time zone) or time with offset.",
  }),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))).annotate({
    description: "One line on what is being done, for whoever reads it next.",
  }),
});

/** The owner in their own turn; in a turn others read, the people behind it, or a refusal. */
const viewerOf = Effect.fn("KinPulseTools.viewer")(function* (lead: Lead) {
  if ((yield* effectiveAudience(lead)) === "owner_only") return { _tag: "owner" } as const;
  const behind = yield* turnPeople(lead);
  if (behind === undefined || behind.people.length === 0)
    return yield* new KinChatError({ reason: "not_allowed", message: SHARED_REFUSAL });
  return { _tag: "people", people: behind.people } as const;
});

const runRead = Effect.fnUntraced(function* (lead: Lead, input: typeof PulseReadInput.Type) {
  return yield* KinPulse.read({
    orgId: lead.orgId,
    at: yield* Clock.currentTimeMillis,
    viewer: yield* viewerOf(lead),
    scope: { project: input.project, client: input.client, family: input.family },
    includeHandled: input.includeHandled,
  });
});

const runHandle = Effect.fnUntraced(function* (lead: Lead, input: typeof PulseHandleInput.Type) {
  const at = yield* Clock.currentTimeMillis;
  const until =
    input.until === undefined
      ? undefined
      : input.until.length === 10
        ? startOfDay(input.until, yield* ownerZone(lead.orgId))
        : Option.match(DateTime.make(input.until), {
            onNone: () => undefined,
            onSome: DateTime.toEpochMillis,
          });
  return yield* KinPulse.handle({
    orgId: lead.orgId,
    at,
    viewer: yield* viewerOf(lead),
    by: { _tag: "agent", agentId: lead.agentId },
    factKey: input.factKey,
    action: input.action ?? "got_it",
    until,
    note: input.note,
  });
});

const read = leadTool("KinPulseTools.read", runRead);
const handle = leadTool("KinPulseTools.handle", runHandle);

// tools/list runs this before handler services are provided; the Kin MCP endpoint provides `KinIdentity`.
const enabled = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const scope = Context.getOrUndefined(fiber.context, McpInvocationContext);
  const identity = Context.getOrUndefined(fiber.context, KinIdentity);
  return (
    scope?.thread !== undefined &&
    scope.thread.subagent !== true &&
    identity?.isLeadThread(scope.thread.threadId) === true
  );
};
const shared = {
  failure: Schema.Union([KinChatError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService, KinIdentity, SqlClient.SqlClient],
};

export const KinPulseToolkit = Toolkit.make(
  Tool.make("pulse_read", {
    ...shared,
    description:
      "What needs attention now, computed by Kin from its records: late or stalled tasks, overdue invoices, unanswered quotes, renewals, budgets, failed workers. Each fact has a key, a consequence line and who should act. Use it for any question about what is late, overdue or needs someone today, instead of memory. Read-only.",
    parameters: PulseReadInput,
    success: KinPulseRead,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("pulse_handle", {
    ...shared,
    description:
      "Mark a pulse fact as in hand (got_it, optionally until a date) or not a problem, so it stops coming back; undo takes that back. Use it once you have acted on a fact or decided it needs nothing.",
    parameters: PulseHandleInput,
    success: KinPulseFact,
  }).annotate(McpSchema.EnabledWhen, enabled),
);

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "The pulse is unavailable right now." });

export const handlers = McpToolAccess.toLayer(KinPulseToolkit, {
  pulse_read: McpToolAccess.reads(
    Effect.fn("KinPulseToolkit.read")(function* (input) {
      return yield* read(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  pulse_handle: McpToolAccess.actsAsCaller(
    Effect.fn("KinPulseToolkit.handle")(function* (input) {
      return yield* handle(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});
