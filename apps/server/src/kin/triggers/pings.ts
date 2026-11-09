import {
  KIN_MESSAGE_BODY_MAX_LENGTH,
  KinChatError,
  KinChatId,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinTriggerSettings,
  KinWaitingId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as Chat from "../chat/KinChatService.ts";
import * as Memory from "../memory/Memory.ts";
import * as Cache from "../memory/MemoryCache.ts";

const text = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(2000),
);
const Request = Schema.Struct({
  orgId: KinOrgId,
  person: KinPersonId,
  itemId: KinMemoryItemId,
  chatId: KinChatId,
  owner: KinPersonId,
  ownerChatId: KinChatId,
  nextStep: text,
});
type Request = typeof Request.Type;
const decodeRequest = Schema.decodeUnknownEffect(Request);
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Request));
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(Request));
const decodeQuiet = Schema.decodeUnknownOption(KinTriggerSettings.fields.quietHours);
const decodeJsonQuiet = Schema.decodeUnknownOption(
  Schema.fromJsonString(KinTriggerSettings.fields.quietHours),
);
const decodeMessageId = Schema.decodeUnknownEffect(KinMessageId);
const decodeWaitingId = Schema.decodeUnknownEffect(KinWaitingId);
const missing = new KinChatError({ reason: "not_found", message: "Kin record not found." });
const conflict = new KinChatError({ reason: "not_allowed", message: "Ping retry conflict." });
const ownerMismatch = new KinChatError({
  reason: "not_allowed",
  message: "Ping owner does not match the active lead.",
});
const invalid = new KinChatError({ reason: "invalid_state", message: "Invalid ping input." });
type Error =
  | PersistenceSqlError
  | Effect.Error<ReturnType<Chat.KinChatService["Service"]["notice"]>>
  | Effect.Error<ReturnType<Memory.Memory["Service"]["readItem"]>>
  | Effect.Error<ReturnType<Memory.Memory["Service"]["query"]>>;

export class KinPings extends Context.Service<
  KinPings,
  {
    /** Pass `item` when calling inside a write transaction: reading memory there inverts the lock order. */
    readonly put: (input: Request, item?: MemoryItemHead) => Effect.Effect<Request, Error>;
    readonly sweep: (orgId: KinOrgId) => Effect.Effect<void, Error>;
  }
>()("t3/kin/triggers/pings/KinPings") {}

type Row = {
  person: string;
  item_id: string;
  request_json: string;
  first_day: string | null;
  first_seq: number | null;
  stopped_at: number | null;
};

