// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous digest; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import {
  KIN_PICTURES_PROPOSED_LIMIT,
  KIN_TEXT_LOCALE,
  formatKinWhen,
  KinChatError,
  KinChatId,
  KinMessageId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatImageAttachment,
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
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinConnectionSecrets } from "../connections/ConnectionSecrets.ts";
import { KinDocRenderer } from "../gendocs/render.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { mayActAsOwner } from "../people/KinAccess.ts";
import { dayIn, monthOf, shiftMonth } from "../work/money.ts";
import { textLocale } from "../work/companyProfile.ts";
import { ownerZone } from "../work/recordRows.ts";
import { ImageVendorError, type KinImageVendor, type PixelSize } from "./ImageVendor.ts";
import { openAiImages } from "./OpenAiImages.ts";

/** The sizes an agent names, in output pixels, and what each is for. */
export const PICTURE_SIZES = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
  /** A link or LinkedIn card. */
  link: { width: 1200, height: 628 },
  /** A4 portrait. */
  page: { width: 1588, height: 2246 },
} as const satisfies Record<string, PixelSize>;
export type PictureSizeName = keyof typeof PICTURE_SIZES;

/** Generation is slow; past this the vendor counts as down and nothing is counted. */
export const PICTURE_TIMEOUT = Duration.seconds(120);
/** A reservation older than this was cut off by a crash, and stops counting. */
const STALE_RESERVATION_MS = 10 * 60_000;
const WARN_PERCENT = 80;
const MAX_PROMPT = 32_000;

export type PictureRequest = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  /** Who asked, when a person did. */
  readonly askedBy: KinPersonId | null;
  readonly prompt: string;
  readonly size: PictureSizeName;
  /** 1 to 4. */
  readonly count: number;
};

export type PictureRefusal = "no_key" | "limit" | "refused" | "key_rejected" | "unavailable";
export type PictureResult =
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
  | { readonly _tag: "refused"; readonly reason: PictureRefusal; readonly sentence: string };

const WHERE = "Settings → Connections → Pictures";
/** The server's own words for every way a picture isn't made, each saying who can fix it. */
export const PICTURE_SENTENCES = {
  no_key: `No picture service is connected yet. An owner or co-owner can connect one in ${WHERE}.`,
  limit: (limit: number, resetsOn: string) =>
    `This month's ${limit} generated pictures are used. An owner or co-owner can raise the limit in ${WHERE}; it resets on ${resetsOn}.`,
  refused: (reason: string | null) =>
    `The picture service turned this prompt down${reason === null ? "" : `: ${reason}`}. Nothing was counted. Describe it differently and try again.`,
  key_rejected: `The picture service turned down Kin's key. Nothing was counted. An owner or co-owner can check it in ${WHERE}.`,
  unavailable:
    "The picture service didn't answer. Nothing was counted; try again in a few minutes.",
} as const;

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

