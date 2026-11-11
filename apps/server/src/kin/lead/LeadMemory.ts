import { stableStringify } from "@t3tools/shared/relaySigning";
import type { KinOrgId, KinAgentId, MemoryTrust } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import {
  KinChatError,
  KinChatId,
  KinEvent,
  KinEventId,
  KinMemoryItemId,
  KinPersonId,
  MemoryItemEvery,
  MemoryItemFrontMatter,
  MemoryItemHead,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { stringify } from "yaml";
import { isSqlError } from "effect/sql/SqlError";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import {
  SHARED_REFUSAL,
  aborted,
  effectiveAudience,
  turnChat,
  type TurnAudience,
} from "./Audience.ts";
import * as KinLevels from "./KinLevels.ts";
import * as Memory from "../memory/Memory.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as Cache from "../memory/MemoryCache.ts";
import { MemoryItemError, memoryDateMillis, parseFrontMatter } from "../memory/frontMatter.ts";
import { writeRefusal } from "../memory/keeping.ts";
import {
  authorise,
  contentOf,
  fingerprint,
  hold,
  isSensitive,
  looksLikeSecret,
  mustBeSensitive,
  reaches,
  shareable,
  SharedHead,
  SharedItem,
  storedLabels,
  suggest,
} from "../memory/sensitivity.ts";
import { deferralOrigin } from "../triggers/deferralOrigin.ts";
import { cancelDeferralRun } from "../triggers/KinTriggerService.ts";
import { scheduledTaskTriggerId } from "../widgets/scheduledTaskCard.ts";

const text = Schema.String.check(Schema.isMaxLength(100_000));
const date = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(memoryDateMillis(value)), {
    expected: "a date or timestamp with explicit offset",
  }),
);
const deferDue = date.check(
  Schema.makeFilter((value) => /^20\d\d-/.test(value), { expected: "a date in 2000-2099" }),
);
const itemId = KinMemoryItemId.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/));
export const SearchInput = Schema.Struct({
  kind: Schema.optional(MemoryItemFrontMatter.fields.kind),
  status: Schema.optional(MemoryItemFrontMatter.fields.status),
  dueBefore: Schema.optional(date),
  dueAfter: Schema.optional(date),
  reviewOverdue: Schema.optional(Schema.Boolean),
  saidBy: Schema.optional(TrimmedNonEmptyString),
  linksTo: Schema.optional(text),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)),
  ),
});
export const ReadInput = Schema.Struct({ id: KinMemoryItemId });
// The server writes these: where an item was asked, who said it, and who let the team know it.
const {
  chat: _chat,
  source_event: _sourceEvent,
  sensitive: _sensitive,
  shared_by: _sharedBy,
  shared_from: _sharedFrom,
  ...writableFields
} = MemoryItemFrontMatter.fields;
export const WriteInput = Schema.Struct({
  op: Schema.Literals(["create", "update", "supersede", "invalidate"]),
  item: Schema.Struct({
    ...writableFields,
    id: itemId,
    chat: Schema.optional(KinChatId),
    review_by: Schema.optional(MemoryItemFrontMatter.fields.review_by),
    body: text,
    sensitive: Schema.Boolean,
  }),
  sourceEventId: TrimmedNonEmptyString,
  supersedes: Schema.optional(KinMemoryItemId),
});
export const DeferInput = Schema.Struct({
  itemId: Schema.optional(itemId),
  what: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  due: deferDue,
  onDue: Schema.Literals(["remind", "start", "ask", "chase"]),
  chatId: KinChatId,
  sourceEventId: TrimmedNonEmptyString,
  replaces: Schema.optional(KinMemoryItemId),
});
export const ScheduleInput = Schema.Struct({
  itemId: Schema.optional(itemId),
  what: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  at: MemoryItemEvery.fields.at,
  days: MemoryItemEvery.fields.days,
  chatId: KinChatId,
  sourceEventId: TrimmedNonEmptyString,
  replaces: Schema.optional(KinMemoryItemId),
});
export const CancelInput = Schema.Struct({
  itemId: KinMemoryItemId,
  sourceEventId: TrimmedNonEmptyString,
});
export const LabelInput = Schema.Struct({
  itemIds: Schema.Array(KinMemoryItemId).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  sensitive: Schema.Boolean,
  sourceEventId: TrimmedNonEmptyString,
});
export const JournalInput = Schema.Struct({
  saw: Schema.Array(text).check(Schema.isMaxLength(100)),
  did: Schema.Array(text).check(Schema.isMaxLength(100)),
  skipped: Schema.optional(Schema.Array(text).check(Schema.isMaxLength(100))),
});
export const EndInput = Schema.Struct({ summary: text });
export const ItemResult = Schema.Struct({ itemId: KinMemoryItemId });
export const LabelResult = Schema.Struct({ itemIds: Schema.Array(KinMemoryItemId) });
/** The whole item in a turn only the owner reads; in any other, only its shared projection. */
export const ReadResult = Schema.Union([
  Schema.Struct({
    head: MemoryItemHead,
    body: Schema.String,
    reviewOverdue: Schema.Boolean,
    misleading: Schema.Boolean,
  }),
  Schema.Struct({ item: SharedItem }),
]);
export const SearchResult = Schema.Array(
  Schema.Union([
    Schema.Struct({ ...MemoryItemHead.fields, duplicate: Schema.Boolean }),
    Schema.Struct({ ...SharedHead.fields, duplicate: Schema.Boolean }),
  ]),
);
/** An authority refusal: who is calling, or when. Its reason is never spelled out. */
const denied = () =>
  new KinChatError({ reason: "not_allowed", message: "Lead operation is not allowed." });
/** A request the lead can fix: the message says what to change. */
const invalid = (message: string) => new KinChatError({ reason: "not_allowed", message });
const missing = () => new KinChatError({ reason: "not_found", message: "Kin record not found." });
const SECRET_REFUSAL =
  "That holds an actual password, key or token, which is never saved. Save where it is kept instead.";
// The one refusal for anything a shared turn may not save, so it never tells what it can't see.
const TEAM_REFUSAL =
  "That can't be saved from this chat: it may be for the owner alone, or clash with something already saved. Leave it, or save a different claim under a new id.";
