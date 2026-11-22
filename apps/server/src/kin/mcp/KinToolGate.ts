import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { OrchestratorMcpTarget } from "@t3tools/contracts";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpToolPolicy from "./toolPolicy.ts";
import { McpInvocationContext, type McpThreadCaller } from "../../mcp/McpInvocationContext.ts";
import { KinServer, type Services } from "../KinServer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { SHARED_REFUSAL } from "../lead/Audience.ts";
import { OUTSIDE_REFUSAL, outsideToolAllowed } from "../lead/OutsideContent.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import { REVIEW_REFUSAL, reviewToolAllowed } from "../lead/outsideReview.ts";
import { APPROVED_REFUSAL, approvedToolAllowed } from "../lead/approvedDraft.ts";
import { TURN_EVENT_TOOLS, TURN_ONLY_EVENT_TOOLS } from "../lead/eventIds.ts";
import { KinBudget } from "../lead/KinBudget.ts";
import { delegatedTurn, workerMayReach } from "../lead/AgentSession.ts";
import { helperModelRefusal, isDevServer, kinHelperProviders } from "../lead/leadModels.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as KinShell from "../shell/KinShell.ts";
import { sectionOfKey, sectionOfList, sectionOfTool } from "../shell/sections.ts";
import * as ReadTools from "./readTools.ts";

type Check = (
  turn: Parameters<typeof toolAdmitted>[0],
  tool: string,
  args: unknown,
) => Effect.Effect<boolean, never, Services>;

export const TASK_LIMIT_REFUSAL =
  "Today's limit for delegated tasks is reached, so no task starts until it resets at midnight; don't try again. Tell the owner, who can also raise it in Settings.";

/** What a task delegated from a lead reads when it calls a T3 tool its lead doesn't get. */
export const WORKER_REFUSAL = "That tool isn't part of this work.";

/** What a lead, or a task it delegated, reads when a call names another machine. */
export const REMOTE_REFUSAL =
  "Kin's work stays on this server, so this call can't go to another machine; leave out environmentId to delegate or do it here.";

/** Whether a call names another machine: its `environmentId`, or `delegate_task`'s `target.environmentId`. */
const namesOtherMachine = Effect.fnUntraced(function* (args: unknown) {
  const here = Option.getOrUndefined(
    yield* Effect.serviceOption(McpInvocationContext),
  )?.environmentId;
  const target = Predicate.hasProperty(args, "target") ? args.target : undefined;
  return [
    Predicate.hasProperty(args, "environmentId") ? args.environmentId : undefined,
    Predicate.hasProperty(target, "environmentId") ? target.environmentId : undefined,
  ].some((environmentId) => environmentId !== undefined && environmentId !== here);
});

/** What a Kin agent reads when the check itself failed. */
export const HELPER_MODEL_UNCHECKED =
  "Kin can't check this task's model right now, so it didn't start it. Leave target.model and target.providerInstanceId out to run it on your own model.";

const decodeTarget = Schema.decodeUnknownOption(
  Schema.Union([OrchestratorMcpTarget, Schema.fromJsonString(OrchestratorMcpTarget)]),
);

/** What a helper's check reads of the host, taken once when the gate is built. */
export const helperModelHost = Effect.gen(function* () {
  return {
    settings: yield* Effect.serviceOption(ServerSettingsService),
    registry: yield* Effect.serviceOption(ProviderRegistry),
    devServer: yield* isDevServer,
  };
});
type HelperModelHost = Effect.Success<typeof helperModelHost>;

/**
 * Why a Kin agent's `delegate_task` may not start on the provider and model its target names
 * (`helperModelRefusal`), before any task exists; a target T3 can't decode is T3's to refuse.
 */
export const helperModelRefused = Effect.fn("KinToolGate.helperModel")(
  function* (tool: string, args: unknown, host: HelperModelHost) {
    if (tool !== "delegate_task" || !Predicate.hasProperty(args, "target")) return undefined;
    const target = Option.getOrUndefined(decodeTarget(args.target));
    if (target === undefined) return undefined;
    const callerInstanceId = Option.getOrUndefined(
      yield* Effect.serviceOption(McpInvocationContext),
    )?.thread?.providerInstanceId;
    const named =
      target.model !== undefined ||
      target.driverKind !== undefined ||
      (target.providerInstanceId !== undefined && target.providerInstanceId !== callerInstanceId);
    if (!named) return undefined;
    if (Option.isNone(host.settings)) return HELPER_MODEL_UNCHECKED;
    const providers = Option.isNone(host.registry)
      ? null
      : yield* host.registry.value.getProviders.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin couldn't read the providers for a task", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
    return helperModelRefusal({
      settings: yield* host.settings.value.getSettings,
      providers,
      devServer: host.devServer,
      callerInstanceId,
      target,
    });
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin couldn't check a task's model; refusing", { cause }).pipe(
      Effect.as<string | undefined>(HELPER_MODEL_UNCHECKED),
    ),
  ),
);

