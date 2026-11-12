import { KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Lead from "../lead/LeadMemory.ts";
import { KinWorkers } from "../lead/Workers.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { DocumentInput, DocumentResult } from "./DocJobs.ts";
import * as Documents from "./leadDocuments.ts";
import { KinWorkspace } from "./workspace.ts";

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
  dependencies: [
    Lead.LeadMemory,
    McpInvocationContext,
    ThreadManagementService,
    KinWorkers,
    KinWorkspace,
    KinRecords,
    KinIdentity,
    SqlClient.SqlClient,
  ],
};

/** Files Kin makes: a worker runs a recipe, or the agent's brief, and Kin files the result as a doc. */
export const KinDocumentToolkit = Toolkit.make(
  Tool.make("kin_document", {
    ...shared,
    description:
      "Have a worker make a file the owner keeps or sends: a PDF, spreadsheet, deck, image or CSV. A doc is text you write and keep current (doc_create); a chart answers in chat (kin_chart); this makes a file. With recipe (from kin_recipes) and entry, Kin reads every stored figure itself and the recipe's script does all the sums: pass in inputs only the recipe inputs that are yours, never an amount Kin stores, and never work out a figure yourself. Without recipe it is a one-off file from your brief, which must hold every figure it shows. writeRecipe has a worker write a new recipe, or change the one named, so the next file is one call. A numbered recipe makes a draft marked DRAFT until the entry is issued (kin_issue); issue first when the owner wants the real one. Only from your direct chat with the owner, when only the owner is in the turn. Don't wait: the file arrives on the task card as a doc, and its report as a later event; then tell the owner in one or two lines what was made. If it is refused, nothing started. Identical retries return the same job.",
    parameters: DocumentInput,
    success: DocumentResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("kin_recipes", {
    ...shared,
    description:
      "List the recipes this company's files are made from: each one's name, what it makes, the list it is for, whether it is numbered or confidential, its inputs (from is agent for the ones you give, else where Kin reads it) and its output files. Read-only.",
    success: Documents.RecipesResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("kin_issue", {
    ...shared,
    description:
      "Issue a draft entry of a numbered list, such as an invoice: Kin gives it the next number in its series for this financial year, dates it today if it had no date, and marks it issued. The number is for good: asking again returns it, and a voided entry keeps it. void: true voids it instead. Only when the owner asked, in a turn only the owner is in. Then make its file with kin_document.",
    parameters: Documents.IssueInput,
    success: Documents.IssueResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
);

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Documents are unavailable right now." });

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinDocumentToolkit, {
  kin_document: McpToolAccess.actsAsCaller(
    Effect.fn("KinDocumentToolkit.document")(function* (input) {
      return yield* (yield* KinWorkers).document(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  kin_recipes: McpToolAccess.reads(
    Effect.fn("KinDocumentToolkit.recipes")(function* () {
      return yield* Documents.recipes(yield* McpInvocationContext, {});
    }, Effect.mapError(failure)),
  ),
  kin_issue: McpToolAccess.actsAsCaller(
    Effect.fn("KinDocumentToolkit.issue")(function* (input) {
      return yield* Documents.issue(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});
