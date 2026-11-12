// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure, synchronous content hashes (git's blob id among them); Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { readProfile } from "../work/companyProfile.ts";
import { attachmentIdOf, chatFiles, readStoredFile, sniffImage } from "./brand.ts";
import { svgProblem } from "./svgCheck.ts";

/**
 * Files the owner sent that a recipe writer may look at, such as an invoice in the format the
 * company already uses. Kin copies them read-only into the job's `in/references/`; they are the
 * owner's documents, so a recipe written with them is labelled, and none is ever committed by
 * Kin: a recipe holding one is refused unless it is an image its template shows.
 */

export const REFERENCE_CAPS = {
  files: 5,
  bytes: 20 * 1024 * 1024,
  /** An image the template shows may be a reference's own bytes, up to this. */
  shownImageBytes: 2 * 1024 * 1024,
} as const;

export const Reference = Schema.Struct({
  attachmentId: Schema.String,
  /** Its name under `in/references/`: plain, unique, with its type's extension. */
  name: Schema.String,
  mimeType: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
  /** Git's blob id for the same bytes, to find a copy in a recipe's tree. */
  blob: Schema.String,
});
export type Reference = typeof Reference.Type;
export const ReferencesJson = Schema.fromJsonString(Schema.Array(Reference));

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const NOTHING = "Nothing started.";

const sniffReference = (bytes: Uint8Array) => {
  if (bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-")
    return { mimeType: "application/pdf", extension: "pdf" } as const;
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  )
    return { mimeType: "image/webp", extension: "webp" } as const;
  return sniffImage(bytes);
};

/** A plain name for the file, kept unique among the others. */
const plainName = (given: string | null, index: number, extension: string, taken: Set<string>) => {
  const stem =
    (given ?? "")
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9 ._-]+/g, "")
      .replace(/^[ ._-]+/, "")
      .trim()
      .slice(0, 60) || `reference-${index + 1}`;
  let name = `${stem}.${extension}`;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${stem}-${n}.${extension}`;
  taken.add(name.toLowerCase());
  return name;
};

const gitBlobId = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/**
 * The references a recipe job may look at: each a file on a live message in the chat the turn
 * answers in, a PDF or an image by its bytes, within the caps. Anything else refuses the job.
 */
export const checkReferences = Effect.fn("KinDocReferences.check")(function* (
  orgId: KinOrgId,
  chatId: string | undefined,
  ids: ReadonlyArray<string>,
) {
  if (ids.length === 0) return [];
  if (ids.length > REFERENCE_CAPS.files)
    return yield* invalid(`Give at most ${REFERENCE_CAPS.files} references. ${NOTHING}`);
  const found = yield* chatFiles(orgId, chatId, ids);
  const taken = new Set<string>();
  const references: Array<Reference> = [];
  for (const [index, id] of ids.entries()) {
    const file = found.find((one) => one.attachmentId === attachmentIdOf(id));
    if (file === undefined)
      return yield* invalid(
        `${id} is not a file in this chat. Use the id of a file the owner sent in the chat you are answering. ${NOTHING}`,
      );
    if (references.some((one) => one.attachmentId === file.attachmentId)) continue;
    const read = yield* readStoredFile(file.attachmentId, REFERENCE_CAPS.bytes);
    if ("error" in read)
      return yield* invalid(`${file.name ?? id} can't be used: ${read.error}. ${NOTHING}`);
    const kind = sniffReference(read.bytes);
    if (kind === undefined)
      return yield* invalid(
        `${file.name ?? id} isn't a PDF, PNG, JPEG, WebP or SVG, so a recipe writer can't look at it. ${NOTHING}`,
      );
    if (kind.mimeType === "image/svg+xml") {
      const problem = svgProblem(new TextDecoder().decode(read.bytes));
      if (problem !== undefined)
        return yield* invalid(`${file.name ?? id} is an SVG with ${problem}. ${NOTHING}`);
    }
    references.push({
      attachmentId: file.attachmentId,
      name: plainName(file.name, index, kind.extension, taken),
      mimeType: kind.mimeType,
      bytes: read.bytes.length,
      sha256: NodeCrypto.createHash("sha256").update(read.bytes).digest("hex"),
      blob: gitBlobId(read.bytes),
    });
  }
  return references;
});

