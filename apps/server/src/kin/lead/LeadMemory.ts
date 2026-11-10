import { stableStringify } from "@t3tools/shared/relaySigning";
import type { KinOrgId, KinAgentId, MemoryTrust } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import {
  KinChatError,
  KinChatId,
  KinEvent,
  KinMemoryItemId,
  MemoryItemEvery,
  MemoryItemFrontMatter,
  MemoryItemHead,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { stringify } from "yaml";
import { isSqlError } from "effect/sql/SqlError";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinLevels from "./KinLevels.ts";
import * as Memory from "../memory/Memory.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as Cache from "../memory/MemoryCache.ts";
import { MemoryItemError, memoryDateMillis } from "../memory/frontMatter.ts";

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
const { chat: _chat, source_event: _sourceEvent, ...writableFields } = MemoryItemFrontMatter.fields;
export const WriteInput = Schema.Struct({
  op: Schema.Literals(["create", "update", "supersede", "invalidate"]),
  item: Schema.Struct({
    ...writableFields,
    id: itemId,
    chat: Schema.optional(KinChatId),
    review_by: Schema.optional(MemoryItemFrontMatter.fields.review_by),
    body: text,
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
});
export const ScheduleInput = Schema.Struct({
  itemId: Schema.optional(itemId),
  what: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  at: MemoryItemEvery.fields.at,
  days: MemoryItemEvery.fields.days,
  chatId: KinChatId,
  sourceEventId: TrimmedNonEmptyString,
});
export const JournalInput = Schema.Struct({
  saw: Schema.Array(text).check(Schema.isMaxLength(100)),
  did: Schema.Array(text).check(Schema.isMaxLength(100)),
  skipped: Schema.optional(Schema.Array(text).check(Schema.isMaxLength(100))),
});
export const EndInput = Schema.Struct({ summary: text });
export const ItemResult = Schema.Struct({ itemId: KinMemoryItemId });
export const ReadResult = Schema.Struct({
  head: MemoryItemHead,
  body: Schema.String,
  reviewOverdue: Schema.Boolean,
  misleading: Schema.Boolean,
});
export const SearchResult = Schema.Array(
  Schema.Struct({ ...MemoryItemHead.fields, duplicate: Schema.Boolean }),
);
/** An authority refusal: who is calling, or when. Its reason is never spelled out. */
const denied = () =>
  new KinChatError({ reason: "not_allowed", message: "Lead operation is not allowed." });
/** A request the lead can fix: the message says what to change. */
const invalid = (message: string) => new KinChatError({ reason: "not_allowed", message });
const missing = () => new KinChatError({ reason: "not_found", message: "Kin record not found." });
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
  const locks = new Map<KinOrgId, Semaphore.Semaphore>();
  const locked = Effect.fn("LeadMemory.locked")(function* <A, E, R>(
    orgId: KinOrgId,
    operation: Effect.Effect<A, E, R>,
  ) {
    let lock = locks.get(orgId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(orgId, lock);
    }
    return yield* lock.withPermits(1)(operation);
  });
  const ended = new Map<KinOrgId, string>();
  const resolve = (scope: McpInvocationScope, allowEnded = false) =>
    resolveLead(scope, allowEnded).pipe(
      Effect.provideService(KinIdentity, identity),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
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
  const receipt = Effect.fn("LeadMemory.receipt")(function* (
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    key: string,
    request: unknown,
    operation: Effect.Effect<
      void,
      Effect.Error<ReturnType<Writer.MemoryWriter["Service"]["stage"]>>
    >,
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
  const stage = Effect.fn("LeadMemory.stage")(function* (
    ctx: Effect.Success<ReturnType<typeof resolve>>,
    input: typeof WriteInput.Type,
  ) {
    if (input.item.kind === "deferral" && input.op !== "update" && input.op !== "invalidate")
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "Use kin_defer to write deferrals.",
      });
    yield* checkSource(ctx, input.sourceEventId);
    const { body, ...fields } = input.item;
    if (input.op === "supersede" && (!input.supersedes || input.supersedes === fields.id))
      return yield* invalid("supersede needs `supersedes` naming another item's id.");
    if (input.op !== "supersede" && input.supersedes !== undefined)
      return yield* invalid("Only the supersede op takes `supersedes`.");
    const current = yield* memory
      .readItemQuietly(ctx.orgId, fields.id, { lead: ctx.agentId })
      .pipe(Effect.asSome, Effect.catchTags({ MemoryNotFound: () => Effect.succeedNone }));
    if (input.op === "update" || input.op === "invalidate") {
      if (current._tag === "None") return yield* missing();
    }
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
    yield* receipt(
      ctx,
      `item:${fields.id}`,
      input,
      writer.stage(ctx.orgId, ctx.wakeupId, {
        path: current._tag === "Some" ? current.value.head.path : `${folder}/${fields.id}.md`,
        content: `---\n${stringify(
          current._tag === "Some" && fields.kind === "deferral"
            ? {
                ...fields,
                chat: current.value.head.chat,
                source_event: current.value.head.source_event,
                what: current.value.head.what,
                on_due: current.value.head.on_due,
              }
            : fields,
        )}---\n${body}`,
        sourceEventId: input.sourceEventId,
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      }),
    );
    return { itemId: fields.id };
  });
  return LeadMemory.of({
    search: Effect.fn("LeadMemory.search")(function* (scope, input) {
      const ctx = yield* resolve(scope);
      return yield* memory.query(
        ctx.orgId,
        {
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.dueBefore === undefined ? {} : { dueBefore: input.dueBefore }),
          ...(input.dueAfter === undefined ? {} : { dueAfter: input.dueAfter }),
          ...(input.reviewOverdue === undefined ? {} : { reviewOverdue: input.reviewOverdue }),
          ...(input.saidBy === undefined ? {} : { saidBy: input.saidBy }),
          ...(input.linksTo === undefined ? {} : { linksTo: input.linksTo }),
          limit: input.limit ?? 50,
        },
        { lead: ctx.agentId },
      );
    }, Effect.mapError(failure)),
    read: Effect.fn("LeadMemory.read")(function* (scope, input) {
      const ctx = yield* resolve(scope);
      const item = yield* memory.readItem(ctx.orgId, input.id, { lead: ctx.agentId });
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      return {
        ...item,
        reviewOverdue: item.head.review_by !== null && memoryDateMillis(item.head.review_by) < now,
        misleading: item.head.invalid_at !== null,
      };
    }, Effect.mapError(failure)),
    write: Effect.fn("LeadMemory.write")(function* (scope, input) {
      const ctx = yield* resolve(scope);
      return yield* locked(
        ctx.orgId,
        Effect.gen(function* () {
          return yield* stage(yield* resolve(scope), input);
        }),
      );
    }, Effect.mapError(failure)),
    defer: Effect.fn("LeadMemory.defer")(function* (scope, input) {
      const ctx = yield* resolve(scope);
      return yield* locked(
        ctx.orgId,
        Effect.gen(function* () {
          const ctx = yield* resolve(scope);
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
      const ctx = yield* resolve(scope);
      return yield* locked(
        ctx.orgId,
        Effect.gen(function* () {
          const ctx = yield* resolve(scope);
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
    journal: Effect.fn("LeadMemory.journal")(function* (scope, input) {
      const ctx = yield* resolve(scope);
      yield* writer.appendJournal(ctx.orgId, ctx.wakeupId, [
        ...input.saw.map((x) => `Saw: ${x}`),
        ...input.did.map((x) => `Did: ${x}`),
        ...(input.skipped ?? []).map((x) => `Skipped: ${x}`),
      ]);
    }, Effect.mapError(failure)),
    end: Effect.fn("LeadMemory.end")(function* (scope, input) {
      const ctx = yield* resolve(scope, true);
      yield* locked(
        ctx.orgId,
        Effect.gen(function* () {
          const ctx = yield* resolve(scope, true);
          yield* receipt(
            ctx,
            "end",
            input,
            ended.get(ctx.orgId) === ctx.wakeupId
              ? Effect.void
              : writer.appendJournal(ctx.orgId, ctx.wakeupId, [`Summary: ${input.summary}`]),
          );
          ended.set(ctx.orgId, ctx.wakeupId);
        }),
      );
    }, Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(LeadMemory, make);
