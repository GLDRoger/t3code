import { LEAD_T3_TOOLS } from "../lead/t3Tools.ts";
import { viewOf } from "../work/leadWork.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "../work/teamView.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

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
import * as KinShell from "../shell/KinShell.ts";
import {
  looksLikeRecordReference,
  resolveSections,
  SECTIONS,
  sectionOfList,
  sectionOfTool,
  type SectionId,
} from "../shell/sections.ts";
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
const inRunningTurn = <A, B>(
  name: string,
  check: (...input: Parameters<Check>) => Effect.Effect<A, never, Services>,
  otherwise: B,
) =>
  Effect.fn(name)(
    function* (tool: string, args: unknown) {
      const kin = yield* Effect.serviceOption(KinServer);
      if (Option.isNone(kin) || Option.isNone(kin.value.services)) return otherwise;
      const identity = Context.get(kin.value.services.value, KinIdentity);
      const sql = Context.get(kin.value.services.value, SqlClient.SqlClient);
      const agent = yield* identity.resolveAgent(yield* McpInvocationContext).pipe(Effect.option);
      if (Option.isNone(agent)) return otherwise;
      const { orgId, agentId, threadId } = agent.value;
      const [row] = yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId" FROM kin_wakeups
      WHERE org_id = ${orgId} AND agent_id = ${agentId} AND thread_id = ${threadId}
        AND status = 'running'
      ORDER BY started_at, wakeup_id LIMIT 1`;
      if (row === undefined) return otherwise;
      return yield* check({ orgId, agentId, wakeupId: row.wakeupId }, tool, args).pipe(
        Effect.provideContext(kin.value.services.value),
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin tool gate failed; refusing", { cause }).pipe(Effect.as(otherwise)),
    ),
  );

const gate = (name: string, check: Check) => inRunningTurn(name, check, false);

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
const sectionsOfArguments = (
  args: unknown,
  sectionOfReference: (value: string) => SectionId | null,
  skipForeignArguments = false,
) => {
  const sections = new Set<SectionId>();
  const pending = [{ value: args, field: "" }];
  while (pending.length > 0) {
    const { value, field } = pending.pop()!;
    if (typeof value === "string") {
      const section =
        sectionOfReference(value.trim()) ??
        (field === "list" || field === "lists" ? sectionOfList(value) : null) ??
        ((field === "client" || field === "project") && value.trim() !== "" ? "clients" : null);
      if (section !== null) sections.add(section);
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, field });
    } else if (Predicate.isReadonlyObject(value)) {
      for (const [key, child] of Object.entries(value))
        if (!skipForeignArguments || key !== "arguments")
          pending.push({ value: child, field: key });
    }
  }
  return sections;
};

const sectionRefusal = (
  message: string,
  args: unknown,
  section: SectionId,
  sectionOfReference: (value: string) => SectionId | null,
) => {
  if (!Predicate.hasProperty(args, "records") || !Array.isArray(args.records)) return message;
  const index = args.records.findIndex((row: unknown) =>
    sectionsOfArguments(row, sectionOfReference).has(section),
  );
  if (index < 0) return message;
  const row: unknown = args.records[index];
  const named =
    Predicate.hasProperty(row, "title") && typeof row.title === "string"
      ? ` (${JSON.stringify(row.title.slice(0, 60))})`
      : "";
  return `Row ${index + 1}${named}: ${message} Nothing was saved.`;
};

const forwardedTools: ReadonlySet<string> = new Set(LEAD_T3_TOOLS);
const sectionAdmitted = McpToolPolicy.toolCallRefusal((name, args) => {
  if (!Object.hasOwn(SECTIONS.tools, name) || forwardedTools.has(name)) return Effect.undefined;
  const foreign = name === "kin_connection_call";
  const references = new Set<string>();
  const sections = sectionsOfArguments(
    args,
    (value) => {
      if (looksLikeRecordReference(value)) references.add(value);
      return null;
    },
    foreign,
  );
  const tool = sectionOfTool(name);
  const template =
    name === "list_define" &&
    Predicate.hasProperty(args, "template") &&
    typeof args.template === "string"
      ? sectionOfList(args.template)
      : null;
  if (tool !== null) sections.add(tool);
  if (template !== null) sections.add(template);
  if (sections.size === 0 && references.size === 0) return Effect.undefined;
  const unavailable = "Kin couldn't check this company's sections. Nothing was done.";
  return inRunningTurn(
    "KinToolGate.section",
    (turn) =>
      Effect.gen(function* () {
        const shell = yield* KinShell.get(turn.orgId);
        if (shell.sections.every(({ on }) => on)) return undefined;
        const team = references.size === 0 ? undefined : yield* viewOf(turn);
        const sectionOfReference = yield* resolveSections(
          turn.orgId,
          references,
          team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople(team.people),
        );
        const off =
          tool !== null && !KinShell.sectionOn(shell, tool)
            ? tool
            : [...sectionsOfArguments(args, sectionOfReference, foreign), ...sections].find(
                (id) => !KinShell.sectionOn(shell, id),
              );
        return off === undefined
          ? undefined
          : sectionRefusal(
              `${KinShell.sectionName(shell, off)} is turned off for this company.`,
              args,
              off,
              sectionOfReference,
            );
      }).pipe(Effect.orElseSucceed(() => unavailable)),
    unavailable,
  )(name, args);
});
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
export const workerPolicy = (services: Context.Context<Services>) => {
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
        return undefined;
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
 * run outside text could steer (`OutsideContent`); no task past the limit.
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
      sectionAdmitted,
    ),
  ),
);
