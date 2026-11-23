// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous content hash; Digest would add a service to every caller.
import * as NodeCrypto from "node:crypto";

import {
  KinChatError,
  type KinChatId,
  type KinOrgId,
  type KinPersonId,
  KinWakeupId,
  KinWorkerId,
} from "@t3tools/contracts";
import { kinVisualFileReferences } from "@t3tools/shared/kinVisual";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { KinAttachmentStore } from "../chat/KinAttachmentStore.ts";
import { logoFile } from "../gendocs/brand.ts";
import { KinDocRenderer } from "../gendocs/render.ts";
import { KinToolchain } from "../gendocs/toolchain.ts";
import { effectiveAudience } from "../lead/Audience.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { isOrgPaused } from "../lead/orgState.ts";
import { outsideRead } from "../lead/OutsideContent.ts";
import { laneFor } from "../reply/replyLane.ts";
import * as Docs from "../work/docs.ts";
import type { Writer } from "../work/KinRecords.ts";
import { admitted, type Lead, leadTool, viewOf, viewWriter, writerFor } from "../work/leadWork.ts";
import { personReads } from "../chat/sharing.ts";
import { readProfile } from "../work/companyProfile.ts";
import { turnSensitive } from "../work/sensitiveReads.ts";
import {
  docVersionSeen,
  KIN_OWNER_LEVEL,
  PICTURE_DOC_ORIGIN,
  viewerOfPeople,
} from "../work/teamView.ts";
import { ownerLevelPeople } from "../people/KinAccess.ts";
import { visualPage } from "../widgets/visualCard.ts";
import { KinPictures } from "./KinPictures.ts";
import { KinPictureRenderer, type PictureBrand, type PictureFile } from "./renderer.ts";
import { KinPictureSize, pictureOutput } from "./sizes.ts";
import { keySentSql } from "../chat/keySent.ts";

/**
 * What `kin_picture` takes: `html` to draw a page or `prompt` to generate from words, never both.
 * `doc` names an earlier picture this one is the next version of.
 */
export const PictureInput = Schema.Struct({
  title: Schema.String,
  size: KinPictureSize,
  html: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  count: Schema.optional(Schema.Number),
  doc: Schema.optional(Schema.String),
});
export type PictureInput = typeof PictureInput.Type;
export const PictureResult = Schema.Struct({
  /** The image's id in the chat: what a social draft's media takes. */
  files: Schema.Array(Schema.String),
  doc: Schema.String,
  version: Schema.Number,
  next: Schema.String,
});

const TOOL = "kin_picture";
const PAUSED = "Kin is paused by the owner, so nothing new is made until they resume it.";
/** A prompt leaves Kin: after outside text, only a person's own ask sends one. */
export const UNASKED_AFTER_OUTSIDE =
  "This turn read text from a connected service and no one asked for this picture in their own message, so nothing was generated or counted. Design it with html instead.";

/** A generated batch is 1 to 4 pictures, checked before anything is set aside for it. */
export const COUNT_RANGE = "count is a whole number from 1 to 4, so nothing was made.";

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const sha256 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const fileName = (title: string, extension: string, index = 0) =>
  `${
    title
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .toLowerCase() || "picture"
  }${index === 0 ? "" : `-${index + 1}`}.${extension}`;
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
const isPictureType = (mimeType: string): mimeType is keyof typeof EXTENSIONS =>
  Object.hasOwn(EXTENSIONS, mimeType);

/**
 * The earlier picture `doc` names, as this turn may read it (in one others read, one they all
 * see), and the chat its versions belong to: the one its first was made in.
 */
