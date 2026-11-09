import { stableStringify } from "@t3tools/shared/relaySigning";
import type { KinOrgId, KinAgentId, MemoryTrust } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import {
  KinChatError,
  KinChatId,
  KinEvent,
  KinMemoryItemId,
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
const denied = () =>
  new KinChatError({ reason: "not_allowed", message: "Lead operation is not allowed." });
const missing = () => new KinChatError({ reason: "not_found", message: "Kin record not found." });
const isChatError = Schema.is(KinChatError);
const isNotFound = Schema.is(Memory.MemoryNotFound);
const isConflict = Schema.is(Writer.MemoryConflict);
const isRejected = Schema.is(Writer.MemoryWriteRejected);
const isItemError = Schema.is(MemoryItemError);
const isQueryError = Schema.is(Memory.MemoryQueryDecodeError);
const failure = (error: unknown) =>
  isChatError(error)
    ? error
    : isNotFound(error)
      ? missing()
      : isConflict(error) || isRejected(error) || isItemError(error) || isQueryError(error)
        ? denied()
        : new KinChatError({ reason: "unavailable", message: "Kin memory is unavailable." });
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
          return {
            orgId,
            wakeupId,
            agentId: row.agentId,
            level: row.level,
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
    if (prior && prior.request_hash !== digest) return yield* denied();
    // Identical retries may re-stage; the writer reports lost sessions after restart.
    yield* operation;
    const inserted =
      yield* sql`INSERT INTO kin_lead_tool_calls (org_id, wakeup_id, call_key, request_hash) VALUES (${ctx.orgId}, ${ctx.wakeupId}, ${key}, ${digest}) ON CONFLICT DO NOTHING RETURNING request_hash`;
    if (inserted.length === 0) {
      const [stored] = yield* sql<{
        request_hash: string;
      }>`SELECT request_hash FROM kin_lead_tool_calls WHERE org_id = ${ctx.orgId} AND wakeup_id = ${ctx.wakeupId} AND call_key = ${key}`;
      if (stored?.request_hash !== digest) return yield* denied();
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
      return yield* denied();
    if (input.op !== "supersede" && input.supersedes !== undefined) return yield* denied();
    const current = yield* memory
      .readItemQuietly(ctx.orgId, fields.id, { lead: ctx.agentId })
      .pipe(Effect.asSome, Effect.catchTags({ MemoryNotFound: () => Effect.succeedNone }));
    if (input.op === "update" || input.op === "invalidate") {
      if (current._tag === "None") return yield* missing();
    }
    if (fields.kind === "deferral") {
      if (current._tag === "None" || current.value.head.kind !== "deferral") return yield* denied();
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
        return yield* denied();
    } else if (fields.chat !== undefined) return yield* denied();
    if (input.op === "invalidate" && fields.invalid_at === null) return yield* denied();
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
