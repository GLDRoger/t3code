// @effect-diagnostics nodeBuiltinImport:off -- a bounded, in-memory inflate of a few small parts; Effect has no zlib.
import * as NodeZlib from "node:zlib";

import { SaxesParser } from "saxes";

/**
 * Whether an XLSX, DOCX or PPTX is only a document. Its ZIP directory is read here, under caps,
 * and only `[Content_Types].xml` and the `.rels` parts are inflated, in memory. Macros, embedded
 * objects and packages, ActiveX, templates and any outside link but a web or email hyperlink are
 * refused. Hyperlinks stay: they open only when the reader clicks one, and Office shows where to.
 */

export type OfficeKind = "xlsx" | "docx" | "pptx";

const OFFICE_CAPS = {
  entries: 2_000,
  entryBytes: 256 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  partBytes: 4 * 1024 * 1024,
  inflatedBytes: 16 * 1024 * 1024,
  commentBytes: 1024,
} as const;

const MAIN: Record<OfficeKind, { readonly part: string; readonly type: string }> = {
  xlsx: {
    part: "xl/workbook.xml",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  },
  docx: {
    part: "word/document.xml",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  },
  pptx: {
    part: "ppt/presentation.xml",
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  },
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;

type Entry = {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly packed: number;
  readonly size: number;
  readonly offset: number;
};

// @effect-diagnostics-next-line extendsNativeError:off - a local throw sentinel inside one pure check.
class Refusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

const decodeName = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("a part name that isn't UTF-8");
  }
};

/** The ZIP's directory, checked: one end record, no ZIP64, no gaps, no odd or repeated names. */
const directory = (bytes: Buffer) => {
  const floor = Math.max(0, bytes.length - 22 - OFFICE_CAPS.commentBytes);
  let end = -1;
  for (let at = bytes.length - 22; at >= floor; at -= 1)
    if (bytes.readUInt32LE(at) === EOCD) {
      end = at;
      break;
    }
  if (end === -1) return refuse("no ZIP directory at its end");
  if (end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)
    return refuse("data after its ZIP directory");
  if (end >= 20 && bytes.readUInt32LE(end - 20) === ZIP64_LOCATOR)
    return refuse("a ZIP64 directory");
  const disk = bytes.readUInt16LE(end + 4);
  const startDisk = bytes.readUInt16LE(end + 6);
  const here = bytes.readUInt16LE(end + 8);
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (disk !== 0 || startDisk !== 0 || here !== count) return refuse("a split ZIP");
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff)
    return refuse("a ZIP64 directory");
  if (count > OFFICE_CAPS.entries) return refuse(`more than ${OFFICE_CAPS.entries} parts`);
  if (start + size !== end) return refuse("data between its parts and its ZIP directory");
  const entries: Array<Entry> = [];
  const names = new Set<string>();
  let total = 0;
  let at = start;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== CENTRAL)
      return refuse("a broken ZIP directory");
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const packed = bytes.readUInt32LE(at + 20);
    const entrySize = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const offset = bytes.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end) return refuse("a broken ZIP directory");
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) return refuse("an encrypted part");
    if (method !== 0 && method !== 8) return refuse("a part packed in a way Kin doesn't read");
    if (packed === 0xffffffff || entrySize === 0xffffffff || offset === 0xffffffff)
      return refuse("a ZIP64 part");
    const extra = bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    for (let field = 0; field + 4 <= extra.length; field += 4 + extra.readUInt16LE(field + 2))
      if (extra.readUInt16LE(field) === 0x0001) return refuse("a ZIP64 part");
    const name = decodeName(bytes.subarray(at + 46, at + 46 + nameLength));
    if (
      name.length === 0 ||
      name.startsWith("/") ||
      /[\\\0:]/.test(name) ||
      name.split("/").some((part) => part === ".." || part === ".")
    )
      return refuse(`a part named ${JSON.stringify(name.slice(0, 80))}`);
    const key = name.toLowerCase();
    if (names.has(key)) return refuse(`two parts named ${JSON.stringify(name.slice(0, 80))}`);
    names.add(key);
    if (entrySize > OFFICE_CAPS.entryBytes) return refuse("a part over the size cap");
    total += entrySize;
    if (total > OFFICE_CAPS.totalBytes) return refuse("parts over the size cap together");
    entries.push({ name, method, crc, packed, size: entrySize, offset });
    at = next;
  }
  if (at !== end) return refuse("a broken ZIP directory");
  // Parts sit back to back from the first byte to the directory: nothing hides between them.
  let previous = 0;
  for (const entry of entries.toSorted((left, right) => left.offset - right.offset)) {
    const head = entry.offset;
    if (head !== previous || head + 30 > start || bytes.readUInt32LE(head) !== LOCAL)
      return refuse("data between its parts");
    const flags = bytes.readUInt16LE(head + 6);
    if ((flags & 0x0001) !== 0) return refuse("an encrypted part");
    const nameLength = bytes.readUInt16LE(head + 26);
    const extraLength = bytes.readUInt16LE(head + 28);
    const local = decodeName(bytes.subarray(head + 30, head + 30 + nameLength));
    const data = head + 30 + nameLength + extraLength;
    if (local !== entry.name || data + entry.packed > start) return refuse("a broken ZIP part");
    previous = data + entry.packed;
    // A data descriptor after the bytes, with or without its optional signature.
    if ((flags & 0x0008) !== 0)
      previous += previous + 4 <= start && bytes.readUInt32LE(previous) === 0x08074b50 ? 16 : 12;
  }
  if (previous !== start) return refuse("data between its parts and its ZIP directory");
  return { entries, start };
};

