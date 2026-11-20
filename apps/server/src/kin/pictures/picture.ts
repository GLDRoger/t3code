// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous content hash; Digest would add a service to every caller.
import * as NodeCrypto from "node:crypto";

import {
  KinChatError,
  type KinChatId,
  type KinOrgId,
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
import { laneFor } from "../reply/replyLane.ts";
import * as Docs from "../work/docs.ts";
import type { Writer } from "../work/KinRecords.ts";
import { admitted, type Lead, leadTool, viewOf, viewWriter, writerFor } from "../work/leadWork.ts";
import { readProfile } from "../work/companyProfile.ts";
import { turnSensitive } from "../work/sensitiveReads.ts";
import { KIN_OWNER_LEVEL, PICTURE_DOC_ORIGIN, viewerOfPeople } from "../work/teamView.ts";
import { visualPage } from "../widgets/visualCard.ts";
import { KinPictureRenderer, type PictureBrand, type PictureFile } from "./renderer.ts";
import { KIN_PICTURE_SCALE, KIN_PICTURE_SIZES, KinPictureSize } from "./sizes.ts";

/** What `kin_picture` takes. `doc` names an earlier picture this one is the next version of. */
export const PictureInput = Schema.Struct({
  title: Schema.String,
  size: KinPictureSize,
  html: Schema.String,
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

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const sha256 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const fileName = (title: string) =>
  `${
    title
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .toLowerCase() || "picture"
  }.png`;

/** The earlier picture `doc` names, as this turn may read it: in one others read, one they all see. */
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
  return row;
});

/** Images the page names as `kin-file:<id>` that were sent in this chat, read for the renderer. */
const chatImages = Effect.fn("KinPictures.chatImages")(function* (
  orgId: KinOrgId,
  chatId: KinChatId,
  ids: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig;
  const files: Array<PictureFile> = [];
  for (const id of ids) {
    const [row] = yield* sql<{ mimeType: string | null }>`
      SELECT json_extract(j.value, '$.mimeType') AS "mimeType"
      FROM kin_message_attachments a
      JOIN kin_messages m ON m.org_id = a.org_id AND m.message_id = a.message_id
      JOIN json_each(COALESCE(m.attachments_json, '[]')) j ON json_extract(j.value, '$.id') = a.attachment_id
      WHERE a.org_id = ${orgId} AND a.chat_id = ${chatId} AND a.attachment_id = ${id.toLowerCase()}
        AND m.status <> 'deleted'
      ORDER BY a.attachment_id LIMIT 1`;
    const path = resolveAttachmentPathById({ attachmentsDir, attachmentId: id.toLowerCase() });
    if (row?.mimeType == null || !/^image\//i.test(row.mimeType) || path === null)
      return yield* invalid(
        `kin-file:${id} is not an image sent in this chat, so nothing was made. Use the id of a picture sent here, or put the image in the page as a data: URL.`,
      );
    files.push({ id, mimeType: row.mimeType, bytes: yield* fs.readFile(path) });
  }
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

/** `kin_picture`: draws the page, files it as a version of its doc and puts it on the reply. */
export const makePicture = leadTool("KinPictures.make", (lead: Lead, input: PictureInput) =>
  Effect.gen(function* () {
    yield* admitted(lead, TOOL, input);
    if (yield* isOrgPaused(lead.orgId))
      return yield* new KinChatError({ reason: "not_allowed", message: PAUSED });
    const wakeupId = KinWakeupId.make(lead.wakeupId);
    const lane = yield* laneFor({ orgId: lead.orgId, agentId: lead.agentId, wakeupId });
    if (Option.isNone(lane))
      return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
    const chatId = lane.value.chatId;
    const page = yield* visualPage({ title: input.title, html: input.html });
    const earlier = input.doc === undefined ? undefined : yield* earlierPicture(lead, input.doc);
    const files = yield* chatImages(lead.orgId, chatId, kinVisualFileReferences(page.html));

    const drawn = yield* (yield* KinPictureRenderer).render({
      html: page.html,
      size: input.size,
      files,
      brand: yield* companyBrand(lead.orgId),
      fonts: yield* (yield* KinToolchain).fonts(),
    });
    if (drawn._tag === "refused") return yield* invalid(drawn.reason);
    if (drawn._tag === "cannotDraw")
      return yield* new KinChatError({ reason: "unavailable", message: drawn.reason });

    // An identical call in the same turn is a retry: the same doc version and the same image.
    const key = sha256(stableStringify(input)).slice(0, 32);
    const png = drawn.png;
    const sensitive = yield* turnSensitive(lead.orgId, lead.wakeupId);
    const docFile = yield* (yield* KinDocRenderer).store(lead.orgId, `pic-${key}`, {
      sha256: sha256(png),
      extension: "png",
      bytes: png,
    });
    const stores = yield* Effect.serviceOption(KinAttachmentStore);
    if (Option.isNone(stores))
      return yield* new KinChatError({
        reason: "unavailable",
        message: "Attachments are unavailable.",
      });
    const store = stores.value;
    const chatImage = yield* store.storeImage(png);
    const name = fileName(page.title);
    const size = KIN_PICTURE_SIZES[input.size];
    const team = yield* viewOf(lead);
    const owned = yield* writerFor(lead);
    // Not the turn's view guard, which keeps new docs the owner's: who reads a picture is its own
    // rule (`teamView.pictureReader`), and one it revises was found in the view (`earlierPicture`).
    const { view: _view, ...writer }: Writer = team === undefined ? owned : viewWriter(owned, team);
    const sql = yield* SqlClient.SqlClient;
    const gate = yield* KinLevelGate;
    const made = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* admitted(lead, TOOL, input);
          const filed = yield* Docs.fileVersion(
            lead.orgId,
            writer,
            { audience: yield* effectiveAudience(lead) },
            {
              docOrigin: earlier?.originKey ?? `${PICTURE_DOC_ORIGIN}${lead.agentId}:${key}`,
              originKey: `kin-picture:${lead.wakeupId}:${key}`,
              title: page.title.slice(0, 200),
              summary: `Picture, ${size.width * KIN_PICTURE_SCALE}×${size.height * KIN_PICTURE_SCALE}`,
              owner: { _tag: "agent", agentId: lead.agentId },
              sensitive,
              file: {
                attachmentId: docFile,
                name,
                mimeType: "image/png",
                bytes: png.length,
                sha256: sha256(png),
                pages: null,
                recipe: null,
                inputsHash: key,
                workerId: KinWorkerId.make(`pic-${key}`),
                number: null,
                draft: false,
              },
            },
          );
          const placed = yield* gate.picture(
            { ...lead, wakeupId },
            {
              chatId,
              clientMessageId: `kin-picture:${wakeupId}:${key}`,
              intent: lane.value.mode === "reply" ? "answer" : "evidence",
              attachment: {
                type: "image",
                id: chatImage,
                name,
                mimeType: "image/png",
                sizeBytes: png.length,
              },
              doc: { key: filed.row.key, version: filed.version.version },
              seen: `${page.title}\n${page.html.replace(/<[^>]*>/g, " ")}`,
            },
          );
          return { filed, placed };
        }),
      )
      .pipe(Effect.onError(() => store.remove([chatImage])));
    if (made.placed.attachmentId !== chatImage) yield* store.remove([chatImage]);
    const doc = made.filed.row.key;
    const version = made.filed.version.version;
    return {
      files: [made.placed.attachmentId],
      doc,
      version,
      next:
        made.placed.placed === "reply"
          ? `The picture shows under your reply and is in Docs as ${doc}, version ${version}.`
          : `The picture is posted in the chat and is in Docs as ${doc}, version ${version}.`,
    };
  }),
);
