// @effect-diagnostics nodeBuiltinImport:off -- a bounded, streaming inflate of each part; Effect has no zlib.
import * as NodeZlib from "node:zlib";

import { SaxesParser, type SaxesTagNS } from "saxes";

import { svgProblem } from "./svgCheck.ts";

// Whether an XLSX, DOCX or PPTX is only a document: its ZIP read under caps, each XML part inflated
// a chunk at a time into an event parser. Macros, embedded objects, ActiveX, templates, data
// connections, fields and formulas that fetch or run, and outside links but web or email
// hyperlinks are refused. Hyperlinks stay: they open only when the reader clicks one.

export type OfficeKind = "xlsx" | "docx" | "pptx";

export const OFFICE_CAPS = {
  entries: 2_000,
  entryBytes: 256 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  /** XML Kin parses: per part, and across the file. A part streams, so neither is held whole. */
  partBytes: 256 * 1024 * 1024,
  inflatedBytes: 512 * 1024 * 1024,
  /** An SVG image inside is checked as one text, so it stays small. */
  svgBytes: 16 * 1024 * 1024,
  /** Past this, a part unpacks to far more than real XML does: a ZIP bomb, not a sheet. */
  ratio: 500,
  commentBytes: 1024,
};
export type OfficeCaps = typeof OFFICE_CAPS;
const CHUNK = 64 * 1024;
/** One tag with its attributes, one formula or one field instruction: no real document's is near. */
const HELD_CHARS = 1024 * 1024;
/** One run of text, CDATA or comment the parser holds before it hands it on. */
const NODE_CHARS = 16 * 1024 * 1024;

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

const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XMLNS = "http://www.w3.org/2000/xmlns/";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const UNICODE_PATH_EXTRA = 0x7075;
// Encrypted, data descriptor, strong encryption, UTF-8 name: what changes how a part is read.
const READ_FLAGS = 0x0001 | 0x0008 | 0x0040 | 0x0800;

type Entry = {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly packed: number;
  readonly size: number;
  readonly offset: number;
};

// @effect-diagnostics-next-line extendsNativeError:off - a local throw sentinel inside one pure check.
class Refusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

const quoted = (name: string) => JSON.stringify(name.slice(0, 80));

const decodeName = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("a part name that isn't UTF-8");
  }
};

/** A header's extra fields by id, each once, filling the extra area exactly. */
const extraFields = (extra: Buffer) => {
  const fields = new Map<number, Buffer>();
  for (let at = 0; at < extra.length;) {
    if (at + 4 > extra.length) return refuse("has a broken ZIP extra field");
    const id = extra.readUInt16LE(at);
    const end = at + 4 + extra.readUInt16LE(at + 2);
    if (end > extra.length || fields.has(id)) return refuse("has a broken ZIP extra field");
    fields.set(id, extra.subarray(at + 4, end));
    at = end;
  }
  if (fields.has(ZIP64_EXTRA)) return refuse("a ZIP64 part");
  return fields;
};

/** A header's part name, refused when its raw bytes, flags and Unicode-path field disagree. */
const headerName = (raw: Buffer, flags: number, extra: Buffer) => {
  if ((flags & 0x0800) === 0 && raw.some((byte) => byte >= 0x80))
    return refuse(`has a part name that isn't marked as UTF-8`);
  const name = decodeName(raw);
  const unicode = extraFields(extra).get(UNICODE_PATH_EXTRA);
  if (unicode !== undefined && (unicode.length < 5 || decodeName(unicode.subarray(5)) !== name))
    return refuse(`has a part with two different names, one of them ${quoted(name)}`);
  return name;
};

type ZipCaps = Pick<OfficeCaps, "entries" | "entryBytes" | "totalBytes" | "commentBytes">;

