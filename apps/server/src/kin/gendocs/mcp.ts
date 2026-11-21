import { KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
import { KinRecords } from "../work/KinRecords.ts";
import { fileDocument, writeRecipe } from "./agentFiles.ts";
import * as Documents from "./leadDocuments.ts";
import { KinDocRenderer } from "./render.ts";
import { KinWorkspace } from "./workspace.ts";

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
const shared = {
  failure: Schema.Union([KinChatError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    Lead.LeadMemory,
    McpInvocationContext,
    ThreadManagementService,
    KinWorkspace,
    KinRecords,
    KinIdentity,
    KinDocRenderer,
    KinLevelGate,
    SqlClient.SqlClient,
    FileSystem.FileSystem,
    Path.Path,
    ServerConfig,
  ],
};

/** Files Kin makes from a recipe in the call, files the agent made, and recipes the agent writes. */
export const KinDocumentToolkit = Toolkit.make(
  Tool.make("kin_document", {
    ...shared,
    description:
      "Make or file a file the owner keeps or sends: a PDF, spreadsheet, deck, image or CSV. A doc is text you write and keep current (doc_create); a chart answers in chat (kin_chart); this makes a file. With recipe (from kin_recipes) and entry, Kin makes it now, in this call: it reads every stored figure, works out every sum itself, files the result as a doc and shows its card in the chat. Pass in inputs only the recipe inputs that are yours, never an amount Kin stores, and never work out a figure yourself. If it is refused, nothing was made and the reason says why. A numbered recipe makes a draft marked DRAFT until the entry is issued (kin_issue), which makes it again with its number. A quote is an entry of the quotes list made with the quotation recipe; to invoice it, pass from with its key and the invoice recipe instead of entry. A doc becomes a PDF with the report recipe and doc: its key. When no recipe fits, make the file yourself with your shell (typst is on your PATH) and pass its full path in file: Kin checks it and files it as a doc with its card in the chat. writeRecipe writes a new recipe, or changes the one named: to change how a document looks or what it shows, change its recipe. The first call gives you a folder to edit with your own tools; call again to keep it, which Kin does once its sample renders, showing the sample to the owner. To make it look like a file the owner sent, such as an invoice in their old format, add references with that file's attachment id on the first call: copy the look, never the data. kin_recipe_undo puts the old look back. Only when only the owner is in the turn. Identical retries return the same result.",
    parameters: Documents.DocumentInput,
    success: Documents.DocumentResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("kin_recipes", {
    ...shared,
    description:
      "List the recipes this company's files are made from: each one's name, what it makes, the list it is for, whether it is numbered or confidential, its inputs (from is agent for the ones you give, else where Kin reads it), the fields Kin computes and its output files. Read-only.",
    success: Documents.RecipesResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("kin_issue", {
    ...shared,
    description:
      "Issue a draft entry of a numbered list, such as an invoice: Kin gives it the next number in its series for this financial year, dates it today if it had no date, marks it issued, and makes its documents again with the number, as new versions of the same docs. The number is for good: asking again returns it and makes again any of its documents that don't carry it yet, and a voided entry keeps it. void: true voids it instead; unvoid: true takes a void back with its number, so never issue a new one for it. An entry dated before one already issued still takes the next number, and the result's notice says so: warn the owner before issuing a backdated one. An invoice is issued with the total its own document shows, so make its document first when it has no amount; when the entry records a different amount, nothing is issued and the reason gives both: ask the owner which is right. Only when the owner asked, in a turn only the owner is in.",
    parameters: Documents.IssueInput,
    success: Documents.IssueResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("kin_receipt", {
    ...shared,
    description:
      "Make a receipt for money received, numbered in the receipts series for this financial year, with its PDF in the receipt recipe's look; its card shows in the chat. For a payment recorded on an invoice, pass payment (its paymentId): the receipt is for the payment's own amount, and a receipt number the old system gave it in an imported payment's note is kept. For money received before any invoice, pass advance (client, amount as the owner said it, day) with towards: it is recorded as received, like a payment, and the owner sees it with their money. Later, pass entry (the advance's receipt) and against (an invoice of the same client) to set it against that invoice as a payment; Kin refuses one with no client, another client's invoice, or more than the invoice still owes. A receipt that would record money not already recorded as a live payment (any advance, or an entry with no payment) is not made: it returns status proposed and Kin shows the owner a Confirm card with the client, amount, day and what it is set against from the records, and your towards, mode and reference as your note. The owner's tap on Confirm records it and makes its receipt; in a later turn, call again with only proposal to read what was made. Cancel ends it, a card whose figures changed since is refused, and changed arguments are a new card. A receipt whose payment was taken back is void and is refused. Kin writes a receipt's payment, invoice and number itself; record_create and record_update can't. Asking again returns the same receipt and number. Only when the owner asked, in a turn only the owner is in.",
    parameters: Documents.ReceiptInput,
    success: Documents.ReceiptResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("kin_recipe_undo", {
    ...shared,
    description:
      "Undo the last change to a recipe, such as a new look the owner doesn't like: Kin puts it back as it was before, as a new change, so undoing again redoes it. Only when the owner asked, in a turn only the owner is in.",
    parameters: Documents.UndoInput,
    success: Documents.UndoResult,
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
      const scope = yield* McpInvocationContext;
      if (input.writeRecipe === true) return yield* writeRecipe(scope, input);
      return input.recipe === undefined
        ? yield* fileDocument(scope, input)
        : yield* Documents.make(scope, input);
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
