// @effect-diagnostics nodeBuiltinImport:off -- PDF streams are inspected before opening the document.
import * as NodeBuffer from "node:buffer";
import * as NodeZlib from "node:zlib";

const STREAM_BYTES = 32 * 1024 * 1024;
const STREAMS_BYTES = 256 * 1024 * 1024;

// pdf.js takes these short forms of filter names (`Parser.makeFilter`).
const SHORT_FILTERS: Readonly<Record<string, string>> = {
  Fl: "FlateDecode",
  AHx: "ASCIIHexDecode",
  A85: "ASCII85Decode",
  LZW: "LZWDecode",
  RL: "RunLengthDecode",
  CCF: "CCITTFaxDecode",
  DCT: "DCTDecode",
};
const WHITE = new Set(
  [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20].map((code) => String.fromCharCode(code)),
);
const DELIMITER = new Set("()<>[]{}/%");
const DICT_CHARS = 1024 * 1024;

/** A PDF name with its `#xx` escapes decoded and a short filter name spelled out. */
const filterName = (raw: string) => {
  const name = raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return SHORT_FILTERS[name] ?? name;
};

/**
 * The stream dictionary starting at `at`: the filters it names (undefined when a reference or
 * anything else this can't follow names them) and where its data starts, if a stream follows.
 */
const streamAt = (text: string, at: number) => {
  let index = at;
  const skipSpace = () => {
    while (index < text.length) {
      if (WHITE.has(text[index]!)) index += 1;
      else if (text[index] === "%")
        while (index < text.length && !/[\r\n]/.test(text[index]!)) index += 1;
      else return;
    }
  };
  skipSpace();
  if (!text.startsWith("<<", index)) return undefined;
  const limit = Math.min(text.length, at + DICT_CHARS);
  let depth = 0;
  let filterAt: number | undefined;
  let filters: Array<string> | undefined = [];
  let inArray = false;
  let value = false;
  while (index < limit) {
    skipSpace();
    const char = text[index]!;
    if (text.startsWith("<<", index)) {
      depth += 1;
      index += 2;
      if (value && depth === 2) filters = undefined;
      value = false;
    } else if (text.startsWith(">>", index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) break;
    } else if (char === "<") {
      const close = text.indexOf(">", index);
      index = close === -1 ? limit : close + 1;
      if (value) filters = undefined;
      value = false;
    } else if (char === "(") {
      let nesting = 0;
      for (; index < limit; index += 1) {
        if (text[index] === "\\") index += 1;
        else if (text[index] === "(") nesting += 1;
        else if (text[index] === ")" && --nesting === 0) break;
      }
      index += 1;
      if (value) filters = undefined;
      value = false;
    } else if (char === "[") {
      index += 1;
      if (value) inArray = true;
    } else if (char === "]") {
      index += 1;
      inArray = false;
      value = false;
    } else {
      const begin = index;
      index += 1;
      while (index < limit && !WHITE.has(text[index]!) && !DELIMITER.has(text[index]!)) index += 1;
      const token = text.slice(begin, index);
      if (depth !== 1) continue;
      if (value) {
        if (token.startsWith("/")) filters?.push(filterName(token.slice(1)));
        else filters = undefined;
        if (!inArray) value = false;
      } else if (token.startsWith("/") && filterName(token.slice(1)) === "Filter") {
        filterAt = begin;
        filters = [];
        value = true;
      }
    }
  }
  if (depth !== 0) return undefined;
  skipSpace();
  const keyword = /^stream\r?\n/.exec(text.slice(index, index + 8));
  if (keyword === null) return undefined;
  return { filters: filterAt === undefined ? [] : filters, start: index + keyword[0].length };
};

const hexDecoded = (data: Uint8Array) => {
  const digits = NodeBuffer.Buffer.from(data)
    .toString("latin1")
    .split(">")[0]!
    .replace(/[^0-9A-Fa-f]/g, "");
  return new Uint8Array(
    NodeBuffer.Buffer.from(digits.length % 2 === 0 ? digits : `${digits}0`, "hex"),
  );
};
const ascii85Decoded = (data: Uint8Array) => {
  const text = NodeBuffer.Buffer.from(data).toString("latin1").split("~>")[0]!.replace(/\s/g, "");
  const out: Array<number> = [];
  let group: Array<number> = [];
  const flush = (count: number) => {
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    for (let shift = 3; shift >= 4 - count; shift -= 1) out.push((value >>> (shift * 8)) & 0xff);
  };
  for (const char of text) {
    if (char === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(char.charCodeAt(0) - 33);
    if (group.length === 5) {
      flush(4);
      group = [];
    }
  }
  if (group.length > 1) {
    const count = group.length - 1;
    while (group.length < 5) group.push(84);
    flush(count);
  }
  return new Uint8Array(out);
};

/**
 * Why a PDF's streams would decode past what a statement needs, before pdf.js decodes them in
 * memory: a few kilobytes can hold gigabytes. Every object's stream is followed through its
 * filters, names in any form; a filter this can't decode ends the check for that stream. Only a
 * first line: the reader process's own memory bound is what holds.
 */
export const inflatedTooFar = (bytes: Uint8Array): string | undefined => {
  const text = NodeBuffer.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "latin1",
  );
  const tooFar = "The PDF holds far more data than a statement.";
  let total = 0;
  for (const found of text.matchAll(
    /\d+(?:[\0\t\n\f\r ]|%[^\r\n]*)+\d+(?:[\0\t\n\f\r ]|%[^\r\n]*)+obj/g,
  )) {
    const stream = streamAt(text, found.index + found[0].length);
    if (stream === undefined || stream.filters === undefined) continue;
    const end = text.indexOf("endstream", stream.start);
    if (end === -1) continue;
    let data = bytes.subarray(stream.start, end);
    for (const filter of stream.filters) {
      if (filter === "ASCIIHexDecode") data = hexDecoded(data);
      else if (filter === "ASCII85Decode") data = ascii85Decoded(data);
      else if (filter === "FlateDecode") {
        try {
          data = new Uint8Array(
            NodeZlib.inflateSync(data, {
              maxOutputLength: STREAM_BYTES,
              finishFlush: NodeZlib.constants.Z_SYNC_FLUSH,
            }),
          );
        } catch (error) {
          if (error instanceof RangeError) return tooFar;
          break;
        }
      } else break;
      total += data.byteLength;
      if (total > STREAMS_BYTES) return tooFar;
    }
  }
  return undefined;
};
