// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous digest; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import {
  KIN_PICTURES_PROPOSED_LIMIT,
  formatKinPicturesDay,
  KinChatError,
  KinChatId,
  KinMessageId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ChatImageAttachment,
  type KinAgentId,
  type KinOrgId,
  type KinPersonId,
  type KinPicturesInput,
  type KinPicturesSetInput,
  type KinPicturesView,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinConnectionSecrets } from "../connections/ConnectionSecrets.ts";
import { KinDocRenderer } from "../gendocs/render.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { mayActAsOwner } from "../people/KinAccess.ts";
import { dayIn, monthOf, shiftMonth } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import { ImageVendorError, type KinImageVendor, type PixelSize } from "./ImageVendor.ts";
import { openAiImages } from "./OpenAiImages.ts";
import { KIN_PICTURE_SIZES, type KinPictureSize, pictureOutput } from "./sizes.ts";

/** Generation is slow; past this no answer is coming, and what may have been made is counted. */
export const PICTURE_TIMEOUT = Duration.seconds(120);
const WARN_PERCENT = 80;
const MAX_PROMPT = 32_000;

export type GenerateRequest = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  /** Who asked, when a person did. */
  readonly askedBy: KinPersonId | null;
  /** Only the owner level reads the turn: a rejected key is named to it, and to no one else. */
  readonly ownerLevel: boolean;
  readonly prompt: string;
  readonly size: KinPictureSize;
  /** 1 to 4. */
  readonly count: number;
  /** The same key again returns what it made the first time, made and counted once. */
  readonly retryKey?: string;
};

/** `unavailable`: nothing was made or counted; `lost`: it may have been made, and is counted. */
export type GenerateRefusal =
  | "no_key"
  | "limit"
  | "refused"
  | "key_rejected"
  | "unavailable"
  | "lost";
export type GenerateResult =
  | {
      readonly _tag: "made";
      /** Stored by content, as documents' files are; the vendor's URLs are never kept. */
      readonly files: ReadonlyArray<ChatImageAttachment>;
      readonly size: PixelSize;
      readonly vendor: string;
      readonly model: string;
      /** What differs from what was asked: the size, or fewer pictures than asked for. */
      readonly note: string | null;
    }
  | { readonly _tag: "refused"; readonly reason: GenerateRefusal; readonly sentence: string };

const WHERE = "Settings → Connections → Pictures";
/**
 * The server's own words for every way a picture isn't made, each saying who can fix it; the
 * service's own words never reach an agent or a person.
 */
export const GENERATE_SENTENCES = {
  no_key: `No picture service is connected yet. An owner or co-owner can connect one in ${WHERE}.`,
  limit: (limit: number, resetsOn: string) =>
    `This month's ${limit} generated pictures are used. An owner or co-owner can raise the limit in ${WHERE}; it resets on ${resetsOn}.`,
  refused:
    "The picture service refused this description, so nothing was made or counted. Tell the person; don't send it again.",
  key_rejected: `The picture service turned down Kin's key. Nothing was counted. An owner or co-owner can check it in ${WHERE}.`,
  not_working:
    "The picture service isn't working right now, so nothing was made or counted; the owner can check it in Settings.",
  unavailable:
    "The picture service didn't take this request, so nothing was made and nothing was counted. Try again in a few minutes.",
  lost: "The picture service may have made this picture, but Kin didn't get it back, so nothing was posted and it is counted. Try again in a few minutes.",
} as const;

/** What a made generation returned, kept on its count row so a retry returns it again. */
const MadeJson = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Array(ChatImageAttachment),
    size: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
    vendor: Schema.String,
    model: Schema.String,
    note: Schema.NullOr(Schema.String),
  }),
);
const decodeMade = Schema.decodeUnknownOption(MadeJson);
const encodeMade = Schema.encodeSync(MadeJson);
const stillMaking = new KinChatError({
  reason: "unavailable",
  message: "Kin is still making this picture, so nothing new was made. Try again in a minute.",
});

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const notFound = (message: string) => new KinChatError({ reason: "not_found", message });
const notAllowed = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can change the picture service.",
});
const unavailable = new KinChatError({
  reason: "unavailable",
  message: "Kin couldn't save the picture settings. Try again in a minute.",
});

