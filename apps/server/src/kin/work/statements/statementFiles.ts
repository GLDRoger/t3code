// @effect-diagnostics nodeBuiltinImport:off -- a bounded, synchronous read of one file's bytes; no service owns these formats.
import * as NodeBuffer from "node:buffer";
import * as NodeZlib from "node:zlib";

import * as Schema from "effect/Schema";
import { SaxesParser } from "saxes";
import * as Yauzl from "yauzl";

import { officeProblem } from "../../gendocs/officeCheck.ts";
import {
  type Cell,
  cellBudget,
  delimitedLines,
  EMPTY_CELL,
  htmlLines,
  type Line,
  LINE_CAPS,
  readTable,
  type Statement,
  TooLarge,
} from "./statementTable.ts";

/**
 * A statement file's lines, from whatever the bank sent: CSV, an XLSX or old binary XLS sheet,
 * an HTML table saved as ".xls", or a PDF's text layer, password-protected or not. A password is
 * used for this one read and never kept, logged or returned here.
 */

export type FileOutcome =
  | { readonly _tag: "read"; readonly statement: Statement; readonly format: StatementFormat }
  | { readonly _tag: "needs_password" }
  | { readonly _tag: "wrong_password" }
  | { readonly _tag: "scanned"; readonly pages: number }
  | { readonly _tag: "unreadable"; readonly reason: string };
export type StatementFormat = "csv" | "xlsx" | "xls" | "html" | "pdf";

const STATEMENT_CAPS = {
  bytes: 25 * 1024 * 1024,
  pages: 300,
  rows: 20_000,
  sheetBytes: 64 * 1024 * 1024,
  /** What one deflated PDF stream may inflate to, and all of them together. */
  streamBytes: 32 * 1024 * 1024,
  streamsBytes: 256 * 1024 * 1024,
};

const isTooLarge = Schema.is(TooLarge);
const tooLarge = (reason: string): Failure => ({ _tag: "unreadable", reason });

const startsWith = (bytes: Uint8Array, magic: ReadonlyArray<number>) =>
  magic.every((byte, index) => bytes[index] === byte);
const PDF = [0x25, 0x50, 0x44, 0x46];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** What the bytes are, by their own first bytes; the name only tells text formats apart. */
const formatOf = (bytes: Uint8Array): StatementFormat | undefined => {
  if (startsWith(bytes, PDF)) return "pdf";
  if (startsWith(bytes, ZIP)) return "xlsx";
  if (startsWith(bytes, CFB)) return "xls";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  if (/\p{Cc}/u.test(head.replace(/[\t\r\n\f]/g, ""))) return undefined;
  return /<table\b|<html\b/i.test(head) ? "html" : "csv";
};

const decodeText = (bytes: Uint8Array) => {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  const text = new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bytes);
  return text.replace(/^﻿/, "");
};

/** Reads a statement file. `password` opens a protected PDF for this read only. */
export const readStatementFile = async (
  bytes: Uint8Array,
  password?: string,
): Promise<FileOutcome> => {
  if (bytes.byteLength > STATEMENT_CAPS.bytes)
    return {
      _tag: "unreadable",
      reason: "The file is larger than Kin reads as a statement (25 MB).",
    };
  const format = formatOf(bytes);
  if (format === undefined)
    return {
      _tag: "unreadable",
      reason: "This isn't a statement file Kin reads: send a PDF, CSV, XLS or XLSX.",
    };
  const lines = await linesOf(format, bytes, password).catch((error: unknown) => {
    if (isTooLarge(error)) return tooLarge(error.reason);
    throw error;
  });
  if (!Array.isArray(lines)) return lines as Failure;
  const table = readTable(lines);
  if (table._tag === "no_table") return { _tag: "unreadable", reason: table.reason };
  if (table.statement.rows.length > STATEMENT_CAPS.rows)
    return {
      _tag: "unreadable",
      reason: `The statement has more than ${STATEMENT_CAPS.rows} rows.`,
    };
  return { _tag: "read", statement: table.statement, format };
};