/** The ZIP's directory, checked: one end record, no ZIP64, no gaps, no odd or repeated names. */
const directory = (bytes: Buffer, caps: ZipCaps = OFFICE_CAPS) => {
  const floor = Math.max(0, bytes.length - 22 - caps.commentBytes);
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
  if (count > caps.entries) return refuse(`more than ${caps.entries} parts`);
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
    const name = headerName(
      bytes.subarray(at + 46, at + 46 + nameLength),
      flags,
      bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
    );
    // Office and Windows read a name the same after case, Unicode form and trailing dots or spaces.
    if (
      name.length === 0 ||
      name.startsWith("/") ||
      /[\\\0:]/.test(name) ||
      name.split("/").some((part) => /[. ]$/.test(part))
    )
      return refuse(`a part named ${quoted(name)}`);
    const key = name.toLowerCase().normalize("NFC");
    if (names.has(key)) return refuse(`two parts named ${quoted(name)}`);
    names.add(key);
    if (entrySize > caps.entryBytes) return refuse("a part over the size cap");
    total += entrySize;
    if (total > caps.totalBytes) return refuse("parts over the size cap together");
    entries.push({ name, flags, method, crc, packed, size: entrySize, offset });
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
    const data = head + 30 + nameLength + extraLength;
    if (data > start) return refuse("a broken ZIP part");
    const local = headerName(
      bytes.subarray(head + 30, head + 30 + nameLength),
      flags,
      bytes.subarray(head + 30 + nameLength, data),
    );
    if (local !== entry.name || data + entry.packed > start) return refuse("a broken ZIP part");
    const disagree = `has a part, ${quoted(entry.name)}, whose two ZIP headers disagree`;
    if (((flags ^ entry.flags) & READ_FLAGS) !== 0 || bytes.readUInt16LE(head + 8) !== entry.method)
      return refuse(disagree);
    const described = (flags & 0x0008) !== 0;
    for (const [at, expected] of [
      [head + 14, entry.crc],
      [head + 18, entry.packed],
      [head + 22, entry.size],
    ] as const) {
      const value = bytes.readUInt32LE(at);
      if (value !== expected && !(described && value === 0)) return refuse(disagree);
    }
    previous = data + entry.packed;
    if (described) {
      // The descriptor after the bytes, with or without its optional signature.
      const signed = previous + 16 <= start && bytes.readUInt32LE(previous) === DESCRIPTOR;
      const fields = signed ? previous + 4 : previous;
      if (
        fields + 12 > start ||
        bytes.readUInt32LE(fields) !== entry.crc ||
        bytes.readUInt32LE(fields + 4) !== entry.packed ||
        bytes.readUInt32LE(fields + 8) !== entry.size
      )
        return refuse(`has a part, ${quoted(entry.name)}, whose sizes after its data disagree`);
      previous = fields + 12;
    }
  }
  if (previous !== start) return refuse("data between its parts and its ZIP directory");
  return entries;
};

/** One part's bytes, inflated a chunk at a time into `sink`, its size and CRC checked as they come. */
const streamBytes = (bytes: Buffer, entry: Entry, sink: (chunk: Buffer) => void) =>
  new Promise<void>((resolve, reject) => {
    const head = entry.offset;
    const data = head + 30 + bytes.readUInt16LE(head + 26) + bytes.readUInt16LE(head + 28);
    const packed = bytes.subarray(data, data + entry.packed);
    const mismatch = `${entry.name} doesn't match its ZIP directory`;
    let size = 0;
    let crc = 0;
    let done = false;
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      inflater?.destroy();
      reject(error instanceof Refusal ? error : new Refusal(`${entry.name} doesn't unpack`));
    };
    const take = (chunk: Buffer) => {
      size += chunk.length;
      if (size > entry.size) refuse(mismatch);
      crc = NodeZlib.crc32(chunk, crc);
      sink(chunk);
    };
    const finish = () => {
      if (size !== entry.size || crc !== entry.crc) refuse(mismatch);
      done = true;
      resolve();
    };
    const inflater =
      entry.method === 0 ? undefined : NodeZlib.createInflateRaw({ chunkSize: CHUNK });
    try {
      if (inflater === undefined) {
        for (let at = 0; at < packed.length; at += CHUNK) take(packed.subarray(at, at + CHUNK));
        return finish();
      }
    } catch (error) {
      return fail(error);
    }
    inflater.on("data", (chunk: Buffer) => {
      if (done) return;
      try {
        take(chunk);
      } catch (error) {
        fail(error);
      }
    });
    inflater.on("error", fail);
    inflater.on("end", () => {
      if (done) return;
      try {
        finish();
      } catch (error) {
        fail(error);
      }
    });
    inflater.end(packed);
  });

