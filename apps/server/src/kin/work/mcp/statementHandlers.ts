import { KinChatError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as Statements from "../leadStatements.ts";
import { KinStatementToolkit } from "./statementTools.ts";

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Statements are unavailable right now." });

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinStatementToolkit, {
  statement_read: McpToolAccess.actsAsCaller(
    Effect.fn("KinStatementToolkit.read")(function* (input) {
      return yield* Statements.read(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  statement_rows: McpToolAccess.reads(
    Effect.fn("KinStatementToolkit.rows")(function* (input) {
      return yield* Statements.rows(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});