const TEAM_CLAIMS_ONLY =
  "From a chat other people read, save what someone said as a claim (kind claim), with create, update or invalidate.";
const TEAM_OWN_ITEMS =
  "From a chat other people read you can change only what was saved from this same chat.";
const TEAM_SOURCE = "sourceEventId must be the message, in this chat, of the person who said it.";
const TEAM_CAP_REFUSAL =
  "That is as much as can be saved from one person's messages today, so it was not saved.";
const TEAM_FILTERS = "From a chat other people read, search memory only by kind or linksTo.";
const changedSinceOwner = (itemId: string) =>
  `${itemId} changed after the owner's message, so it was not shared. Tell the owner what it says now and ask again.`;
const SHARE_NEEDS_OWNER =
  "Only the owner's own message, in a chat only they read, lets the team know something. Ask the owner first.";
// What a teammate's messages can cause shared turns to save, per person per day.
const SHARED_WRITES_PER_DAY = 20;
const SHARED_BYTES_PER_DAY = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const busy = () =>
  new KinChatError({
    reason: "unavailable",
    message: "Memory is busy finishing another wake-up. Try the same call again in a moment.",
  });
// Writer rejections about the caller rather than the request.
const authorityRejections = new Set([
  "Wake-up is not running",
  "Unknown source person",
  "Invalid writer authority",
  "Invalid server context",
  "Different wake-up retry",
  "Invalid agent id",
  "Invalid dream branch",
  "Invalid undo target",
]);
const isChatError = Schema.is(KinChatError);
const isNotFound = Schema.is(Memory.MemoryNotFound);
const isDuplicate = Schema.is(Memory.MemoryDuplicateId);
const isConflict = Schema.is(Writer.MemoryConflict);
const isRejected = Schema.is(Writer.MemoryWriteRejected);
const isItemError = Schema.is(MemoryItemError);
const isQueryError = Schema.is(Memory.MemoryQueryDecodeError);
const failure = (error: unknown) => {
  if (isChatError(error)) return error;
  if (isNotFound(error)) return missing();
  if (isConflict(error))
    return new KinChatError({
      reason: "conflict",
      message: `Memory item ${error.existingId} already exists. Update or supersede it instead of creating it again.`,
    });
  if (isRejected(error)) {
    if (error.reason === "Another wake-up owns the writer") return busy();
    return authorityRejections.has(error.reason)
      ? denied()
      : invalid(`Memory write refused: ${error.reason}.`);
  }
  if (isItemError(error)) return invalid(`Memory item is malformed: ${error.reason}.`);
  if (isQueryError(error)) return invalid("Memory search filters are invalid.");
  return new KinChatError({ reason: "unavailable", message: "Kin memory is unavailable." });
};
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(KinEvent));

export class LeadMemory extends Context.Service<
  LeadMemory,
  {
    readonly search: (
      scope: McpInvocationScope,
      input: typeof SearchInput.Type,
    ) => Effect.Effect<typeof SearchResult.Type, KinChatError>;
    readonly read: (
      scope: McpInvocationScope,
      input: typeof ReadInput.Type,
    ) => Effect.Effect<typeof ReadResult.Type, KinChatError>;
    readonly write: (
      scope: McpInvocationScope,
      input: typeof WriteInput.Type,
    ) => Effect.Effect<typeof ItemResult.Type, KinChatError>;
    readonly defer: (
      scope: McpInvocationScope,
      input: typeof DeferInput.Type,
    ) => Effect.Effect<typeof ItemResult.Type, KinChatError>;
    /** A recurring task, only from an owner's message in this batch; the server keeps their words. */
    readonly schedule: (
      scope: McpInvocationScope,
      input: typeof ScheduleInput.Type,
    ) => Effect.Effect<typeof ItemResult.Type, KinChatError>;
    /** Cancels an open deferral or scheduled task this lead set up; it stops firing at once. */
    readonly cancel: (
      scope: McpInvocationScope,
      input: typeof CancelInput.Type,
    ) => Effect.Effect<typeof ItemResult.Type, KinChatError>;
    /**
     * Marks an item as for the owner alone, or lets the team know it. The second is the owner's
     * decision: only their own stored message, in a turn only they read, allows it.
     */
    readonly label: (
      scope: McpInvocationScope,
      input: typeof LabelInput.Type,
    ) => Effect.Effect<typeof LabelResult.Type, KinChatError>;
    readonly journal: (
      scope: McpInvocationScope,
      input: typeof JournalInput.Type,
    ) => Effect.Effect<void, KinChatError>;
    readonly end: (
      scope: McpInvocationScope,
      input: typeof EndInput.Type,
    ) => Effect.Effect<void, KinChatError>;
  }
>()("t3/kin/lead/LeadMemory") {}

