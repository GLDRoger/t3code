// @effect-diagnostics nodeBuiltinImport:off -- a file is opened with O_NOFOLLOW and read through that descriptor, which Effect's FileSystem can't express.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { officeProblem } from "./officeCheck.ts";
import { svgProblem } from "./svgCheck.ts";

/**
 * The one way a worker's file comes back: only names its report gave, read from `out/` itself,
 * each a regular file with one link, within the caps, whose leading bytes are its named type.
 * Nothing is executed or unpacked to disk: an Office file's directory and links are read in memory.
 */

/**
 * A 60-page deck with a full-screen image per slide is about 60-90 MB as PPTX or PDF; a month's
 * pack is a handful of sheets. Past these, a job is almost surely wrong, and a phone pays for it.
 */
export const RETURN_CAPS = {
  files: 20,
  fileBytes: 100 * 1024 * 1024,
  totalBytes: 200 * 1024 * 1024,
} as const;

export type ReturnCaps = {
  readonly files: number;
  readonly fileBytes: number;
  readonly totalBytes: number;
};

const OUT_DIR = "out";

const MIME_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
} as const;
type Extension = keyof typeof MIME_TYPES;
const isExtension = (value: string): value is Extension => Object.hasOwn(MIME_TYPES, value);

export type Taken = {
  readonly name: string;
  readonly extension: Extension;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** A PDF's page count, when its page objects can be counted without parsing it. */
  readonly pages: number | null;
};
export type Refused = { readonly name: string; readonly reason: string };
export type Returned = {
  readonly taken: ReadonlyArray<Taken>;
  readonly refused: ReadonlyArray<Refused>;
};

const plainName = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$/;
// A page reaches chat only as the agent's own kin_visual, under that turn's rules.
const HTML_REFUSAL =
  "a worker's HTML page doesn't come back as a file: make a PDF or a PNG of it, or the agent sends a page itself with kin_visual";
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** `out/<name>` or a bare `<name>`; anything with another directory, `..` or a leading `/` is not. */
const outputName = (ref: string): string | undefined => {
  const trimmed = ref.trim();
  const name = trimmed.startsWith(`${OUT_DIR}/`) ? trimmed.slice(OUT_DIR.length + 1) : trimmed;
  if (!plainName.test(name) || name.includes("..")) return undefined;
  return name;
};

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0) =>
  bytes.length >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

