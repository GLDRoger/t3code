import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { LeadMemory } from "../LeadMemory.ts";
import { KinLeadToolkit } from "./tools.ts";

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinLeadToolkit, {
  memory_search: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.search")(function* (input) {
      return yield* (yield* LeadMemory).search(yield* McpInvocationContext, input);
    }),
  ),
  memory_read: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.read")(function* (input) {
      return yield* (yield* LeadMemory).read(yield* McpInvocationContext, input);
    }),
  ),
  memory_write: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.write")(function* (input) {
      return yield* (yield* LeadMemory).write(yield* McpInvocationContext, input);
    }),
  ),
  kin_defer: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.defer")(function* (input) {
      return yield* (yield* LeadMemory).defer(yield* McpInvocationContext, input);
    }),
  ),
  kin_journal: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.journal")(function* (input) {
      return yield* (yield* LeadMemory).journal(yield* McpInvocationContext, input);
    }),
  ),
  kin_end: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.end")(function* (input) {
      return yield* (yield* LeadMemory).end(yield* McpInvocationContext, input);
    }),
  ),
});