/** A Kin agent's `orchestrator_capabilities` offers what its helper tasks may run on. */
const offeredToAgents = (
  settings: Parameters<typeof kinHelperProviders>[0],
  providers: Parameters<typeof kinHelperProviders>[1],
) => Effect.succeed(kinHelperProviders(settings, providers));

/** A Kin agent's helper tasks run only on what agents may, and it is offered only that. */
export const helperModels = Layer.mergeAll(
  McpToolPolicy.toolCallRefusal(
    Effect.map(
      helperModelHost,
      (host) => (tool: string, args: unknown) => helperModelRefused(tool, args, host),
    ),
  ),
  McpToolPolicy.providersOffered(offeredToAgents),
);

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
const turnEvents = McpToolPolicy.toolCallPrepare(
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

/** An outside review's turn refuses what it may not call with the review's own refusal. */
const reviewOnly: Check = (turn, tool, args) =>
  reviewToolAllowed(turn, tool, args).pipe(Effect.map((allowed) => allowed ?? true));
/** An approved draft's turn refuses what it may not call with its own refusal. */
const approvedOnly: Check = (turn, tool, args) =>
  approvedToolAllowed(turn, tool, args).pipe(Effect.map((allowed) => allowed ?? true));
/** A confined turn (an outside review, an approved draft) is decided by its own gate alone. */
const confinedDecides = (turn: Parameters<Check>[0], tool: string, args: unknown) =>
  reviewToolAllowed(turn, tool, args).pipe(
    Effect.flatMap((review) =>
      review !== undefined
        ? Effect.succeed(true)
        : approvedToolAllowed(turn, tool, args).pipe(
            Effect.map((approved) => approved !== undefined),
          ),
    ),
  );
const besideReview =
  (check: Check): Check =>
  (turn, tool, args) =>
    confinedDecides(turn, tool, args).pipe(
      Effect.flatMap((confined) => (confined ? Effect.succeed(true) : check(turn, tool, args))),
    );
const sectionOfArguments = (args: unknown) => {
  const pending = [{ value: args, list: false }];
  while (pending.length > 0) {
    const { value, list } = pending.pop()!;
    if (typeof value === "string") {
      const section = sectionOfKey(value) ?? (list ? sectionOfList(value) : null);
      if (section !== null) return section;
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, list });
    } else if (Predicate.isReadonlyObject(value)) {
      for (const [key, child] of Object.entries(value))
        pending.push({ value: child, list: key === "list" || key === "lists" });
    }
  }
  return null;
};

const DEALS_OFF =
  "Deals is turned off for this company. An owner can turn it on in Settings › Deals.";

const dealRefusal = (args: unknown) => {
  if (!Predicate.hasProperty(args, "records") || !Array.isArray(args.records)) return DEALS_OFF;
  const index = args.records.findIndex((row: unknown) => sectionOfArguments(row) === "deals");
  if (index < 0) return DEALS_OFF;
  const row: unknown = args.records[index];
  const named =
    Predicate.hasProperty(row, "title") && typeof row.title === "string"
      ? ` (${JSON.stringify(row.title.slice(0, 60))})`
      : "";
  return `Row ${index + 1}${named}: ${DEALS_OFF} Nothing was saved.`;
};

const sectionAdmitted = McpToolPolicy.toolCallGate((name, args) => {
  const section = sectionOfTool(name) ?? sectionOfArguments(args);
  return section === null
    ? Effect.succeed(true)
    : gate("KinToolGate.section", (turn) =>
        KinShell.sectionOn(turn.orgId, section).pipe(Effect.orElseSucceed(() => false)),
      )(name, args);
}, dealRefusal);
const admitted = besideReview(toolAdmitted);
const outside = besideReview(outsideToolAllowed);

const kinChecks = [
  [reviewOnly, REVIEW_REFUSAL],
  [approvedOnly, APPROVED_REFUSAL],
  [toolAdmitted, SHARED_REFUSAL],
  [outsideToolAllowed, OUTSIDE_REFUSAL],
  [taskAdmitted, TASK_LIMIT_REFUSAL],
] as const;

/**
 * Kin's policy for T3's own endpoint. A task delegated, at any depth, from a lead (or one whose
 * lineage can't be read) lists, finds and may call only its lead's T3 tools, never on another
 * machine, each through the checks a call from the turn that asked for it passes
 * (`delegatedTurn`, as its shell follows). Every other thread's list and calls are T3's.
 */