const streamPart = async (bytes: Buffer, entry: Entry, sink: (text: string) => void) => {
  const decoder = new TextDecoder("utf-8");
  await streamBytes(bytes, entry, (chunk) => sink(decoder.decode(chunk, { stream: true })));
  sink(decoder.decode());
};

/**
 * A ZIP's files by name, its directory checked as an Office file's is but under `caps`. Each
 * `read` inflates one file, its size and CRC checked; `undefined` for a name it doesn't have.
 */
export const openZip = (
  input: Uint8Array,
  caps: ZipCaps,
):
  | {
      readonly names: ReadonlyArray<string>;
      readonly read: (name: string) => Promise<Uint8Array | undefined>;
    }
  | { readonly refused: string } => {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  try {
    const entries = directory(bytes, caps).filter((entry) => !entry.name.endsWith("/"));
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return {
      names: entries.map((entry) => entry.name),
      read: async (name) => {
        const entry = byName.get(name);
        if (entry === undefined) return undefined;
        const chunks: Array<Buffer> = [];
        await streamBytes(bytes, entry, (chunk) => chunks.push(chunk));
        return Buffer.concat(chunks);
      },
    };
  } catch (error) {
    return { refused: error instanceof Refusal ? error.reason : "its ZIP couldn't be read" };
  }
};

type Handlers = {
  readonly open: (tag: SaxesTagNS) => void;
  readonly text?: (text: string) => void;
  readonly close?: (tag: SaxesTagNS) => void;
};

/** Reads a part into a parser's handlers; the first refusal stops it there. */
type Source = (handlers: Handlers) => Promise<void>;

/**
 * Parses one part namespace-aware, as its text arrives; a handler's refusal stops it there. What
 * the parser holds between two of its events stays under a cap: a tag under `HELD_CHARS`, any
 * other node under `NODE_CHARS`, so a part's size never becomes one string's.
 */
const parser = (part: string, handlers: Handlers) => {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const broken = () => refuse(`${part} isn't well-formed XML`);
  let held = 0;
  let inTag = false;
  const handed = () => {
    held = 0;
  };
  parser.on("doctype", broken);
  parser.on("error", broken);
  parser.on("opentagstart", () => {
    handed();
    inTag = true;
  });
  parser.on("opentag", (tag) => {
    handed();
    inTag = false;
    handlers.open(tag);
  });
  const { text, close } = handlers;
  parser.on("text", (value) => {
    handed();
    text?.(value);
  });
  parser.on("cdata", (value) => {
    handed();
    text?.(value);
  });
  parser.on("closetag", (tag) => {
    handed();
    close?.(tag);
  });
  for (const event of ["comment", "processinginstruction", "xmldecl"] as const)
    parser.on(event, handed);
  const guarded = (step: () => void) => {
    try {
      step();
    } catch (error) {
      if (error instanceof Refusal) throw error;
      broken();
    }
  };
  return {
    write: (value: string) => {
      for (let at = 0; at < value.length; at += CHUNK) {
        const piece = value.slice(at, at + CHUNK);
        guarded(() => parser.write(piece));
        held += piece.length;
        if (held > (inTag ? HELD_CHARS : NODE_CHARS))
          refuse(`has a single value larger than any real document holds (in ${part})`);
      }
    },
    close: () => guarded(() => parser.close()),
  };
};

/** An attribute with no prefix: the only one Office reads in package parts. */
const plain = (tag: SaxesTagNS, name: string) => tag.attributes[name]?.value;

const BODY_ATTRIBUTES = new Set(["instr", "fldCharType", "action", "macro", "href", "src"]);