export const authority = Layer.effect(
  Writer.MemoryWriterAuthority,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cache = yield* Cache.MemoryCache;
    return Writer.MemoryWriterAuthority.of({
      resolve: Effect.fn("LeadMemory.writerAuthority")(
        function* (orgId, wakeupId) {
          const [row] = yield* sql<{
            agentId: KinAgentId;
            level: "L0" | "L1" | "L2" | "L3";
            startedAt: number;
          }>`SELECT w.agent_id AS "agentId", l.level, w.started_at AS "startedAt" FROM kin_wakeups w JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id WHERE w.org_id = ${orgId} AND w.wakeup_id = ${wakeupId} AND w.status = 'running'`;
          if (!row)
            return yield* new Writer.MemoryWriteRejected({ reason: "Wake-up is not running" });
          const events = yield* sql<{
            json: string;
          }>`SELECT json FROM kin_events WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND agent_id = ${row.agentId} ORDER BY event_id`;
          const sources = new Map<string, { saidBy: string; trust: MemoryTrust; source: string }>();
          for (const record of events) {
            const event = yield* decodeEvent(record.json);
            const who = event.provenance;
            const person =
              who._tag === "human"
                ? (yield* sql<{
                    handle: string;
                    role: string;
                  }>`SELECT p.handle, m.role FROM kin_people p JOIN kin_chat_members m ON m.org_id = p.org_id AND m.person_id = p.person_id WHERE p.org_id = ${orgId} AND p.person_id = ${who.personId} AND m.member_id = ${who.memberId}`)[0]
                : undefined;
            if (who._tag === "human" && !person)
              return yield* new Writer.MemoryWriteRejected({ reason: "Unknown source person" });
            sources.set(event.eventId, {
              saidBy: person?.handle ?? (who._tag === "agent" ? who.agentId : "external"),
              trust: person
                ? person.role === "owner"
                  ? "owner"
                  : "member"
                : who._tag === "agent"
                  ? "agent"
                  : "external",
              source:
                event._tag === "chat.message" || event._tag === "widget.action"
                  ? `kin:chat:${event.chatId}:message:${event.messageId}`
                  : `kin:event:${event.eventId}`,
            });
          }
          // The lane's level, not the lead's: an owner-DM wake-up writes the default branch.
          const level = yield* KinLevels.wakeupLevel({
            orgId,
            agentId: row.agentId,
            wakeupId,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          return {
            orgId,
            wakeupId,
            agentId: row.agentId,
            level,
            startedAt: DateTime.formatIso(DateTime.makeUnsafe(row.startedAt)),
            timeZone: yield* cache.ownerTimeZone(orgId),
            eventIds: [...sources.keys()],
            sources,
            stagedReceipts:
              (yield* sql`SELECT 1 FROM kin_lead_tool_calls WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} LIMIT 1`)
                .length > 0,
          };
        },
        Effect.mapError((error) =>
          isSqlError(error)
            ? toPersistenceSqlError("LeadMemory.writerAuthority")(error)
            : new Writer.MemoryWriteRejected({ reason: "Invalid writer authority" }),
        ),
      ),
    });
  }),
);

/** Kin-tool caller: a registered lead thread in its running wake-up, never another agent. */
export const resolveLead = Effect.fn("LeadMemory.resolveLead")(function* (
  scope: McpInvocationScope,
  allowEnded = false,
) {
  const identity = yield* KinIdentity;
  const sql = yield* SqlClient.SqlClient;
  const agent = yield* identity.resolveAgent(scope);
  const [row] = yield* sql<{
    wakeupId: string;
    startedAt: number;
  }>`SELECT w.wakeup_id AS "wakeupId", w.started_at AS "startedAt" FROM kin_wakeups w JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id WHERE w.org_id = ${agent.orgId} AND w.agent_id = ${agent.agentId} AND w.thread_id = ${agent.threadId} AND l.thread_id = w.thread_id AND a.role = 'lead' AND w.status = 'running'`;
  if (!row) return yield* denied();
  if (!allowEnded) {
    const ended =
      yield* sql`SELECT 1 FROM kin_lead_tool_calls WHERE org_id = ${agent.orgId} AND wakeup_id = ${row.wakeupId} AND call_key = 'end'`;
    if (ended.length > 0) return yield* denied();
  }
  return { ...agent, ...row };
});