const earlierPicture = Effect.fn("KinPictures.earlier")(function* (lead: Lead, key: string) {
  const team = yield* viewOf(lead);
  const row = yield* Docs.docRow(
    lead.orgId,
    { key },
    team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople(team.people),
  );
  if (!row.originKey.startsWith(PICTURE_DOC_ORIGIN))
    return yield* invalid(
      `${row.key} isn't a picture, so nothing was made. Leave doc out to make a new picture.`,
    );
  const sql = yield* SqlClient.SqlClient;
  const [first] = yield* sql<{ chatId: string | null }>`SELECT chat_id AS "chatId"
    FROM kin_doc_versions WHERE org_id = ${lead.orgId} AND record_id = ${row.recordId}
    ORDER BY version LIMIT 1`;
  return { row, chatId: first?.chatId ?? null };
});

/**
 * The people whose own message or card tap woke this turn: none for a check-in, a pulse, a
 * hand-off or a schedule, which no one asked for in person.
 */
const messageAskers = Effect.fn("KinPictures.askers")(function* (lead: Lead) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: string }>`SELECT DISTINCT m.author_person_id AS "personId"
    FROM kin_events e JOIN kin_messages m ON m.org_id = e.org_id
      AND m.message_id = json_extract(e.json, '$.messageId')
      AND m.chat_id = json_extract(e.json, '$.chatId') AND m.author_kind = 'human'
      AND NOT ${sql.literal(keySentSql("m.client_message_id"))}
    WHERE e.org_id = ${lead.orgId} AND e.agent_id = ${lead.agentId}
      AND e.wakeup_id = ${lead.wakeupId} AND e.tag IN ('chat.message', 'widget.action')
      AND json_extract(e.json, '$.origin') IS NULL
    ORDER BY m.author_person_id`;
  return rows.map((row) => row.personId);
});

/**
 * Images the page names as `kin-file:<id>` sent in this chat, read for the renderer: each only if
 * whoever asked reads its message (with no one asking, everyone in the chat), and, for a doc's file
 * or picture, each of them below the owner level reads that version of it (`docVersionSeen`).
 */
const chatImages = Effect.fn("KinPictures.chatImages")(function* (
  lead: Lead,
  chatId: KinChatId,
  ids: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig;
  const orgId = lead.orgId;
  const askers = ids.length === 0 ? [] : yield* messageAskers(lead);
  const readers =
    askers.length > 0 || ids.length === 0
      ? askers
      : (yield* sql<{ personId: string }>`SELECT DISTINCT person_id AS "personId"
          FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${chatId}
            AND principal_kind = 'person' AND left_at IS NULL AND person_id IS NOT NULL
          ORDER BY person_id`).map((row) => row.personId);
  const owners = ids.length === 0 ? new Set<string>() : yield* ownerLevelPeople(orgId);
  const below = readers.filter((person) => !owners.has(person));
  const found: Array<{ id: string; mimeType: string; path: string }> = [];
  for (const id of ids) {
    const [row] = yield* sql<{ mimeType: string | null; messageId: string }>`
      SELECT json_extract(j.value, '$.mimeType') AS "mimeType", m.message_id AS "messageId"
      FROM kin_message_attachments a
      JOIN kin_messages m ON m.org_id = a.org_id AND m.message_id = a.message_id
      JOIN json_each(COALESCE(m.attachments_json, '[]')) j ON json_extract(j.value, '$.id') = a.attachment_id
      WHERE a.org_id = ${orgId} AND a.chat_id = ${chatId} AND a.attachment_id = ${id.toLowerCase()}
        AND m.status <> 'deleted'
      ORDER BY a.attachment_id LIMIT 1`;
    const [read] =
      row === undefined || readers.length === 0
        ? [{ readers: 0 }]
        : yield* sql<{ readers: number }>`SELECT COUNT(DISTINCT who.person_id) AS readers
            FROM kin_people who, kin_messages
            WHERE who.org_id = ${orgId} AND who.person_id IN ${sql.in(readers)}
              AND kin_messages.org_id = ${orgId} AND kin_messages.message_id = ${row.messageId}
              AND ${personReads(sql, sql`who.person_id`)}`;
    const [hidden] =
      below.length === 0
        ? [{ docs: 0 }]
        : yield* sql<{ docs: number }>`SELECT COUNT(*) AS docs FROM kin_doc_versions pv
            JOIN kin_records r ON r.org_id = pv.org_id AND r.record_id = pv.record_id
            WHERE pv.org_id = ${orgId}
              AND (pv.file_attachment_id = ${id.toLowerCase()} OR EXISTS (SELECT 1
                FROM kin_picture_images pi WHERE pi.org_id = pv.org_id
                  AND pi.record_id = pv.record_id AND pi.version = pv.version
                  AND pi.attachment_id = ${id.toLowerCase()}))
              AND NOT ${sql.and(below.map((person) => docVersionSeen(sql, person as KinPersonId)))}`;
    const path = resolveAttachmentPathById({ attachmentsDir, attachmentId: id.toLowerCase() });
    if (
      row?.mimeType == null ||
      !/^image\//i.test(row.mimeType) ||
      path === null ||
      read?.readers !== readers.length ||
      (hidden?.docs ?? 0) > 0
    )
      return yield* invalid(
        `kin-file:${id} is not an image sent in this chat, so nothing was made. Use the id of a picture sent here, or put the image in the page as a data: URL.`,
      );
    found.push({ id, mimeType: row.mimeType, path });
  }
  // Sizes first: past the cap, nothing is read into memory.
  let total = 0;
  for (const one of found) total += Number((yield* fs.stat(one.path)).size);
  if (total > PICTURE_INPUTS.bytes) return yield* invalid(TOO_MANY_INPUTS);
  const files: Array<PictureFile> = [];
  for (const one of found)
    files.push({ id: one.id, mimeType: one.mimeType, bytes: yield* fs.readFile(one.path) });
  return files;
});