/** Writes each reference, as checked, read-only under the worktree's `in/references/`. */
export const copyReferences = Effect.fn("KinDocReferences.copy")(function* (
  worktree: string,
  references: ReadonlyArray<Reference>,
) {
  if (references.length === 0) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(worktree, "in", "references");
  yield* fs.makeDirectory(folder, { recursive: true });
  for (const reference of references) {
    const read = yield* readStoredFile(reference.attachmentId, REFERENCE_CAPS.bytes);
    if ("error" in read) return yield* invalid(`A reference is gone: ${read.error}. ${NOTHING}`);
    if (NodeCrypto.createHash("sha256").update(read.bytes).digest("hex") !== reference.sha256)
      return yield* invalid(`A reference changed since it was checked. ${NOTHING}`);
    const target = path.join(folder, reference.name);
    yield* fs.writeFile(target, read.bytes, { flag: "wx", mode: 0o444 });
  }
});

/**
 * Why a recipe's files can't be kept because one is a reference: only an image the template
 * names, small enough to be a logo or a signature, may be one.
 */
export const referenceCopy = (
  files: ReadonlyArray<{ readonly path: string; readonly blob: string; readonly size: number }>,
  references: ReadonlyArray<Reference>,
  template: string | undefined,
) => {
  for (const file of files) {
    const reference = references.find((one) => one.blob === file.blob);
    if (reference === undefined) continue;
    const name = file.path.split("/").at(-1) ?? file.path;
    const shownImage =
      reference.mimeType.startsWith("image/") &&
      file.size <= REFERENCE_CAPS.shownImageBytes &&
      template !== undefined &&
      template.includes(name);
    if (!shownImage)
      return `${file.path} is a copy of the owner's reference ${reference.name}. A recipe copies a reference's look, never the file: remove it (only an image the template shows, up to 2 MB, such as a signature, may stay)`;
  }
  return undefined;
};

/** Every text in a sample, however deep, to look for real details in. */
const textsOf = (value: unknown, into: Array<string> = []): Array<string> => {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const one of value) textsOf(one, into);
  else if (typeof value === "object" && value !== null)
    for (const one of Object.values(value)) textsOf(one, into);
  return into;
};
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const folded = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The company's or a client's real details in a sample, which must be invented: its tax ids, bank
 * details, names and clients' names and tax ids as Kin stores them. `undefined` when none is there.
 */
export const sampleLeak = Effect.fn("KinDocReferences.sampleLeak")(function* (
  orgId: KinOrgId,
  sample: string | undefined,
) {
  const parsed = sample === undefined ? undefined : decodeJson(sample);
  if (parsed === undefined || parsed._tag === "None") return undefined;
  const texts = textsOf(parsed.value).map(folded).join("\n");
  if (texts === "") return undefined;
  const sql = yield* SqlClient.SqlClient;
  const profile = yield* readProfile(orgId);
  const clients = yield* sql<{ title: string; gstin: string | null }>`SELECT title,
      json_extract(fields_json, '$.gstin') AS gstin
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'clients'
    ORDER BY record_id LIMIT 5000`;
  const real = [
    profile.legalName,
    profile.tradeName,
    profile.gstin,
    profile.pan,
    profile.bank.accountNumber,
    profile.bank.upi,
    ...clients.flatMap((client) => [client.title, client.gstin]),
  ]
    .filter((one): one is string => typeof one === "string")
    .map(folded)
    .filter((one) => one.length >= 5);
  const found = real.find((one) => texts.includes(one));
  return found === undefined
    ? undefined
    : "its sample.json holds the company's or a client's real details; a sample is invented: use made-up names, numbers and amounts";
});
