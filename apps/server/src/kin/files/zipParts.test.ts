import { assert, it } from "@effect/vitest";

import { typeMismatch } from "../gendocs/returnPath.ts";
import { type Part, relationship, rels, types, zip } from "../gendocs/zip.testkit.ts";
import { readStatementFile } from "../work/statements/statementFiles.ts";

const NS = "http://schemas.openxmlformats.org";
const SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

/** An XLSX as Excel saves one: workbook, its rels, shared strings, one sheet, and `more` beside them. */
const xlsx = (
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
  more: ReadonlyArray<Part> = [],
) => {
  const strings: Array<string> = [];
  const cells = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map((value, c) => {
            const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
            if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
            strings.push(value);
            return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
          })
          .join("")}</row>`,
    )
    .join("");
  return zip([
    [
      "[Content_Types].xml",
      types(
        "xl/workbook.xml",
        `${SHEET}.sheet.main+xml`,
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${SHEET}.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${SHEET}.sharedStrings+xml"/>`,
      ),
    ],
    ["_rels/.rels", rels(relationship("officeDocument", "xl/workbook.xml"))],
    [
      "xl/workbook.xml",
      `<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      rels(
        relationship("worksheet", "worksheets/sheet1.xml"),
        relationship("sharedStrings", "sharedStrings.xml"),
      ),
    ],
    [
      "xl/worksheets/sheet1.xml",
      `<worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`,
    ],
    [
      "xl/sharedStrings.xml",
      `<sst xmlns="${NS}/spreadsheetml/2006/main">${strings.map((one) => `<si><t>${one}</t></si>`).join("")}</sst>`,
    ],
    ...more,
  ]);
};

const STATEMENT = [
  ["Invented Bank statement for account XXXX4471"],
  ["Txn Date", "Description", "Reference", "Amount", "Balance"],
  [46297, "Client payment Larkspur Studio", "UTR31", 8000, 18000],
  [46298, "Office rent", "", -2500, 15500],
] as const;

/** `bytes` with the directory's packed and unpacked sizes of `name` set to `size`. */
const declaring = (bytes: Buffer, name: string, size: number) => {
  for (let at = bytes.lastIndexOf(Buffer.from("PK\x01\x02", "latin1")); at >= 0; at -= 1) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) continue;
    const length = bytes.readUInt16LE(at + 28);
    if (bytes.toString("utf8", at + 46, at + 46 + length) !== name) continue;
    bytes.writeUInt32LE(size, at + 20);
    bytes.writeUInt32LE(size, at + 24);
    return bytes;
  }
  throw new Error(`no ${name}`);
};

const TOO_LARGE = "unpacks to more than Kin reads in one file";

/** Both of Kin's ZIP readers on one file: the office checker's reason and the statement reader's. */
const bothRefuse = async (bytes: Uint8Array, reason: string) => {
  assert.strictEqual(await typeMismatch("xlsx", bytes), `it's an XLSX that ${reason}`);
  assert.deepStrictEqual(await readStatementFile(bytes), {
    _tag: "unreadable",
    reason: `Kin doesn't open this spreadsheet: it ${reason}.`,
  });
};

it("refuses a ZIP past a cap, or cut short, the same through the office checker and the statement reader", async () => {
  const sheetOfSpaces = `<worksheet xmlns="${NS}/spreadsheetml/2006/main">${" ".repeat(5 * 1024 * 1024)}</worksheet>`;
  const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
    [
      "a sheet that unpacks a thousand times its packed size",
      xlsx([], [["xl/worksheets/sheet2.xml", sheetOfSpaces]]),
      TOO_LARGE,
    ],
    [
      "a part larger than any Kin reads",
      declaring(xlsx(STATEMENT), "xl/worksheets/sheet1.xml", 300 * 1024 * 1024),
      TOO_LARGE,
    ],
    [
      "more parts than any document has",
      xlsx(
        STATEMENT,
        Array.from({ length: 2_000 }, (_, i): Part => [`xl/media/note${i}.txt`, "x"]),
      ),
      TOO_LARGE,
    ],
    [
      "an archive cut short",
      (() => {
        const whole = xlsx(STATEMENT);
        return whole.subarray(0, whole.length - 40);
      })(),
      "has no ZIP directory at its end",
    ],
  ];
  const wrong: Array<string> = [];
  for (const [what, bytes, reason] of cases)
    await bothRefuse(bytes, reason).catch((error: unknown) => wrong.push(`${what}: ${error}`));
  assert.deepStrictEqual(wrong, []);
});

it("reads a real-shaped XLSX and DOCX through both callers", async () => {
  const book = xlsx(STATEMENT);
  assert.isUndefined(await typeMismatch("xlsx", book));
  const read = await readStatementFile(book);
  if (read._tag !== "read") return assert.fail(JSON.stringify(read));
  assert.strictEqual(read.format, "xlsx");
  assert.strictEqual(read.statement.account, "4471");
  assert.deepStrictEqual(
    read.statement.rows.map((row) => [row.date, row.direction, row.amountMinor, row.reference]),
    [
      ["2026-10-02", "credit", 800_000, "UTR31"],
      ["2026-10-03", "debit", 250_000, null],
    ],
  );

  const letter = zip([
    ["[Content_Types].xml", types("word/document.xml", DOCX)],
    ["_rels/.rels", rels(relationship("officeDocument", "word/document.xml"))],
    [
      "word/document.xml",
      `<w:document xmlns:w="${NS}/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Dear Larkspur Studio, your invoice INV-7 is attached.</w:t></w:r></w:p></w:body></w:document>`,
    ],
    [
      "word/_rels/document.xml.rels",
      rels(relationship("hyperlink", "https://example.invalid/pay", true)),
    ],
  ]);
  assert.isUndefined(await typeMismatch("docx", letter));
  // A letter is no statement: the statement reader says what it lacks, in the same words.
  assert.deepStrictEqual(await readStatementFile(letter), {
    _tag: "unreadable",
    reason: "Kin doesn't open this spreadsheet: it has no xl/workbook.xml.",
  });
});
