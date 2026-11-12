// @effect-diagnostics nodeBuiltinImport:off -- fixtures are committed files and ZIPs built byte by byte.
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";

import { readStatementFile } from "./statementFiles.ts";
import { checkBalances, parseAmount, parseDay, readTable } from "./statementTable.ts";

// Every statement here is invented: Lakeview Studio, its clients and its accounts are made up.
const fixture = (name: string) =>
  new Uint8Array(NodeFS.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const read = async (bytes: Uint8Array, password?: string) => {
  const outcome = await readStatementFile(bytes, password);
  if (outcome._tag !== "read") assert.fail(`expected a statement, got ${JSON.stringify(outcome)}`);
  return outcome;
};
const text = (value: string) => new TextEncoder().encode(value);

/** A stored (uncompressed) ZIP of these parts, as a minimal XLSX is. */
const zip = (parts: Record<string, string>) => {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;
  for (const [name, body] of Object.entries(parts)) {
    const data = Buffer.from(body, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
};
const SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml";
const xlsx = (rows: ReadonlyArray<ReadonlyArray<string | number>>) => {
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
  const ns = "http://schemas.openxmlformats.org";
  return zip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${SHEET}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${SHEET}.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${SHEET}.sharedStrings+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${ns}/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`,
    "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${ns}/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((one) => `<si><t>${one.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`).join("")}</sst>`,
  });
};

describe("statement values", () => {
  it.each([
    ["02/10/26", "2026-10-02"],
    ["2/10/2026", "2026-10-02"],
    ["02-Oct-26", "2026-10-02"],
    ["02 Oct 2026", "2026-10-02"],
    ["2026-10-02", "2026-10-02"],
    ["02/10/2026 14:31", "2026-10-02"],
    ["31/02/26", undefined],
    ["N275260001234567", undefined],
  ])("reads the day %s", (said, day) => {
    assert.strictEqual(parseDay(said), day);
  });
  it("reads a spreadsheet's day serial", () => {
    assert.strictEqual(parseDay("46297", 46297), "2026-10-02");
  });

  it.each([
    ["1,23,456.78", 12_345_678, false, null],
    ["(500.00)", 50_000, true, null],
    ["1,200.00 Cr", 120_000, false, "credit"],
    ["99.5 Dr", 9_950, false, "debit"],
    ["₹ 4,130.00", 413_000, false, null],
    ["-45", 4_500, true, null],
    ["+ 1,312.50", 131_250, false, "credit"],
  ] as const)("reads the amount %s", (said, minor, negative, marker) => {
    assert.deepStrictEqual(parseAmount(said), { minor, negative, marker });
  });
});

describe("statement files", () => {
  it("reads an HDFC account PDF: columns from the header, wrapped narrations, both pages", async () => {
    const { statement, format } = await read(fixture("hdfc-account.pdf"));
    assert.strictEqual(format, "pdf");
    assert.strictEqual(statement.kind, "account");
    assert.strictEqual(statement.bank, "HDFC Bank");
    assert.strictEqual(statement.account, "4821");
    assert.deepStrictEqual([statement.from, statement.to], ["2026-10-01", "2026-10-31"]);
    assert.deepStrictEqual(
      [statement.openingMinor, statement.closingMinor],
      [25_000_000, 33_500_499],
    );
    assert.strictEqual(statement.rows.length, 20);
    assert.strictEqual(statement.check.status, "adds_up");
    const first = statement.rows[0]!;
    assert.deepStrictEqual(
      [first.date, first.description, first.reference, first.direction, first.amountMinor],
      [
        "2026-10-02",
        "NEFT CR-ICIC0000001-BRIGHTLINE MEDIA LLP- INV 26-27 004",
        "N275260001234567",
        "credit",
        11_800_000,
      ],
    );
    assert.strictEqual(first.balanceMinor, 36_800_000);
    // Two identical tea payments on one day stay two rows.
    assert.lengthOf(
      statement.rows.filter((row) => row.description === "UPI-CHAI POINT-chai@invbank"),
      2,
    );
    assert.strictEqual(
      statement.rows.find((row) => row.description.startsWith("SMS CHGS"))?.amountMinor,
      1_770,
    );
  });

  it("asks for a statement PDF's password, refuses a wrong one and opens with the right one", async () => {
    const locked = fixture("hdfc-account-locked.pdf");
    assert.deepStrictEqual(await readStatementFile(locked), { _tag: "needs_password" });
    assert.deepStrictEqual(await readStatementFile(locked, "lake0000"), {
      _tag: "wrong_password",
    });
    const { statement } = await read(locked, "lake4821");
    assert.strictEqual(statement.account, "4821");
    assert.strictEqual(statement.rows.length, 20);
  });

  it("reads an HDFC card PDF: Cr marks payments, foreign spends keep their currency", async () => {
    const { statement } = await read(fixture("hdfc-card.pdf"));
    assert.strictEqual(statement.kind, "card");
    assert.strictEqual(statement.account, "7710");
    assert.deepStrictEqual([statement.from, statement.to], ["2026-09-16", "2026-10-15"]);
    assert.strictEqual(statement.rows.length, 6);
    assert.deepStrictEqual(
      statement.rows.map((row) => row.direction),
      ["debit", "credit", "debit", "debit", "debit", "debit"],
    );
    assert.deepStrictEqual(
      statement.rows.find((row) => row.description.startsWith("FIGMA"))?.foreign,
      { currency: "USD", amountMinor: 1_500 },
    );
    assert.strictEqual(statement.check.status, "adds_up");
  });

  it("says a PDF with no text layer is a scan", async () => {
    assert.deepStrictEqual(await readStatementFile(fixture("scanned.pdf")), {
      _tag: "scanned",
      pages: 1,
    });
  });

  it("reads an old binary XLS download", async () => {
    const { statement, format } = await read(fixture("hdfc-account.xls"));
    assert.strictEqual(format, "xls");
    assert.strictEqual(statement.account, "4821");
    assert.deepStrictEqual(
      statement.rows.map((row) => [row.date, row.direction, row.amountMinor, row.balanceMinor]),
      [
        ["2026-10-02", "credit", 11_800_000, 36_800_000],
        ["2026-10-03", "debit", 413_000, 36_387_000],
        ["2026-10-15", "debit", 1_770, 36_385_230],
      ],
    );
    assert.strictEqual(statement.check.status, "adds_up");
  });

  it("reads an XLSX with a signed amount column and dates as day serials", async () => {
    const { statement, format } = await read(
      xlsx([
        ["Invented Bank statement for account XXXX9034"],
        ["Txn Date", "Description", "Reference", "Amount", "Balance"],
        [46297, "Client payment Brightline", "UTR77", 5000, 15000],
        [46298, "Cloud hosting", "", -1200.5, 13799.5],
      ]),
    );
    assert.strictEqual(format, "xlsx");
    assert.strictEqual(statement.account, "9034");
    assert.deepStrictEqual(
      statement.rows.map((row) => [row.date, row.direction, row.amountMinor, row.reference]),
      [
        ["2026-10-02", "credit", 500_000, "UTR77"],
        ["2026-10-03", "debit", 120_050, null],
      ],
    );
    assert.strictEqual(statement.check.status, "adds_up");
  });

  it("reads a CSV export and an HTML table saved as .xls", async () => {
    const csv = await read(
      text(
        [
          "Date ,Narration ,Value Dat ,Debit Amount ,Credit Amount ,Chq/Ref Number ,Closing Balance",
          '02/10/26 ,"NEFT CR-BRIGHTLINE MEDIA, INV 4" ,02/10/26 ,0.00 ,118000.00 ,N2752 ,368000.00',
          "03/10/26 ,UPI-AWS ,03/10/26 ,4130.00 ,0.00 ,0000627 ,363870.00",
        ].join("\r\n"),
      ),
    );
    assert.strictEqual(csv.format, "csv");
    assert.deepStrictEqual(
      csv.statement.rows.map((row) => [row.description, row.direction, row.reference]),
      [
        ["NEFT CR-BRIGHTLINE MEDIA, INV 4", "credit", "N2752"],
        ["UPI-AWS", "debit", "0000627"],
      ],
    );
    const html = await read(
      text(
        "<html><body><table><tr><th>Date</th><th>Particulars</th><th>Withdrawals</th><th>Deposits</th><th>Balance</th></tr>" +
          "<tr><td>02-Oct-2026</td><td>Rent &amp; maintenance</td><td>25,000.00</td><td></td><td>75,000.00</td></tr></table></body></html>",
      ),
    );
    assert.strictEqual(html.format, "html");
    assert.deepStrictEqual(
      html.statement.rows.map((row) => [row.date, row.description, row.direction, row.amountMinor]),
      [["2026-10-02", "Rent & maintenance", "debit", 2_500_000]],
    );
  });

  it("says plainly when the balances don't add up, instead of guessing", async () => {
    const { statement } = await read(
      text(
        [
          '"Opening Balance: 1,000.00"',
          '"Closing Balance: 1,600.00"',
          "Date,Narration,Withdrawal,Deposit,Balance",
          "01/10/2026,Deposit,,500.00,",
          "02/10/2026,Coffee,20.00,,",
        ].join("\n"),
      ),
    );
    assert.strictEqual(statement.check.status, "off");
    assert.include(statement.check.line, "₹1,480.00");
    assert.include(statement.check.line, "₹120.00 apart");
    const jumped = checkBalances(
      "account",
      [
        { ...statement.rows[0]!, balanceMinor: 150_000 },
        { ...statement.rows[1]!, balanceMinor: 140_000 },
      ],
      100_000,
      null,
      "INR",
    );
    assert.strictEqual(jumped.status, "off");
    assert.include(jumped.line, "row 2");
  });

  it("refuses what isn't a statement", async () => {
    assert.strictEqual(
      (await readStatementFile(text("just some words\nno table here")))._tag,
      "unreadable",
    );
    assert.strictEqual(readTable([[{ text: "Hello" }]])._tag, "no_table");
  });
});
