// @effect-diagnostics nodeBuiltinImport:off -- fixtures are committed files and ZIPs built byte by byte.
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { readStatementFile } from "./statementFiles.ts";
import { READER_LIMITS, readIsolated, runReader, TOO_LARGE } from "./statementReader.ts";
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
  return workbook(cells, strings);
};
/** An XLSX whose one sheet holds this `sheetData` markup as it is. */
const workbook = (cells: string, strings: ReadonlyArray<string> = []) => {
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

/** A text PDF: each page a list of lines, each line cells placed at x, in Helvetica. */
export const pdf = (
  pages: ReadonlyArray<ReadonlyArray<ReadonlyArray<{ readonly x: number; readonly text: string }>>>,
  extra?: { readonly stream: Uint8Array; readonly filter: string },
  /** The first page's content stream as it is, under this dictionary. */
  content?: { readonly dict: string; readonly data: Uint8Array },
) => {
  const objects: Array<Buffer> = [];
  const add = (body: Buffer | string) => {
    objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    return objects.length;
  };
  const stream = (dict: string, data: Uint8Array) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.byteLength} >>\nstream\n`, "latin1"),
      data,
      Buffer.from("\nendstream", "latin1"),
    ]);
  const catalog = add("");
  const pagesId = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: Array<number> = [];
  const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);
  for (const lines of pages) {
    const ops = lines
      .flatMap((cells, index) =>
        cells.map(
          (cell) => `BT /F1 8 Tf ${cell.x} ${800 - index * 12} Td (${escape(cell.text)}) Tj ET`,
        ),
      )
      .join("\n");
    const contents = add(
      content !== undefined && kids.length === 0
        ? stream(content.dict, content.data)
        : stream("", Buffer.from(ops, "latin1")),
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 600 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  if (extra !== undefined) add(stream(`/Filter ${extra.filter}`, extra.stream));
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, "latin1");
  objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`,
    "latin1",
  );
  const parts: Array<Buffer> = [Buffer.from("%PDF-1.7\n", "latin1")];
  const offsets: Array<number> = [];
  let at = parts[0]!.byteLength;
  for (const [index, body] of objects.entries()) {
    offsets.push(at);
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    parts.push(part);
    at += part.byteLength;
  }
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${at}\n%%EOF\n`,
  ].join("");
  parts.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
};

/** A zlib stream of `megabytes` MiB of zeros, built from one flushed block repeated. */
export const zeros = (megabytes: number) => {
  const block = NodeZlib.deflateRawSync(Buffer.alloc(1024 * 1024), {
    finishFlush: NodeZlib.constants.Z_FULL_FLUSH,
  });
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((((megabytes * 1024 * 1024) % 65521) << 16) | 1) >>> 0, 0);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x78, 0x9c]),
      ...Array.from({ length: megabytes }, () => block),
      NodeZlib.deflateRawSync(Buffer.alloc(0)),
      adler,
    ]),
  );
};

/** A compound file with one "Workbook" stream, as an old binary XLS is. */
export const cfb = (workbook: Uint8Array) => {
  const size = 512;
  const body = Buffer.alloc(Math.max(4096, Math.ceil(workbook.byteLength / size) * size));
  Buffer.from(workbook).copy(body);
  const streamSectors = body.byteLength / size;
  let fatSectors = 1;
  while (streamSectors + 1 + fatSectors > fatSectors * 128) fatSectors += 1;
  const dirSector = streamSectors;
  const fat = Buffer.alloc(fatSectors * size, 0xff);
  for (let id = 0; id < streamSectors; id += 1)
    fat.writeUInt32LE(id === streamSectors - 1 ? 0xfffffffe : id + 1, id * 4);
  fat.writeUInt32LE(0xfffffffe, dirSector * 4);
  for (let id = 0; id < fatSectors; id += 1)
    fat.writeUInt32LE(0xfffffffd, (dirSector + 1 + id) * 4);
  const header = Buffer.alloc(512);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(dirSector, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(0xfffffffe, 60);
  header.writeUInt32LE(0xfffffffe, 68);
  header.fill(0xff, 76);
  for (let id = 0; id < fatSectors; id += 1) header.writeUInt32LE(dirSector + 1 + id, 76 + id * 4);
  const dir = Buffer.alloc(size);
  const entry = (at: number, name: string, type: number, start: number, length: number) => {
    Buffer.from(`${name}\0`, "utf16le").copy(dir, at);
    dir.writeUInt16LE((name.length + 1) * 2, at + 64);
    dir[at + 66] = type;
    dir.writeUInt32LE(start, at + 116);
    dir.writeUInt32LE(length, at + 120);
  };
  entry(0, "Root Entry", 5, 0xfffffffe, 0);
  entry(128, "Workbook", 2, 0, body.byteLength);
  return new Uint8Array(Buffer.concat([header, body, dir, fat]));
};

/** BIFF8 records: a worksheet's BOF, then the given records. */
export const biff = (records: ReadonlyArray<readonly [number, Buffer]>) =>
  Buffer.concat(
    [[0x0809, Buffer.from([0, 6, 0x10, 0])] as const, ...records].map(([type, data]) => {
      const head = Buffer.alloc(4);
      head.writeUInt16LE(type, 0);
      head.writeUInt16LE(data.byteLength, 2);
      return Buffer.concat([head, data]);
    }),
  );
export const numberRecord = (row: number, column: number, value: number) => {
  const data = Buffer.alloc(14);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(column, 2);
  data.writeDoubleLE(value, 6);
  return [0x0203, data] as const;
};

/** An invented account's rows, money in every third, its running balance never below zero. */
const ledger = (count: number) => {
  let balance = 50_000_000;
  return Array.from({ length: count }, (_, index) => {
    const credit = index % 3 === 0;
    const minor = 10_000 + ((index * 7_919) % 90_000);
    balance += credit ? minor : -minor;
    // Fifteen rows a day, 28 days a month, from April 2025.
    const day = Math.floor(index / 15);
    const month = 3 + Math.floor(day / 28);
    return {
      date: `${String(1 + (day % 28)).padStart(2, "0")}/${String(1 + (month % 12)).padStart(2, "0")}/${2025 + Math.floor(month / 12)}`,
      text: `UPI-INVENTED VENDOR ${index % 97}-ref${index}@invbank`,
      credit,
      amount: (minor / 100).toFixed(2),
      balance: (balance / 100).toFixed(2),
    };
  });
};
const ledgerCsv = (count: number) =>
  text(
    [
      "Date,Narration,Chq/Ref Number,Debit Amount,Credit Amount,Closing Balance",
      ...ledger(count).map((row, index) =>
        [
          row.date,
          `"${row.text}"`,
          100_000 + index,
          row.credit ? "" : row.amount,
          row.credit ? row.amount : "",
          row.balance,
        ].join(","),
      ),
    ].join("\n"),
  );
const grouped = (amount: string) =>
  Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2 });
const ledgerPdf = (pages: number, perPage: number) => {
  const rows = ledger(pages * perPage);
  return pdf(
    Array.from({ length: pages }, (_, page) => [
      [{ x: 40, text: "Invented Bank statement of account 50100000009034" }],
      [
        { x: 40, text: "Date" },
        { x: 100, text: "Narration" },
        { x: 330, text: "Withdrawal Amt." },
        { x: 420, text: "Deposit Amt." },
        { x: 500, text: "Closing Balance" },
      ],
      ...rows.slice(page * perPage, (page + 1) * perPage).map((row) => [
        { x: 40, text: row.date },
        { x: 100, text: row.text },
        { x: row.credit ? 420 : 330, text: grouped(row.amount) },
        { x: 500, text: grouped(row.balance) },
      ]),
    ]),
  );
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

describe("hostile statement files", () => {
  const xls = (records: ReadonlyArray<readonly [number, Buffer]>) => cfb(biff(records));
  // Each was shown to take the server down: out of memory, or the event loop held for seconds.
  const hostile: ReadonlyArray<readonly [string, () => Uint8Array, RegExp]> = [
    [
      "an XLSX cell said to be in column ZZZZZZZZ",
      () =>
        workbook(
          '<row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c></row><row r="2"><c r="ZZZZZZZZ2"><v>1</v></c></row>',
        ),
      /no table/,
    ],
    [
      "an XLSX of rows padded out to their last column",
      () =>
        workbook(
          Array.from(
            { length: 10_000 },
            (_, row) => `<row><c r="IV${row + 1}"><v>1</v></c></row>`,
          ).join(""),
        ),
      /far more cells/,
    ],
    [
      "an HTML table of rows that never close",
      () => text(`<table>${"<tr><td>x".repeat(300_000)}`),
      /far more cells/,
    ],
    [
      "a 1 MB PDF whose stream inflates to 1 GiB",
      () =>
        pdf([[[{ x: 40, text: "Invented Bank" }]]], {
          stream: zeros(1_024),
          filter: "/FlateDecode",
        }),
      /far more data/,
    ],
    ["24 MB of commas", () => text(`${",".repeat(299)}\n`.repeat(80_000)), /far more cells/],
    [
      "an XLS claiming a million FAT sectors in a chain that points at itself",
      () => {
        const file = Buffer.from(xls([numberRecord(0, 0, 1)]));
        const self = 1;
        file.writeUInt32LE(1_000_000, 44);
        file.writeUInt32LE(self, 68);
        for (let at = 76; at < 512; at += 4) file.writeUInt32LE(self, at);
        for (let at = 0; at < 512; at += 4) file.writeUInt32LE(self, 512 + self * 512 + at);
        return new Uint8Array(file);
      },
      /couldn't be read/,
    ],
    [
      "an XLS of ten thousand rows each with a cell at column 65,535",
      () => xls(Array.from({ length: 10_000 }, (_, row) => numberRecord(row + 55_535, 65_535, 1))),
      /no table/,
    ],
    [
      "an XLS of ten thousand rows at its last column",
      () => xls(Array.from({ length: 10_000 }, (_, row) => numberRecord(row, 255, 1))),
      /far more cells/,
    ],
  ];

  it.each(hostile)("reads %s as unreadable, in Kin's own bounds", async (_name, file, reason) => {
    const outcome = await readStatementFile(file());
    assert.strictEqual(outcome._tag, "unreadable");
    if (outcome._tag === "unreadable") assert.match(outcome.reason, reason);
  });

  it.live("reads each of them as unreadable in its reader process, and reads on after", () =>
    Effect.gen(function* () {
      for (const [name, file] of hostile)
        assert.strictEqual((yield* readIsolated(file()))._tag, "unreadable", name);
      assert.strictEqual((yield* readIsolated(fixture("hdfc-account.pdf")))._tag, "read");
    }),
  );

  it.live("stops a reader past its time or memory with a reason the owner can act on", () =>
    Effect.gen(function* () {
      const slow = yield* readIsolated(fixture("hdfc-account.pdf"), undefined, {
        ...READER_LIMITS,
        timeoutMs: 1,
      });
      if (slow._tag !== "unreadable") return assert.fail(slow._tag);
      assert.include(slow.reason, "too complex to read safely");
      const big = yield* readIsolated(ledgerCsv(20_000), undefined, {
        ...READER_LIMITS,
        heapMb: 32,
      });
      if (big._tag !== "unreadable") return assert.fail(big._tag);
      assert.strictEqual(big.reason, TOO_LARGE);
    }),
  );

  // Each decodes to gigabytes in the first page's own content stream, which pdf.js reads.
  const page = [[[{ x: 40, text: "Invented Bank" }]]];
  const deflated = (data: Uint8Array) => new Uint8Array(NodeZlib.deflateSync(data));
  const bombs: ReadonlyArray<readonly [string, () => Uint8Array, boolean]> = [
    [
      "a page whose content inflates to 1 GiB",
      () => pdf(page, undefined, { dict: "/Filter /FlateDecode", data: zeros(1_024) }),
      true,
    ],
    [
      "a page compressed twice over, 2 GiB from a few kilobytes",
      () =>
        pdf(page, undefined, {
          dict: "/Filter [/FlateDecode /FlateDecode]",
          data: deflated(zeros(2_048)),
        }),
      true,
    ],
    [
      "a page naming its filter by the short name /Fl",
      () => pdf(page, undefined, { dict: "/Filter /Fl", data: zeros(1_024) }),
      true,
    ],
    [
      "a page naming its filter with a hex escape, /Flate#44ecode",
      () => pdf(page, undefined, { dict: "/Filter /Flate#44ecode", data: zeros(1_024) }),
      true,
    ],
    [
      "a page whose dictionary is padded past a kilobyte after its filter",
      () =>
        pdf(page, undefined, {
          dict: `/Filter /FlateDecode /Pad (${"x".repeat(4_000)})`,
          data: zeros(1_024),
        }),
      true,
    ],
    [
      "a page run-length encoded under deflate, a filter the check doesn't decode",
      () =>
        pdf(page, undefined, {
          dict: "/Filter [/FlateDecode /RunLengthDecode]",
          // Each pair writes 128 zero bytes: 30 MB of pairs is 1.9 GB.
          data: deflated(Buffer.alloc(30 * 1024 * 1024, Buffer.from([0x81, 0x00]))),
        }),
      false,
    ],
  ];

  it.live.each(bombs)(
    "kills the reader of %s at its memory limit, check or no check",
    ([, file, checked]) =>
      Effect.gen(function* () {
        const bytes = file();
        const limit = READER_LIMITS.residentMb * 1024;
        if (checked) {
          const refused = yield* runReader(bytes);
          assert.deepStrictEqual(refused.outcome, {
            _tag: "unreadable",
            reason: "The PDF holds far more data than a statement.",
          });
          assert.isBelow(refused.peakKib, limit);
        }
        const run = yield* runReader(bytes, undefined, { ...READER_LIMITS, precheck: false });
        assert.deepStrictEqual(run.outcome, { _tag: "unreadable", reason: TOO_LARGE });
        assert.strictEqual(run.stopped, "memory");
        // Killed at the first sample past the limit: never the gigabytes the file decodes to.
        assert.isAbove(run.peakKib, limit);
        assert.isBelow(run.peakKib, limit * 2);
      }),
  );

  it.live(
    "reads honest statements whole in its reader, well under its memory limit: CSV and XLSX, 300 PDF pages",
    () =>
      Effect.gen(function* () {
        const rows = ledger(5_000);
        const sheet = xlsx([
          ["Date", "Narration", "Debit", "Credit", "Balance"],
          ...rows.map((row) => [
            row.date,
            row.text,
            row.credit ? "" : Number(row.amount),
            row.credit ? Number(row.amount) : "",
            Number(row.balance),
          ]),
        ]);
        for (const [file, count] of [
          [ledgerCsv(5_000), 5_000],
          [ledgerCsv(20_000), 20_000],
          [sheet, 5_000],
          [ledgerPdf(300, 30), 9_000],
        ] as const) {
          const { outcome, stopped, peakKib } = yield* runReader(file);
          if (outcome._tag !== "read") return assert.fail(JSON.stringify(outcome));
          assert.strictEqual(outcome.statement.rows.length, count);
          assert.strictEqual(outcome.statement.check.status, "adds_up");
          assert.isUndefined(stopped);
          assert.isBelow(peakKib, READER_LIMITS.residentMb * 1024);
        }
      }),
  );

  it.live("opens a locked PDF in its reader process with the owner's password", () =>
    Effect.gen(function* () {
      const locked = fixture("hdfc-account-locked.pdf");
      assert.deepStrictEqual(yield* readIsolated(locked), { _tag: "needs_password" });
      const opened = yield* readIsolated(locked, Redacted.make("lake4821"));
      assert.strictEqual(opened._tag, "read");
    }),
  );
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
