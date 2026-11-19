import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { KinServer, type Services } from "../KinServer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { SHARED_REFUSAL } from "../lead/Audience.ts";
import { OUTSIDE_REFUSAL, outsideToolAllowed } from "../lead/OutsideContent.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import { TURN_EVENT_TOOLS, TURN_ONLY_EVENT_TOOLS } from "../lead/eventIds.ts";
import { KinBudget } from "../lead/KinBudget.ts";

type Check = (
  turn: Parameters<typeof toolAdmitted>[0],
  tool: string,
  args: unknown,
) => Effect.Effect<boolean, never, Services>;

const TASK_LIMIT_REFUSAL =
  "Today's limit for delegated tasks is reached, so no task starts until it resets at midnight; don't try again. Tell the owner, who can also raise it in Settings.";

export const taskAdmitted: Check = Effect.fn("KinToolGate.taskAdmitted")(
  function* (turn, tool) {
    if (tool !== "delegate_task") return true;
    return yield* (yield* KinBudget).admitTask(turn.orgId);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin couldn't read the task limit; refusing", { cause }).pipe(
      Effect.as(false),
    ),
  ),
);

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
        Effect.provideContext(kin.value.services.value),
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin tool gate failed; refusing", { cause }).pipe(Effect.as(false)),
    ),
  );

/**
 * The event a call acts on, from the lead's running turn: a left-out one is the turn's latest
 * message or tap, else its first event; a message id becomes its event. Anything else stays, and
 * the tool refuses it as before, except where the event only names the turn (`TURN_ONLY_EVENT_TOOLS`). The call's arguments are filled in before they are decoded.
 */
const turnEvents = McpHttpServer.toolCallPrepare(
  Effect.fn("KinToolGate.turnEvents")(
    function* (name: string, args: Record<string, unknown>) {
      if (!TURN_EVENT_TOOLS.has(name)) return;
      const given = args.sourceEventId;
      const kin = yield* Effect.serviceOption(KinServer);
      if (Option.isNone(kin) || Option.isNone(kin.value.services)) return;
      const identity = Context.get(kin.value.services.value, KinIdentity);
      const sql = Context.get(kin.value.services.value, SqlClient.SqlClient);
      const agent = yield* identity.resolveAgent(yield* McpInvocationContext).pipe(Effect.option);
      if (Option.isNone(agent)) return;
      const { orgId, agentId, threadId } = agent.value;
      const events = yield* sql<{ eventId: string; messageId: string | null; asked: number }>`
        SELECT e.event_id AS "eventId", json_extract(e.json, '$.messageId') AS "messageId",
          e.tag IN ('chat.message', 'widget.action') AS asked
        FROM kin_events e JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
        WHERE w.org_id = ${orgId} AND w.agent_id = ${agentId} AND w.thread_id = ${threadId}
          AND w.status = 'running'
        ORDER BY e.received_at, e.event_id`;
      if (events.some((event) => event.eventId === given)) return;
      const named = events.find((event) => event.messageId !== null && event.messageId === given);
      const chosen =
        named ??
        (given === undefined || TURN_ONLY_EVENT_TOOLS.has(name)
          ? (events.findLast((event) => event.asked === 1) ?? events[0])
          : undefined);
      if (chosen !== undefined) args.sourceEventId = chosen.eventId;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin couldn't fill a tool's event; the tool decides", { cause }),
    ),
  ),
);

/**
 * Every tool call on the Kin MCP endpoint passes here before its handler, whichever toolkit
 * registered it: nothing reaches the owner's context in a turn someone else can read
 * (`SharedTools`), nothing outside text could steer runs once the turn has read some
 * (`OutsideContent`), and no task starts past the owner's daily limit. Each refuses with its own line.
 */
export const layer = Layer.mergeAll(
  turnEvents,
  McpHttpServer.toolCallGate(gate("KinToolGate.admitted", toolAdmitted), SHARED_REFUSAL),
  McpHttpServer.toolCallGate(gate("KinToolGate.outside", outsideToolAllowed), OUTSIDE_REFUSAL),
  McpHttpServer.toolCallGate(gate("KinToolGate.taskLimit", taskAdmitted), TASK_LIMIT_REFUSAL),
);