type Failure = Exclude<FileOutcome, { _tag: "read" }>;

const linesOf = async (
  format: StatementFormat,
  bytes: Uint8Array,
  password: string | undefined,
): Promise<ReadonlyArray<Line> | Failure> =>
  format === "pdf"
    ? pdfLines(bytes, password)
    : format === "xlsx"
      ? xlsxLines(bytes)
      : format === "xls"
        ? xlsLines(bytes)
        : format === "html"
          ? htmlLines(decodeText(bytes))
          : delimitedLines(decodeText(bytes));

// pdf.js reports a missing or wrong password with these codes (`PasswordResponses`).
const NEED_PASSWORD = 1;
const INCORRECT_PASSWORD = 2;

/** A PDF's text, as lines of positioned cells per page, top to bottom. */
const pdfLines = async (
  bytes: Uint8Array,
  password?: string,
): Promise<ReadonlyArray<Line> | Failure> => {
  const bomb = inflatedTooFar(bytes);
  if (bomb !== undefined) return tooLarge(bomb);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js runs its worker in this thread, from this global; bundled, its own path to it is gone.
  Reflect.set(globalThis, "pdfjsWorker", await import("pdfjs-dist/legacy/build/pdf.worker.mjs"));
  // Text only: no fonts, CMaps, wasm decoders or fetches, which a statement's text never needs.
  // pdf.js 6 has no eval path left to turn off (`isEvalSupported` is gone).
  const task = pdfjs.getDocument({
    // pdf.js takes ownership of the buffer it is given, so it reads a copy.
    data: new Uint8Array(bytes),
    ...(password === undefined ? {} : { password }),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    stopAtErrors: false,
    useWorkerFetch: false,
    useWasm: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  try {
    const document = await task.promise;
    if (document.numPages > STATEMENT_CAPS.pages)
      return { _tag: "unreadable", reason: `The PDF has more than ${STATEMENT_CAPS.pages} pages.` };
    const budget = cellBudget();
    const lines: Array<Line> = [];
    let characters = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const items = content.items.flatMap((item) =>
        "str" in item && item.str.trim() !== ""
          ? [
              {
                text: item.str,
                x: item.transform[4] as number,
                y: item.transform[5] as number,
                width: item.width,
              },
            ]
          : [],
      );
      characters += items.reduce((sum, item) => sum + item.text.trim().length, 0);
      for (const line of groupLines(items)) {
        budget.line();
        budget.cells(line.length);
        lines.push(line);
      }
      page.cleanup();
    }
    if (characters < 20) return { _tag: "scanned", pages: document.numPages };
    return lines;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    const name =
      typeof error === "object" && error !== null ? Reflect.get(error, "name") : undefined;
    if (name === "PasswordException" && code === NEED_PASSWORD) return { _tag: "needs_password" };
    if (name === "PasswordException" && code === INCORRECT_PASSWORD)
      return { _tag: "wrong_password" };
    if (isTooLarge(error)) return tooLarge(error.reason);
    return { _tag: "unreadable", reason: "The PDF couldn't be opened; it may be damaged." };
  } finally {
    await task.destroy();
  }
};

type Item = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
};

/** Items on one baseline (within a few points) are a line; pieces that touch are one cell. */
const groupLines = (items: ReadonlyArray<Item>): ReadonlyArray<Line> => {
  const sorted = items.toSorted((left, right) => right.y - left.y || left.x - right.x);
  const rows: Array<Array<Item>> = [];
  for (const item of sorted) {
    const row = rows.at(-1);
    if (row !== undefined && Math.abs(row[0]!.y - item.y) <= 2.5) row.push(item);
    else rows.push([item]);
  }
  return rows.map((row) => {
    const cells: Array<{ text: string; x: number; right: number }> = [];
    for (const item of row.toSorted((left, right) => left.x - right.x)) {
      const last = cells.at(-1);
      const gap = last === undefined ? Infinity : item.x - last.right;
      // Only pieces that touch are one word: a cell beside another stays its own, for its column.
      if (last !== undefined && gap > -0.6 && gap < 0.6) {
        last.text += item.text;
        last.right = Math.max(last.right, item.x + item.width);
      } else cells.push({ text: item.text, x: item.x, right: item.x + item.width });
    }
    return cells.slice(0, LINE_CAPS.width).map((cell) => ({ ...cell, text: cell.text.trim() }));
  });
};