/** The type from the leading bytes; a vendor's own label is never trusted. */
const sniff = (bytes: Uint8Array) => {
  const at = (index: number, ...values: ReadonlyArray<number>) =>
    values.every((value, offset) => bytes[index + offset] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return { mime: "image/png", ext: "png" };
  if (at(0, 0xff, 0xd8, 0xff)) return { mime: "image/jpeg", ext: "jpg" };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return { mime: "image/webp", ext: "webp" };
  return undefined;
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
    readonly generate: (request: PictureRequest) => Effect.Effect<PictureResult, KinChatError>;
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

  /** The day a month starts, as the company writes a date: "1 Dec". */
  const dayName = (orgId: KinOrgId, day: string) =>
    db(textLocale(orgId)).pipe(
      Effect.orElseSucceed(() => KIN_TEXT_LOCALE),
      Effect.map((locale) =>
        formatKinWhen(Date.parse(`${day}T12:00:00.000Z`), "date", { zone: "UTC", locale }),
      ),
    );

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

  const used = Effect.fn("KinPictures.used")(function* (
    orgId: KinOrgId,
    month: string,
    now: number,
  ) {
    const [row] = yield* sql<{ used: number | null }>`SELECT SUM(count) AS used
      FROM kin_picture_counts WHERE org_id = ${orgId} AND month = ${month}
        AND (state = 'made' OR at > ${now - STALE_RESERVATION_MS})`;
    return row?.used ?? 0;
  });

  const view = Effect.fn("KinPictures.view")(function* (orgId: KinOrgId) {
    const { now, month, resetsOn } = yield* monthNow(orgId);
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
      usedThisMonth: yield* used(orgId, month, now),
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
      if (input.disconnect === true) yield* secrets.removePicturesKey(vendor.name);
      if (input.key !== undefined) yield* secrets.setPicturesKey(vendor.name, input.key);
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
      // Every other device showing Connections reads it again.
      yield* refreshes.touch(input.orgId, "connections");
      return yield* view(input.orgId);
    },
    Effect.catchTags({ SqlError: () => Effect.fail(unavailable) }),
  );

  /** Holds the count before the call: two requests at once can't pass the limit together. */
  const reserve = Effect.fn("KinPictures.reserve")(function* (request: PictureRequest) {
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
      yield* sql`DELETE FROM kin_picture_counts WHERE org_id = ${request.orgId}
        AND state = 'reserved' AND at <= ${now - STALE_RESERVATION_MS}`;
      const before = yield* used(request.orgId, month, now);
      const take = limit === null ? request.count : Math.min(request.count, limit - before);
      if (take <= 0)
        return {
          _tag: "full" as const,
          sentence: PICTURE_SENTENCES.limit(limit ?? 0, yield* dayName(request.orgId, resetsOn)),
        };
      const countId = `pic_${NodeCrypto.randomBytes(10).toString("hex")}`;
      yield* sql`INSERT INTO kin_picture_counts (org_id, count_id, month, agent_id, person_id,
          count, state, at)
        VALUES (${request.orgId}, ${countId}, ${month}, ${request.agentId}, ${request.askedBy},
          ${take}, 'reserved', ${now})`;
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

  const release = (orgId: KinOrgId, countId: string) =>
    sql`DELETE FROM kin_picture_counts WHERE org_id = ${orgId} AND count_id = ${countId}
      AND state = 'reserved'`.pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Kin couldn't release a picture count", { cause }),
      ),
      Effect.ignore,
    );

  /** Once a month, as a set limit passes 80%: the owner notice line, in the Chief of staff's chat. */
  const warnIfNear = Effect.fn("KinPictures.warnIfNear")(function* (
    orgId: KinOrgId,
    held: { readonly limit: number | null; readonly month: string; readonly resetsOn: string },
  ) {
    const limit = held.limit;
    if (limit === null) return;
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.gen(function* () {
      const count = yield* used(orgId, held.month, now);
      if (count * 100 < limit * WARN_PERCENT) return;
      const claimed = yield* sql`UPDATE kin_picture_settings SET warned_month = ${held.month}
        WHERE org_id = ${orgId} AND (warned_month IS NULL OR warned_month <> ${held.month})
        RETURNING org_id`;
      if (claimed.length === 0) return;
      const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
      if (lead === undefined) return;
      yield* chat.notice({
        orgId,
        chatId: KinChatId.make(lead.ownerChatId),
        messageId: KinMessageId.make(`kin-pictures-near:${orgId}:${held.month}`),
        audience: "owner",
        body: `Kin has made ${count} of this month's ${limit} generated pictures. At ${limit}, new ones stop until ${yield* dayName(orgId, held.resetsOn)}. You can raise the limit or choose No limit in ${WHERE}.`,
      });
    }).pipe(
      sql.withTransaction,
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin couldn't post the pictures notice", cause),
      ),
    );
  });

  const sentenceOf = (error: ImageVendorError) =>
    error.kind === "refused"
      ? PICTURE_SENTENCES.refused(error.reason?.trim().replace(/[.\s]+$/, "") || null)
      : PICTURE_SENTENCES[error.kind];

  const generate = Effect.fn("KinPictures.generate")(
    function* (request: PictureRequest) {
      const prompt = request.prompt.trim();
      if (prompt === "" || prompt.length > MAX_PROMPT)
        return yield* invalid(`A picture's prompt is 1 to ${MAX_PROMPT} characters.`);
      if (!Number.isInteger(request.count) || request.count < 1 || request.count > 4)
        return yield* invalid("count is 1 to 4 pictures.");
      const wanted = PICTURE_SIZES[request.size];
      if (wanted === undefined)
        return yield* invalid(`size is one of ${Object.keys(PICTURE_SIZES).join(", ")}.`);
      const settings = yield* settingsOf(request.orgId);
      const key = yield* secrets.getPicturesKey(vendor.name);
      if (settings?.keySavedAt == null || Option.isNone(key))
        return { _tag: "refused", reason: "no_key", sentence: PICTURE_SENTENCES.no_key } as const;
      const held = yield* reserve(request);
      if (held._tag === "full")
        return { _tag: "refused", reason: "limit", sentence: held.sentence } as const;
      const size = nearestSize(vendor.sizes, wanted);
      const answer = yield* vendor
        .generate(key.value, { model: held.model, prompt, size, count: held.take })
        .pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.timeoutOrElse({
            duration: PICTURE_TIMEOUT,
            orElse: () => Effect.fail(new ImageVendorError({ kind: "unavailable", reason: null })),
          }),
          Effect.map((made) => ({ _tag: "made" as const, made })),
          Effect.catch((error) => Effect.succeed({ _tag: "failed" as const, error })),
          // A turn stopped mid-call frees its count at once rather than when it goes stale.
          Effect.onInterrupt(() => release(request.orgId, held.countId)),
        );
      const images =
        answer._tag === "made"
          ? answer.made.images.slice(0, held.take).flatMap((image) => {
              const type = sniff(image.bytes);
              return type === undefined ||
                image.bytes.byteLength === 0 ||
                image.bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
                ? []
                : [{ bytes: image.bytes, ...type }];
            })
          : [];
      if (images.length === 0) {
        yield* release(request.orgId, held.countId);
        const reason = answer._tag === "failed" ? answer.error.kind : "unavailable";
        return {
          _tag: "refused",
          reason,
          sentence:
            answer._tag === "failed" ? sentenceOf(answer.error) : PICTURE_SENTENCES.unavailable,
        } as const;
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
      ).pipe(Effect.tapError(() => release(request.orgId, held.countId)));
      yield* sql`UPDATE kin_picture_counts SET state = 'made', count = ${files.length}
        WHERE org_id = ${request.orgId} AND count_id = ${held.countId}`.pipe(sql.withTransaction);
      yield* refreshes.touch(request.orgId, "connections");
      yield* warnIfNear(request.orgId, held);
      const notes = [
        size.width === wanted.width && size.height === wanted.height
          ? null
          : `Made at ${size.width}×${size.height}, the picture service's nearest size to ${request.size} (${wanted.width}×${wanted.height}).`,
        held.take < request.count
          ? `Only ${held.take} of this month's ${held.limit} pictures were left, so Kin made ${files.length}.`
          : files.length < request.count
            ? `The picture service made ${files.length} of the ${request.count} asked for; only those were counted.`
            : null,
      ].filter((note) => note !== null);
      return {
        _tag: "made",
        files,
        size,
        vendor: vendor.label,
        model: held.model,
        note: notes.length === 0 ? null : notes.join(" "),
      } as const;
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
