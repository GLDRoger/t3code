import {
  KinChatError,
  KinChatId,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinTriggerSettings,
  KinWaitingId,
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
const invalid = new KinChatError({ reason: "invalid_state", message: "Invalid ping input." });
type Error =
  | PersistenceSqlError
  | Effect.Error<ReturnType<Chat.KinChatService["Service"]["notice"]>>
  | Effect.Error<ReturnType<Memory.Memory["Service"]["readItem"]>>
  | Effect.Error<ReturnType<Memory.Memory["Service"]["query"]>>;

export class KinPings extends Context.Service<
  KinPings,
  {
    readonly put: (input: Request) => Effect.Effect<Request, Error>;
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
  return KinPings.of({
    put: Effect.fn("KinPings.put")(function* (input) {
      const r = yield* decodeRequest(input).pipe(Effect.mapError(() => invalid));
      yield* validate(r);
      yield* memory
        .readItem(r.orgId, r.itemId)
        .pipe(Effect.catchTags({ MemoryNotFound: () => missing }));
      const json = yield* encodeRequest(r).pipe(Effect.mapError(() => invalid));
      const stopped = yield* sql<{ stopped_at: number }>`SELECT stopped_at FROM kin_ping_items
        WHERE org_id = ${r.orgId} AND item_id = ${r.itemId} AND stopped_at IS NOT NULL ORDER BY person LIMIT 1`;
      yield* sql`INSERT INTO kin_ping_items (org_id, person, item_id, request_json, stopped_at)
        VALUES (${r.orgId}, ${r.person}, ${r.itemId}, ${json}, ${stopped[0]?.stopped_at ?? null}) ON CONFLICT DO NOTHING RETURNING item_id`;
      const rows =
        yield* sql<Row>`SELECT * FROM kin_ping_items WHERE org_id = ${r.orgId} AND person = ${r.person} AND item_id = ${r.itemId} ORDER BY item_id`;
      if (rows[0]?.request_json !== json) return yield* conflict;
      return yield* decodeStored(rows[0].request_json).pipe(Effect.mapError(() => invalid));
    }, transaction),
    sweep: Effect.fn("KinPings.sweep")(function* (orgId) {
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
      const rows =
        yield* sql<Row>`SELECT * FROM kin_ping_items WHERE org_id = ${orgId} AND stopped_at IS NULL ORDER BY person, item_id`;
      const stopped = new Set<string>();
      const batches = new Map<string, Array<{ row: Row; request: Request }>>();
      for (const row of rows) {
        const r = yield* decodeStored(row.request_json).pipe(Effect.mapError(() => invalid));
        yield* validate(r);
        const item = yield* memory.readItem(orgId, r.itemId);
        const replies =
          row.first_seq === null
            ? []
            : yield* sql`SELECT message_id FROM kin_messages
          WHERE org_id = ${orgId} AND chat_id = ${r.chatId} AND author_person_id = ${r.person}
          AND author_kind = 'human' AND status = 'posted' AND seq > ${row.first_seq} ORDER BY seq LIMIT 1`;
        if (item.head.status !== "open" || item.head.invalid_at !== null || replies.length > 0) {
          const escalation = yield* sql<{
            waiting_id: string;
          }>`SELECT waiting_id FROM kin_ping_escalations WHERE org_id = ${orgId} AND item_id = ${r.itemId} ORDER BY item_id`;
          if (escalation[0] !== undefined)
            yield* chat.resolveNotice({
              orgId,
              waitingId: yield* decodeWaitingId(escalation[0].waiting_id).pipe(
                Effect.mapError(() => invalid),
              ),
              resolution: replies.length > 0 ? "answered" : "closed",
            });
          yield* sql`UPDATE kin_ping_items SET stopped_at = ${now} WHERE org_id = ${orgId} AND item_id = ${r.itemId}`;
          stopped.add(r.itemId);
          continue;
        }
        const person = yield* sql<{
          handle: string;
        }>`SELECT handle FROM kin_people WHERE org_id = ${orgId} AND person_id = ${r.person} ORDER BY person_id`;
        const profile = people.find(
          (p) => !p.duplicate && p.path === `people/${person[0]?.handle}.md`,
        );
        const personalHours = decodeQuiet(profile?.quiet_hours);
        if (
          isQuiet(
            now,
            validZone(profile?.tz, zone),
            personalHours._tag === "Some" ? personalHours.value : hours,
          )
        )
          continue;
        const sent =
          yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} AND person = ${r.person} AND item_id = ${r.itemId} AND day = ${day} ORDER BY item_id`;
        if (sent.length > 0) continue;
        // One destination per recipient per sweep; a changed destination requires a new lifecycle.
        const batch = batches.get(r.person) ?? [];
        if (batch[0] !== undefined && batch[0].request.chatId !== r.chatId) return yield* conflict;
        batch.push({ row, request: r });
        batches.set(r.person, batch);
      }
      for (const candidates of batches.values()) {
        const batch = candidates.filter(({ request }) => !stopped.has(request.itemId));
        const first = batch[0];
        if (first === undefined) continue;
        const { message } = yield* chat.notice({
          messageId: yield* decodeMessageId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
          orgId,
          chatId: first.request.chatId,
          body: batch.map(({ request: r }) => `- ${r.itemId}: ${r.nextStep}`).join("\n"),
        });
        for (const { row, request: r } of batch) {
          const escalation = yield* sql<{
            waiting_id: string;
          }>`SELECT waiting_id FROM kin_ping_escalations WHERE org_id = ${orgId} AND item_id = ${r.itemId} ORDER BY item_id`;
          let waitingId = escalation[0]?.waiting_id ?? null;
          let escalatedAt: number | null = null;
          if (row.first_day !== null && row.first_day < day && waitingId === null) {
            const notice = yield* chat.notice({
              messageId: yield* decodeMessageId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
              orgId,
              chatId: r.ownerChatId,
              waitingFor: r.owner,
              body: `Waiting for ${r.person} on ${r.itemId}. Next step: ${r.nextStep}`,
            });
            waitingId = notice.waiting?.waitingId ?? null;
            escalatedAt = now;
            if (waitingId === null) return yield* invalid;
            yield* sql`INSERT INTO kin_ping_escalations (org_id, item_id, waiting_id, escalated_at)
              VALUES (${orgId}, ${r.itemId}, ${waitingId}, ${now}) ON CONFLICT DO NOTHING RETURNING item_id`;
          }
          yield* sql`INSERT INTO kin_ping_ledger (org_id, person, item_id, day, pinged_at, escalated_at)
            VALUES (${orgId}, ${r.person}, ${r.itemId}, ${day}, ${now}, ${escalatedAt})
            ON CONFLICT DO NOTHING RETURNING item_id`;
          yield* sql`UPDATE kin_ping_items SET first_day = COALESCE(first_day, ${day}), first_seq = COALESCE(first_seq, ${message.seq})
            WHERE org_id = ${orgId} AND person = ${r.person} AND item_id = ${r.itemId}`;
        }
      }
    }, transaction),
  });
});

export const layer = Layer.effect(KinPings, make);
