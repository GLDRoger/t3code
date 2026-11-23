import {
  KinChatError,
  KinNumberCadence,
  KinNumberDecimal,
  KinNumberDirection,
  KinNumberSource,
  KinWidgetId,
  MemoryItemEvery,
  OrchestratorMcpFailure,
  type KinOrgId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { McpSchema, Tool } from "effect/ai";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { turnChat } from "../lead/Audience.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { OUTSIDE_REFUSAL, outsideToolAllowed } from "../lead/OutsideContent.ts";
import { askOwner } from "../work/leadMoney.ts";
import { KinToolText } from "../work/leadSchemas.ts";
import { admitted, type Lead, leadTool, retryKey } from "../work/leadWork.ts";
import { ownerLevelNumbers } from "./KinNumbers.ts";
import {
  liveFeeds,
  NUMBERS_CHANGE,
  NumbersChangeJson,
  NumberSpec,
  type NumbersChange,
} from "./numberRows.ts";
import { cardLine, WATCH_NEXT } from "./words.ts";

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const encodeChange = Schema.encodeEffect(NumbersChangeJson);

export const NumbersWatchInput = Schema.Struct({
  numbers: Schema.Array(
    Schema.Struct({
      name: KinToolText(80),
      unit: Schema.optional(KinToolText(20)),
      direction: Schema.optional(KinNumberDirection).annotate({
        description: "up when a higher value is better, down when a lower one is.",
      }),
      above: Schema.optional(KinNumberDecimal),
      below: Schema.optional(KinNumberDecimal),
      compute: Schema.optional(NumberSpec).annotate({
        description: "Kin works it out from its own records instead of a feed.",
      }),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  feed: Schema.optional(
    Schema.Struct({
      source: KinNumberSource.annotate({
        description: "Where it comes from, in words the owner reads on the card, never an id.",
      }),
      every: KinNumberCadence,
      at: MemoryItemEvery.fields.at.annotate({ description: "HH:MM, the owner's time." }),
      how: Schema.optional(KinToolText(240)),
    }),
  ),
});
export const NumbersWatchResult = Schema.Struct({
  /** Each number as the owner's card lists it. */
  proposed: Schema.Array(Schema.String),
  next: Schema.String,
});

const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
/** What the card is drawn against: each named number as it stands, and the source's feed. */
export const baseOf = Effect.fn("KinNumbersWatch.base")(function* (
  orgId: KinOrgId,
  names: ReadonlyArray<string>,
  source: string | undefined,
  now: number,
) {
  const numbers = yield* ownerLevelNumbers(orgId, now, {});
  const matched = names.map((name) =>
    numbers.find((number) => nameKey(number.name) === nameKey(name)),
  );
  const feed =
    source === undefined
      ? undefined
      : (yield* liveFeeds(orgId)).find((one) => one.feed.source === source);
  return {
    matched,
    base: retryKey(
      stableStringify({
        numbers: matched.map((number) =>
          number === undefined
            ? null
            : [
                number.recordId,
                number.unit ?? null,
                number.above ?? null,
                number.below ?? null,
                number.every ?? null,
                number.definedSource ?? null,
                number.keeper ?? null,
              ],
        ),
        feed: feed === undefined ? null : [feed.scheduleId, feed.agentId, feed.feed],
      }),
    ),
  };
});

const runWatch = Effect.fnUntraced(function* (lead: Lead, input: typeof NumbersWatchInput.Type) {
  yield* admitted(lead, "numbers_watch", input);
  if (!(yield* outsideToolAllowed(lead, "numbers_watch", input)))
    return yield* new KinChatError({ reason: "not_allowed", message: OUTSIDE_REFUSAL });
  const names = input.numbers.map((number) => nameKey(number.name));
  if (new Set(names).size !== names.length) return yield* invalid("Name each number once.");
  if (input.feed !== undefined && input.numbers.every((number) => number.compute !== undefined))
    return yield* invalid("Kin works these out from its own records, so they need no feed.");
  const now = yield* Clock.currentTimeMillis;
  const { matched, base } = yield* baseOf(
    lead.orgId,
    input.numbers.map((number) => number.name),
    input.feed?.source,
    now,
  );
  if (
    matched.some(
      (number, index) =>
        number?.kind === "computed" &&
        input.numbers[index]!.compute === undefined &&
        input.feed !== undefined,
    )
  )
    return yield* invalid("Kin works that number out from its own records, so it needs no feed.");
  const change: NumbersChange = {
    numbers: input.numbers.map((number, index) => ({
      ...number,
      ...(matched[index] === undefined ? {} : { key: matched[index].key }),
    })),
    ...(input.feed === undefined ? {} : { feed: input.feed }),
    base,
  };
  const lines = change.numbers.map((number, index) =>
    cardLine(number, change.feed, matched[index]),
  );
  // Asked where the turn was asked, else in the agent's own chat with the owner.
  const chatId =
    (yield* turnChat(lead))?.chatId ??
    (yield* (yield* SqlClient.SqlClient)<{ chatId: string }>`SELECT owner_chat_id AS "chatId"
      FROM kin_leads WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}`)[0]?.chatId;
  if (chatId === undefined) return yield* invalid("There is no owner chat to confirm this in.");
  const patch = yield* encodeChange(change).pipe(Effect.orDie);
  const changeId = `${NUMBERS_CHANGE}${retryKey(`${lead.orgId}|${lead.agentId}|${lead.wakeupId}|${patch}`)}`;
  let older: ReadonlyArray<string> = [];
  const widgetId = yield* askOwner(
    lead,
    {
      chatId,
      clientMessageId: `kin-numbers:${changeId}`,
      question:
        lines.length === 1
          ? "Watch this number for the company?"
          : "Watch these numbers for the company?",
      detail: lines.join("\n"),
      yes: "Confirm",
      no: "Cancel",
    },
    (widgetId) =>
      bindNumbersChange({
        orgId: lead.orgId,
        changeId,
        agentId: lead.agentId,
        wakeupId: lead.wakeupId,
        patch,
        source: input.feed?.source ?? null,
        widgetId,
        now,
      }).pipe(
        Effect.map((replaced) => {
          older = replaced;
        }),
      ),
  );
  if (older.length > 0)
    yield* (yield* KinLevelGate).closeReplaced(lead, older, KinWidgetId.make(widgetId));
  return { proposed: lines, next: WATCH_NEXT };
});
export const watch = leadTool("KinNumbersWatch.propose", runWatch);

/**
 * Stores the proposal bound to its card and declines every older unanswered one for the same
 * source, in the card's own transaction. Returns the older cards to close.
 */
const bindNumbersChange = Effect.fn("KinNumbersWatch.bind")(function* (input: {
  readonly orgId: KinOrgId;
  readonly changeId: string;
  readonly agentId: string;
  readonly wakeupId: string;
  readonly patch: string;
  readonly source: string | null;
  readonly widgetId: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_profile_changes (org_id, change_id, agent_id, wakeup_id, patch_json,
      base_rev, widget_id, proposed_at)
    VALUES (${input.orgId}, ${input.changeId}, ${input.agentId}, ${input.wakeupId}, ${input.patch},
      0, ${input.widgetId}, ${input.now})
    ON CONFLICT (org_id, change_id) DO NOTHING`;
  // Only cards stored before this one: a retry of an older card never declines a newer one.
  const older = yield* sql<{ changeId: string; widgetId: string }>`
    SELECT change_id AS "changeId", widget_id AS "widgetId" FROM kin_profile_changes
    WHERE org_id = ${input.orgId} AND substr(change_id, 1, 3) = ${NUMBERS_CHANGE}
      AND widget_id IS NOT NULL AND applied_at IS NULL AND declined_at IS NULL
      AND json_extract(patch_json, '$.feed.source') IS ${input.source}
      AND rowid < (SELECT rowid FROM kin_profile_changes
        WHERE org_id = ${input.orgId} AND change_id = ${input.changeId})
    ORDER BY rowid`;
  if (older.length === 0) return [];
  yield* sql`UPDATE kin_profile_changes SET declined_at = ${input.now}
    WHERE org_id = ${input.orgId} AND change_id IN ${sql.in(older.map((row) => row.changeId))}`;
  return older.map((row) => row.widgetId);
});

// tools/list runs this before handler services are provided; the Kin MCP endpoint provides `KinIdentity`.
const enabled = McpToolAccess.threadBoundGate(() => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const scope = Context.getOrUndefined(fiber.context, McpInvocationContext);
  const identity = Context.getOrUndefined(fiber.context, KinIdentity);
  return (
    scope?.thread !== undefined &&
    scope.thread.subagent !== true &&
    identity?.isLeadThread(scope.thread.threadId) === true
  );
});

/** Served with the work tools (`work/mcp/tools.ts`), so a lead's session lists it beside them. */
export const numbersWatchTool = Tool.make("numbers_watch", {
  failure: Schema.Union([KinChatError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies: [
    McpInvocationContext,
    ThreadManagementService,
    KinIdentity,
    KinLevelGate,
    SqlClient.SqlClient,
  ],
  description:
    "Proposes numbers for this company to watch (daily users, refund rate, stock on hand), each with an optional limit that makes Kin speak up when it is crossed, and an optional feed: where the value comes from and how often you fetch it. Kin shows the owner or a co-owner one card; nothing is watched until they tap Confirm. When someone else asks, pass it to the owner with kin_relay.",
  parameters: NumbersWatchInput,
  success: NumbersWatchResult,
}).annotate(McpSchema.EnabledWhen, enabled);

const isKinChatError = Schema.is(KinChatError);
export const watchHandler = McpToolAccess.actsAsCaller(
  Effect.fn("KinNumbersWatch.mcp")(
    function* (input: typeof NumbersWatchInput.Type) {
      return yield* watch(yield* McpInvocationContext, input);
    },
    Effect.mapError((error) =>
      isKinChatError(error)
        ? error
        : new KinChatError({ reason: "unavailable", message: "Kin couldn't do that right now." }),
    ),
  ),
);
