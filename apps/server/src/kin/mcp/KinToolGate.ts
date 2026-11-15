import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { KinServer } from "../KinServer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { SHARED_REFUSAL } from "../lead/Audience.ts";
import { OUTSIDE_REFUSAL, outsideToolAllowed } from "../lead/OutsideContent.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";

type Check = typeof toolAdmitted;

/**
 * Runs `check` on the calling lead's running turn: no running lead turn admits nothing. The
 * endpoint's auth middleware provides the caller; without it nothing passes.
 */
const gate = (name: string, check: Check) =>
  Effect.fn(name)(
    function* (tool: string, args: unknown) {
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
      return yield* check({ orgId, agentId, wakeupId: row.wakeupId }, tool, args).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin tool gate failed; refusing", { cause }).pipe(Effect.as(false)),
    ),
  );

/**
 * Every tool call on the Kin MCP endpoint passes here before its handler, whichever toolkit
 * registered it: nothing reaches the owner's context in a turn someone else can read
 * (`SharedTools`), and nothing outside text could steer runs once the turn has read some
 * (`OutsideContent`). Each refuses with its own line.
 */
export const layer = Layer.mergeAll(
  McpHttpServer.toolCallGate(gate("KinToolGate.admitted", toolAdmitted), SHARED_REFUSAL),
  McpHttpServer.toolCallGate(gate("KinToolGate.outside", outsideToolAllowed), OUTSIDE_REFUSAL),
);
