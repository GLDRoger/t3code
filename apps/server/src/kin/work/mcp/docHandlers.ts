import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { KinChatError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Docs from "../leadDocs.ts";
import { KinDocsToolkit } from "./docTools.ts";

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Docs are unavailable right now." });

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinDocsToolkit, {
  doc_create: McpToolAccess.actsAsCaller(
    Effect.fn("KinDocsToolkit.create")(function* (input) {
      return yield* Docs.create(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  doc_read: McpToolAccess.reads(
    Effect.fn("KinDocsToolkit.read")(function* (input) {
      return yield* Docs.read(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  doc_edit: McpToolAccess.actsAsCaller(
    Effect.fn("KinDocsToolkit.edit")(function* (input) {
      return yield* Docs.edit(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  doc_rewrite: McpToolAccess.actsAsCaller(
    Effect.fn("KinDocsToolkit.rewrite")(function* (input) {
      return yield* Docs.rewrite(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  doc_move: McpToolAccess.actsAsCaller(
    Effect.fn("KinDocsToolkit.move")(function* (input) {
      return yield* Docs.move(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  doc_link: McpToolAccess.actsAsCaller(
    Effect.fn("KinDocsToolkit.link")(function* (input) {
      return yield* Docs.link(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  docs_search: McpToolAccess.reads(
    Effect.fn("KinDocsToolkit.search")(function* (input) {
      return yield* Docs.searchTool(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  doc_history: McpToolAccess.reads(
    Effect.fn("KinDocsToolkit.history")(function* (input) {
      return yield* Docs.history(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  doc_restore: McpToolAccess.actsAsCaller(
    Effect.fn("KinDocsToolkit.restore")(function* (input) {
      return yield* Docs.restore(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});