/** The company's brand for the page; a profile that can't be read is no brand, the theme's look. */
const companyBrand = Effect.fn("KinPictures.brand")(function* (orgId: KinOrgId) {
  const profile = yield* readProfile(orgId).pipe(Effect.option);
  if (Option.isNone(profile)) return undefined;
  const { brand, logo } = profile.value;
  const file = logo === null ? null : yield* logoFile(logo).pipe(Effect.orElseSucceed(() => null));
  return {
    primary: brand.primaryColor,
    secondary: brand.secondaryColor,
    font: brand.font,
    logo: logo === null || file === null ? null : { mimeType: logo.mimeType, bytes: file.bytes },
  } satisfies PictureBrand;
});

/** One picture, drawn or generated, to file as a version of its doc and put on the reply. */
type Made = {
  readonly bytes: Uint8Array;
  readonly mimeType: keyof typeof EXTENSIONS;
  /** Already stored by content in the docs' store, for a generated picture. */
  readonly docFile?: string;
  readonly width: number;
  readonly height: number;
  readonly summary: string;
  /** What the level gate checks it shows. */
  readonly seen: string;
};

/** What one drawing may load of the chat's images, checked before any is read. */
const PICTURE_INPUTS = { images: 8, bytes: 24 * 1024 * 1024 };
export const TOO_MANY_INPUTS = `A picture can use at most ${PICTURE_INPUTS.images} of the chat's images, ${PICTURE_INPUTS.bytes / 1024 / 1024} MB together, so nothing was made. Use fewer or smaller ones, or put one in the page as a data: URL.`;
const CANT_MAKE = "Kin can't make pictures right now, so nothing was made.";
/** A batch trimmed to the room left on the reply. */
export const REPLY_ROOM = (count: number) =>
  `The reply had room for ${count} more, so Kin made ${count}.`;

/** Where a picture is placed in the chat, and its retry: one per picture of the call. */
const placeOf = (wakeupId: string, one: string) => `kin-picture:${wakeupId}:${one}`;
const isKinChatError = Schema.is(KinChatError);
/** A generated batch Kin made and counted but couldn't place: it stays, for the same call. */
export const KEPT =
  "The pictures are made and counted, and Kin keeps them: call again with the same input in this turn to put them on your reply, with nothing new made or counted.";

