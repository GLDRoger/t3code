import { KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { ServerConfig } from "../../config.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Lead from "../lead/LeadMemory.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { KinWorkers } from "../lead/Workers.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { DocumentInput, DocumentResult } from "./DocJobs.ts";
import * as Documents from "./leadDocuments.ts";
import { KinDocRenderer } from "./render.ts";
import { KinWorkspace } from "./workspace.ts";
import { deferredMeta } from "../lead/deferredTools.ts";

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
    KinDocRenderer,
    KinLevelGate,
    SqlClient.SqlClient,
    FileSystem.FileSystem,
    ServerConfig,
  ],
};

/** Files Kin makes: a recipe's document in the call, or a worker's one-off file or new recipe. */
export const KinDocumentToolkit = Toolkit.make(
  Tool.make("kin_document", {
    ...shared,
    description:
      "Make a file the owner keeps or sends: PDF, spreadsheet, deck, image or CSV (a doc is text you keep current: doc_create; a chart answers in chat: kin_chart). With recipe (from kin_recipes) and entry, Kin makes it now: it reads every stored figure, does every sum, files it as a doc and shows its card. In inputs pass only the recipe inputs that are yours, never an amount Kin stores or one you worked out. A numbered recipe makes a DRAFT until kin_issue numbers the entry. A quote is a quotes entry made with the quotation recipe; to invoice it, pass from with its key and the invoice recipe instead of entry. A doc becomes a PDF with the report recipe and doc: its key. Without recipe, a worker makes a one-off file from your brief, which must hold every figure it shows; it arrives later on a task card. writeRecipe has a worker write a new recipe or change the named one: to change how a document looks or what it shows, change its recipe. To copy the look of a file the owner sent (an invoice in their old format), add references with its attachment id: the look, never the data; kin_recipe_undo restores the old look. A refusal says why; nothing was made.",
    parameters: DocumentInput,
    success: DocumentResult,
  }).annotate(McpSchema.EnabledWhen, enabled)
    .annotate(Tool.Meta, deferredMeta),
  Tool.make("kin_recipes", {
    ...shared,
    description:
      "List the recipes the company's files are made from: name, what it makes, its list, numbered or confidential, inputs (from: agent for yours, else where Kin reads it), computed fields and output files. Read-only.",
    success: Documents.RecipesResult,
  }).annotate(McpSchema.EnabledWhen, enabled)
    .annotate(Tool.Meta, deferredMeta),
  Tool.make("kin_issue", {
    ...shared,
    description:
      "Issue a draft entry of a numbered list, such as an invoice, only when the owner asked: Kin gives it the next number in its series for this financial year, dates it today if undated, and remakes its documents with the number. The number is for good: asking again returns it and remakes documents that lack it. void: true voids it; unvoid: true restores a void with its number, so never issue a new one for it. A backdated entry still takes the next number and the notice says so: warn the owner before issuing one. An invoice issues with the total its document shows, so make its document first when it has no amount; if the entry records a different amount nothing is issued: ask the owner which is right.",
    parameters: Documents.IssueInput,
    success: Documents.IssueResult,
  }).annotate(McpSchema.EnabledWhen, enabled)
    .annotate(Tool.Meta, deferredMeta),
  Tool.make("kin_receipt", {
    ...shared,
    description:
      "Make a receipt for money received, only when the owner asked: numbered in the receipts series for the financial year, PDF in the receipt recipe's look, card in the chat. For a payment recorded on an invoice, pass payment (its paymentId): the receipt is for that amount, keeping an imported payment's old receipt number. For money received before any invoice, pass advance (client, amount as said, day) with towards; later pass entry (the advance's receipt) and against (an invoice of the same client) to set it against that invoice. Money not already recorded as a live payment returns status proposed: the owner sees a Confirm card with the client, amount, day and what it is set against, with your towards, mode and reference as your note; his Confirm records it and makes the receipt (call again with only proposal to read it). Kin writes the receipt's payment, invoice and number; record_create and record_update can't. Asking again returns the same receipt.",
    parameters: Documents.ReceiptInput,
    success: Documents.ReceiptResult,
  }).annotate(McpSchema.EnabledWhen, enabled)
    .annotate(Tool.Meta, deferredMeta),
  Tool.make("kin_recipe_undo", {
    ...shared,
    description:
      "Undo the last change to a recipe, such as a new look the owner doesn't like, only when he asked; undoing again redoes it.",
    parameters: Documents.UndoInput,
    success: Documents.UndoResult,
  }).annotate(McpSchema.EnabledWhen, enabled)
    .annotate(Tool.Meta, deferredMeta),
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
      const scope = yield* McpInvocationContext;
      // A recipe's document is the server's to make now; only a worker writes a file or a recipe.
      return input.recipe !== undefined && input.writeRecipe !== true
        ? yield* Documents.make(scope, input)
        : yield* (yield* KinWorkers).document(scope, input);
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
  kin_receipt: McpToolAccess.actsAsCaller(
    Effect.fn("KinDocumentToolkit.receipt")(function* (input) {
      return yield* Documents.receipt(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  kin_recipe_undo: McpToolAccess.actsAsCaller(
    Effect.fn("KinDocumentToolkit.undoRecipe")(function* (input) {
      return yield* Documents.undoRecipe(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});
