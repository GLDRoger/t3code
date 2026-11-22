import { KinChatError, KinWidgetId, OrchestratorMcpFailure } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { McpSchema, Tool } from "effect/ai";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { turnChat } from "../lead/Audience.ts";
import { attachChangeCard } from "../work/companyProfile.ts";
import { askOwner } from "../work/leadMoney.ts";
import { KinToolText } from "../work/leadSchemas.ts";
import { admitted, type Lead, leadTool, retryKey } from "../work/leadWork.ts";
import {
  SHELL_CHANGE,
  applied,
  replaceOlderShellChanges,
  shellChangeLines,
  storeShellChange,
} from "./changes.ts";
import { get } from "./KinShell.ts";

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const SECTION_IDS = ["clients", "deals", "money", "invoices", "docs"] as const;
const Word = Schema.NullOr(KinToolText(40));

export const ShellProposeInput = Schema.Struct({
  sections: Schema.Array(
    Schema.Struct({
      id: Schema.Literals(SECTION_IDS),
      on: Schema.optional(Schema.Boolean),
      name: Schema.optional(Word).annotate({ description: "Plural, as shown; null for Kin's." }),
      noun: Schema.optional(Word).annotate({ description: "One of them; null for Kin's." }),
    }),
  ).check(Schema.isMinLength(1)),
});
export const ShellProposeResult = Schema.Struct({
  /** Each change as the owner's card lists it. */
  proposed: Schema.Array(Schema.String),
  next: Schema.String,
});

const runPropose = Effect.fnUntraced(function* (lead: Lead, input: typeof ShellProposeInput.Type) {
  yield* admitted(lead, "shell_propose", input);
  if (new Set(input.sections.map((one) => one.id)).size !== input.sections.length)
    return yield* invalid("Name each section once. Nothing was asked.");
  const shell = yield* get(lead.orgId);
  const next = applied(shell, input.sections);
  const lines = shellChangeLines(shell.sections, next);
  if (lines.length === 0)
    return yield* invalid("The company is already set up that way. Nothing was asked.");
  // Asked where the turn was asked: a co-owner's turn can't post in the owner's own chat.
  const chat = yield* turnChat(lead);
  if (chat === undefined) return yield* invalid("There is no owner chat to confirm this in.");
  const now = yield* Clock.currentTimeMillis;
  const changeId = `${SHELL_CHANGE}${retryKey(`${lead.orgId}|${lead.agentId}|${lead.wakeupId}|${shell.rev}|${stableStringify(next)}`)}`;
  yield* storeShellChange({
    orgId: lead.orgId,
    changeId,
    agentId: lead.agentId,
    wakeupId: lead.wakeupId,
    sections: next,
    baseRev: shell.rev,
    now,
  });
  const widgetId = yield* askOwner(
    lead,
    {
      chatId: chat.chatId,
      clientMessageId: `kin-shell:${changeId}`,
      question: "Change how Kin is set up for this company?",
      detail: lines.join("\n"),
      yes: "Confirm",
      no: "Cancel",
    },
    (widgetId) => attachChangeCard(lead.orgId, changeId, widgetId),
  );
  const older = yield* replaceOlderShellChanges(lead.orgId, changeId, now);
  if (older.length > 0)
    yield* (yield* KinLevelGate).closeReplaced(lead, older, KinWidgetId.make(widgetId));
  return {
    proposed: lines,
    next: "Nothing has changed yet. Kin showed this change on a card in this chat; it applies when they tap Confirm. Say so in one line.",
  };
});
export const propose = leadTool("KinShellTools.propose", runPropose);

// tools/list runs this before handler services are provided; the Kin MCP endpoint provides `KinIdentity`.
const enabled = McpToolAccess.threadBoundGate(() => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const scope = Context.getOrUndefined(fiber.context, McpInvocationContext);
  const identity = Context.getOrUndefined(fiber.context, KinIdentity);
  return (
    scope?.thread !== undefined &&
    scope.thread.subagent !== true &&
    identity?.isLeadThread(scope.thread.threadId) === true
  );
});

/** Served with the work tools (`work/mcp/tools.ts`), so a lead's session lists it beside them. */
export const shellPropose = Tool.make("shell_propose", {
  failure: Schema.Union([KinChatError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies: [
    McpInvocationContext,
    ThreadManagementService,
    KinIdentity,
    KinLevelGate,
    SqlClient.SqlClient,
  ],
  description:
    "Asks the owner to turn sections of Kin on or off for this company, or to call one by the company's own word. Kin shows them one card listing each change, old beside new; it applies only when they tap Confirm, and replaces an unanswered older card. Nothing changes before then. When someone else asks, pass it to the owner with kin_relay.",
  parameters: ShellProposeInput,
  success: ShellProposeResult,
}).annotate(McpSchema.EnabledWhen, enabled);

const isKinChatError = Schema.is(KinChatError);
export const proposeHandler = McpToolAccess.actsAsCaller(
  Effect.fn("KinShellToolkit.propose")(
    function* (input: typeof ShellProposeInput.Type) {
      return yield* propose(yield* McpInvocationContext, input);
    },
    Effect.mapError((error) =>
      isKinChatError(error)
        ? error
        : new KinChatError({ reason: "unavailable", message: "Kin couldn't do that right now." }),
    ),
  ),
);
