// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous content hash; Digest would add a service to every caller.
import * as NodeCrypto from "node:crypto";
import { KinChatError, type KinCompanyLogo, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import {
  createDeterministicAttachmentId,
  resolveAttachmentPathById,
} from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { svgProblem } from "./svgCheck.ts";

/**
 * Files the owner sent in a chat, taken for documents: the company logo, and references a recipe
 * writer may look at. Each is read only from the chat the turn answers in, typed by its bytes,
 * and capped; the logo is copied to a file the org owns, so clearing the chat keeps it.
 */

/** Where the logo is in a render's root, as a template reads it. */
export const logoPath = (extension: string) => `/brand/logo.${extension}`;
const LOGO_CAPS = { bytes: 10 * 1024 * 1024, side: 12_000 } as const;
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

type Sniffed = { readonly mimeType: KinCompanyLogo["mimeType"]; readonly extension: string };
const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>) =>
  prefix.every((byte, index) => bytes[index] === byte);
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** What the bytes are, of the logo types; a declared type is the sender's word, not this. */
export const sniffImage = (bytes: Uint8Array): Sniffed | undefined => {
  if (startsWith(bytes, PNG)) return { mimeType: "image/png", extension: "png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg", extension: "jpg" };
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  return /^(?:﻿)?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)
    ? { mimeType: "image/svg+xml", extension: "svg" }
    : undefined;
};

const u32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
const u16 = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;

/** A JPEG's size from its first frame header; `undefined` when it has none. */
const jpegSize = (bytes: Uint8Array) => {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = u16(bytes, at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: u16(bytes, at + 5), width: u16(bytes, at + 7) };
    if (length < 2) return undefined;
    at += 2 + length;
  }
  return undefined;
};