const utf8 = (bytes: Uint8Array): string | undefined => {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** Why these bytes are not the type `extension` says, or `undefined` when they are. */
export const typeMismatch = (extension: Extension, bytes: Uint8Array): string | undefined => {
  const wrong = `its bytes aren't a ${extension.toUpperCase()} file`;
  switch (extension) {
    case "pdf":
      return startsWith(bytes, ascii("%PDF-")) ? undefined : wrong;
    case "png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ? undefined
        : wrong;
    case "jpg":
    case "jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]) ? undefined : wrong;
    case "webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)
        ? undefined
        : wrong;
    case "xlsx":
    case "docx":
    case "pptx": {
      if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return wrong;
      const problem = officeProblem(extension, bytes);
      return problem === undefined
        ? undefined
        : `it's a ${extension.toUpperCase()} that ${problem}. Kin takes back Office files with no macros, embedded objects or outside links, plain web and email hyperlinks aside: make it again without them, or return a PDF`;
    }
    case "svg": {
      const text = utf8(bytes);
      if (text === undefined || !/<svg[\s>/]/.test(text)) return wrong;
      const problem = svgProblem(text);
      return problem === undefined
        ? undefined
        : `it's an SVG with ${problem}: Kin takes back only plain drawings. Return it as a PNG or a PDF, or show it in chat with kin_visual`;
    }
    case "json": {
      const text = utf8(bytes);
      if (text === undefined) return wrong;
      try {
        JSON.parse(text);
        return undefined;
      } catch {
        return wrong;
      }
    }
    case "csv": {
      const text = utf8(bytes);
      return text === undefined ? "it isn't plain UTF-8 text" : csvProblem(text);
    }
    case "md":
    case "txt":
      return utf8(bytes) === undefined ? "it isn't plain UTF-8 text" : undefined;
  }
};

const PLAIN_NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
const FORMULA_START: Record<string, string> = {
  "=": '"="',
  "+": '"+"',
  "-": '"-"',
  "@": '"@"',
  "\t": "a tab",
  "\r": "a carriage return",
};

/** The first cell a spreadsheet would run as a formula, by row and column, or `undefined`. */
const csvProblem = (text: string): string | undefined => {
  let row = 1;
  let column = 1;
  let at = 0;
  while (at <= text.length) {
    let cell = "";
    if (text[at] === '"') {
      at += 1;
      while (at < text.length) {
        if (text[at] === '"') {
          if (text[at + 1] !== '"') break;
          at += 1;
        }
        cell += text[at];
        at += 1;
      }
      at += 1;
    }
    while (
      at < text.length &&
      text[at] !== "," &&
      text[at] !== "\n" &&
      !text.startsWith("\r\n", at)
    ) {
      cell += text[at];
      at += 1;
    }
    const start = cell.replace(/^ +/, "")[0];
    if (
      start !== undefined &&
      FORMULA_START[start] !== undefined &&
      !PLAIN_NUMBER.test(cell.trim())
    )
      return `row ${row}, column ${column} starts with ${FORMULA_START[start]}: a spreadsheet would run it as a formula. Write that cell with a leading ' (as the starter recipes do) or as a plain number`;
    if (text[at] === ",") {
      column += 1;
      at += 1;
    } else {
      row += 1;
      column = 1;
      at += text[at] === "\r" ? 2 : 1;
    }
  }
  return undefined;
};

const pdfPages = (bytes: Uint8Array) => {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const count = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  return count > 0 ? count : null;
};

const errorCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";

type Read = { readonly bytes: Uint8Array } | { readonly refused: string };

/** One named file, through a descriptor opened without following a link. */
const readOne = (path: string, budget: number): Promise<Read> =>
  NodeFS.promises
    .open(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    )
    .then(
      async (handle) => {
        try {
          const info = await handle.stat();
          if (!info.isFile()) return { refused: "it isn't a regular file" };
          if (info.nlink !== 1) return { refused: "it has another link to it (a hard link)" };
          if (info.size > budget) return { refused: `it's over the ${megabytes(budget)} cap` };
          const bytes = new Uint8Array(info.size);
          let offset = 0;
          while (offset < info.size) {
            const { bytesRead } = await handle.read(bytes, offset, info.size - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
          }
          if (offset !== info.size) return { refused: "it changed while Kin read it" };
          return { bytes };
        } finally {
          await handle.close();
        }
      },
      (cause: unknown): Read => {
        const code = errorCode(cause);
        return {
          refused:
            code === "ENOENT"
              ? "it was named but isn't there"
              : code === "ELOOP" || code === "EMLINK"
                ? "it's a link"
                : "Kin couldn't read it",
        };
      },
    );

/** Real path of the worktree's own `out/`, or why there is none to read from. */
const outDirectory = (worktree: string): Promise<string | { readonly refused: string }> =>
  (async () => {
    const root = await NodeFS.promises.realpath(worktree);
    const out = NodePath.join(root, OUT_DIR);
    const info = await NodeFS.promises.lstat(out).catch(() => undefined);
    if (info === undefined) return { refused: "the worktree has no out/ folder" };
    if (info.isSymbolicLink() || !info.isDirectory())
      return { refused: "out/ isn't a plain folder" };
    return (await NodeFS.promises.realpath(out)) === out
      ? out
      : { refused: "out/ isn't a plain folder" };
  })().catch(() => ({ refused: "Kin couldn't read the worktree" }));

/**
 * Takes the files the report named, and nothing else. Returns each one taken with its bytes and
 * hash, and each one refused with a reason in plain words for the agent and the owner.
 */
export const takeOutputs = Effect.fn("KinGenDocs.takeOutputs")(function* (input: {
  readonly worktree: string;
  readonly named: ReadonlyArray<string>;
  readonly caps?: ReturnCaps;
}) {
  const caps = input.caps ?? RETURN_CAPS;
  const refused: Array<Refused> = [];
  const taken: Array<Taken> = [];
  const seen = new Set<string>();
  const wanted: Array<{
    readonly ref: string;
    readonly name: string;
    readonly extension: Extension;
  }> = [];
  for (const ref of input.named) {
    const shown = ref.trim().slice(0, 120);
    const name = outputName(ref);
    if (name === undefined) {
      refused.push({ name: shown, reason: "it isn't a plain file name in out/" });
      continue;
    }
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const extension = NodePath.extname(name).slice(1).toLowerCase();
    if (extension === "html" || extension === "htm") {
      refused.push({ name, reason: HTML_REFUSAL });
      continue;
    }
    if (!isExtension(extension)) {
      refused.push({ name, reason: `.${extension || "(none)"} isn't a file type Kin takes back` });
      continue;
    }
    if (wanted.length >= caps.files) {
      refused.push({ name, reason: `a job returns at most ${caps.files} files` });
      continue;
    }
    wanted.push({ ref, name, extension });
  }
  if (wanted.length === 0) return { taken, refused } satisfies Returned;
  const out = yield* Effect.promise(() => outDirectory(input.worktree));
  if (typeof out !== "string") {
    for (const one of wanted) refused.push({ name: one.name, reason: out.refused });
    return { taken, refused } satisfies Returned;
  }
  let total = 0;
  for (const one of wanted) {
    const budget = Math.min(caps.fileBytes, caps.totalBytes - total);
    const read = yield* Effect.promise(() => readOne(NodePath.join(out, one.name), budget));
    if ("refused" in read) {
      refused.push({
        name: one.name,
        reason:
          budget < caps.fileBytes && read.refused.startsWith("it's over")
            ? `the job's files together are over the ${megabytes(caps.totalBytes)} cap`
            : read.refused,
      });
      continue;
    }
    const mismatch = typeMismatch(one.extension, read.bytes);
    if (mismatch !== undefined) {
      refused.push({ name: one.name, reason: mismatch });
      continue;
    }
    total += read.bytes.byteLength;
    taken.push({
      name: one.name,
      extension: one.extension,
      mimeType: MIME_TYPES[one.extension],
      bytes: read.bytes,
      sha256: NodeCrypto.createHash("sha256").update(read.bytes).digest("hex"),
      pages: one.extension === "pdf" ? pdfPages(read.bytes) : null,
    });
  }
  return { taken, refused } satisfies Returned;
});