const make = Effect.gen(function* () {
  const digest = yield* Digest.Digest;
  const hash = Effect.fn("LeadMemory.hash")((value: unknown) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(stableStringify(value)))
      .pipe(Effect.map(Hex.encode)),
  );
  const identity = yield* KinIdentity;
  const memory = yield* Memory.Memory;
  const writer = yield* Writer.MemoryWriter;
  const writerAuthority = yield* Writer.MemoryWriterAuthority;
  const sql = yield* SqlClient.SqlClient;
  // A lead runs one wake-up at a time, so the lock that orders its receipts is per lead:
  // keyed per wake-up, these maps would grow with every wake-up ever run.
  const locks = new Map<string, Semaphore.Semaphore>();
  const agentKey = (orgId: KinOrgId, agentId: KinAgentId) => `${orgId}\u0000${agentId}`;
  const locked = Effect.fn("LeadMemory.locked")(function* <A, E, R>(
    orgId: KinOrgId,
    agentId: KinAgentId,
    operation: Effect.Effect<A, E, R>,
  ) {
    const key = agentKey(orgId, agentId);
    let lock = locks.get(key);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    return yield* lock.withPermits(1)(operation);
  });
  // The last wake-up each lead ended, so an identical kin_end retry appends no second summary.
  const ended = new Map<string, string>();
  const resolve = (scope: McpInvocationScope, allowEnded = false) =>
    resolveLead(scope, allowEnded).pipe(
      Effect.provideService(KinIdentity, identity),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  const provideSql = Effect.provideService(SqlClient.SqlClient, sql);
  /** The calling turn and who reads it; every memory read and write below starts here. */
  const turn = Effect.fn("LeadMemory.turn")(function* (scope: McpInvocationScope) {
    const ctx = yield* resolve(scope);
    // A turn aborted because someone joined does nothing more, here as at the gate.
    if (yield* aborted(ctx).pipe(provideSql)) return yield* invalid(SHARED_REFUSAL);
    return { ctx, audience: yield* effectiveAudience(ctx).pipe(provideSql) };
  });
  /**
   * Reminders, scheduled tasks and who may know an item are the owner's: a turn someone else
   * reads changes none of them.
   */
  const notes = Effect.fn("LeadMemory.notes")(function* (scope: McpInvocationScope) {
    const { ctx, audience } = yield* turn(scope);
    if (audience !== "owner_only") return yield* invalid(SHARED_REFUSAL);
    return ctx;
  });
  /**
   * Who said the cited message and where, from stored rows: a person's own message in the chat
   * this turn answers. Their names are kept as they were then, for the owner's index.
   */
  const speaker = Effect.fn("LeadMemory.speaker")(function* (
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    eventId: string,
  ) {
    const chat = yield* turnChat(ctx).pipe(provideSql);
    const [row] = yield* sql<{
      person: string;
      chat: string;
      name: string;
      title: string | null;
      kind: string;
    }>`SELECT m.author_person_id AS person, m.chat_id AS chat, p.display_name AS name,
        c.title, c.kind
      FROM kin_events e
      JOIN kin_messages m ON m.org_id = e.org_id AND m.author_kind = 'human'
        AND m.message_id = json_extract(e.json, '$.messageId')
        AND m.chat_id = json_extract(e.json, '$.chatId')
      JOIN kin_people p ON p.org_id = m.org_id AND p.person_id = m.author_person_id
      JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
      WHERE e.org_id = ${ctx.orgId} AND e.agent_id = ${ctx.agentId}
        AND e.wakeup_id = ${ctx.wakeupId} AND e.event_id = ${eventId} AND e.tag = 'chat.message'
      ORDER BY e.event_id`;
    if (row === undefined || chat?.chatId !== row.chat) return undefined;
    return {
      person: KinPersonId.make(row.person),
      chat: KinChatId.make(row.chat),
      name: row.name,
      chat_name: row.title ?? (row.kind === "direct" ? "a direct chat" : "a group"),
    };
  });
  /** The lead's owner and when they said it, when the cited event is their own message in this turn. */
  const ownerSaid = Effect.fn("LeadMemory.ownerSaid")(function* (
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    eventId: string,
  ) {
    const [row] = yield* sql<{ owner: string; at: string }>`SELECT a.owner_person_id AS owner,
        m.created_at AS at
      FROM kin_events e
      JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
      JOIN kin_messages m ON m.org_id = e.org_id AND m.author_kind = 'human'
        AND m.message_id = json_extract(e.json, '$.messageId')
        AND m.chat_id = json_extract(e.json, '$.chatId')
        AND m.author_person_id = a.owner_person_id
      WHERE e.org_id = ${ctx.orgId} AND e.agent_id = ${ctx.agentId}
        AND e.wakeup_id = ${ctx.wakeupId} AND e.event_id = ${eventId} AND e.tag = 'chat.message'
      ORDER BY e.event_id`;
    return row === undefined
      ? undefined
      : {
          person: KinPersonId.make(row.owner),
          at: DateTime.toEpochMillis(DateTime.makeUnsafe(row.at)),
        };
  });
  const checkSource = Effect.fn("LeadMemory.checkSource")(function* (
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    eventId: string,
  ) {
    const [row] =
      yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId} AND event_id = ${eventId}`;
    if (!row) return yield* missing();
  });
  const reused = (key: string) =>
    invalid(
      key === "end"
        ? "kin_end was already called with a different summary in this wake-up."
        : `Memory item ${key.slice("item:".length)} was already written differently in this wake-up. Repeat the same call, or use a new id.`,
    );
  const receipt = Effect.fn("LeadMemory.receipt")(function* <E>(
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    key: string,
    request: unknown,
    operation: Effect.Effect<void, E>,
  ) {
    const digest = yield* hash(request);
    const [prior] = yield* sql<{
      request_hash: string;
    }>`SELECT request_hash FROM kin_lead_tool_calls WHERE org_id = ${ctx.orgId} AND wakeup_id = ${ctx.wakeupId} AND call_key = ${key}`;
    if (prior && prior.request_hash !== digest) return yield* reused(key);
    // Identical retries may re-stage; the writer reports lost sessions after restart.
    yield* operation;
    const inserted =
      yield* sql`INSERT INTO kin_lead_tool_calls (org_id, wakeup_id, call_key, request_hash) VALUES (${ctx.orgId}, ${ctx.wakeupId}, ${key}, ${digest}) ON CONFLICT DO NOTHING RETURNING request_hash`;
    if (inserted.length === 0) {
      const [stored] = yield* sql<{
        request_hash: string;
      }>`SELECT request_hash FROM kin_lead_tool_calls WHERE org_id = ${ctx.orgId} AND wakeup_id = ${ctx.wakeupId} AND call_key = ${key}`;
      if (stored?.request_hash !== digest) return yield* reused(key);
    }
  });
  /**
   * Only the lead that set an item up cancels it, asked from the chat it was set up in or that
   * lead's owner chat. The run stops in the same transaction as the checks; memory follows at commit.
   */
  const cancelOwn = Effect.fn("LeadMemory.cancelOwn")(function* (
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    itemId: KinMemoryItemId,
    sourceEventId: string,
  ) {
    yield* checkSource(ctx, sourceEventId);
    // The view triggers arm from, so the lead cancels what would fire, whichever branch holds it.
    const item = yield* memory.readItemQuietly(ctx.orgId, itemId, "triggers");
    const head = item.head;
    if (head.kind !== "deferral")
      return yield* invalid(`${itemId} is not a deferral or scheduled task.`);
    if (head.status !== "open" || head.invalid_at !== null || head.superseded_by !== null)
      return yield* invalid(
        `${itemId} is already ${head.status === "open" ? "closed" : head.status}.`,
      );
    const allowed = yield* sql.withTransaction(
      Effect.gen(function* () {
        // Checked again where the run stops: a join may have aborted the turn since `notes`.
        if (
          (yield* effectiveAudience(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql))) !==
          "owner_only"
        )
          return "shared" as const;
        const [creator] =
          head.source_event === undefined
            ? []
            : yield* sql<{ agentId: string }>`SELECT agent_id AS "agentId" FROM kin_events
                WHERE org_id = ${ctx.orgId} AND event_id = ${head.source_event} ORDER BY event_id`;
        if (creator?.agentId !== ctx.agentId) return false;
        const [lead] = yield* sql<{ ownerChatId: string }>`SELECT owner_chat_id AS "ownerChatId"
          FROM kin_leads WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} ORDER BY agent_id`;
        if (lead === undefined) return false;
        const asked = yield* deferralOrigin(
          sql,
          ctx.orgId,
          { source_event: KinEventId.make(sourceEventId), chat: undefined },
          { agentId: ctx.agentId, ownerChatId: KinChatId.make(lead.ownerChatId) },
        );
        if (asked !== undefined && asked.chatId !== head.chat) return false;
        const now = yield* Clock.currentTimeMillis;
        if (head.every === undefined)
          yield* cancelDeferralRun({ orgId: ctx.orgId, itemId, now }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
        else
          yield* sql`UPDATE kin_triggers SET enabled = 0, next_run_at = NULL,
            updated_at = max(updated_at, ${now})
            WHERE org_id = ${ctx.orgId} AND trigger_id = ${scheduledTaskTriggerId(itemId)}`;
        return true;
      }),
    );
    if (allowed === "shared") return yield* invalid(SHARED_REFUSAL);
    if (!allowed)
      return yield* invalid(
        "Only the lead that set it up can cancel or replace it, from the chat it was set up in or the owner's direct chat.",
      );
    const { orgId: _org, path, ...frontMatter } = head;
    yield* receipt(
      ctx,
      `item:${itemId}`,
      { cancel: itemId, sourceEventId },
      writer.stage(ctx.orgId, ctx.wakeupId, {
        path,
        content: `---\n${stringify({ ...frontMatter, status: "cancelled" })}---\n${item.body}`,
        sourceEventId,
      }),
    );
  });
  /** The items a shared turn may see, judged and returned from one snapshot of the lead's view. */
  const visibleItems = Effect.fn("LeadMemory.visibleItems")(function* (
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    audience: TurnAudience,
  ) {
    const labels = yield* storedLabels(ctx.orgId).pipe(provideSql);
    return (yield* memory.items(ctx.orgId, { lead: ctx.agentId })).filter((item) =>
      reaches(audience, item, labels),
    );
  });
  /**
   * A shared turn's write the writer refused: one fixed refusal, unless it names an item this
   * turn can see. Never an id, title or count of one it can't.
   */
  const sharedRefusal = Effect.fn("LeadMemory.sharedRefusal")(function* (
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    audience: TurnAudience,
    error: unknown,
  ) {
    if (
      isRejected(error) &&
      (error.reason === "Another wake-up owns the writer" || authorityRejections.has(error.reason))
    )
      return failure(error);
    if (isConflict(error)) {
      const visible = yield* visibleItems(ctx, audience);
      if (visible.some((item) => item.head.id === error.existingId)) return failure(error);
    }
    if (isConflict(error) || isRejected(error) || isNotFound(error) || isDuplicate(error))
      return invalid(TEAM_REFUSAL);
    return failure(error);
  });
  /**
   * Counts this write against what someone else's messages caused shared turns to save today,
   * checked and recorded in one transaction, so no two leads both take the last place.
   */
  const reserveShared = Effect.fn("LeadMemory.reserveShared")(function* (
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    person: KinPersonId,
    itemId: string,
    bytes: number,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const [used] = yield* sql<{ writes: number; bytes: number }>`
          SELECT COUNT(*) AS writes, COALESCE(SUM(bytes), 0) AS bytes FROM kin_memory_shared_writes
          WHERE org_id = ${ctx.orgId} AND person_id = ${person} AND written_at > ${now - DAY_MS}
            AND NOT (wakeup_id = ${ctx.wakeupId} AND item_id = ${itemId})`;
        if (
          (used?.writes ?? 0) >= SHARED_WRITES_PER_DAY ||
          (used?.bytes ?? 0) + bytes > SHARED_BYTES_PER_DAY
        )
          return yield* invalid(TEAM_CAP_REFUSAL);
        const inserted = yield* sql`INSERT INTO kin_memory_shared_writes
            (org_id, wakeup_id, item_id, person_id, bytes, written_at)
          VALUES (${ctx.orgId}, ${ctx.wakeupId}, ${itemId}, ${person}, ${bytes}, ${now})
          ON CONFLICT (org_id, wakeup_id, item_id) DO NOTHING RETURNING item_id`;
        return inserted.length > 0;
      }),
    );
  });
  const stage = Effect.fn("LeadMemory.stage")(function* (
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    audience: TurnAudience,
    input: typeof WriteInput.Type,
  ) {
    if (input.item.kind === "deferral" && input.op !== "update" && input.op !== "invalidate")
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "Use kin_defer to write deferrals.",
      });
    yield* checkSource(ctx, input.sourceEventId);
    const { body, sensitive: asked, ...fields } = input.item;
    const content = contentOf({ head: fields, body });
    if (looksLikeSecret(content)) return yield* invalid(SECRET_REFUSAL);
    // Judged on the words sent alone, so the refusal says nothing about what is stored.
    const notMemory = writeRefusal(input, yield* Clock.currentTimeMillis);
    if (notMemory !== undefined) return yield* invalid(notMemory);
    const shared = audience !== "owner_only";
    if (shared && (fields.kind !== "claim" || input.op === "supersede"))
      return yield* invalid(TEAM_CLAIMS_ONLY);
    // A chat other people read never stores, or says anything about, what is the owner's alone.
    if (shared && (asked || mustBeSensitive(content))) return yield* invalid(TEAM_REFUSAL);
    const from = shared ? yield* speaker(ctx, input.sourceEventId) : undefined;
    if (shared && from === undefined) return yield* invalid(TEAM_SOURCE);
    // Only the owner's own stored message, cited as this write's source, is the owner's say-so.
    const owner = (yield* ownerSaid(ctx, input.sourceEventId))?.person;
    const capped = shared && owner === undefined ? from?.person : undefined;
    if (input.op === "supersede" && (!input.supersedes || input.supersedes === fields.id))
      return yield* invalid("supersede needs `supersedes` naming another item's id.");
    if (input.op !== "supersede" && input.supersedes !== undefined)
      return yield* invalid("Only the supersede op takes `supersedes`.");
    const current = yield* memory
      .readItemQuietly(ctx.orgId, fields.id, { lead: ctx.agentId })
      .pipe(Effect.asSome, Effect.catchTags({ MemoryNotFound: () => Effect.succeedNone }));
    const known = yield* storedLabels(ctx.orgId).pipe(provideSql);
    if (shared && current._tag === "Some") {
      // What this turn can't see refuses like any other refused write; what an owner's turn
      // wrote is not its to change.
      if (!reaches(audience, current.value, known)) return yield* invalid(TEAM_REFUSAL);
      if (current.value.head.shared_from?.chat !== from?.chat)
        return yield* invalid(TEAM_OWN_ITEMS);
    }
    if (input.op === "update" || input.op === "invalidate") {
      if (current._tag === "None") return yield* shared ? invalid(TEAM_REFUSAL) : missing();
    }
    const replaced =
      input.op === "supersede" && input.supersedes !== undefined
        ? yield* memory
            .readItemQuietly(ctx.orgId, input.supersedes, { lead: ctx.agentId })
            .pipe(Effect.option)
        : Option.none();
    const stored =
      input.op === "create" || current._tag === "None" ? undefined : current.value.head;
    const sensitiveBefore = (head: MemoryItemHead) => isSensitive(head, known);
    // Only ever more sensitive here: an item the owner alone had stays theirs through an update
    // or a replacement, and `label` is the one way to let the team know it.
    const sensitive = shared
      ? false
      : stored !== undefined && input.op !== "supersede"
        ? asked || sensitiveBefore(stored)
        : asked ||
          mustBeSensitive(content) ||
          (replaced._tag === "Some" && sensitiveBefore(replaced.value.head));
    if (sensitive && stored !== undefined && !sensitiveBefore(stored))
      yield* hold(ctx.orgId, stored.id).pipe(provideSql);
    const labels = {
      sensitive,
      ...(shared ? { trust: "member" as const } : {}),
      ...(stored?.shared_from !== undefined
        ? { shared_from: stored.shared_from }
        : from === undefined
          ? {}
          : { shared_from: from }),
      ...(sensitive || stored?.shared_by === undefined ? {} : { shared_by: stored.shared_by }),
    };
    if (fields.kind === "deferral") {
      if (current._tag === "None" || current.value.head.kind !== "deferral")
        return yield* invalid(`${fields.id} is not a deferral. Use kin_defer to make one.`);
      const { orgId: _org, path: _path, ...stored } = current.value.head;
      if (
        (fields.status !== current.value.head.status &&
          !["done", "cancelled"].includes(fields.status)) ||
        body !== current.value.body ||
        Object.entries(fields).some(
          ([key, value]) =>
            key !== "status" &&
            key !== "invalid_at" &&
            JSON.stringify(value) !== JSON.stringify(stored[key as keyof typeof stored]),
        )
      )
        return yield* invalid(
          "A deferral can only be marked done or cancelled, or invalidated; send its other fields unchanged.",
        );
    } else if (fields.chat !== undefined)
      return yield* invalid("Only deferrals carry `chat`. Leave it out.");
    if (input.op === "invalidate" && fields.invalid_at === null)
      return yield* invalid("invalidate needs `invalid_at`.");
    const folder = fields.kind === "person" ? "people" : `${fields.kind}s`;
    const path = current._tag === "Some" ? current.value.head.path : `${folder}/${fields.id}.md`;
    const text = `---\n${stringify(
      current._tag === "Some" && fields.kind === "deferral"
        ? {
            ...fields,
            ...labels,
            chat: current.value.head.chat,
            source_event: current.value.head.source_event,
            what: current.value.head.what,
            on_due: current.value.head.on_due,
          }
        : { ...fields, ...labels },
    )}---\n${body}`;
    const written = yield* parseFrontMatter(ctx.orgId, path, text, true);
    const saved = fingerprint({ head: written.frontMatter, body: written.body });
    yield* receipt(
      ctx,
      `item:${fields.id}`,
      input,
      Effect.gen(function* () {
        // A write that wasn't staged, however it ended, gives its place back.
        const staged = yield* Effect.acquireUseRelease(
          capped === undefined
            ? Effect.succeed(false)
            : reserveShared(ctx, capped, fields.id, Buffer.byteLength(content)),
          () =>
            writer.stage(ctx.orgId, ctx.wakeupId, {
              path,
              content: text,
              sourceEventId: input.sourceEventId,
              ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
            }),
          (reserved, exit) =>
            !reserved || Exit.isSuccess(exit)
              ? Effect.void
              : sql`DELETE FROM kin_memory_shared_writes WHERE org_id = ${ctx.orgId}
                  AND wakeup_id = ${ctx.wakeupId} AND item_id = ${fields.id}`.pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Kin shared write reservation not released", cause),
                  ),
                ),
        ).pipe(Effect.result);
        if (staged._tag === "Failure") {
          return yield* shared
            ? Effect.fail(yield* sharedRefusal(ctx, audience, staged.failure))
            : Effect.fail(staged.failure);
        }
        // Who may know what was just written, from stored rows alone: the owner's own message
        // or a teammate's own words let the team know it; anything else only suggests it.
        if (sensitive) return;
        if (shared || owner !== undefined)
          yield* authorise(
            ctx.orgId,
            fields.id,
            saved,
            owner !== undefined ? "owner_message" : "teammate",
          ).pipe(provideSql);
        else yield* suggest(ctx.orgId, fields.id, saved).pipe(provideSql);
      }),
    );
    return { itemId: fields.id };
  });
  return LeadMemory.of({
    search: Effect.fn("LeadMemory.search")(function* (scope, input) {
      const { ctx, audience } = yield* turn(scope);
      if (audience !== "owner_only") {
        // Only by what the turn may read, so no filter tells it about the fields it may not.
        if (
          input.status !== undefined ||
          input.dueBefore !== undefined ||
          input.dueAfter !== undefined ||
          input.reviewOverdue !== undefined ||
          input.saidBy !== undefined
        )
          return yield* invalid(TEAM_FILTERS);
        // Filtered before the limit and the duplicate flag, so neither counts what is left out.
        const visible = (yield* visibleItems(ctx, audience)).filter(
          ({ head }) =>
            (input.kind === undefined || head.kind === input.kind) &&
            (input.linksTo === undefined || head.links.includes(input.linksTo)),
        );
        const counts = new Map<string, number>();
        for (const { head } of visible) counts.set(head.id, (counts.get(head.id) ?? 0) + 1);
        return visible.slice(0, input.limit ?? 50).map((item) => {
          const { body: _body, ...head } = shareable(item);
          return { ...head, duplicate: (counts.get(item.head.id) ?? 0) > 1 };
        });
      }
      const found = yield* memory.query(
        ctx.orgId,
        {
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.dueBefore === undefined ? {} : { dueBefore: input.dueBefore }),
          ...(input.dueAfter === undefined ? {} : { dueAfter: input.dueAfter }),
          ...(input.reviewOverdue === undefined ? {} : { reviewOverdue: input.reviewOverdue }),
          ...(input.saidBy === undefined ? {} : { saidBy: input.saidBy }),
          ...(input.linksTo === undefined ? {} : { linksTo: input.linksTo }),
        },
        { lead: ctx.agentId },
      );
      const counts = new Map<string, number>();
      for (const item of found) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
      return found
        .map((item) => ({ ...item, duplicate: (counts.get(item.id) ?? 0) > 1 }))
        .slice(0, input.limit ?? 50);
    }, Effect.mapError(failure)),
    read: Effect.fn("LeadMemory.read")(function* (scope, input) {
      const { ctx, audience } = yield* turn(scope);
      const shared = audience !== "owner_only";
      // In a shared turn only what it may see exists, judged on the very item returned: one it
      // can't see reads as not found, unrecorded, and a hidden duplicate changes nothing.
      const labels = shared ? yield* storedLabels(ctx.orgId).pipe(provideSql) : undefined;
      const item = yield* memory.readItem(
        ctx.orgId,
        input.id,
        { lead: ctx.agentId },
        labels === undefined ? undefined : (candidate) => reaches(audience, candidate, labels),
      );
      // Review dates and invalidation are not in the projection, so a shared turn never gets them.
      if (shared) return { item: shareable(item) };
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      return {
        ...item,
        reviewOverdue: item.head.review_by !== null && memoryDateMillis(item.head.review_by) < now,
        misleading: item.head.invalid_at !== null,
      };
    }, Effect.mapError(failure)),
    write: Effect.fn("LeadMemory.write")(function* (scope, input) {
      const { ctx } = yield* turn(scope);
      return yield* locked(
        ctx.orgId,
        ctx.agentId,
        Effect.gen(function* () {
          // Again under the lock: who reads the turn may have changed since.
          const now = yield* turn(scope);
          return yield* stage(now.ctx, now.audience, input);
        }),
      );
    }, Effect.mapError(failure)),
    label: Effect.fn("LeadMemory.label")(function* (scope, input) {
      const ctx = yield* notes(scope);
      return yield* locked(
        ctx.orgId,
        ctx.agentId,
        Effect.gen(function* () {
          const ctx = yield* notes(scope);
          yield* checkSource(ctx, input.sourceEventId);
          // Letting the team know is a disclosure, so only the owner's own words decide it.
          const said = input.sensitive ? undefined : yield* ownerSaid(ctx, input.sourceEventId);
          if (!input.sensitive && said === undefined) return yield* invalid(SHARE_NEEDS_OWNER);
          const owner = said?.person;
          const itemIds = [...new Set(input.itemIds)];
          // Every item is found before any is changed, so a bad id changes none of them. The
          // owner's word covers only what an item said when he gave it, never a later rewording.
          const items = yield* Effect.forEach(itemIds, (itemId) =>
            said === undefined
              ? memory.readItemQuietly(ctx.orgId, itemId, { lead: ctx.agentId })
              : memory
                  .readItemChangedAt(ctx.orgId, itemId, { lead: ctx.agentId })
                  .pipe(
                    Effect.flatMap(({ item, changedAt }) =>
                      changedAt + 1000 > said.at
                        ? Effect.fail(invalid(changedSinceOwner(item.head.id)))
                        : Effect.succeed(item),
                    ),
                  ),
          );
          for (const item of items) {
            const { orgId: _org, path, shared_by: _before, ...frontMatter } = item.head;
            // Sensitive at once, ahead of the commit.
            if (input.sensitive) yield* hold(ctx.orgId, item.head.id).pipe(provideSql);
            yield* receipt(
              ctx,
              `item:${item.head.id}`,
              {
                itemId: item.head.id,
                sensitive: input.sensitive,
                sourceEventId: input.sourceEventId,
              },
              Effect.gen(function* () {
                yield* writer.stage(ctx.orgId, ctx.wakeupId, {
                  path,
                  content: `---\n${stringify({
                    ...frontMatter,
                    sensitive: input.sensitive,
                    ...(owner === undefined
                      ? {}
                      : {
                          shared_by: {
                            person: owner,
                            at: DateTime.formatIso(DateTime.makeUnsafe(ctx.startedAt)),
                          },
                        }),
                  })}---\n${item.body}`,
                  sourceEventId: input.sourceEventId,
                  label: owner === undefined ? "keep" : "share",
                });
                // The owner's authorisation of the item as it reads now; a later rewording ends it.
                if (owner !== undefined)
                  yield* authorise(ctx.orgId, item.head.id, fingerprint(item), "owner_label").pipe(
                    provideSql,
                  );
              }),
            );
          }
          return { itemIds };
        }),
      );
    }, Effect.mapError(failure)),
    defer: Effect.fn("LeadMemory.defer")(function* (scope, input) {
      const ctx = yield* notes(scope);
      return yield* locked(
        ctx.orgId,
        ctx.agentId,
        Effect.gen(function* () {
          // Again under the lock: a join may have aborted the turn since.
          const ctx = yield* notes(scope);
          yield* checkSource(ctx, input.sourceEventId);
          const source = (yield* writerAuthority.resolve(ctx.orgId, ctx.wakeupId)).sources.get(
            input.sourceEventId,
          );
          if (!source) return yield* missing();
          const [chat] =
            yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${ctx.orgId} AND chat_id = ${input.chatId}`;
          if (!chat) return yield* missing();
          const id =
            input.itemId ??
            KinMemoryItemId.make(
              `def-${(yield* hash({ wakeup: ctx.wakeupId, input })).slice(0, 32)}`,
            );
          if (input.replaces === id) return yield* invalid("`replaces` names this same item.");
          if (input.replaces !== undefined)
            yield* cancelOwn(ctx, input.replaces, input.sourceEventId);
          const recorded = DateTime.formatIso(DateTime.makeUnsafe(ctx.startedAt));
          const fields = {
            id,
            kind: "deferral" as const,
            title: input.what,
            status: "open" as const,
            due: input.due,
            on_due: input.onDue,
            recorded_at: recorded,
            valid_from: recorded,
            invalid_at: null,
            superseded_by: null,
            source: source.source,
            said_by: source.saidBy,
            trust: source.trust,
            links: [],
            what: input.what,
            chat: input.chatId,
            source_event: input.sourceEventId,
            // Reminders and scheduled tasks are the owner's own.
            sensitive: true,
          };
          yield* receipt(
            ctx,
            `item:${id}`,
            { ...input, itemId: id },
            writer.stage(ctx.orgId, ctx.wakeupId, {
              path: `deferrals/${id}.md`,
              content: `---\n${stringify(fields)}---\n${input.what}\n`,
              sourceEventId: input.sourceEventId,
            }),
          );
          return { itemId: id };
        }),
      );
    }, Effect.mapError(failure)),
    schedule: Effect.fn("LeadMemory.schedule")(function* (scope, input) {
      const ctx = yield* notes(scope);
      return yield* locked(
        ctx.orgId,
        ctx.agentId,
        Effect.gen(function* () {
          // Again under the lock: a join may have aborted the turn since.
          const ctx = yield* notes(scope);
          yield* checkSource(ctx, input.sourceEventId);
          const source = (yield* writerAuthority.resolve(ctx.orgId, ctx.wakeupId)).sources.get(
            input.sourceEventId,
          );
          // Mirrors kin_defer's provenance, and narrows it: a scheduled run may start work, so
          // only the owner's own message sets one up, never a tap, reaction, event or member.
          const [event] = yield* sql<{ json: string }>`SELECT json FROM kin_events
            WHERE org_id = ${ctx.orgId} AND wakeup_id = ${ctx.wakeupId}
              AND event_id = ${input.sourceEventId} ORDER BY event_id`;
          const decoded = event === undefined ? undefined : yield* decodeEvent(event.json);
          if (!source || decoded === undefined) return yield* missing();
          if (source.trust !== "owner" || decoded._tag !== "chat.message")
            return yield* invalid(
              "Only the owner's own message can set up a scheduled task. Ask the owner to say what to run and when.",
            );
          const [message] = yield* sql<{ body: string }>`SELECT body FROM kin_messages
            WHERE org_id = ${ctx.orgId} AND message_id = ${decoded.messageId}
              AND chat_id = ${decoded.chatId} ORDER BY message_id`;
          const [chat] =
            yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${ctx.orgId} AND chat_id = ${input.chatId}`;
          if (!chat || !message) return yield* missing();
          const id =
            input.itemId ??
            KinMemoryItemId.make(
              `sch-${(yield* hash({ wakeup: ctx.wakeupId, input })).slice(0, 32)}`,
            );
          if (input.replaces === id) return yield* invalid("`replaces` names this same item.");
          if (input.replaces !== undefined)
            yield* cancelOwn(ctx, input.replaces, input.sourceEventId);
          const recorded = DateTime.formatIso(DateTime.makeUnsafe(ctx.startedAt));
          const fields = {
            id,
            kind: "deferral" as const,
            title: input.title ?? input.what.slice(0, 120),
            status: "open" as const,
            due: null,
            every: { at: input.at, days: [...new Set(input.days)].toSorted((a, b) => a - b) },
            recorded_at: recorded,
            valid_from: recorded,
            invalid_at: null,
            superseded_by: null,
            source: source.source,
            said_by: source.saidBy,
            trust: source.trust,
            links: [],
            what: input.what,
            chat: input.chatId,
            source_event: input.sourceEventId,
            // Reminders and scheduled tasks are the owner's own.
            sensitive: true,
          };
          // The body is the owner's message as they wrote it; `what` is the lead's instruction.
          yield* receipt(
            ctx,
            `item:${id}`,
            { ...input, itemId: id },
            writer.stage(ctx.orgId, ctx.wakeupId, {
              path: `deferrals/${id}.md`,
              content: `---\n${stringify(fields)}---\n${message.body}\n`,
              sourceEventId: input.sourceEventId,
            }),
          );
          return { itemId: id };
        }),
      );
    }, Effect.mapError(failure)),
    cancel: Effect.fn("LeadMemory.cancel")(function* (scope, input) {
      const ctx = yield* notes(scope);
      return yield* locked(
        ctx.orgId,
        ctx.agentId,
        Effect.gen(function* () {
          yield* cancelOwn(yield* notes(scope), input.itemId, input.sourceEventId);
          return { itemId: input.itemId };
        }),
      );
    }, Effect.mapError(failure)),
    journal: Effect.fn("LeadMemory.journal")(function* (scope, input) {
      const { ctx, audience } = yield* turn(scope);
      const lines = [
        ...input.saw.map((x) => `Saw: ${x}`),
        ...input.did.map((x) => `Did: ${x}`),
        ...(input.skipped ?? []).map((x) => `Skipped: ${x}`),
      ];
      if (looksLikeSecret(lines.join("\n"))) return yield* invalid(SECRET_REFUSAL);
      const chat = audience === "owner_only" ? undefined : yield* turnChat(ctx).pipe(provideSql);
      // The journal is the owner's to read later, so a line from such a chat says where it is from.
      yield* writer.appendJournal(
        ctx.orgId,
        ctx.wakeupId,
        audience === "owner_only"
          ? lines
          : lines.map(
              (line) =>
                `${line} (from chat ${chat?.chatId ?? "unknown"}, which other people read: what was said there, not the owner's instruction)`,
            ),
      );
    }, Effect.mapError(failure)),
    end: Effect.fn("LeadMemory.end")(function* (scope, input) {
      const ctx = yield* resolve(scope, true);
      yield* locked(
        ctx.orgId,
        ctx.agentId,
        Effect.gen(function* () {
          const ctx = yield* resolve(scope, true);
          // The turn still ends; only an owner-only turn's own words reach the journal.
          const shared =
            (yield* effectiveAudience(ctx).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            )) !== "owner_only";
          yield* receipt(
            ctx,
            "end",
            input,
            shared || ended.get(agentKey(ctx.orgId, ctx.agentId)) === ctx.wakeupId
              ? Effect.void
              : writer.appendJournal(ctx.orgId, ctx.wakeupId, [`Summary: ${input.summary}`]),
          );
          ended.set(agentKey(ctx.orgId, ctx.agentId), ctx.wakeupId);
        }),
      );
    }, Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(LeadMemory, make);