/** An SVG's own size in pixels, from its root's plain width and height; else none. */
const svgSize = (text: string) => {
  const root = /<svg\b([^>]*)>/i.exec(text)?.[1] ?? "";
  const length = (name: string) => {
    const value = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`).exec(root);
    const parsed = value === null ? Number.NaN : Number.parseFloat(value[1]!);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  };
  return { width: length("width"), height: length("height") };
};

/** The logo's type and size, or why it can't be one: a print-quality logo passes. */
const checkLogo = (
  bytes: Uint8Array,
):
  | { readonly sniffed: Sniffed; readonly width: number | null; readonly height: number | null }
  | { readonly error: string } => {
  if (bytes.length === 0) return { error: "the file is empty" };
  if (bytes.length > LOGO_CAPS.bytes)
    return { error: `it is over ${LOGO_CAPS.bytes / 1048576} MB; send a smaller export` };
  const sniffed = sniffImage(bytes);
  if (sniffed === undefined) return { error: "it isn't a PNG, JPEG or SVG" };
  const size =
    sniffed.mimeType === "image/png"
      ? bytes.length >= 24 && u32(bytes, 12) === 0x49484452
        ? { width: u32(bytes, 16), height: u32(bytes, 20) }
        : undefined
      : sniffed.mimeType === "image/jpeg"
        ? jpegSize(bytes)
        : undefined;
  if (sniffed.mimeType === "image/svg+xml") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const problem = svgProblem(text);
    if (problem !== undefined) return { error: `it is an SVG with ${problem}` };
    return { sniffed, ...svgSize(text) };
  }
  if (size === undefined || size.width === 0 || size.height === 0)
    return { error: "Kin couldn't read its size, so it may be damaged" };
  if (size.width > LOGO_CAPS.side || size.height > LOGO_CAPS.side)
    return {
      error: `it is ${size.width} × ${size.height} pixels; a logo is at most ${LOGO_CAPS.side} on a side`,
    };
  return { sniffed, ...size };
};

export type ChatFile = {
  readonly attachmentId: string;
  readonly mimeType: string | null;
  readonly name: string | null;
};

/** An attachment id as an agent gives it: its file name, with or without the extension, is fine. */
export const attachmentIdOf = (given: string) =>
  given
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,10}$/, "");

/** The named files as they are on live messages of `chatId`; any other id isn't there. */
export const chatFiles = Effect.fn("KinBrand.chatFiles")(function* (
  orgId: KinOrgId,
  chatId: string | undefined,
  ids: ReadonlyArray<string>,
) {
  if (chatId === undefined || ids.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const wanted = [...new Set(ids.map(attachmentIdOf))];
  return yield* sql<ChatFile>`SELECT a.attachment_id AS "attachmentId",
      (SELECT json_extract(j.value, '$.mimeType') FROM json_each(COALESCE(m.attachments_json, '[]')) j
        WHERE json_extract(j.value, '$.id') = a.attachment_id) AS "mimeType",
      (SELECT json_extract(j.value, '$.name') FROM json_each(COALESCE(m.attachments_json, '[]')) j
        WHERE json_extract(j.value, '$.id') = a.attachment_id) AS name
    FROM kin_message_attachments a
    JOIN kin_messages m ON m.org_id = a.org_id AND m.message_id = a.message_id
    WHERE a.org_id = ${orgId} AND a.chat_id = ${chatId} AND m.status <> 'deleted'
      AND a.attachment_id IN ${sql.in(wanted)}
    GROUP BY a.attachment_id ORDER BY a.attachment_id`;
});

/** A stored file's bytes, read only when it is no larger than `cap`. */
export const readStoredFile = Effect.fn("KinBrand.readStoredFile")(function* (
  attachmentId: string,
  cap: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig;
  const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
  if (path === null) return { error: "the file is no longer stored" } as const;
  const info = yield* fs.stat(path);
  if (info.type !== "File") return { error: "the file is no longer stored" } as const;
  if (Number(info.size) > cap)
    return { error: `it is over ${Math.floor(cap / 1048576)} MB` } as const;
  return { path, bytes: yield* fs.readFile(path) } as const;
});

const NOT_HERE =
  "is not a file in this chat. Use the id of an image the owner sent in the chat you are answering.";

/**
 * The owner's image in this chat, checked and copied to a file the org owns as its logo: the
 * same bytes again are the same file. Nothing is re-encoded.
 */
export const takeLogo = Effect.fn("KinBrand.takeLogo")(function* (
  orgId: KinOrgId,
  chatId: string | undefined,
  attachmentId: string,
) {
  const [file] = yield* chatFiles(orgId, chatId, [attachmentId]);
  if (file === undefined) return yield* invalid(`${attachmentId} ${NOT_HERE} Nothing changed.`);
  const read = yield* readStoredFile(file.attachmentId, LOGO_CAPS.bytes);
  if ("error" in read)
    return yield* invalid(`That logo can't be used: ${read.error}. Nothing changed.`);
  const checked = checkLogo(read.bytes);
  if ("error" in checked)
    return yield* invalid(`That logo can't be used: ${checked.error}. Nothing changed.`);
  const sha256 = NodeCrypto.createHash("sha256").update(read.bytes).digest("hex");
  const base = createDeterministicAttachmentId("kin-chat", `${orgId}:logo:${sha256}`);
  const fs = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig;
  if (base === null) return yield* invalid("Kin couldn't keep that logo. Nothing changed.");
  const ownId = `${base}-${checked.sniffed.extension}`;
  const target = `${attachmentsDir}/${ownId}.${checked.sniffed.extension}`;
  if (!(yield* fs.exists(target))) {
    const scratch = `${target}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fs.writeFile(scratch, read.bytes);
    yield* fs.rename(scratch, target);
  }
  const logo: KinCompanyLogo = {
    attachmentId: ownId,
    name: (file.name ?? `logo.${checked.sniffed.extension}`).slice(0, 255),
    mimeType: checked.sniffed.mimeType,
    bytes: read.bytes.length,
    width: checked.width,
    height: checked.height,
    sha256,
  };
  return { logo, shown: { attachmentId: file.attachmentId, mimeType: checked.sniffed.mimeType } };
});

/** Where the logo's file is, checked again against what the profile holds; `null` if gone or changed. */
export const logoFile = Effect.fn("KinBrand.logoFile")(function* (logo: KinCompanyLogo) {
  const read = yield* readStoredFile(logo.attachmentId, LOGO_CAPS.bytes).pipe(
    Effect.orElseSucceed(() => ({ error: "unreadable" }) as const),
  );
  if ("error" in read) return null;
  const sniffed = sniffImage(read.bytes);
  if (
    sniffed?.mimeType !== logo.mimeType ||
    NodeCrypto.createHash("sha256").update(read.bytes).digest("hex") !== logo.sha256
  )
    return null;
  return { bytes: read.bytes, extension: sniffed.extension };
});