/**
 * Why a PDF's deflated streams would inflate past what a statement needs, before pdf.js
 * inflates them all in memory: a few kilobytes can hold gigabytes. Streams that aren't plain
 * deflate (an encrypted file's) are left to pdf.js, which the reader's time limit bounds.
 */
const inflatedTooFar = (bytes: Uint8Array): string | undefined => {
  const text = NodeBuffer.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "latin1",
  );
  let total = 0;
  for (const found of text.matchAll(/(?<!end)stream\r?\n/g)) {
    const start = found.index + found[0].length;
    const dict = text.slice(Math.max(0, found.index - 1_024), found.index);
    if (!/\/FlateDecode\b/.test(dict.slice(dict.lastIndexOf("obj")))) continue;
    const end = text.indexOf("endstream", start);
    if (end === -1) continue;
    try {
      total += NodeZlib.inflateSync(bytes.subarray(start, end), {
        maxOutputLength: STATEMENT_CAPS.streamBytes,
      }).byteLength;
    } catch (error) {
      if (error instanceof RangeError) return "The PDF holds far more data than a statement.";
    }
    if (total > STATEMENT_CAPS.streamsBytes) return "The PDF holds far more data than a statement.";
  }
  return undefined;
};

const unzip = (bytes: Uint8Array) =>
  new Promise<Map<string, string>>((resolve, reject) => {
    const parts = new Map<string, string>();
    Yauzl.fromBuffer(
      NodeBuffer.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error !== null || zip === undefined) return reject(error ?? new Error("no zip"));
        let total = 0;
        zip.on("entry", (entry: Yauzl.Entry) => {
          const name = entry.fileName;
          const wanted =
            name === "xl/workbook.xml" ||
            name === "xl/sharedStrings.xml" ||
            name === "xl/_rels/workbook.xml.rels" ||
            /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
          if (!wanted) return zip.readEntry();
          total += entry.uncompressedSize;
          if (total > STATEMENT_CAPS.sheetBytes) return reject(new Error("too large"));
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError !== null || stream === undefined)
              return reject(streamError ?? new Error("no stream"));
            const chunks: Array<NodeBuffer.Buffer> = [];
            stream.on("data", (chunk: NodeBuffer.Buffer) => chunks.push(chunk));
            stream.on("error", reject);
            stream.on("end", () => {
              parts.set(name, NodeBuffer.Buffer.concat(chunks).toString("utf8"));
              zip.readEntry();
            });
          });
        });
        zip.on("end", () => resolve(parts));
        zip.on("error", reject);
        zip.readEntry();
      },
    );
  });

const xml = (
  text: string,
  on: {
    readonly open?: (name: string, attributes: Record<string, string>) => void;
    readonly text?: (text: string) => void;
    readonly close?: (name: string) => void;
  },
) => {
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) =>
    on.open?.(
      tag.name.replace(/^\w+:/, ""),
      Object.fromEntries(
        Object.entries(tag.attributes).map(([key, value]) => [key, String(value)]),
      ),
    ),
  );
  parser.on("text", (value) => on.text?.(value));
  parser.on("closetag", (tag) => on.close?.(tag.name.replace(/^\w+:/, "")));
  parser.write(text).close();
};

