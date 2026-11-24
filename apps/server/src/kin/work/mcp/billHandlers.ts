import { KinChatError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as Bills from "../leadBills.ts";
import { KinBillToolkit } from "./billTools.ts";

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Bills are unavailable right now." });

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinBillToolkit, {
  bills_add: McpToolAccess.actsAsCaller(
    Effect.fn("KinBillToolkit.add")(function* (input) {
      return yield* Bills.add(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  bill_read: McpToolAccess.actsAsCaller(
    Effect.fn("KinBillToolkit.read")(function* (input) {
      return yield* Bills.read(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});
