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
import { delegatedTurn, workerMayReach } from "../lead/AgentSession.ts";

type Check = (
  turn: Parameters<typeof toolAdmitted>[0],
  tool: string,
  args: unknown,
) => Effect.Effect<boolean, never, Services>;

export const TASK_LIMIT_REFUSAL =
  "Today's limit for delegated tasks is reached, so no task starts until it resets at midnight; don't try again. Tell the owner, who can also raise it in Settings.";

/** What a task delegated from a lead reads when it calls a T3 tool its lead doesn't get. */
export const WORKER_REFUSAL = "That tool isn't part of this work.";

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
 * The calls on T3's own endpoint from a task delegated, at any depth, from a lead: only its lead's
 * T3 tools, each through the checks a call from the turn that asked for it passes
 * (`delegatedTurn`, as its shell follows). Every other thread's calls pass untouched.
 */
export const workers = (services: Context.Context<Services>) => {
  const sql = Context.get(services, SqlClient.SqlClient);
  const lineage = Effect.gen(function* () {
    const thread = Option.getOrUndefined(yield* Effect.serviceOption(McpInvocationContext))?.thread;
    if (thread === undefined) return { delegated: false, turn: undefined };
    return yield* delegatedTurn(thread.threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  });
  const refusing = Effect.catchCause((cause) =>
    Effect.logWarning("Kin worker tool gate failed; refusing", { cause }).pipe(Effect.as(false)),
  );
  const gate = (name: string, check: Check) =>
    Effect.fn(name)(function* (tool: string, args: unknown) {
      const { delegated, turn } = yield* lineage;
      if (!delegated) return true;
      if (turn === undefined) return false;
      return yield* check(turn, tool, args).pipe(Effect.provideContext(services));
    }, refusing);
  const reach = Effect.fn("KinToolGate.workerReach")(function* (tool: string) {
    return !(yield* lineage).delegated || workerMayReach(tool);
  }, refusing);
  return Layer.mergeAll(
    McpHttpServer.toolCallGate(reach, WORKER_REFUSAL),
    McpHttpServer.toolCallGate(gate("KinToolGate.workerAdmitted", toolAdmitted), SHARED_REFUSAL),
    McpHttpServer.toolCallGate(
      gate("KinToolGate.workerOutside", outsideToolAllowed),
      OUTSIDE_REFUSAL,
    ),
    McpHttpServer.toolCallGate(
      gate("KinToolGate.workerTaskLimit", taskAdmitted),
      TASK_LIMIT_REFUSAL,
    ),
  );
};

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