/** The vendor's size nearest in shape; a tie goes to the larger. */
export const nearestSize = (sizes: ReadonlyArray<PixelSize>, wanted: PixelSize): PixelSize => {
  const shape = (size: PixelSize) => Math.log(size.width / size.height);
  return sizes.reduce((best, size) => {
    const off = Math.abs(shape(size) - shape(wanted));
    const bestOff = Math.abs(shape(best) - shape(wanted));
    return off < bestOff - 1e-9 ||
      (Math.abs(off - bestOff) <= 1e-9 && size.width * size.height > best.width * best.height)
      ? size
      : best;
  });
};

/** A side no picture service makes past: an image's header naming more is refused. */
const MAX_SIDE = 4096;

/**
 * The type and size from the image's own header, never the vendor's label: a PNG, JPEG or WebP
 * whole from start to end, none truncated or with bytes after it, and no side over `MAX_SIDE`.
 */
export const pictureHeader = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.byteLength;
  const at = (index: number, ...values: ReadonlyArray<number>) =>
    index + values.length <= length &&
    values.every((value, offset) => bytes[index + offset] === value);
  const sized = (type: { mime: string; ext: string }, width: number, height: number) =>
    width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE
      ? { ...type, width, height }
      : undefined;
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    if (!at(12, 0x49, 0x48, 0x44, 0x52) || length < 24) return undefined;
    // Chunk by chunk to IEND, which must end the file.
    for (let index = 8; index + 12 <= length;) {
      const next = index + 12 + view.getUint32(index);
      if (next > length) return undefined;
      if (at(index + 4, 0x49, 0x45, 0x4e, 0x44))
        return next === length
          ? sized({ mime: "image/png", ext: "png" }, view.getUint32(16), view.getUint32(20))
          : undefined;
      index = next;
    }
    return undefined;
  }
  if (at(0, 0xff, 0xd8)) {
    // Segment by segment to the frame header and the scan; the file ends at its end marker.
    let size: { width: number; height: number } | undefined;
    for (let index = 2; index + 4 <= length;) {
      if (bytes[index] !== 0xff) return undefined;
      const marker = bytes[index + 1]!;
      if (marker === 0xff) {
        index += 1;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        index += 2;
        continue;
      }
      if (marker === 0xd9) return undefined;
      const segment = view.getUint16(index + 2);
      if (index + 2 + segment > length) return undefined;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        size = { height: view.getUint16(index + 5), width: view.getUint16(index + 7) };
      if (marker === 0xda)
        return size !== undefined && at(length - 2, 0xff, 0xd9)
          ? sized({ mime: "image/jpeg", ext: "jpg" }, size.width, size.height)
          : undefined;
      index += 2 + segment;
    }
    return undefined;
  }
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    // The RIFF length is the whole file's, so a cut one or one with more after it fails here.
    if (length < 30 || view.getUint32(4, true) + 8 !== length) return undefined;
    const webp = { mime: "image/webp", ext: "webp" };
    const u24 = (index: number) => view.getUint16(index, true) | (bytes[index + 2]! << 16);
    if (at(12, 0x56, 0x50, 0x38, 0x58)) return sized(webp, 1 + u24(24), 1 + u24(27));
    if (at(12, 0x56, 0x50, 0x38, 0x4c) && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return sized(webp, 1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
    if (at(12, 0x56, 0x50, 0x38, 0x20) && at(23, 0x9d, 0x01, 0x2a))
      return sized(webp, view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    return undefined;
  }
  return undefined;
};

/** What differs from what was asked: the size, or fewer pictures than asked for. */
const noteOf = (input: {
  readonly size: PixelSize;
  readonly wanted: PixelSize;
  readonly request: GenerateRequest;
  readonly held: { readonly take: number; readonly limit: number | null };
  readonly made: number;
  readonly counted: number;
}) => {
  const { size, wanted, request, held, made, counted } = input;
  const notes = [
    size.width === wanted.width && size.height === wanted.height
      ? null
      : `Made at ${size.width}×${size.height}, the picture service's nearest size to ${request.size} (${wanted.width}×${wanted.height}).`,
    held.take < request.count
      ? `Only ${held.take} of this month's ${held.limit} pictures were left, so Kin made ${made}.`
      : made < request.count
        ? `The picture service made ${made} of the ${request.count} asked for; ${made === counted ? "only those were counted" : `the ${counted} it sent are counted`}.`
        : null,
  ].filter((note) => note !== null);
  return notes.length === 0 ? null : notes.join(" ");
};

type Settings = {
  readonly monthlyLimit: number | null;
  readonly model: string | null;
  readonly keySavedAt: number | null;
  readonly warnedMonth: string | null;
};

export class KinPictures extends Context.Service<
  KinPictures,
  {
    readonly get: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinPicturesInput,
    ) => Effect.Effect<KinPicturesView, KinChatError>;
    readonly set: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinPicturesSetInput,
    ) => Effect.Effect<KinPicturesView, KinChatError>;
    /**
     * Makes pictures from a prompt, counted against the company's month. Trusted server callers
     * only (the agent tool): the agent and the person are checked against the org, not the caller.
     */
    readonly generate: (request: GenerateRequest) => Effect.Effect<GenerateResult, KinChatError>;
  }