const SENTENCE_REASONS = {
  no_key: "unavailable",
  limit: "limit",
  refused: "invalid_state",
  key_rejected: "unavailable",
  unavailable: "unavailable",
  lost: "unavailable",
} as const;

/** `kin_picture`: draws the page or generates from the prompt, files each as a doc and puts it on the reply. */
export const makePicture = leadTool("KinPictures.make", (lead: Lead, input: PictureInput) =>
  Effect.gen(function* () {
    if (
      input.count !== undefined &&
      !(Number.isInteger(input.count) && input.count >= 1 && input.count <= 4)
    )
      return yield* invalid(COUNT_RANGE);
    yield* admitted(lead, TOOL, input);
    if (yield* isOrgPaused(lead.orgId))
      return yield* new KinChatError({ reason: "not_allowed", message: PAUSED });
    if ((input.html === undefined) === (input.prompt === undefined))
      return yield* invalid(
        "Give html to draw the picture or prompt to generate it, one of the two, so nothing was made.",
      );
    if (input.html !== undefined && input.count !== undefined)
      return yield* invalid(
        "count is for a generated picture: a drawn one is one picture, so nothing was made.",
      );
    if (input.doc !== undefined && (input.count ?? 1) !== 1)
      return yield* invalid(
        "A change makes one picture, the doc's next version: leave count out, so nothing was made.",
      );
    if (
      input.prompt !== undefined &&
      (yield* outsideRead(lead)) &&
      (yield* messageAskers(lead)).length === 0
    )
      return yield* new KinChatError({ reason: "not_allowed", message: UNASKED_AFTER_OUTSIDE });
    const wakeupId = KinWakeupId.make(lead.wakeupId);
    const lane = yield* laneFor({ orgId: lead.orgId, agentId: lead.agentId, wakeupId });
    if (Option.isNone(lane))
      return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
    const chatId = lane.value.chatId;
    const found = input.doc === undefined ? undefined : yield* earlierPicture(lead, input.doc);
    // A doc's versions are all one chat's: a change asked for elsewhere starts this chat's own,
    // and so does a change to a deleted picture, which would otherwise land out of sight.
    const earlier =
      found?.chatId === chatId && found.row.state !== "dropped" ? found.row : undefined;
    const changedFrom = found !== undefined && earlier === undefined ? found.row.key : undefined;
    const team = yield* viewOf(lead);
    const owned = yield* writerFor(lead);
    // Not the turn's view guard, which keeps new docs the owner's: who reads a picture is its own
    // rule (`teamView.pictureReader`), and one it revises was found in the view (`earlierPicture`).
    const { view: _view, ...turnWriter }: Writer =
      team === undefined ? owned : viewWriter(owned, team);
    const writer: Writer = { ...turnWriter, chatId };
    // An identical call in the same turn is a retry: the same doc versions and the same images.
    const key = sha256(stableStringify(input)).slice(0, 32);
    const title = input.title.slice(0, 200);
    const from = changedFrom === undefined ? "" : `, changed from ${changedFrom}`;

    const stores = yield* Effect.serviceOption(KinAttachmentStore);
    if (Option.isNone(stores))
      return yield* new KinChatError({
        reason: "unavailable",
        message: "Attachments are unavailable.",
      });
    const store = stores.value;
    const gate = yield* KinLevelGate;
    const asked = input.html === undefined ? (input.count ?? 1) : 1;
    const oneOf = (index: number) => (index === 0 ? key : `${key}-${index + 1}`);
    const placing = { ...lead, wakeupId };
    const page =
      input.html === undefined
        ? undefined
        : yield* visualPage({ title: input.title, html: input.html });
    // Where it goes, what it shows and how many fit, before anything is drawn or paid for.
    const room = yield* gate.pictureRoom(placing, {
      chatId,
      clientMessageIds: Array.from({ length: asked }, (_, index) =>
        placeOf(wakeupId, oneOf(index)),
      ),
      seen:
        page === undefined
          ? `${input.title}\n${input.prompt ?? ""}`
          : `${page.title}\n${page.html.replace(/<[^>]*>/g, " ")}`,
    });

    const count = Math.min(asked, room);
    const pictures: Array<Made> = [];
    let note: string | null = count < asked ? REPLY_ROOM(count) : null;
    if (page !== undefined) {
      const named = [...new Set(kinVisualFileReferences(page.html).map((id) => id.toLowerCase()))];
      if (named.length > PICTURE_INPUTS.images) return yield* invalid(TOO_MANY_INPUTS);
      const context = yield* Effect.context<
        SqlClient.SqlClient | FileSystem.FileSystem | ServerConfig
      >();
      const drawn = yield* (yield* KinPictureRenderer).render({
        html: page.html,
        size: input.size,
        // Read once this picture's turn to draw comes, so a line of them holds no files.
        inputs: Effect.all({
          files: chatImages(lead, chatId, named),
          brand: companyBrand(lead.orgId),
        }).pipe(
          Effect.provideContext(context),
          Effect.mapError((error) =>
            isKinChatError(error)
              ? error
              : new KinChatError({ reason: "unavailable", message: CANT_MAKE }),
          ),
        ),
        fonts: yield* (yield* KinToolchain).fonts(),
      });
      if (drawn._tag === "refused") return yield* invalid(drawn.reason);
      if (drawn._tag === "cannotDraw")
        return yield* new KinChatError({ reason: "unavailable", message: drawn.reason });
      const size = pictureOutput(input.size);
      pictures.push({
        bytes: drawn.png,
        mimeType: "image/png",
        width: size.width,
        height: size.height,
        summary: `Picture, ${size.width}×${size.height}${from}`,
        seen: `${page.title}\n${page.html.replace(/<[^>]*>/g, " ")}`,
      });
    } else {
      const prompt = input.prompt ?? "";
      const generated = yield* (yield* KinPictures).generate({
        orgId: lead.orgId,
        agentId: lead.agentId,
        askedBy: writer.askedBy ?? null,
        ownerLevel: team === undefined,
        prompt,
        size: input.size,
        count,
        retryKey: `kin-picture:${wakeupId}:${key}`,
      });
      // The service's own sentence, word for word: nothing was filed.
      if (generated._tag === "refused")
        return yield* new KinChatError({
          reason: SENTENCE_REASONS[generated.reason],
          message: generated.sentence,
        });
      note = [note, generated.note].filter((one) => one !== null).join(" ") || null;
      const fs = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig;
      for (const file of generated.files) {
        const path = resolveAttachmentPathById({ attachmentsDir, attachmentId: file.id });
        const mimeType = file.mimeType;
        if (path === null || !isPictureType(mimeType))
          return yield* new KinChatError({ reason: "unavailable", message: CANT_MAKE });
        pictures.push({
          bytes: yield* fs.readFile(path),
          mimeType,
          docFile: file.id,
          width: generated.size.width,
          height: generated.size.height,
          summary: `Picture, ${generated.size.width}×${generated.size.height}${from}, generated by ${generated.vendor} (${generated.model}) from: ${prompt.trim().slice(0, 300)}`,
          seen: `${input.title}\n${prompt}`,
        });
      }
    }

    const sensitive = yield* turnSensitive(lead.orgId, lead.wakeupId);
    const sql = yield* SqlClient.SqlClient;
    const renderer = yield* KinDocRenderer;
    const audience = yield* effectiveAudience(lead);
    const stored = yield* Effect.forEach(pictures, (picture, index) =>
      Effect.gen(function* () {
        const one = oneOf(index);
        const extension = EXTENSIONS[picture.mimeType];
        const hash = sha256(picture.bytes);
        const docFile =
          picture.docFile ??
          (yield* renderer.store(lead.orgId, `pic-${one}`, {
            sha256: hash,
            extension,
            bytes: picture.bytes,
          }));
        return {
          picture,
          one,
          extension,
          hash,
          docFile,
          chatImage: yield* store.storeImage(picture.bytes, extension),
        };
      }),
    );
    const chatImageIds = stored.map((one) => one.chatImage);
    // The whole batch is filed and placed together, or none of it is.
    const filedAll = yield* sql
      .withTransaction(
        Effect.forEach(stored, ({ picture, one, extension, hash, docFile, chatImage }, index) =>
          Effect.gen(function* () {
            yield* admitted(lead, TOOL, input);
            const name = fileName(input.title, extension, index);
            const filed = yield* Docs.fileVersion(
              lead.orgId,
              writer,
              { audience },
              {
                docOrigin:
                  earlier?.originKey ?? `${PICTURE_DOC_ORIGIN}${chatId}:${lead.wakeupId}:${one}`,
                originKey: `kin-picture:${lead.wakeupId}:${one}`,
                title,
                summary: picture.summary,
                owner: { _tag: "agent", agentId: lead.agentId },
                sensitive,
                file: {
                  attachmentId: docFile,
                  name,
                  mimeType: picture.mimeType,
                  bytes: picture.bytes.length,
                  sha256: hash,
                  pages: null,
                  recipe: null,
                  inputsHash: one,
                  workerId: KinWorkerId.make(`pic-${one}`),
                  number: null,
                  draft: false,
                },
              },
            );
            const placed = yield* gate.picture(placing, {
              chatId,
              clientMessageId: placeOf(wakeupId, one),
              intent: lane.value.mode === "reply" ? "answer" : "evidence",
              attachment: {
                type: "image",
                id: chatImage,
                name,
                mimeType: picture.mimeType,
                sizeBytes: picture.bytes.length,
              },
              doc: { key: filed.row.key, version: filed.version.version },
              seen: picture.seen,
            });
            yield* sql`INSERT INTO kin_picture_images (org_id, record_id, version, attachment_id,
                page, prompt)
              VALUES (${lead.orgId}, ${filed.row.recordId}, ${filed.version.version},
                ${placed.attachmentId}, ${input.html ?? null},
                ${input.html === undefined ? (input.prompt ?? null) : null})
              ON CONFLICT DO NOTHING`;
            return { filed, placed };
          }),
        ),
      )
      .pipe(
        Effect.onError(() => store.remove(chatImageIds)),
        // Generated pictures were paid for and are kept: the same call again places them.
        Effect.mapError((error) =>
          input.prompt === undefined
            ? error
            : new KinChatError({
                reason: "unavailable",
                message: `${isKinChatError(error) && error.reason !== "unavailable" ? error.message : "Kin couldn't put the pictures on your reply."} ${KEPT}`,
              }),
        ),
      );
    const made: Array<{ readonly file: string; readonly doc: string; readonly version: number }> =
      [];
    let placedIn: "reply" | "chat" = "reply";
    for (const [index, { filed, placed }] of filedAll.entries()) {
      if (placed.attachmentId !== chatImageIds[index]) yield* store.remove([chatImageIds[index]!]);
      placedIn = placed.placed === "reply" ? "reply" : "chat";
      made.push({ file: placed.attachmentId, doc: filed.row.key, version: filed.version.version });
    }
    const [first] = made;
    if (first === undefined)
      return yield* new KinChatError({ reason: "unavailable", message: CANT_MAKE });
    const where = placedIn === "reply" ? "under your reply" : "in the chat";
    const next =
      made.length === 1
        ? placedIn === "reply"
          ? `The picture shows under your reply and is in Docs as ${first.doc}, version ${first.version}.`
          : `The picture is posted in the chat and is in Docs as ${first.doc}, version ${first.version}.`
        : `The ${made.length} pictures show ${where} and are in Docs as ${made
            .map((one) => one.doc)
            .join(", ")}.`;
    return {
      files: made.map((one) => one.file),
      doc: first.doc,
      version: first.version,
      next: note === null ? next : `${next} ${note}`,
    };
  }),
);
