// @effect-diagnostics nodeBuiltinImport:off -- a workbook is a small zip written in memory; zlib's deflate and crc32 are synchronous and exact.
import * as NodeZlib from "node:zlib";

import type { Money, Sheet, Value } from "./recipe.ts";

/**
 * A `kind: table` recipe's files: a sheet per declared input, with the columns its RECIPE.md
 * names and a total per currency under each money column, as CSVs and one workbook. Text a
 * spreadsheet would run as a formula is neutralised, and the workbook holds text as text.
 */

type Cell = { readonly text: string } | { readonly number: string; readonly currency: string };

const isMoney = (value: unknown): value is Money =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "minor") === "number" &&
  typeof Reflect.get(value, "currency") === "string";
/** Paise as an exact decimal string: 11800050 is "118000.50". */
const decimal = (minor: number) => {
  const value = BigInt(minor);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
};
type Row = Readonly<Record<string, unknown>>;
const valueAt = (row: Row, field: string): unknown => {
  const [name = "", part] = field.split(".");
  const value = row[name];
  return part === "currency" ? (isMoney(value) ? value.currency : null) : value;
};

/** One sheet's rows as cells, with a total per currency under each money column. */
export const sheetCells = (rows: ReadonlyArray<Row>, sheet: Sheet): ReadonlyArray<Array<Cell>> => {
  const counted = (row: Row) =>
    sheet.leaveOutOfTotals === undefined ||
    !sheet.leaveOutOfTotals.values.includes(String(row[sheet.leaveOutOfTotals.field] ?? ""));
  const header = sheet.columns.map((column): Cell => ({ text: column.header }));
  const body = rows.map((row) =>
    sheet.columns.map((column): Cell => {
      const value = valueAt(row, column.field);
      if (value === null || value === undefined) return { text: "" };
      if (isMoney(value)) return { number: decimal(value.minor), currency: value.currency };
      return { text: String(value) };
    }),
  );
  const moneyColumns = sheet.columns.flatMap((column, index) =>
    rows.some((row) => isMoney(row[column.field])) ? [index] : [],
  );
  const currencies = [
    ...new Set(
      moneyColumns.flatMap((index) =>
        rows
          .map((row) => row[sheet.columns[index]!.field])
          .filter(isMoney)
          .map((value) => value.currency),
      ),
    ),
  ].toSorted();
  const totals = currencies.map((currency) =>
    sheet.columns.map((column, index): Cell => {
      if (index === 0) return { text: currencies.length > 1 ? `Total ${currency}` : "Total" };
      if (!moneyColumns.includes(index)) return { text: "" };
      const sum = rows.reduce((total, row) => {
        const value = row[column.field];
        return counted(row) && isMoney(value) && value.currency === currency
          ? total + BigInt(value.minor)
          : total;
      }, 0n);
      return { number: decimal(Number(sum)), currency };
    }),
  );
  return [header, ...body, ...totals];
};

const PLAIN_NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
/** Text a spreadsheet would run as a formula gets a leading ' so it opens as text. */
const neutralise = (text: string) =>
  /^ *[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text.trim()) ? `'${text}` : text;
const csvCell = (cell: Cell) => {
  const text = "number" in cell ? cell.number : neutralise(cell.text);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export const toCsv = (cells: ReadonlyArray<ReadonlyArray<Cell>>) =>
  `${cells.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    // XML 1.0 has no place for most control characters; a cell drops them.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const columnName = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const sheetXml = (cells: ReadonlyArray<ReadonlyArray<Cell>>) => {
  const rows = cells.map((row, r) => {
    const values = row.map((cell, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      if ("number" in cell) return `<c r="${ref}" s="1"><v>${cell.number}</v></c>`;
      if (cell.text === "") return "";
      return `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="2"' : ""}><is><t xml:space="preserve">${xml(cell.text)}</t></is></c>`;
    });
    return `<row r="${r + 1}">${values.join("")}</row>`;
  });
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${rows.join("")}</sheetData></worksheet>`;
};

const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";

/** A minimal XLSX: a zip of the parts Excel, Numbers, Sheets and LibreOffice all read. */
export const toXlsx = (
  sheets: ReadonlyArray<{
    readonly name: string;
    readonly cells: ReadonlyArray<ReadonlyArray<Cell>>;
  }>,
) => {
  const files: ReadonlyArray<readonly [string, string]> = [
    [
      "[Content_Types].xml",
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${SHEET_TYPE}"/>`).join("")}</Types>`,
    ],
    [
      "_rels/.rels",
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${RELS}"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${RELS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${RELS}/styles" Target="styles.xml"/></Relationships>`,
    ],
    [
      "xl/styles.xml",
      `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf numFmtId="4" applyNumberFormat="1"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    ],
    ...sheets.map(
      (sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet.cells)] as const,
    ),
  ];
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, "utf8");
    const packed = NodeZlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = NodeZlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    // A fixed DOS time (1 Jan 1980): the same rows give the same bytes.
    header.writeUInt32LE(0x00210000, 10);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += header.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
};

/** `{month}` and the like in a file name: a text, month or date input's value. */
export const fileName = (pattern: string, inputs: Readonly<Record<string, Value>>) =>
  pattern.replace(/\{([a-z][A-Za-z0-9_]{0,39})\}/g, (whole, name: string) => {
    const value = inputs[name];
    return typeof value === "string" && /^[A-Za-z0-9 ._()-]{1,40}$/.test(value) ? value : whole;
  });

/** Every file a table recipe makes, by name, from its inputs. */
export const tableFiles = (
  recipe: { readonly sheets: ReadonlyArray<Sheet>; readonly workbook: string | null },
  inputs: Readonly<Record<string, Value>>,
): ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }> => {
  const sheets = recipe.sheets.map((sheet) => {
    const rows = inputs[sheet.input];
    return {
      sheet,
      name: sheet.name,
      cells: sheetCells(Array.isArray(rows) ? (rows as ReadonlyArray<Row>) : [], sheet),
    };
  });
  return [
    ...(recipe.workbook === null
      ? []
      : [{ name: fileName(recipe.workbook, inputs), bytes: toXlsx(sheets) }]),
    ...sheets.flatMap((one) =>
      one.sheet.file === undefined
        ? []
        : [
            {
              name: fileName(one.sheet.file, inputs),
              bytes: new TextEncoder().encode(toCsv(one.cells)),
            },
          ],
    ),
  ];
};