export const workerPolicy = (services: Context.Context<Services>, host: HelperModelHost) => {
  const sql = Context.get(services, SqlClient.SqlClient);
  // Per token: a thread's lineage is written before its session's token is issued.
  const known = new WeakMap<object, boolean>();
  const lineage = (thread: McpThreadCaller | undefined) =>
    thread === undefined
      ? Effect.succeed({ lineage: "ordinary", delegated: false, turn: undefined } as const)
      : delegatedTurn(thread.threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const caller = Effect.map(Effect.serviceOption(McpInvocationContext), Option.getOrUndefined);
  const isWorker = Effect.gen(function* () {
    const scope = yield* caller;
    const cached = scope === undefined ? undefined : known.get(scope);
    if (cached !== undefined) return cached;
    const found = yield* lineage(scope?.thread);
    // A lookup that failed may succeed next time.
    if (scope !== undefined && found.lineage !== "unresolved") known.set(scope, found.delegated);
    return found.delegated;
  });
  return {
    visible: (name: string) =>
      workerMayReach(name) ? Effect.succeed(true) : Effect.map(isWorker, (worker) => !worker),
    offered: (
      settings: Parameters<typeof kinHelperProviders>[0],
      providers: Parameters<typeof kinHelperProviders>[1],
    ) =>
      Effect.map(isWorker, (worker) =>
        worker ? kinHelperProviders(settings, providers) : providers,
      ),
    refusal: Effect.fn("KinToolGate.workerRefusal")(
      function* (tool: string, args: unknown) {
        const { delegated, turn } = yield* lineage((yield* caller)?.thread);
        if (!delegated) return undefined;
        if (!workerMayReach(tool)) return WORKER_REFUSAL;
        if (yield* namesOtherMachine(args)) return REMOTE_REFUSAL;
        if (turn === undefined) return SHARED_REFUSAL;
        for (const [check, refusal] of kinChecks)
          if (!(yield* check(turn, tool, args).pipe(Effect.provideContext(services))))
            return refusal;
        return yield* helperModelRefused(tool, args, host);
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin worker tool gate failed; refusing", { cause }).pipe(
          Effect.as<string | undefined>(SHARED_REFUSAL),
        ),
      ),
    ),
  };
};

/**
 * How often agents call each Kin tool, to decide what loads up front: counted in memory and
 * logged as one line an hour, and once more when the server stops; never stored.
 */
export const callCounts = Layer.unwrap(
  Effect.gen(function* () {
    const counts = new Map<string, number>();
    const flush = Effect.suspend(() => {
      if (counts.size === 0) return Effect.void;
      const calls = Object.fromEntries(counts);
      counts.clear();
      return Effect.logInfo("Kin tool calls", { calls });
    });
    yield* Effect.addFinalizer(() => flush);
    yield* Effect.forkScoped(Effect.forever(Effect.delay(flush, "1 hour")));
    return McpHttpServer.toolCallAround((effect, { target }) => {
      counts.set(target, (counts.get(target) ?? 0) + 1);
      return effect;
    });
  }),
);

/**
 * Every Kin MCP call passes here first, whatever registered it: nothing to another machine, where
 * none of these checks follow; only the review in a stranger's pull request's turn
 * (`outsideReview`), only the one approved make in an approved draft's (`approvedDraft`); nothing reaches the owner's context in a turn others read (`SharedTools`); no
 * run outside text could steer (`OutsideContent`); no task past the limit (or off `helperModels`).
 */
export const layer = ReadTools.layer.pipe(
  // Built last, so outermost: a read tool's gates read on the reader too.
  Layer.provideMerge(
    Layer.mergeAll(
      callCounts,
      turnEvents,
      McpToolPolicy.toolCallGate(
        (_tool, args) => Effect.map(namesOtherMachine(args), (other) => !other),
        REMOTE_REFUSAL,
      ),
      McpToolPolicy.toolCallGate(gate("KinToolGate.review", reviewOnly), REVIEW_REFUSAL),
      McpToolPolicy.toolCallGate(gate("KinToolGate.approved", approvedOnly), APPROVED_REFUSAL),
      McpToolPolicy.toolCallGate(gate("KinToolGate.admitted", admitted), SHARED_REFUSAL),
      McpToolPolicy.toolCallGate(gate("KinToolGate.outside", outside), OUTSIDE_REFUSAL),
      McpToolPolicy.toolCallGate(gate("KinToolGate.taskLimit", taskAdmitted), TASK_LIMIT_REFUSAL),
      helperModels,
      sectionAdmitted,
    ),
  ),
);