function localParts(now: number, zone: string) {
  return DateTime.toParts(DateTime.makeZonedUnsafe(now, { timeZone: zone }));
}
function ownerDay(now: number, zone: string) {
  const p = localParts(now, zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
function validZone(zone: string | undefined, fallback: string) {
  if (zone === undefined) return fallback;
  try {
    DateTime.makeZonedUnsafe(0, { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}
function isQuiet(now: number, zone: string, hours: { readonly from: string; readonly to: string }) {
  const p = localParts(now, zone);
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return hours.from < hours.to
    ? time >= hours.from && time < hours.to
    : hours.from > hours.to && (time >= hours.from || time < hours.to);
}

export function quoted(value: string) {
  const content = Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " "))
    .slice(0, 500)
    .join("");
  const longestRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestRun + 1);
  return `> ${fence} ${content} ${fence}`;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* Chat.KinChatService;
  const memory = yield* Memory.Memory;
  const cache = yield* Cache.MemoryCache;
  const transaction = <A, R>(effect: Effect.Effect<A, Error | SqlError.SqlError, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          SqlError.isSqlError(cause) ? toPersistenceSqlError("KinPings.transaction")(cause) : cause,
        ),
      );
  const validate = Effect.fn("KinPings.validate")(function* (r: Request) {
    for (const [person, chatId] of [
      [r.person, r.chatId],
      [r.owner, r.ownerChatId],
    ] as const) {
      const rows =
        yield* sql`SELECT p.person_id FROM kin_people p JOIN kin_chat_members m ON m.org_id = p.org_id AND m.person_id = p.person_id
        WHERE p.org_id = ${r.orgId} AND p.person_id = ${person} AND m.chat_id = ${chatId} AND m.left_at IS NULL ORDER BY m.member_id`;
      if (rows.length === 0) return yield* missing;
    }
  });
  const checkOwner = Effect.fn("KinPings.checkOwner")(function* (r: Request) {
    const owners = yield* sql<{ owner_person_id: string; owner_chat_id: string }>`
      SELECT a.owner_person_id, l.owner_chat_id FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${r.orgId} AND a.retired_at IS NULL ORDER BY l.agent_id`;
    if (
      owners.length !== 1 ||
      owners[0]?.owner_person_id !== r.owner ||
      owners[0]?.owner_chat_id !== r.ownerChatId
    )
      return yield* ownerMismatch;
  });
  const stop = Effect.fn("KinPings.stop")(function* (
    r: Request,
    now: number,
    closed: boolean,
    resolution: "closed" | "answered" = closed ? "closed" : "answered",
  ) {
    yield* sql`UPDATE kin_ping_items SET stopped_at = ${now} WHERE org_id = ${r.orgId} AND item_id = ${r.itemId}
      AND (${closed ? 1 : 0} OR person = ${r.person})`;
    const pending =
      yield* sql`SELECT person FROM kin_ping_items WHERE org_id = ${r.orgId} AND item_id = ${r.itemId} AND stopped_at IS NULL ORDER BY person`;
    if (pending.length > 0) return;
    const escalations = yield* sql<{
      waiting_id: string;
    }>`SELECT waiting_id FROM kin_ping_escalations WHERE org_id = ${r.orgId} AND item_id = ${r.itemId} ORDER BY item_id`;
    if (escalations[0])
      yield* chat.resolveNotice({
        orgId: r.orgId,
        waitingId: yield* decodeWaitingId(escalations[0].waiting_id).pipe(
          Effect.mapError(() => invalid),
        ),
        resolution,
      });
  });
  return KinPings.of({
    put: Effect.fn("KinPings.put")(function* (input, known) {
      const r = yield* decodeRequest(input).pipe(Effect.mapError(() => invalid));
      if (known !== undefined && (known.orgId !== r.orgId || known.id !== r.itemId))
        return yield* invalid;
      const head =
        known ??
        (yield* memory.readItemQuietly(r.orgId, r.itemId).pipe(
          Effect.map((item) => item.head),
          Effect.catchTags({ MemoryNotFound: () => missing }),
        ));
      const json = yield* encodeRequest(r).pipe(Effect.mapError(() => invalid));
      return yield* transaction(
        Effect.gen(function* () {
          yield* checkOwner(r);
          yield* validate(r);
          const rows =
            yield* sql<Row>`SELECT * FROM kin_ping_items WHERE org_id = ${r.orgId} AND person = ${r.person} AND item_id = ${r.itemId} ORDER BY item_id`;
          const previous = rows[0];
          if (previous?.stopped_at != null && head.status === "open" && head.invalid_at === null) {
            yield* sql`DELETE FROM kin_ping_deliveries WHERE org_id = ${r.orgId} AND person = ${r.person} AND item_id = ${r.itemId}`;
            yield* sql`DELETE FROM kin_ping_escalations WHERE org_id = ${r.orgId} AND item_id = ${r.itemId} AND waiting_id IN
            (SELECT waiting_id FROM kin_waiting WHERE org_id = ${r.orgId} AND resolved_at IS NOT NULL ORDER BY waiting_id)`;
            yield* sql`UPDATE kin_ping_items SET request_json = ${json}, stopped_at = NULL, first_day = NULL, first_seq = NULL
            WHERE org_id = ${r.orgId} AND person = ${r.person} AND item_id = ${r.itemId}`;
          } else {
            if (previous && previous.request_json !== json) return yield* conflict;
            yield* sql`INSERT INTO kin_ping_items (org_id, person, item_id, request_json)
            VALUES (${r.orgId}, ${r.person}, ${r.itemId}, ${json}) ON CONFLICT DO NOTHING RETURNING item_id`;
          }
          return r;
        }),
      );
    }),
    sweep: Effect.fn("KinPings.sweep")(
      function* (orgId) {
        const rows =
          yield* sql<Row>`SELECT * FROM kin_ping_items WHERE org_id = ${orgId} AND stopped_at IS NULL ORDER BY person, item_id`;
        if (rows.length === 0) return;
        const now = yield* Clock.currentTimeMillis;
        const zone = yield* cache.ownerTimeZone(orgId);
        const day = ownerDay(now, zone);
        const settings = yield* sql<{
          quiet_hours_json: string;
        }>`SELECT quiet_hours_json FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`;
        const defaultHours = decodeJsonQuiet(settings[0]?.quiet_hours_json);
        const hours =
          defaultHours._tag === "Some" ? defaultHours.value : { from: "21:00", to: "08:00" };
        const people = yield* memory.query(orgId, { kind: "person", excludeInvalid: true });
        const candidates: Array<{
          row: Row;
          request: Request;
          closed: boolean;
          handle: string;
          quiet: boolean;
        }> = [];
        for (const row of rows) {
          const result = yield* Effect.gen(function* () {
            const r = yield* decodeStored(row.request_json).pipe(Effect.mapError(() => invalid));
            if (r.orgId !== orgId || r.person !== row.person || r.itemId !== row.item_id)
              return yield* invalid;
            const item = yield* memory
              .readItemQuietly(orgId, r.itemId)
              .pipe(Effect.catchTags({ MemoryNotFound: () => Effect.succeed(null) }));
            const person = yield* sql<{
              handle: string;
            }>`SELECT handle FROM kin_people WHERE org_id = ${orgId} AND person_id = ${r.person} ORDER BY person_id`;
            const profile = people.find(
              (p) => !p.duplicate && p.path === `people/${person[0]?.handle}.md`,
            );
            const personalHours = decodeQuiet(profile?.quiet_hours);
            return {
              row,
              request: r,
              closed: item === null || item.head.status !== "open" || item.head.invalid_at !== null,
              handle: person[0]?.handle ?? "member",
              quiet: isQuiet(
                now,
                validZone(profile?.tz, zone),
                personalHours._tag === "Some" ? personalHours.value : hours,
              ),
            };
          }).pipe(Effect.result);
          if (result._tag === "Failure") {
            if (
              result.failure._tag === "MemoryDuplicateId" ||
              result.failure._tag === "KinChatError"
            ) {
              const stopped =
                yield* sql`UPDATE kin_ping_items SET stopped_at = ${now} WHERE org_id = ${orgId} AND person = ${row.person} AND item_id = ${row.item_id} AND stopped_at IS NULL AND request_json = ${row.request_json} AND first_seq IS ${row.first_seq} RETURNING item_id`;
              if (stopped.length === 0) continue;
            }
            yield* Effect.logWarning("Kin ping row skipped", {
              orgId,
              person: row.person,
              itemId: row.item_id,
              reason: result.failure._tag,
            });
            continue;
          }
          candidates.push(result.success);
        }
        if (candidates.length === 0) return;
        yield* transaction(
          Effect.gen(function* () {
            const batches = new Map<string, typeof candidates>();
            for (const candidate of candidates) {
              const { row, request: r, closed } = candidate;
              const current =
                yield* sql<Row>`SELECT * FROM kin_ping_items WHERE org_id = ${orgId} AND person = ${r.person} AND item_id = ${r.itemId} AND stopped_at IS NULL ORDER BY item_id`;
              if (
                !current[0] ||
                current[0].request_json !== row.request_json ||
                current[0].first_seq !== row.first_seq
              )
                continue;
              const replies =
                yield* sql`SELECT m.message_id FROM kin_messages m JOIN kin_ping_deliveries d
              ON d.org_id = m.org_id AND d.person = ${r.person} AND d.item_id = ${r.itemId}
              WHERE m.org_id = ${orgId} AND m.chat_id = ${r.chatId} AND m.author_person_id = ${r.person}
              AND m.author_kind = 'human' AND m.status = 'posted' AND m.seq > d.seq
              AND (m.reply_to = d.message_id OR d.item_count = 1) ORDER BY m.seq LIMIT 1`;

              if (closed || replies.length > 0) {
                yield* stop(r, now, closed);
                continue;
              }
              const valid = yield* checkOwner(r).pipe(Effect.andThen(validate(r)), Effect.result);
              if (valid._tag === "Failure") {
                if (valid.failure._tag === "KinChatError") yield* stop(r, now, false, "closed");
                yield* Effect.logWarning("Kin ping destination skipped", {
                  orgId,
                  person: r.person,
                  itemId: r.itemId,
                  reason: valid.failure._tag,
                });
                continue;
              }
              const batch = batches.get(r.person) ?? [];
              if (batch[0] && batch[0].request.chatId !== r.chatId) {
                yield* stop(r, now, false, "closed");
                yield* Effect.logWarning("Kin ping chat mismatch", {
                  orgId,
                  person: r.person,
                  itemId: r.itemId,
                  reason: "chat_mismatch",
                });
                continue;
              }
              batch.push(candidate);
              batches.set(r.person, batch);
            }
            for (const candidates of batches.values()) {
              const batch = [];
              let body = "Reminder: next step below.";
              for (const candidate of candidates) {
                const { row, request: r, handle } = candidate;
                const pending =
                  yield* sql`SELECT person FROM kin_ping_items WHERE org_id = ${orgId} AND person = ${r.person} AND item_id = ${r.itemId} AND stopped_at IS NULL ORDER BY person`;
                if (!pending.length) continue;
                let escalatedAt: number | null = null;
                const escalation =
                  yield* sql`SELECT waiting_id FROM kin_ping_escalations WHERE org_id = ${orgId} AND item_id = ${r.itemId} ORDER BY item_id`;
                if (row.first_day !== null && row.first_day < day && !escalation.length) {
                  const notice = yield* chat.notice({
                    messageId: yield* decodeMessageId(SecureRandom.uuidV4Unsafe()).pipe(
                      Effect.orDie,
                    ),
                    orgId,
                    chatId: r.ownerChatId,
                    waitingFor: r.owner,
                    body: `Waiting for a reply: next step below.\n${quoted(`${handle}: ${r.itemId}: ${r.nextStep}`)}`,
                  });
                  if (!notice.waiting) return yield* invalid;
                  escalatedAt = now;
                  yield* sql`INSERT INTO kin_ping_escalations (org_id, item_id, waiting_id, escalated_at) VALUES (${orgId}, ${r.itemId}, ${notice.waiting.waitingId}, ${now}) ON CONFLICT DO NOTHING RETURNING item_id`;
                }
                if (candidate.quiet) continue;
                const sent =
                  yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} AND person = ${r.person} AND item_id = ${r.itemId} AND day = ${day} ORDER BY item_id`;
                if (!sent.length) {
                  const line = `\n${quoted(`${r.itemId}: ${r.nextStep}`)}`;
                  if (body.length + line.length > KIN_MESSAGE_BODY_MAX_LENGTH) continue;
                  body += line;
                  batch.push({ ...candidate, escalatedAt });
                }
              }
              const first = batch[0];
              if (!first) continue;
              const { message } = yield* chat.notice({
                messageId: yield* decodeMessageId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
                orgId,
                chatId: first.request.chatId,
                body,
              });
              for (const { request: r, escalatedAt } of batch) {
                yield* sql`INSERT INTO kin_ping_deliveries (org_id, person, item_id, message_id, seq, item_count)
              VALUES (${orgId}, ${r.person}, ${r.itemId}, ${message.messageId}, ${message.seq}, ${batch.length}) ON CONFLICT DO NOTHING RETURNING item_id`;
                yield* sql`INSERT INTO kin_ping_ledger (org_id, person, item_id, day, pinged_at, escalated_at) VALUES (${orgId}, ${r.person}, ${r.itemId}, ${day}, ${now}, ${escalatedAt}) ON CONFLICT DO NOTHING RETURNING item_id`;
                yield* sql`UPDATE kin_ping_items SET first_day = COALESCE(first_day, ${day}), first_seq = COALESCE(first_seq, ${message.seq}) WHERE org_id = ${orgId} AND person = ${r.person} AND item_id = ${r.itemId}`;
              }
            }
          }),
        );
      },
      (effect) =>
        effect.pipe(
          Effect.mapError((cause) =>
            SqlError.isSqlError(cause) ? toPersistenceSqlError("KinPings.sweep")(cause) : cause,
          ),
        ),
    ),
  });
});

export const layer = Layer.effect(KinPings, make);
