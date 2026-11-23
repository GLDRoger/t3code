import {
  KinAgentId,
  KinChatError,
  KinNumberCadence,
  KinNumberDecimal,
  KinNumberDirection,
  KinNumberSource,
  KinPersonId,
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
import { ownerLevel } from "../people/KinAccess.ts";
import { goalFields } from "../work/goals.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { askOwner } from "../work/leadMoney.ts";
import { KinToolText } from "../work/leadSchemas.ts";
import { admitted, type Lead, leadTool, retryKey } from "../work/leadWork.ts";
import { ownerWriter } from "../work/ownerWork.ts";
import { ownerLevelNumbers } from "./KinNumbers.ts";
import {
  decodeNumbersChange,
  liveFeeds,
  NUMBERS_CHANGE,
  NumbersChangeJson,
  NumberSpec,
  type NumbersChange,
} from "./numberRows.ts";
import { cadenceText, figure } from "./words.ts";

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const encodeChange = Schema.encodeEffect(NumbersChangeJson);

export const NumbersWatchInput = Schema.Struct({
  numbers: Schema.Array(
    Schema.Struct({
      name: KinToolText(80),
      unit: Schema.optional(KinToolText(20)),
      direction: Schema.optional(KinNumberDirection),
      above: Schema.optional(KinNumberDecimal),
      below: Schema.optional(KinNumberDecimal),
      compute: Schema.optional(NumberSpec).annotate({
        description: "Kin works it out from its own records instead of a feed.",
      }),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  feed: Schema.optional(
    Schema.Struct({
      source: KinNumberSource,
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

type Watched = Effect.Success<ReturnType<typeof ownerLevelNumbers>>[number];
const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
const quoted = (word: string) => `"${word}"`;
const plain = (decimal: string, unit: string | undefined) =>
  unit === undefined || unit === "%"
    ? figure(decimal, unit)
    : `${figure(decimal, undefined)} ${unit}`;
const limitOf = (number: {
  readonly unit?: string | undefined;
  readonly above?: string | undefined;
  readonly below?: string | undefined;
}) => {
  const sides = [
    ...(number.below === undefined ? [] : [`below ${plain(number.below, number.unit)}`]),
    ...(number.above === undefined ? [] : [`above ${plain(number.above, number.unit)}`]),
  ];
  return sides.length === 0 ? undefined : sides.join(" or ");
};

/** One card line per number: its limit, where its value comes from and when it is fetched. */
const cardLine = (
  number: NumbersChange["numbers"][number],
  feed: NumbersChange["feed"],
  existing: Watched | undefined,
) => {
  const unit = number.unit ?? existing?.unit;
  const next = {
    unit,
    above: number.above ?? existing?.above,
    below: number.below ?? existing?.below,
  };
  const sides = limitOf(next);
  const limit = sides === undefined ? "no limit" : `speak up ${sides}`;
  const before = existing === undefined ? undefined : (limitOf(existing) ?? "no limit");
  const origin =
    number.compute !== undefined
      ? "Kin works it out from its own records"
      : feed !== undefined
        ? `from ${quoted(feed.source)}, fetched ${cadenceText(feed.every)} at ${feed.at}`
        : existing === undefined
          ? "typed in by you"
          : undefined;
  const parts = [
    before !== undefined && before !== (sides ?? "no limit") ? `${limit} (now ${before})` : limit,
    ...(origin === undefined ? [] : [origin]),
  ];
  return existing === undefined
    ? `Watch ${quoted(number.name)}: ${parts.join("; ")}`
    : `Change ${quoted(existing.name)} (${existing.key}): ${parts.join("; ")}`;
};

/** What the card is drawn against: each named number as it stands, and the source's feed. */
const baseOf = Effect.fn("KinNumbersWatch.base")(function* (
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
  return {
    proposed: lines,
    next: "Nothing is watched yet. Kin showed this on a card in this chat; it applies when they tap Confirm. Say so in one line.",
  };
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

/**
 * The answer on a numbers card: an owner-level Confirm makes or changes exactly the numbers it
 * lists, kept by the agent that asked, once, while nothing it names has changed. Its feed's one
 * schedule is made by the scheduled-tasks pass (`makeFeeds`). Undefined for any other card.
 */
export const answerNumbersChange = Effect.fn("KinNumbersWatch.answer")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: KinPersonId;
  readonly confirmed: boolean;
  readonly via: "tap" | "reaction";
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ changeId: string; agentId: string; patch: string; done: number }>`
    SELECT change_id AS "changeId", agent_id AS "agentId", patch_json AS patch,
      (applied_at IS NOT NULL OR declined_at IS NOT NULL) AS done
    FROM kin_profile_changes
    WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}
      AND substr(change_id, 1, 3) = ${NUMBERS_CHANGE}`;
  if (row === undefined) return undefined;
  if (!(yield* ownerLevel(input.orgId, input.personId).pipe(Effect.orDie)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner or a co-owner decides which numbers Kin watches.",
    });
  if (input.via === "reaction")
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Tap Confirm or Cancel on the card to answer this.",
    });
  if (row.done === 1)
    return yield* new KinChatError({
      reason: "widget_changed",
      message: "This card was already answered or replaced by a newer one.",
    });
  if (!input.confirmed) {
    yield* sql`UPDATE kin_profile_changes SET declined_at = ${input.now}
      WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
    return { title: "Not watched", text: "You said no, so nothing is watched." };
  }
  const change = yield* decodeNumbersChange(row.patch).pipe(Effect.orDie);
  const { matched, base } = yield* baseOf(
    input.orgId,
    change.numbers.map((number) => number.name),
    change.feed?.source,
    input.now,
  );
  if (
    base !== change.base ||
    change.numbers.some((number, index) => number.key !== matched[index]?.key)
  )
    return yield* new KinChatError({
      reason: "conflict",
      message:
        "A number or feed on this card changed since it was made, so nothing was changed. Ask for it again.",
    });
  const records = yield* KinRecords;
  const writer = ownerWriter({ _tag: "person", orgId: input.orgId, personId: input.personId });
  const owner = { _tag: "agent" as const, agentId: KinAgentId.make(row.agentId) };
  for (const [index, number] of change.numbers.entries()) {
    const fed = number.compute === undefined && change.feed !== undefined;
    const fields = yield* goalFields(input.orgId, {
      ...(number.key === undefined ? { measure: "manual" } : {}),
      ...(number.unit === undefined ? {} : { unit: number.unit }),
      ...(number.direction === undefined ? {} : { direction: number.direction }),
      ...(number.above === undefined ? {} : { above: number.above }),
      ...(number.below === undefined ? {} : { below: number.below }),
      ...(number.compute === undefined ? {} : { spec: number.compute }),
      ...(fed ? { source: change.feed!.source, every: change.feed!.every } : {}),
    });
    if (number.key === undefined)
      yield* records.create(input.orgId, writer, {
        list: "goals",
        originKey: `numbers:${row.changeId}:${index}`,
        title: number.name,
        owner,
        fields,
      });
    else
      yield* records.update(input.orgId, writer, number.key, {
        fields,
        ...(fed ? { owner } : {}),
      });
  }
  yield* sql`UPDATE kin_profile_changes SET applied_at = ${input.now},
      patch_json = json_set(patch_json, '$.by', ${input.personId})
    WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
  return {
    title: "Watching",
    text:
      change.feed === undefined
        ? "Saved. To stop watching a number, archive it."
        : "Saved. To stop watching a number, archive it; to stop its feed, pause or delete the schedule's card in this chat.",
  };
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
