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
import { askOwner } from "../work/leadMoney.ts";
import { KinToolText } from "../work/leadSchemas.ts";
import { admitted, type Lead, leadTool, retryKey } from "../work/leadWork.ts";
import { SHELL_CHANGE, applied, bindShellChange, listNames, shellChangeLines } from "./changes.ts";
import { get, listOfSection, listSectionsRefusal, shellRefusal } from "./KinShell.ts";

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const SECTION_IDS = ["clients", "deals", "money", "invoices"] as const;
const Word = Schema.NullOr(KinToolText(40));

export const CompanySectionsInput = Schema.Struct({
  sections: Schema.Array(
    Schema.Struct({
      id: Schema.Union([
        Schema.Literals(SECTION_IDS),
        Schema.String.check(Schema.isPattern(/^list:[a-z][a-z0-9_]{1,39}$/)),
      ]).annotate({ description: "A section, or list:<list id> to show a company list as one." }),
      on: Schema.optional(Schema.Boolean),
      dock: Schema.optional(Schema.Boolean).annotate({
        description: "A list section only: in the phone's dock.",
      }),
      name: Schema.optional(Word).annotate({
        description: "Clients only: plural, as shown; null for Kin's.",
      }),
      noun: Schema.optional(Word).annotate({ description: "Clients only: one; null for Kin's." }),
    }),
  ).check(Schema.isMinLength(1)),
});
export const CompanySectionsResult = Schema.Struct({
  /** Each change as the owner's card lists it. */
  proposed: Schema.Array(Schema.String),
  next: Schema.String,
});

const runPropose = Effect.fnUntraced(function* (
  lead: Lead,
  input: typeof CompanySectionsInput.Type,
) {
  yield* admitted(lead, "company_sections", input);
  if (new Set(input.sections.map((one) => one.id)).size !== input.sections.length)
    return yield* invalid("A section can only be set once.");
  if (
    input.sections.some(
      (one) => one.id !== "clients" && (one.name !== undefined || one.noun !== undefined),
    )
  )
    return yield* invalid("Only Clients can be called by the company's own word.");
  if (input.sections.some((one) => one.dock !== undefined && listOfSection(one.id) === undefined))
    return yield* invalid("Only a list section is put in the phone's dock here.");
  const shell = yield* get(lead.orgId);
  const next = applied(shell, input.sections);
  // The setter's own checks, in its words, before the owner sees a card it would refuse.
  const refusal =
    shellRefusal(shell.sections, next) ??
    (yield* listSectionsRefusal(lead.orgId, next, shell.sections));
  if (refusal !== undefined) return yield* invalid(refusal);
  const lines = shellChangeLines(shell.sections, next, yield* listNames(lead.orgId, next));
  if (lines.length === 0)
    return yield* invalid("The company is already set up that way. Nothing was asked.");
  // Asked where the turn was asked: a co-owner's turn can't post in the owner's own chat.
  const chat = yield* turnChat(lead);
  if (chat === undefined) return yield* invalid("There is no owner chat to confirm this in.");
  const now = yield* Clock.currentTimeMillis;
  const changeId = `${SHELL_CHANGE}${retryKey(`${lead.orgId}|${lead.agentId}|${lead.wakeupId}|${shell.rev}|${stableStringify(next)}`)}`;
  let older: ReadonlyArray<string> = [];
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
    (widgetId) =>
      bindShellChange({
        orgId: lead.orgId,
        changeId,
        agentId: lead.agentId,
        wakeupId: lead.wakeupId,
        before: shell.sections,
        after: next,
        baseRev: shell.rev,
        widgetId,
        now,
      }).pipe(
        Effect.map((replaced) => {
          older = replaced;
        }),
      ),
  );
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
export const companySections = Tool.make("company_sections", {
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
    "Proposes turning a section of Kin on or off for this company (Clients, Deals, Money, Invoices and quotes, or a company list shown as a section of its own), or calling a section by the company's own word. Kin shows the owner or a co-owner one card listing each change; nothing changes until they tap Confirm, and a newer card replaces an unanswered one. When someone else asks, pass it to the owner with kin_relay.",
  parameters: CompanySectionsInput,
  success: CompanySectionsResult,
}).annotate(McpSchema.EnabledWhen, enabled);

const isKinChatError = Schema.is(KinChatError);
export const proposeHandler = McpToolAccess.actsAsCaller(
  Effect.fn("KinShellToolkit.propose")(
    function* (input: typeof CompanySectionsInput.Type) {
      return yield* propose(yield* McpInvocationContext, input);
    },
    Effect.mapError((error) =>
      isKinChatError(error)
        ? error
        : new KinChatError({ reason: "unavailable", message: "Kin couldn't do that right now." }),
    ),
  ),
);