>()("t3/kin/pictures/KinPictures") {}

const make = Effect.fn("KinPictures.make")(function* (vendor: KinImageVendor) {
  const sql = yield* SqlClient.SqlClient;
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* KinConnectionSecrets;
  const renderer = yield* KinDocRenderer;
  const chat = yield* KinChatService;
  const identity = yield* KinIdentity;
  const refreshes = yield* KinRefreshObserver;
  const db = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const ownerOf = Effect.fn("KinPictures.ownerOf")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const person = people.find((one) => one.orgId === orgId);
    if (person === undefined) return yield* notAllowed;
    const allowed = yield* db(mayActAsOwner(orgId, person.personId, identity.owner)).pipe(
      Effect.mapError(() => unavailable),
    );
    if (!allowed) return yield* notAllowed;
    return person;
  });

  const settingsOf = Effect.fn("KinPictures.settingsOf")(function* (orgId: KinOrgId) {
    const [row] = yield* sql<Settings>`SELECT monthly_limit AS "monthlyLimit", model,
        key_saved_at AS "keySavedAt", warned_month AS "warnedMonth"
      FROM kin_picture_settings WHERE org_id = ${orgId} ORDER BY org_id`;
    return row;
  });

  const monthNow = Effect.fn("KinPictures.monthNow")(function* (orgId: KinOrgId) {
    const now = yield* Clock.currentTimeMillis;
    const month = monthOf(dayIn(now, yield* db(ownerZone(orgId))));
    return { now, month, resetsOn: `${shiftMonth(month, 1)}-01` };
  });

  const used = Effect.fn("KinPictures.used")(function* (orgId: KinOrgId, month: string) {
    // A reservation counts until settled: one a crash left may have been made, so it stays.
    const [row] = yield* sql<{ used: number | null }>`SELECT SUM(count) AS used
      FROM kin_picture_counts WHERE org_id = ${orgId} AND month = ${month}`;
    return row?.used ?? 0;
  });

  /** What may have been made but never came back: counted, and said so in Settings. */
  const unclear = Effect.fn("KinPictures.unclear")(function* (orgId: KinOrgId, month: string) {
    const [row] = yield* sql<{ unclear: number | null }>`SELECT SUM(count) AS unclear
      FROM kin_picture_counts WHERE org_id = ${orgId} AND month = ${month} AND state = 'unclear'`;
    return row?.unclear ?? 0;
  });

  const view = Effect.fn("KinPictures.view")(function* (orgId: KinOrgId) {
    const { month, resetsOn } = yield* monthNow(orgId);
    const settings = yield* settingsOf(orgId);
    const key = yield* secrets.getPicturesKey(vendor.name);
    const connected = settings?.keySavedAt != null && Option.isSome(key);
    return {
      orgId,
      vendor: { label: vendor.label, keyUrl: vendor.keyUrl },
      connected,
      savedAt: connected ? DateTime.formatIso(DateTime.makeUnsafe(settings.keySavedAt)) : null,
      model: settings?.model ?? vendor.defaultModel,
      monthlyLimit: settings === undefined ? KIN_PICTURES_PROPOSED_LIMIT : settings.monthlyLimit,
      usedThisMonth: yield* used(orgId, month),
      unclearThisMonth: yield* unclear(orgId, month),
      resetsOn,
    } satisfies KinPicturesView;
  });

  const get = Effect.fn("KinPictures.get")(
    function* (people: ReadonlyArray<PersonIdentity>, input: KinPicturesInput) {
      yield* ownerOf(people, input.orgId);
      return yield* view(input.orgId);
    },
    Effect.catchTags({ SqlError: () => Effect.fail(unavailable) }),
  );

  const set = Effect.fn("KinPictures.set")(
    function* (people: ReadonlyArray<PersonIdentity>, input: KinPicturesSetInput) {
      const person = yield* ownerOf(people, input.orgId);
      if (input.disconnect === true && input.key !== undefined)
        return yield* invalid("Save a key or disconnect, not both at once.");
      const now = yield* Clock.currentTimeMillis;
      // The secret first, then the row; a row that fails puts back the secret there was.
      const previous =
        input.key === undefined ? Option.none() : yield* secrets.getPicturesKey(vendor.name);
      if (input.key !== undefined) yield* secrets.setPicturesKey(vendor.name, input.key);
      const putBack = Option.match(previous, {
        onNone: () => secrets.removePicturesKey(vendor.name),
        onSome: (key) => secrets.setPicturesKey(vendor.name, key),
      });
      yield* Effect.gen(function* () {
        const existing = yield* settingsOf(input.orgId);
        const limit =
          input.monthlyLimit !== undefined
            ? input.monthlyLimit
            : existing === undefined
              ? KIN_PICTURES_PROPOSED_LIMIT
              : existing.monthlyLimit;
        const keySavedAt =
          input.disconnect === true
            ? null
            : input.key !== undefined
              ? now
              : (existing?.keySavedAt ?? null);
        const model = input.model ?? existing?.model ?? null;
        yield* sql`INSERT INTO kin_picture_settings (org_id, monthly_limit, model, key_saved_at,
          warned_month, updated_at, updated_by)
        VALUES (${input.orgId}, ${limit}, ${model}, ${keySavedAt}, NULL, ${now}, ${person.personId})
        ON CONFLICT (org_id) DO UPDATE SET monthly_limit = excluded.monthly_limit,
          model = excluded.model, key_saved_at = excluded.key_saved_at,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
        // Disconnecting forgets the key last, inside the row's transaction: both go, or neither.
        if (input.disconnect === true) yield* secrets.removePicturesKey(vendor.name);
      }).pipe(
        sql.withTransaction,
        Effect.onError(() => (input.key === undefined ? Effect.void : Effect.ignore(putBack))),
      );
      // Every other device showing Connections reads it again.
      yield* refreshes.touch(input.orgId, "connections");
      return yield* view(input.orgId);
    },
    Effect.catchTags({ SqlError: () => Effect.fail(unavailable) }),
  );

  /** Holds the count before the call: two requests at once can't pass the limit together. */
  const reserve = Effect.fn("KinPictures.reserve")(function* (request: GenerateRequest) {
    const { now, month, resetsOn } = yield* monthNow(request.orgId);
    return yield* Effect.gen(function* () {
      const agents = yield* sql`SELECT 1 FROM kin_agents WHERE org_id = ${request.orgId}
        AND agent_id = ${request.agentId} AND retired_at IS NULL`;
      if (agents.length === 0) return yield* notFound("No such agent here.");
      if (request.askedBy !== null) {
        const people = yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${request.orgId}
          AND person_id = ${request.askedBy}`;
        if (people.length === 0) return yield* notFound("No such person here.");
      }
      const settings = yield* settingsOf(request.orgId);
      const limit = settings?.monthlyLimit ?? null;
      const countId =
        request.retryKey === undefined
          ? `pic_${NodeCrypto.randomBytes(10).toString("hex")}`
          : `pic_${NodeCrypto.createHash("sha256").update(request.retryKey).digest("hex").slice(0, 20)}`;
      const [earlier] = yield* sql<{
        agentId: string;
        personId: string | null;
        made: string | null;
      }>`SELECT agent_id AS "agentId", person_id AS "personId", made_json AS made
        FROM kin_picture_counts WHERE org_id = ${request.orgId} AND count_id = ${countId}
        ORDER BY count_id`;
      if (earlier !== undefined) {
        if (earlier.agentId !== request.agentId || earlier.personId !== request.askedBy)
          return yield* new KinChatError({
            reason: "not_allowed",
            message: "This picture was asked for by someone else.",
          });
        const made = earlier.made === null ? undefined : decodeMade(earlier.made);
        if (made === undefined || Option.isNone(made)) return yield* stillMaking;
        return { _tag: "done" as const, made: made.value };
      }
      const before = yield* used(request.orgId, month);
      const take = limit === null ? request.count : Math.min(request.count, limit - before);
      if (take <= 0)
        return {
          _tag: "full" as const,
          sentence: GENERATE_SENTENCES.limit(limit ?? 0, formatKinPicturesDay(resetsOn)),
        };
      const inserted = yield* sql`INSERT INTO kin_picture_counts (org_id, count_id, month, agent_id,
          person_id, count, state, at)
        VALUES (${request.orgId}, ${countId}, ${month}, ${request.agentId}, ${request.askedBy},
          ${take}, 'reserved', ${now})
        ON CONFLICT (org_id, count_id) DO NOTHING RETURNING count_id`;
      if (inserted.length === 0) return yield* stillMaking;
      return {
        _tag: "held" as const,
        countId,
        take,
        limit,
        month,
        resetsOn,
        model: settings?.model ?? vendor.defaultModel,
      };
    }).pipe(sql.withTransaction);
  });

  /** The request never left, or the service settled it with nothing made: the count is freed. */
  const release = (orgId: KinOrgId, countId: string) =>
    sql`DELETE FROM kin_picture_counts WHERE org_id = ${orgId} AND count_id = ${countId}
      AND state = 'reserved'`.pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Kin couldn't release a picture count", { cause }),
      ),
      Effect.ignore,
    );
  /**
   * Sent, and nothing usable came back: it may have been made and billed, so the count stays as
   * unclear, under an id of its own so the same call can be asked again.
   */
  const keepLost = (orgId: KinOrgId, countId: string, count: number) =>
    sql`UPDATE kin_picture_counts SET count_id = ${`lost_${NodeCrypto.randomBytes(10).toString("hex")}`},
        state = 'unclear', count = ${count}
      WHERE org_id = ${orgId} AND count_id = ${countId} AND state = 'reserved'`.pipe(
      Effect.tapError((cause) => Effect.logWarning("Kin couldn't keep a picture count", { cause })),
      Effect.ignore,
    );

  /**
   * The owner notice line, in the Chief of staff's chat, by the limit set now and what is settled:
   * once a month as it passes 80%, and once a month as it is reached, whatever the limit then.
   * A call that goes from under 80% to the limit sends only the second.
   */
  const warnIfNear = Effect.fn("KinPictures.warnIfNear")(function* (
    orgId: KinOrgId,
    held: { readonly month: string; readonly resetsOn: string },
  ) {
    yield* Effect.gen(function* () {
      const limit = (yield* settingsOf(orgId))?.monthlyLimit ?? null;
      if (limit === null) return;
      const [row] = yield* sql<{ settled: number | null }>`SELECT SUM(count) AS settled
        FROM kin_picture_counts WHERE org_id = ${orgId} AND month = ${held.month}
          AND state IN ('made', 'unclear')`;
      const count = row?.settled ?? 0;
      if (count * 100 < limit * WARN_PERCENT) return;
      const full = count >= limit;
      const claimed = yield* sql`UPDATE kin_picture_settings SET warned_month = ${held.month}
        WHERE org_id = ${orgId} AND (warned_month IS NULL OR warned_month <> ${held.month})
        RETURNING org_id`;
      if (!full && claimed.length === 0) return;
      const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
      if (lead === undefined) return;
      const until = formatKinPicturesDay(held.resetsOn);
      yield* chat.notice({
        orgId,
        chatId: KinChatId.make(lead.ownerChatId),
        // One id a month for each: a raised limit reached again says nothing new.
        messageId: KinMessageId.make(
          full
            ? `kin-pictures-full:${orgId}:${held.month}`
            : `kin-pictures-near:${orgId}:${held.month}`,
        ),
        audience: "owner",
        body: full
          ? `Kin has made all ${limit} of this month's generated pictures, so new ones stop until ${until}. You can raise the limit or choose No limit in ${WHERE}.`
          : `Kin has made ${count} of this month's ${limit} generated pictures. At ${limit}, new ones stop until ${until}. You can raise the limit or choose No limit in ${WHERE}.`,
      });
    }).pipe(
      sql.withTransaction,
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin couldn't post the pictures notice", cause),
      ),
    );
  });

  const refusal = (reason: GenerateRefusal, sentence: string) =>
    ({ _tag: "refused", reason, sentence }) as const;
  const settledBy = (error: ImageVendorError, ownerLevel: boolean) =>
    error.kind === "refused"
      ? refusal("refused", GENERATE_SENTENCES.refused)
      : error.kind === "key_rejected"
        ? refusal(
            "key_rejected",
            ownerLevel ? GENERATE_SENTENCES.key_rejected : GENERATE_SENTENCES.not_working,
          )
        : refusal("unavailable", GENERATE_SENTENCES.unavailable);
  const lost = refusal("lost", GENERATE_SENTENCES.lost);

  const generate = Effect.fn("KinPictures.generate")(
    function* (request: GenerateRequest) {
      const prompt = request.prompt.trim();
      if (prompt === "" || prompt.length > MAX_PROMPT)
        return yield* invalid(`A picture's prompt is 1 to ${MAX_PROMPT} characters.`);
      if (!Number.isInteger(request.count) || request.count < 1 || request.count > 4)
        return yield* invalid("count is 1 to 4 pictures.");
      if (!Object.hasOwn(KIN_PICTURE_SIZES, request.size))
        return yield* invalid(`size is one of ${Object.keys(KIN_PICTURE_SIZES).join(", ")}.`);
      const wanted = pictureOutput(request.size);
      const settings = yield* settingsOf(request.orgId);
      const key = yield* secrets.getPicturesKey(vendor.name);
      if (settings?.keySavedAt == null || Option.isNone(key))
        return refusal("no_key", GENERATE_SENTENCES.no_key);
      const held = yield* reserve(request);
      if (held._tag === "full") return refusal("limit", held.sentence);
      if (held._tag === "done") return { _tag: "made", ...held.made } as const;
      const size = nearestSize(vendor.sizes, wanted);
      // Once sent, an interrupted turn leaves its reservation: the picture may still be made.
      const answer = yield* vendor
        .generate(key.value, { model: held.model, prompt, size, count: held.take })
        .pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.timeoutOrElse({
            duration: PICTURE_TIMEOUT,
            orElse: () => Effect.fail(new ImageVendorError({ kind: "lost" })),
          }),
          Effect.map((made) => ({ _tag: "made" as const, made })),
          Effect.catch((error) => Effect.succeed({ _tag: "failed" as const, error })),
        );
      if (answer._tag === "failed") {
        if (answer.error.kind === "lost") {
          yield* keepLost(request.orgId, held.countId, held.take);
          return lost;
        }
        yield* release(request.orgId, held.countId);
        return settledBy(answer.error, request.ownerLevel);
      }
      const sent = answer.made.images.slice(0, held.take);
      const images = sent.flatMap((image) => {
        const type = pictureHeader(image.bytes);
        return type === undefined || image.bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
          ? []
          : [{ bytes: image.bytes, mime: type.mime, ext: type.ext }];
      });
      // What the service sent is what it made: each is counted, usable or not.
      const counted = Math.max(1, sent.length);
      if (images.length === 0) {
        yield* keepLost(request.orgId, held.countId, counted);
        return lost;
      }
      const files = yield* Effect.forEach(images, (image, index) =>
        renderer
          .store(request.orgId, `picture-${held.countId}`, {
            sha256: NodeCrypto.createHash("sha256").update(image.bytes).digest("hex"),
            extension: image.ext,
            bytes: image.bytes,
          })
          .pipe(
            Effect.map((id): ChatImageAttachment => ({
              type: "image",
              id,
              name: `${request.size}-${index + 1}.${image.ext}`,
              mimeType: image.mime,
              sizeBytes: image.bytes.byteLength,
            })),
          ),
      ).pipe(Effect.option);
      if (Option.isNone(files)) {
        yield* keepLost(request.orgId, held.countId, counted);
        return lost;
      }
      const made = {
        files: files.value,
        size,
        vendor: vendor.label,
        model: held.model,
        note: noteOf({ size, wanted, request, held, made: images.length, counted }),
      };
      const settled = yield* sql`UPDATE kin_picture_counts SET state = 'made', count = ${counted},
          made_json = ${encodeMade(made)}
        WHERE org_id = ${request.orgId} AND count_id = ${held.countId}`.pipe(
        sql.withTransaction,
        Effect.as(true),
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.logWarning("Kin couldn't settle a picture count", { cause }).pipe(
              Effect.as(false),
            ),
        }),
      );
      if (!settled) return lost;
      yield* refreshes.touch(request.orgId, "connections");
      yield* warnIfNear(request.orgId, held);
      return { _tag: "made", ...made } as const;
    },
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.logWarning("Kin couldn't count a picture", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new KinChatError({
                reason: "unavailable",
                message:
                  "Kin couldn't count this picture. Nothing was made; try again in a minute.",
              }),
            ),
          ),
        ),
    }),
  );

  return KinPictures.of({ get, set, generate });
});

/** The picture service on `vendor`; every request goes out through the HTTP client beneath. */
export const makeLayer = (vendor: KinImageVendor) => Layer.effect(KinPictures, make(vendor));

export const layer = makeLayer(openAiImages);