/** A cell reference's column from 0, up to XFD; `undefined` past it or when it names none. */
const columnIndex = (reference: string) => {
  const letters = /^[A-Z]{1,3}(?=\d|$)/.exec(reference)?.[0];
  if (letters === undefined) return undefined;
  const index = [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  return index < 16_384 ? index : undefined;
};

/** Puts a cell in its column; a row holds no cells past `LINE_CAPS.width`, padding counted. */
const place = (
  row: Array<Cell>,
  column: number,
  cell: Cell,
  budget: ReturnType<typeof cellBudget>,
) => {
  if (column >= LINE_CAPS.width) return;
  if (column < row.length) {
    row[column] = cell;
    return;
  }
  budget.cells(column - row.length + 1);
  while (row.length < column) row.push(EMPTY_CELL);
  row.push(cell);
};

/** The first sheet of an XLSX, once Kin has checked it is only a document. */
const xlsxLines = async (bytes: Uint8Array): Promise<ReadonlyArray<Line> | Failure> => {
  const problem = await officeProblem("xlsx", bytes);
  if (problem !== undefined)
    return { _tag: "unreadable", reason: `Kin doesn't open this spreadsheet: it has ${problem}.` };
  const parts = await unzip(bytes).catch(() => undefined);
  if (parts === undefined)
    return { _tag: "unreadable", reason: "The spreadsheet couldn't be read." };
  const strings: Array<string> = [];
  let current: string | undefined;
  let inText = false;
  xml(parts.get("xl/sharedStrings.xml") ?? "<sst/>", {
    open: (name) => {
      if (name === "si") current = "";
      if (name === "t") inText = true;
    },
    text: (value) => {
      if (inText && current !== undefined && current.length < 4_000) current += value;
    },
    close: (name) => {
      if (name === "t") inText = false;
      if (name === "si") {
        if (strings.length >= LINE_CAPS.cells)
          throw new TooLarge({ reason: "The spreadsheet has far more text than a statement." });
        strings.push(current ?? "");
        current = undefined;
      }
    },
  });
  const sheets = [...parts.keys()]
    .filter((name) => name.startsWith("xl/worksheets/"))
    .toSorted((left, right) => Number(/\d+/.exec(left)?.[0]) - Number(/\d+/.exec(right)?.[0]));
  const read = (name: string) => {
    const budget = cellBudget();
    const lines: Array<Array<Cell>> = [];
    let row: Array<Cell> = [];
    let cell: { column: number | undefined; type: string; value: string } | undefined;
    let inValue = false;
    xml(parts.get(name)!, {
      open: (tag, attributes) => {
        if (tag === "row") row = [];
        if (tag === "c")
          cell = {
            // A cell without a reference follows the one before it.
            column: attributes.r === undefined ? row.length : columnIndex(attributes.r),
            type: attributes.t ?? "n",
            value: "",
          };
        if (tag === "v" || tag === "t") inValue = true;
      },
      text: (value) => {
        if (inValue && cell !== undefined && cell.value.length < 4_000) cell.value += value;
      },
      close: (tag) => {
        if (tag === "v" || tag === "t") inValue = false;
        if (tag === "c" && cell !== undefined) {
          const text = cell.type === "s" ? (strings[Number(cell.value)] ?? "") : cell.value;
          const number = cell.type === "n" && cell.value !== "" ? Number(cell.value) : undefined;
          const finite = number !== undefined && Number.isFinite(number);
          if (cell.column !== undefined)
            place(
              row,
              cell.column,
              finite ? { text: String(number), serial: number } : { text },
              budget,
            );
          cell = undefined;
        }
        if (tag === "row") {
          budget.line();
          lines.push(row);
        }
      },
    });
    return lines;
  };
  for (const name of sheets) {
    const lines = read(name);
    if (readTable(lines)._tag === "read") return lines;
  }
  return sheets.length === 0 ? [] : read(sheets[0]!);
};

// An old binary .xls: a compound file holding a BIFF8 workbook stream. Only cell values are read.
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** The "Workbook" stream of a compound file, or a failure. */
const workbookStream = (bytes: Uint8Array): Uint8Array | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 512) return undefined;
  const sectorShift = view.getUint16(30, true);
  if ((sectorShift !== 9 && sectorShift !== 12) || view.getUint16(32, true) !== 6) return undefined;
  const sectorSize = 1 << sectorShift;
  const miniSize = 64;
  const sectors = Math.floor((bytes.byteLength - 512) / sectorSize);
  const fatCount = view.getUint32(44, true);
  // Every FAT sector is a sector of this file; a header claiming more is not a workbook.
  if (fatCount > sectors) return undefined;
  const firstDir = view.getUint32(48, true);
  const miniCutoff = view.getUint32(56, true);
  const firstMiniFat = view.getUint32(60, true);
  let difatSector = view.getUint32(68, true);
  const sectorAt = (id: number) => 512 + id * sectorSize;
  const fatSectors: Array<number> = [];
  for (let at = 76; at < 512 && fatSectors.length < fatCount; at += 4)
    fatSectors.push(view.getUint32(at, true));
  const difatSeen = new Set<number>();
  while (difatSector !== ENDOFCHAIN && difatSector !== FREESECT && fatSectors.length < fatCount) {
    if (difatSeen.has(difatSector) || difatSector >= sectors) return undefined;
    difatSeen.add(difatSector);
    for (let at = 0; at < sectorSize - 4 && fatSectors.length < fatCount; at += 4)
      fatSectors.push(view.getUint32(sectorAt(difatSector) + at, true));
    difatSector = view.getUint32(sectorAt(difatSector) + sectorSize - 4, true);
  }
  const fat: Array<number> = [];
  if (new Set(fatSectors).size !== fatSectors.length) return undefined;
  for (const sector of fatSectors) {
    if (sector >= sectors) return undefined;
    for (let at = 0; at < sectorSize; at += 4)
      fat.push(view.getUint32(sectorAt(sector) + at, true));
  }
  /** A sector chain, each of its `count` sectors once: a cycle or a sector past the end fails. */
  const chain = (start: number, table: ReadonlyArray<number>, count: number) => {
    const ids: Array<number> = [];
    const seen = new Set<number>();
    for (let id = start; id !== ENDOFCHAIN && id !== FREESECT; id = table[id] ?? ENDOFCHAIN) {
      if (id >= count || seen.has(id)) return undefined;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  };
  const read = (start: number, size: number) => {
    const ids = chain(start, fat, sectors);
    if (ids === undefined) return undefined;
    const out = new Uint8Array(ids.length * sectorSize);
    for (const [index, id] of ids.entries())
      out.set(bytes.subarray(sectorAt(id), sectorAt(id) + sectorSize), index * sectorSize);
    return out.subarray(0, Math.min(size, out.length));
  };
  const directory = read(firstDir, Number.MAX_SAFE_INTEGER);
  if (directory === undefined) return undefined;
  const dir = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  type DirEntry = { name: string; type: number; start: number; size: number };
  const entries: Array<DirEntry> = [];
  for (let at = 0; at + 128 <= directory.length; at += 128) {
    const nameLength = dir.getUint16(at + 64, true);
    const name = new TextDecoder("utf-16le").decode(
      directory.subarray(at, at + Math.max(0, Math.min(nameLength, 64) - 2)),
    );
    entries.push({
      name,
      type: directory[at + 66]!,
      start: dir.getUint32(at + 116, true),
      size: dir.getUint32(at + 120, true),
    });
  }
  const root = entries.find((entry) => entry.type === 5);
  const book = entries.find(
    (entry) => entry.type === 2 && (entry.name === "Workbook" || entry.name === "Book"),
  );
  if (root === undefined || book === undefined) return undefined;
  if (book.size >= miniCutoff) return read(book.start, book.size);
  const miniStream = read(root.start, root.size);
  const miniFatBytes = read(firstMiniFat, Number.MAX_SAFE_INTEGER);
  if (miniStream === undefined || miniFatBytes === undefined) return undefined;
  const miniView = new DataView(
    miniFatBytes.buffer,
    miniFatBytes.byteOffset,
    miniFatBytes.byteLength,
  );
  const miniFat = Array.from({ length: miniFatBytes.length / 4 }, (_, index) =>
    miniView.getUint32(index * 4, true),
  );
  const ids = chain(book.start, miniFat, Math.floor(miniStream.length / miniSize));
  if (ids === undefined) return undefined;
  const out = new Uint8Array(ids.length * miniSize);
  for (const [index, id] of ids.entries())
    out.set(miniStream.subarray(id * miniSize, (id + 1) * miniSize), index * miniSize);
  return out.subarray(0, book.size);
};

