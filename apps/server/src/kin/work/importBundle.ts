import { KinChatError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { openZip } from "../gendocs/officeCheck.ts";
import { RETURN_CAPS } from "../gendocs/returnPath.ts";

/**
 * Where an import's `import.json` and its `files/` are read from: a ZIP of them, uploaded or on
 * the host, or a folder on the host for histories too large to pack. Files are read one at a
 * time when the import reaches them, so a folder of a few GB never sits in memory.
 */

/** A real small company's history as JSON: tens of thousands of rows are a few tens of MB. */
const JSON_BYTES = 256 * 1024 * 1024;
/** A ZIP is read in memory; past this, import from a folder. ZIP64 is refused by the reader. */
const ZIP_BYTES = 1024 * 1024 * 1024;
const ZIP_CAPS = {
  entries: 65_000,
  entryBytes: Math.max(JSON_BYTES, RETURN_CAPS.fileBytes),
  totalBytes: 4 * 1024 * 1024 * 1024,
  commentBytes: 1024,
};
const MANIFEST = "import.json";

export type Read =
  | { readonly bytes: Uint8Array }
  | { readonly missing: true }
  | { readonly refused: string };

export type Bundle = {
  readonly json: Uint8Array;
  /** A file under `files/` by its relative path. */
  readonly read: (path: string) => Effect.Effect<Read>;
};

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** `receipts/r-1.pdf`; nothing absolute, empty, `.` or `..`, and no backslashes. */
const safePath = (path: string) => {
  if (path.startsWith("/") || /[\\\0]/.test(path)) return undefined;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..")
    ? parts.join("/")
    : undefined;
};

/** A ZIP with `import.json` at its top, or inside its one top folder, and `files/` beside it. */
export const zipBundle = Effect.fn("KinImportBundle.zip")(function* (bytes: Uint8Array) {
  if (bytes.byteLength > ZIP_BYTES)
    return yield* invalid(
      `The import is over ${megabytes(ZIP_BYTES)}; import it from a folder on the host instead.`,
    );
  const zip = openZip(bytes, ZIP_CAPS);
  if ("refused" in zip) return yield* invalid(`Kin can't read that ZIP: it has ${zip.refused}.`);
  const manifests = zip.names.filter(
    (name) => !name.startsWith("__MACOSX/") && /^(?:[^/]+\/)?import\.json$/.test(name),
  );
  const manifest = manifests.includes(MANIFEST) ? MANIFEST : manifests[0];
  if (manifest === undefined || (manifest !== MANIFEST && manifests.length > 1))
    return yield* invalid("The ZIP needs one import.json, at its top or in its one folder.");
  const root = manifest.slice(0, -MANIFEST.length);
  const read = (name: string) =>
    Effect.tryPromise({ try: () => zip.read(name), catch: () => undefined }).pipe(
      Effect.orElseSucceed(() => null),
    );
  const json = yield* read(manifest);
  if (json === null || json === undefined) return yield* invalid(`Kin can't unpack ${manifest}.`);
  return {
    json,
    read: Effect.fn("KinImportBundle.zipFile")(function* (path: string) {
      const safe = safePath(path);
      if (safe === undefined) return { refused: "its path leaves files/" } satisfies Read;
      const bytes = yield* read(`${root}files/${safe}`);
      if (bytes === undefined) return { missing: true } satisfies Read;
      if (bytes === null) return { refused: "it doesn't unpack from the ZIP" } satisfies Read;
      return { bytes } satisfies Read;
    }),
  } satisfies Bundle;
});

/** `import.json` and `files/` in a folder on this host. */
const folderBundle = Effect.fn("KinImportBundle.folder")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sized = (file: string, cap: number) =>
    fs.stat(file).pipe(
      Effect.flatMap((info) =>
        info.type !== "File"
          ? Effect.succeed<Read>({ refused: "it isn't a regular file" })
          : Number(info.size) > cap
            ? Effect.succeed<Read>({ refused: `it's over the ${megabytes(cap)} cap` })
            : fs.readFile(file).pipe(Effect.map((bytes): Read => ({ bytes }))),
      ),
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.succeed<Read>(
            error.reason._tag === "NotFound" ? { missing: true } : { refused: "it can't be read" },
          ),
      }),
    );
  const manifest = yield* sized(path.join(folder, MANIFEST), JSON_BYTES);
  if (!("bytes" in manifest))
    return yield* invalid(
      "missing" in manifest
        ? `There is no ${MANIFEST} in that folder.`
        : `${MANIFEST} can't be imported: ${manifest.refused}.`,
    );
  return {
    json: manifest.bytes,
    read: (relative) => {
      const safe = safePath(relative);
      return safe === undefined
        ? Effect.succeed<Read>({ refused: "its path leaves files/" })
        : sized(path.join(folder, "files", ...safe.split("/")), RETURN_CAPS.fileBytes);
    },
  } satisfies Bundle;
});

/** A folder or a `.zip` on this host, as the operator's `kin import` names it. */
export const hostBundle = Effect.fn("KinImportBundle.host")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs
    .stat(target)
    .pipe(Effect.mapError(() => invalid(`Kin can't read ${target.slice(0, 200)}.`)));
  if (info.type === "Directory") return yield* folderBundle(target);
  if (Number(info.size) > ZIP_BYTES)
    return yield* invalid(
      `That ZIP is over ${megabytes(ZIP_BYTES)}; unpack it and import the folder instead.`,
    );
  const bytes = yield* fs
    .readFile(target)
    .pipe(Effect.mapError(() => invalid(`Kin can't read ${target.slice(0, 200)}.`)));
  return yield* zipBundle(bytes);
});