/** One small part's bytes, inflated in memory under the part cap and checked against its CRC. */
const inflate = (bytes: Buffer, entry: Entry, budget: number) => {
  if (entry.size > Math.min(OFFICE_CAPS.partBytes, budget))
    return refuse(`${entry.name} is over the size Kin reads`);
  const head = entry.offset;
  const data = head + 30 + bytes.readUInt16LE(head + 26) + bytes.readUInt16LE(head + 28);
  const packed = bytes.subarray(data, data + entry.packed);
  let out: Buffer;
  try {
    out =
      entry.method === 0
        ? Buffer.from(packed)
        : NodeZlib.inflateRawSync(packed, { maxOutputLength: entry.size + 1 });
  } catch {
    return refuse(`${entry.name} doesn't unpack`);
  }
  if (out.length !== entry.size || NodeZlib.crc32(out) !== entry.crc)
    return refuse(`${entry.name} doesn't match its ZIP directory`);
  return out.toString("utf8");
};

/** Each element's attributes, by local name, from a small XML part. */
const elements = (xml: string, part: string) => {
  const found: Array<{ readonly name: string; readonly attributes: Record<string, string> }> = [];
  const parser = new SaxesParser({ position: false });
  let failed = false;
  parser.on("doctype", () => {
    failed = true;
  });
  parser.on("error", () => {
    failed = true;
  });
  parser.on("opentag", (tag) => {
    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(tag.attributes))
      attributes[key.split(":").at(-1)!] = String(value);
    found.push({ name: tag.name.split(":").at(-1)!, attributes });
  });
  try {
    parser.write(xml).close();
  } catch {
    failed = true;
  }
  if (failed) return refuse(`${part} isn't well-formed XML`);
  return found;
};

// Content that runs or that Office loads as another document.
const ACTIVE_TYPE =
  /macroEnabled|vbaProject|vbaData|activeX|oleObject|\.template\.|\.addin\.|\.package\b|sheet\.binary|x-msdownload|ms-office\.legacy|ms-excel\.intl/i;
const ACTIVE_PART =
  /(?:^|\/)(?:vbaProject[^/]*\.bin|vbaData\.xml|activeX\/|embeddings\/|oleObject)/i;
const ACTIVE_RELATIONSHIP =
  /\/(?:attachedTemplate|oleObject|package|control|activeXControlBinary|vbaProject|wordVbaData|aFChunk|subDocument|externalLink|externalLinkPath|frame|oleObjectBinary|externalData)$/i;
const HYPERLINK = /\/hyperlink$/i;
const WEB_OR_MAIL = /^(?:https?:\/\/|mailto:)[^\s\\]+$/i;

/** Why these bytes aren't a plain `kind` document, or `undefined` when they are. */
export const officeProblem = (kind: OfficeKind, input: Uint8Array): string | undefined => {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  try {
    const { entries } = directory(bytes);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const main = MAIN[kind];
    if (!byName.has(main.part)) return refuse(`no ${main.part}`);
    const active = entries.find((entry) => ACTIVE_PART.test(entry.name));
    if (active !== undefined) return refuse(`carries ${active.name}, which runs or embeds content`);
    const types = byName.get("[Content_Types].xml");
    if (types === undefined) return refuse("no [Content_Types].xml");
    let budget: number = OFFICE_CAPS.inflatedBytes;
    const read = (entry: Entry) => {
      const text = inflate(bytes, entry, budget);
      budget -= entry.size;
      return text;
    };
    let mainType: string | undefined;
    for (const element of elements(read(types), types.name)) {
      const type = element.attributes.ContentType ?? "";
      if (ACTIVE_TYPE.test(type)) return refuse(`declares ${type}, which runs or embeds content`);
      if (element.name === "Override" && element.attributes.PartName === `/${main.part}`)
        mainType = type;
    }
    if (mainType !== main.type)
      return refuse(`its ${main.part} isn't a plain ${kind.toUpperCase()}`);
    for (const entry of entries) {
      if (!entry.name.toLowerCase().endsWith(".rels")) continue;
      for (const element of elements(read(entry), entry.name)) {
        if (element.name !== "Relationship") continue;
        const type = element.attributes.Type ?? "";
        const target = (element.attributes.Target ?? "").trim();
        const kindName = type.split("/").at(-1) ?? type;
        if (ACTIVE_RELATIONSHIP.test(type)) return refuse(`has a ${kindName} relationship`);
        if ((element.attributes.TargetMode ?? "").toLowerCase() === "external") {
          if (!HYPERLINK.test(type)) return refuse(`links a ${kindName} from outside the file`);
          if (!WEB_OR_MAIL.test(target))
            return refuse("has a hyperlink that isn't a web or email address");
        }
      }
    }
    return undefined;
  } catch (error) {
    if (error instanceof Refusal) return error.reason;
    return "its ZIP couldn't be read";
  }
};