/** The attributes the body check reads, by local name in any namespace, so none shadows another. */
const bodyAttributes = (tag: SaxesTagNS, part: string) => {
  const values = new Map<string, string>();
  for (const { uri, local, value } of Object.values(tag.attributes)) {
    if (uri === XMLNS || !BODY_ATTRIBUTES.has(local)) continue;
    if (values.has(local)) refuse(`has two ${local} attributes on one element (in ${part})`);
    values.set(local, value);
  }
  return values;
};

/** Each part's content type, from `[Content_Types].xml`. */
const contentTypes = async (read: Source, part: string) => {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  await read({
    open: (tag) => {
      if (tag.uri !== CONTENT_TYPES)
        refuse(`has <${tag.name}>, which Kin doesn't read there (in ${part})`);
      const type = plain(tag, "ContentType") ?? "";
      if (ACTIVE_TYPE.test(type)) refuse(`declares ${type}, which runs, embeds or fetches content`);
      const [map, key] =
        tag.local === "Default"
          ? [defaults, (plain(tag, "Extension") ?? "").toLowerCase()]
          : tag.local === "Override"
            ? [overrides, (plain(tag, "PartName") ?? "").toLowerCase()]
            : [undefined, ""];
      if (map === undefined) return;
      if (map.has(key)) refuse(`gives ${key} two content types`);
      map.set(key, type);
    },
  });
  return (name: string) =>
    overrides.get(`/${name}`.toLowerCase()) ??
    defaults.get(name.split("/").at(-1)!.split(".").at(-1)!.toLowerCase());
};

// Content that runs, that Office loads as another document, or that fetches data.
const ACTIVE_TYPE =
  /macroEnabled|vbaProject|vbaData|activeX|oleObject|\.template\.|\.addin\.|\.package\b|sheet\.binary|x-msdownload|ms-office\.legacy|ms-excel\.intl|macrosheet|externalLink|\.connections\+|queryTable/i;
const ACTIVE_PART =
  /(?:^|\/)(?:vbaProject[^/]*\.bin|vbaData\.xml|activeX\/|embeddings\/|oleObject|macrosheets\/|externalLinks\/|connections\.xml|queryTables\/)/i;
const ACTIVE_RELATIONSHIP =
  /\/(?:attachedTemplate|oleObject|package|control|activeXControlBinary|vbaProject|wordVbaData|aFChunk|subDocument|externalLink|externalLinkPath|frame|oleObjectBinary|externalData|connections|queryTable|xlMacrosheet|xlIntlMacrosheet)$/i;
const HYPERLINK = /\/hyperlink$/i;
const WEB_OR_MAIL = /^(?:https?:\/\/|mailto:)[^\s\\]+$/i;
// A place in this workbook, such as #'Sheet 2'!A1: Excel opens nothing outside it.
const IN_WORKBOOK = /^#[^\\/:]+$/;

/** Why a hyperlink's target isn't a plain web or email address, or `undefined` when it is. */
const linkProblem = (target: string): string | undefined => {
  if (!WEB_OR_MAIL.test(target)) return "a hyperlink that isn't a web or email address";
  if (!/^https?:/i.test(target)) return undefined;
  try {
    const url = new URL(target);
    return url.username === "" && url.password === ""
      ? undefined
      : "a web link that carries a user name or password";
  } catch {
    return "a hyperlink that isn't a web or email address";
  }
};

const relationshipsProblem = (read: Source, part: string) =>
  read({
    open: (tag) => {
      if (tag.uri !== RELATIONSHIPS)
        refuse(`has <${tag.name}>, which Kin doesn't read there (in ${part})`);
      if (tag.local !== "Relationship") return;
      const type = plain(tag, "Type") ?? "";
      const kindName = type.split("/").at(-1) ?? type;
      if (ACTIVE_RELATIONSHIP.test(type)) refuse(`has a ${kindName} relationship`);
      const mode = (plain(tag, "TargetMode") ?? "Internal").trim().toLowerCase();
      const target = (plain(tag, "Target") ?? "").trim();
      if (mode === "internal") {
        if (/^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(target))
          refuse(`has a ${kindName} relationship inside the file that points outside it`);
        return;
      }
      if (mode !== "external") refuse(`has a ${kindName} relationship Kin can't read`);
      if (!HYPERLINK.test(type)) refuse(`links a ${kindName} from outside the file`);
      const problem = linkProblem(target);
      if (problem !== undefined) refuse(`has ${problem}`);
    },
  });

