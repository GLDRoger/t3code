// @effect-diagnostics nodeBuiltinImport:off -- a bounded, streaming inflate of each part; Effect has no zlib.
import * as NodeZlib from "node:zlib";

// Kin's one ZIP reader, for the Office files it checks (`gendocs/officeCheck.ts`) and the
// statements it reads (`work/statements/statementFiles.ts`). The directory is checked whole
// before any part unpacks, and each part streams a chunk at a time, its size and CRC checked as
// it comes. Every refusal completes "it …", so each caller words the file its own way.

export const ZIP_CAPS = {
  /** A 60-slide deck with a picture per slide is about 300 parts; T3's own reader stops at 2,048. */
  entries: 2_000,
  /** A generated sheet of a million rows is about 150 MB of XML; one picture is under the 100 MB file cap. */
  entryBytes: 256 * 1024 * 1024,
  /** Kin takes a file of at most 100 MB: pictures unpack about 1:1 and XML 5-20 times. */
  totalBytes: 512 * 1024 * 1024,
  /** Real XML packs 5-50 times and deflate tops out near 1,032: past 500 it is a bomb, not a sheet. */
  ratio: 500,
};
export type ZipCaps = { readonly [Cap in keyof typeof ZIP_CAPS]: number };

/** Past a cap: one sentence for all four, so no caller tells them apart. */
export const ZIP_TOO_LARGE = "unpacks to more than Kin reads in one file";
/** Below this a part may pack as tightly as it likes: a page of spaces is not a bomb. */
const RATIO_FLOOR = 1024 * 1024;
const COMMENT_BYTES = 1024;
const CHUNK = 64 * 1024;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const UNICODE_PATH_EXTRA = 0x7075;
// Encrypted, data descriptor, strong encryption, UTF-8 name: what changes how a part is read.
const READ_FLAGS = 0x0001 | 0x0008 | 0x0040 | 0x0800;

export type ZipPart = {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly packed: number;
  readonly size: number;
  readonly offset: number;
};

/** Why a file is refused, as a phrase that completes "it …". */
// @effect-diagnostics-next-line extendsNativeError:off - a local throw sentinel inside pure checks.
export class Refusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
export const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

const quoted = (name: string) => JSON.stringify(name.slice(0, 80));

const decodeName = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("has a part name that isn't UTF-8");
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
  if (fields.has(ZIP64_EXTRA)) return refuse("has a ZIP64 part");
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

/** The ZIP's directory, checked: one end record, no ZIP64, no gaps, no odd or repeated names. */
const directory = (bytes: Buffer, caps: ZipCaps) => {
  const floor = Math.max(0, bytes.length - 22 - COMMENT_BYTES);
  let end = -1;
  for (let at = bytes.length - 22; at >= floor; at -= 1)
    if (bytes.readUInt32LE(at) === EOCD) {
      end = at;
      break;
    }
  if (end === -1) return refuse("has no ZIP directory at its end");
  if (end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)
    return refuse("has data after its ZIP directory");
  if (end >= 20 && bytes.readUInt32LE(end - 20) === ZIP64_LOCATOR)
    return refuse("has a ZIP64 directory");
  const disk = bytes.readUInt16LE(end + 4);
  const startDisk = bytes.readUInt16LE(end + 6);
  const here = bytes.readUInt16LE(end + 8);
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (disk !== 0 || startDisk !== 0 || here !== count) return refuse("is a split ZIP");
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff)
    return refuse("has a ZIP64 directory");
  if (count > caps.entries) return refuse(ZIP_TOO_LARGE);
  if (start + size !== end) return refuse("has data between its parts and its ZIP directory");
  const entries: Array<ZipPart> = [];
  const names = new Set<string>();
  let total = 0;
  let at = start;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== CENTRAL)
      return refuse("has a broken ZIP directory");
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
    if (next > end) return refuse("has a broken ZIP directory");
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) return refuse("has an encrypted part");
    if (method !== 0 && method !== 8) return refuse("has a part packed in a way Kin doesn't read");
    if (packed === 0xffffffff || entrySize === 0xffffffff || offset === 0xffffffff)
      return refuse("has a ZIP64 part");
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
      return refuse(`has a part named ${quoted(name)}`);
    const key = name.toLowerCase().normalize("NFC");
    if (names.has(key)) return refuse(`has two parts named ${quoted(name)}`);
    names.add(key);
    total += entrySize;
    if (
      entrySize > caps.entryBytes ||
      total > caps.totalBytes ||
      (entrySize > RATIO_FLOOR && entrySize > Math.max(packed, 1) * caps.ratio)
    )
      return refuse(ZIP_TOO_LARGE);
    entries.push({ name, flags, method, crc, packed, size: entrySize, offset });
    at = next;
  }
  if (at !== end) return refuse("has a broken ZIP directory");
  // Parts sit back to back from the first byte to the directory: nothing hides between them.
  let previous = 0;
  for (const entry of entries.toSorted((left, right) => left.offset - right.offset)) {
    const head = entry.offset;
    if (head !== previous || head + 30 > start || bytes.readUInt32LE(head) !== LOCAL)
      return refuse("has data between its parts");
    const flags = bytes.readUInt16LE(head + 6);
    if ((flags & 0x0001) !== 0) return refuse("has an encrypted part");
    const nameLength = bytes.readUInt16LE(head + 26);
    const extraLength = bytes.readUInt16LE(head + 28);
    const data = head + 30 + nameLength + extraLength;
    if (data > start) return refuse("has a broken ZIP part");
    const local = headerName(
      bytes.subarray(head + 30, head + 30 + nameLength),
      flags,
      bytes.subarray(head + 30 + nameLength, data),
    );
    if (local !== entry.name || data + entry.packed > start) return refuse("has a broken ZIP part");
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
  if (previous !== start) return refuse("has data between its parts and its ZIP directory");
  return entries;
};

/**
 * One part's bytes, inflated a chunk at a time into `sink` as UTF-8 text, its size and CRC checked
 * as they come. A `Refusal` or any other error `sink` throws stops it there and rejects with it.
 */
const streamPart = (bytes: Buffer, entry: ZipPart, sink: (text: string) => void) =>
  new Promise<void>((resolve, reject) => {
    const head = entry.offset;
    const data = head + 30 + bytes.readUInt16LE(head + 26) + bytes.readUInt16LE(head + 28);
    const packed = bytes.subarray(data, data + entry.packed);
    const mismatch = `has ${entry.name}, which doesn't match its ZIP directory`;
    const decoder = new TextDecoder("utf-8");
    let size = 0;
    let crc = 0;
    let done = false;
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      inflater?.destroy();
      reject(error);
    };
    const take = (chunk: Buffer) => {
      size += chunk.length;
      if (size > entry.size) refuse(mismatch);
      crc = NodeZlib.crc32(chunk, crc);
      sink(decoder.decode(chunk, { stream: true }));
    };
    const finish = () => {
      sink(decoder.decode());
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
    inflater.on("error", () => fail(new Refusal(`has ${entry.name}, which doesn't unpack`)));
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

/**
 * A ZIP's parts, its directory checked under `caps` before any part unpacks; throws a `Refusal`.
 * `stream` hands one part's text to `sink` a chunk at a time, so no part is held whole here.
 */
export const openZip = (input: Uint8Array, caps: ZipCaps = ZIP_CAPS) => {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const parts: ReadonlyArray<ZipPart> = directory(bytes, caps);
  return {
    parts,
    stream: (part: ZipPart, sink: (text: string) => void) => streamPart(bytes, part, sink),
  };
};