/** Cell values of the first sheet with a statement table in a BIFF8 workbook. */
const xlsLines = (bytes: Uint8Array): ReadonlyArray<Line> | Failure => {
  const stream = workbookStream(bytes);
  if (stream === undefined) return { _tag: "unreadable", reason: "The XLS file couldn't be read." };
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  type Record = { readonly type: number; readonly data: Uint8Array };
  const records: Array<Record> = [];
  for (let at = 0; at + 4 <= stream.length;) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (at + 4 + length > stream.length) break;
    records.push({ type, data: stream.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  const strings = sharedStrings(records);
  const sheets: Array<Map<number, Map<number, Cell>>> = [];
  let sheet: Map<number, Map<number, Cell>> | undefined;
  let pendingFormula: { row: number; column: number } | undefined;
  const budget = cellBudget();
  const set = (row: number, column: number, cell: Cell) => {
    if (sheet === undefined || column >= LINE_CAPS.width) return;
    budget.cells(1);
    const cells = sheet.get(row) ?? new Map<number, Cell>();
    cells.set(column, cell);
    sheet.set(row, cells);
  };
  const number = (value: number) => ({ text: String(value), serial: value });
  const readRecord = (record: Record) => {
    const data = new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength);
    const u16 = (at: number) => data.getUint16(at, true);
    switch (record.type) {
      case 0x0809: // BOF: a worksheet's begins its cells.
        if (record.data.length >= 4 && u16(2) === 0x0010) {
          sheet = new Map();
          sheets.push(sheet);
        } else sheet = undefined;
        break;
      case 0x00fd: // LABELSST
        set(u16(0), u16(2), { text: strings[data.getUint32(6, true)] ?? "" });
        break;
      case 0x0204: {
        // LABEL
        const read = unicodeString(record.data, 6, u16(6), true);
        set(u16(0), u16(2), { text: read.text });
        break;
      }
      case 0x0203: // NUMBER
        set(u16(0), u16(2), number(data.getFloat64(6, true)));
        break;
      case 0x027e: // RK
        set(u16(0), u16(2), number(rk(data.getUint32(6, true))));
        break;
      case 0x00bd: {
        // MULRK
        const last = u16(record.data.length - 2);
        for (
          let column = u16(2), at = 4;
          column <= last && at + 6 <= record.data.length - 2;
          column += 1, at += 6
        )
          set(u16(0), column, number(rk(data.getUint32(at + 2, true))));
        break;
      }
      case 0x0006: {
        // FORMULA: its cached result; a string result follows in a STRING record.
        const row = u16(0);
        const column = u16(2);
        if (u16(12) === 0xffff) {
          if (record.data[6] === 0) pendingFormula = { row, column };
        } else set(row, column, number(data.getFloat64(6, true)));
        break;
      }
      case 0x0207: // STRING
        if (pendingFormula !== undefined) {
          set(pendingFormula.row, pendingFormula.column, {
            text: unicodeString(record.data, 0, u16(0), true).text,
          });
          pendingFormula = undefined;
        }
        break;
    }
  };
  for (const record of records) {
    try {
      readRecord(record);
    } catch (error) {
      // A record shorter than its type needs is skipped, as Excel skips one it can't read.
      if (!(error instanceof RangeError)) throw error;
    }
  }
  const asLines = (cells: Map<number, Map<number, Cell>>) => {
    const lines = cellBudget();
    return [...cells.keys()]
      .toSorted((left, right) => left - right)
      .map((row) => {
        lines.line();
        const line: Array<Cell> = [];
        for (const [column, cell] of [...cells.get(row)!].toSorted(
          ([left], [right]) => left - right,
        ))
          place(line, column, cell, lines);
        return line;
      });
  };
  for (const one of sheets) {
    const lines = asLines(one);
    if (readTable(lines)._tag === "read") return lines;
  }
  return sheets.length === 0 ? [] : asLines(sheets[0]!);
};

/** An RK number: a 30-bit integer or the top of a double, maybe divided by 100. */
const rk = (value: number) => {
  const hundredths = (value & 1) !== 0;
  let result: number;
  if ((value & 2) !== 0) result = value >> 2;
  else {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setUint32(4, value & 0xfffffffc, true);
    result = buffer.getFloat64(0, true);
  }
  return hundredths ? result / 100 : result;
};

/** A BIFF8 string of `count` characters at `at`: a flags byte, then 8- or 16-bit characters. */
const unicodeString = (data: Uint8Array, at: number, count: number, lengthFirst: boolean) => {
  let offset = lengthFirst ? at + 2 : at;
  const flags = data[offset] ?? 0;
  offset += 1;
  let runs = 0;
  let ext = 0;
  if ((flags & 0x08) !== 0) {
    runs = (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
    offset += 2;
  }
  if ((flags & 0x04) !== 0) {
    ext = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
  }
  const wide = (flags & 0x01) !== 0;
  const length = count * (wide ? 2 : 1);
  const chars = data.subarray(offset, offset + length);
  const text = wide
    ? new TextDecoder("utf-16le").decode(chars)
    : new TextDecoder("latin1").decode(chars);
  return { text, end: offset + length + runs * 4 + ext };
};

/** The shared string table, read across its CONTINUE records, which restart a string's flags. */
const sharedStrings = (
  records: ReadonlyArray<{ readonly type: number; readonly data: Uint8Array }>,
) => {
  const index = records.findIndex((record) => record.type === 0x00fc);
  if (index === -1) return [];
  const segments = [records[index]!.data];
  for (const record of records.slice(index + 1)) {
    if (record.type !== 0x003c) break;
    segments.push(record.data);
  }
  const strings: Array<string> = [];
  let segment = 0;
  let at = 8;
  const unique = new DataView(segments[0]!.buffer, segments[0]!.byteOffset + 4, 4).getUint32(
    0,
    true,
  );
  const byte = () => {
    while (segment < segments.length && at >= segments[segment]!.length) {
      segment += 1;
      at = 0;
    }
    return segments[segment]?.[at++] ?? 0;
  };
  for (let n = 0; n < unique && segment < segments.length; n += 1) {
    const count = byte() | (byte() << 8);
    let flags = byte();
    const runs = (flags & 0x08) !== 0 ? byte() | (byte() << 8) : 0;
    const ext = (flags & 0x04) !== 0 ? byte() | (byte() << 8) | (byte() << 16) | (byte() << 24) : 0;
    let text = "";
    for (let read = 0; read < count; read += 1) {
      if (segment < segments.length && at >= segments[segment]!.length) {
        segment += 1;
        at = 0;
        flags = (flags & ~0x01) | (byte() & 0x01);
      }
      text += String.fromCharCode((flags & 0x01) !== 0 ? byte() | (byte() << 8) : byte());
    }
    for (let skip = 0; skip < runs * 4 + ext; skip += 1) byte();
    strings.push(text);
  }
  return strings;
};