type FieldToken = {
  readonly text: string;
  readonly switch: boolean;
  /** Quoted with `\"` or `\\` escapes inside, which Word reads but a target never needs. */
  readonly escaped: boolean;
};
/**
 * A field instruction as Word splits it: quoted text, switches and bare words. `undefined` when
 * Kin can't split it with certainty, such as a quote left open or two tokens run together.
 */
const fieldTokens = (instruction: string): ReadonlyArray<FieldToken> | undefined => {
  const tokens: Array<FieldToken> = [];
  let at = 0;
  while (at < instruction.length) {
    if (/\s/.test(instruction[at]!)) {
      at += 1;
      continue;
    }
    if (instruction[at] === '"') {
      let text = "";
      let escaped = false;
      at += 1;
      for (;;) {
        const char = instruction[at];
        if (char === undefined) return undefined;
        if (char === '"') break;
        if (char === "\\" && (instruction[at + 1] === '"' || instruction[at + 1] === "\\")) {
          escaped = true;
          at += 1;
        }
        text += instruction[at];
        at += 1;
      }
      tokens.push({ text, switch: false, escaped });
      at += 1;
    } else {
      const word = /^[^\s"]+/.exec(instruction.slice(at))![0];
      const isSwitch = word.startsWith("\\");
      if (isSwitch ? !/^\\[A-Za-z*@#!]$/.test(word) : word.includes("\\")) return undefined;
      tokens.push({ text: word, switch: isSwitch, escaped: false });
      at += word.length;
    }
    if (at < instruction.length && !/\s/.test(instruction[at]!)) return undefined;
  }
  return tokens;
};
// HYPERLINK's switches: these take the next token, the others none.
const LINK_ARGUMENT_SWITCHES = new Set(["\\l", "\\o", "\\t", "\\*"]);
const LINK_FLAG_SWITCHES = new Set(["\\m", "\\n"]);

/**
 * Why a HYPERLINK field's address isn't one the link rule keeps, or `undefined` when it is, when it
 * is a link to a bookmark here only, or when the field is another field.
 */
const hyperlinkProblem = (instruction: string, nested: boolean): string | undefined => {
  if (!/^\s*"?HYPERLINK\b/i.test(instruction)) return undefined;
  const unreadable = "a hyperlink field whose address Kin can't read";
  if (nested) return "a hyperlink field whose address another field writes";
  const tokens = fieldTokens(instruction);
  if (tokens === undefined || tokens[0]?.text.toUpperCase() !== "HYPERLINK") return unreadable;
  let target: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const name = token.text.toLowerCase();
    if (token.switch && LINK_ARGUMENT_SWITCHES.has(name)) {
      index += 1;
      if (tokens[index] === undefined || tokens[index]!.switch) return unreadable;
    } else if (token.switch && !LINK_FLAG_SWITCHES.has(name)) return unreadable;
    else if (!token.switch) {
      if (target !== undefined || token.escaped) return unreadable;
      target = token.text.trim();
    }
  }
  if (target === undefined) return undefined;
  const problem = linkProblem(target);
  return problem === undefined ? undefined : `${problem} in a field`;
};

// Word fields that load another file or address, talk to another program, or run a command.
const FETCHING_FIELDS = new Set([
  "INCLUDEPICTURE",
  "INCLUDETEXT",
  "INCLUDE",
  "DDE",
  "DDEAUTO",
  "LINK",
  "IMPORT",
  "DATABASE",
  "MACROBUTTON",
]);
const fieldProblem = (instruction: string, anywhere = false, nested = false) => {
  if (!anywhere) {
    const link = hyperlinkProblem(instruction, nested);
    if (link !== undefined) return link;
  }
  const words = instruction
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  const name = (anywhere ? words : words.slice(0, 1)).find((word) => FETCHING_FIELDS.has(word));
  if (name === undefined) return undefined;
  return `${/^[AEIOU]/.test(name) ? "an" : "a"} ${name} field, which fetches or runs content`;
};

const FORMULAS = new Set([
  "f",
  "formula",
  "formula1",
  "formula2",
  "definedName",
  "calculatedColumnFormula",
  "totalsRowFormula",
]);
const FETCHING_FUNCTIONS =
  /(?:^|[^A-Z0-9_.])(?:_XL[A-Z]+\.)*(WEBSERVICE|RTD|IMAGE|CALL|REGISTER\.ID|REGISTER|EXEC)\s*\(/;

/** Why an Excel formula could fetch or run something, or `undefined` when it only computes. */
const formulaProblem = (formula: string): string | undefined => {
  // Text and quoted sheet names first, so only the formula's own syntax is checked.
  const texts: Array<string> = [];
  const bare = formula
    .replace(/"((?:[^"]|"")*)"|'(?:[^']|'')*'/g, (_, text: string | undefined) =>
      text === undefined ? "''" : `"${texts.push(text.replaceAll('""', '"')) - 1}"`,
    )
    .toUpperCase();
  if (/["']/.test(bare.replace(/"\d+"|''/g, ""))) return "a formula Kin can't read";
  if (bare.includes("|")) return "a formula that talks to another program";
  if (bare.includes("_XLUDF.")) return "a formula that calls an add-in";
  const call = FETCHING_FUNCTIONS.exec(bare);
  if (call !== null) return `a formula that calls ${call[1]}, which fetches or runs content`;
  for (const match of bare.matchAll(/(?:^|[^A-Z0-9_.])(?:_XL[A-Z]+\.)*HYPERLINK\s*\(\s*/g)) {
    const target = /^"(\d+)"\s*[,)]/.exec(bare.slice(match.index + match[0].length));
    if (target === null) return "a HYPERLINK formula whose address Kin can't see";
    const address = texts[Number(target[1])]!.trim();
    const problem = IN_WORKBOOK.test(address) ? undefined : linkProblem(address);
    if (problem !== undefined) return `${problem} in a formula`;
  }
  return undefined;
};

/** Refuses fields, formulas, actions and links in one XML part that fetch or run something. */
const bodyProblem = async (kind: OfficeKind, read: Source, part: string) => {
  // Word splits a field's instruction over runs; nested fields sit inside it. Instruction text
  // outside a field's instruction is checked word by word.
  const fields: Array<{ text: string; checked: boolean; nested: boolean }> = [];
  let loose = "";
  let instruction = 0;
  let formula: string | undefined;
  const found = (problem: string | undefined) => {
    if (problem !== undefined) refuse(`has ${problem} (in ${part})`);
  };
  const check = (field: { text: string; checked: boolean; nested: boolean }) => {
    if (field.checked) return;
    field.checked = true;
    found(fieldProblem(field.text, false, field.nested));
  };
  const longer = (text: string, what: string) => {
    if (text.length > HELD_CHARS) found(`${what} larger than any real document's`);
    return text;
  };
  await read({
    open: (tag) => {
      const attributes = bodyAttributes(tag, part);
      switch (tag.local) {
        case "fldSimple":
          found(fieldProblem(attributes.get("instr") ?? ""));
          break;
        case "fldChar": {
          const type = attributes.get("fldCharType");
          const top = fields.at(-1);
          if (type === "begin") {
            if (top !== undefined && !top.checked && top.text.trim() === "")
              found("a field whose name another field writes");
            if (top !== undefined && !top.checked) top.nested = true;
            fields.push({ text: "", checked: false, nested: false });
          } else if (type === "separate" && top !== undefined) check(top);
          else if (type === "end" && top !== undefined) check(fields.pop()!);
          break;
        }
        case "instrText":
        case "delInstrText":
          instruction += 1;
          break;
        case "hlinkClick":
        case "hlinkMouseOver":
        case "hlinkHover":
          if (/^\s*ppaction:\/\/(?:program|macro|ole)/i.test(attributes.get("action") ?? ""))
            found("an action that runs a program or macro");
          break;
        case "entryMacro":
        case "exitMacro":
          found("a form field that runs a macro");
          break;
        case "mailMerge":
          found("a mail merge, which loads data from outside the file");
          break;
      }
      if ((attributes.get("macro") ?? "").trim() !== "") found("a shape that runs a macro");
      for (const local of ["href", "src"]) {
        const link = (attributes.get(local) ?? "").trim();
        if (link !== "" && !link.startsWith("#")) found("a link to something outside the file");
      }
      if (kind === "xlsx" && FORMULAS.has(tag.local)) formula = "";
    },
    text: (text) => {
      if (instruction > 0) {
        const top = fields.at(-1);
        if (top === undefined || top.checked) loose = longer(loose + text, "field instructions");
        else top.text = longer(top.text + text, "a field instruction");
      }
      if (formula !== undefined) formula = longer(formula + text, "a formula");
    },
    close: (tag) => {
      if (tag.local === "instrText" || tag.local === "delInstrText") instruction -= 1;
      if (formula !== undefined && FORMULAS.has(tag.local)) {
        const text = formula;
        formula = undefined;
        found(formulaProblem(text));
      }
    },
  });
  for (const field of fields) check(field);
  found(fieldProblem(loose, true));
};

const XML_TYPE = /[/+]xml$/i;
const SVG_TYPE = /^image\/svg\+xml$/i;

/** Why these bytes aren't a plain `kind` document, or `undefined` when they are. */
export const officeProblem = async (
  kind: OfficeKind,
  input: Uint8Array,
  caps: OfficeCaps = OFFICE_CAPS,
): Promise<string | undefined> => {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  try {
    const entries = directory(bytes);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const main = MAIN[kind];
    if (!byName.has(main.part)) return refuse(`no ${main.part}`);
    const active = entries.find((entry) => ACTIVE_PART.test(entry.name));
    if (active !== undefined)
      return refuse(`carries ${active.name}, which runs, embeds or fetches content`);
    const types = byName.get("[Content_Types].xml");
    if (types === undefined) return refuse("no [Content_Types].xml");
    let budget = caps.inflatedBytes;
    const admit = (entry: Entry, cap: number) => {
      if (entry.size > cap) refuse(`has ${entry.name}, which is too large for Kin to check`);
      if (entry.size > 1024 * 1024 && entry.size > Math.max(entry.packed, 1) * caps.ratio)
        refuse(`has ${entry.name}, which unpacks to far more than any real document does`);
      if (entry.size > budget) refuse("has more XML than Kin checks in one file");
      budget -= entry.size;
    };
    const source =
      (entry: Entry): Source =>
      async (handlers) => {
        admit(entry, caps.partBytes);
        const xml = parser(entry.name, handlers);
        await streamPart(bytes, entry, xml.write);
        xml.close();
      };
    const typeOf = await contentTypes(source(types), types.name);
    if (typeOf(main.part) !== main.type)
      return refuse(`its ${main.part} isn't a plain ${kind.toUpperCase()}`);
    const rest = entries.filter((entry) => entry !== types && !entry.name.endsWith("/"));
    for (const entry of rest)
      if (entry.name.toLowerCase().endsWith(".rels"))
        await relationshipsProblem(source(entry), entry.name);
    for (const entry of rest) {
      if (entry.name.toLowerCase().endsWith(".rels")) continue;
      const type = typeOf(entry.name) ?? "";
      if (SVG_TYPE.test(type) || entry.name.toLowerCase().endsWith(".svg")) {
        admit(entry, caps.svgBytes);
        const chunks: Array<string> = [];
        await streamPart(bytes, entry, (text) => chunks.push(text));
        const problem = svgProblem(chunks.join(""));
        if (problem !== undefined) refuse(`has ${entry.name}, an SVG with ${problem}`);
      } else if (XML_TYPE.test(type) || entry.name.toLowerCase().endsWith(".xml"))
        await bodyProblem(kind, source(entry), entry.name);
    }
    return undefined;
  } catch (error) {
    if (error instanceof Refusal) return error.reason;
    return "its ZIP couldn't be read";
  }
};
