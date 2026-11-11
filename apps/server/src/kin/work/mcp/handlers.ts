import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { KinChatError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Work from "../leadWork.ts";
import { KinWorkToolkit } from "./tools.ts";

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Work is unavailable right now." });

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinWorkToolkit, {
  records_query: McpToolAccess.reads(
    Effect.fn("KinWorkToolkit.query")(function* (input) {
      return yield* Work.query(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  record_get: McpToolAccess.reads(
    Effect.fn("KinWorkToolkit.get")(function* (input) {
      return yield* Work.get(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  record_create: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.create")(function* (input) {
      return yield* Work.create(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  record_update: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.update")(function* (input) {
      return yield* Work.update(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});
