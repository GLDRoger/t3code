import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { KinServer } from "../KinServer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { SHARED_REFUSAL, effectiveAudience } from "../lead/Audience.ts";
import { sharedToolAllowed } from "../lead/SharedTools.ts";

/**
 * Whether the calling lead's running turn may make this call: everything when only the owner can
 * read it, else what `SharedTools` allows. No running lead turn admits nothing.
 */
const admitted = Effect.fn("KinToolGate.admitted")(
  function* (name: string, args: unknown) {
    // The endpoint's auth middleware provides it with the caller; without it nothing passes.
    const kin = yield* Effect.serviceOption(KinServer);
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return false;
    const identity = Context.get(kin.value.services.value, KinIdentity);
    const sql = Context.get(kin.value.services.value, SqlClient.SqlClient);
    const agent = yield* identity.resolveAgent(yield* McpInvocationContext).pipe(Effect.option);
    if (Option.isNone(agent)) return false;
    const { orgId, agentId, threadId } = agent.value;
    const [row] = yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId" FROM kin_wakeups
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND thread_id = ${threadId}
      AND status = 'running'
    ORDER BY started_at, wakeup_id LIMIT 1`;
    if (row === undefined) return false;
    const turn = { orgId, agentId, wakeupId: row.wakeupId };
    return (
      (yield* effectiveAudience(turn).pipe(Effect.provideService(SqlClient.SqlClient, sql))) ===
        "owner_only" ||
      (yield* sharedToolAllowed(turn, name, args).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ))
    );
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin tool gate failed; refusing", { cause }).pipe(Effect.as(false)),
  ),
);

/**
 * Every tool call on the Kin MCP endpoint passes here before its handler, whichever toolkit
 * registered it, so no tool reaches the owner's context in a turn someone else can read.
 */
export const layer = McpHttpServer.toolCallGate(admitted, SHARED_REFUSAL);
