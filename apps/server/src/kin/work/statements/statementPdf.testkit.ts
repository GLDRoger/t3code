// @effect-diagnostics nodeBuiltinImport:off -- test PDFs are built byte by byte.
import * as NodeBuffer from "node:buffer";

const { Buffer } = NodeBuffer;

type PdfCell = {
  readonly x: number;
  readonly text: string;
  /** Its baseline; by default each line sits 12 points below the one before. */
  readonly y?: number;
  readonly size?: number;
};
/** A text PDF: each page a list of lines, each line cells placed at x, in Helvetica. */
export const pdf = (
  pages: ReadonlyArray<ReadonlyArray<ReadonlyArray<PdfCell>>>,
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
          (cell) =>
            `BT /F1 ${cell.size ?? 8} Tf ${cell.x} ${cell.y ?? 800 - index * 12} Td (${escape(cell.text)}) Tj ET`,
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
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 638 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents} 0 R >>`,
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
/**
 * An invented three-page statement laid out as one bank prints it: the column header on page 1
 * only, narrations wrapped over the page break, a footer that reads as the table's end, and the
 * balances only in page 3's summary. Every name and figure is made up.
 */
type Spec = {
  readonly day: string;
  readonly lines: ReadonlyArray<readonly [number, string]>;
  readonly ref: readonly [number, string];
  readonly minor: number;
  readonly direction: "debit" | "credit";
};
const SIZE = 7.2;
const WIDTHS: Readonly<Record<string, number>> = { ",": 278, ".": 278 };
const widthOf = (text: string) =>
  [...text].reduce((sum, char) => sum + (WIDTHS[char] ?? 556), 0) * (SIZE / 1000);
const westernMoney = (minor: number) =>
  `${Math.floor(minor / 100).toLocaleString("en-US")}.${String(minor % 100).padStart(2, "0")}`;

const ROWS: ReadonlyArray<Spec> = [
  {
    day: "02/04/26",
    lines: [
      [72, "POS 416021XXXXXX4417 040226 02APR26 13:4"],
      [72, "8:05 CORNERSTONE CAFE BLUE HILL ROAD"],
    ],
    ref: [289, "0000609214455812"],
    minor: 64_000,
    direction: "debit",
  },
  {
    day: "03/04/26",
    lines: [
      [72, "NEFT CR-LKVB0000123-NORTHWIND RETAIL"],
      [68, "PV"],
      [72, "T LTD-STORE DESIGN ADVANCE APR-RENT"],
      [68, "A"],
      [72, "NW-REF0000123456"],
    ],
    ref: [283, "LKVBN26093004417"],
    minor: 418_000,
    direction: "credit",
  },
  {
    day: "06/04/26",
    lines: [
      [72, "POS 416021XXXXXX4417 060426008801 06APR2"],
      [72, "6 11:42:10 GREENLEAF STATIONERS INDIRANAGAR"],
    ],
    ref: [289, "0000609600880112"],
    minor: 21_550,
    direction: "debit",
  },
  {
    day: "09/04/26",
    lines: [
      [72, "POS 416021XXXXXX4417 090426 09APR26 18:1"],
      [72, "2:44 SUNRISE PHARMA LAKE ROAD"],
    ],
    ref: [289, "0000609918122244"],
    minor: 38_900,
    direction: "debit",
  },
  {
    day: "11/04/26",
    lines: [
      [72, "NEFT CR LKVB0000777-BRIGHTLINE MEDIA LL"],
      [72, "P SEPT RETAINER INV-0042 BRIGHT"],
    ],
    ref: [290, "0000N26101104417"],
    minor: 4_500_000,
    direction: "credit",
  },
  {
    day: "14/04/26",
    lines: [
      [72, "IMPS CR-LKVB0LK0042-PARKSIDE RETAIL LLP"],
      [68, "R"],
      [72, "EFUND-APRIL CHARGES REVERSAL-IMPS-4417PR"],
      [72, "0042"],
    ],
    ref: [286, "4417PR0000004417"],
    minor: 300,
    direction: "credit",
  },
  {
    day: "17/04/26",
    lines: [
      [72, "41771200000042-TPT-DESIGN 4-HARBOURLINE"],
      [72, "S LIMITED APR INV"],
    ],
    ref: [289, "0000610417000042"],
    minor: 2_850_000,
    direction: "credit",
  },
  {
    day: "19/04/26",
    lines: [
      [72, "UPI-WAVELENGTH S"],
      [68, "OUND-WAVELENGTHSOUNDSTUDIO42"],
      [72, "-1@okbanklake-LKVB0004417-610400004417-U"],
      [72, "PI"],
    ],
    ref: [289, "0000610419004417"],
    minor: 1_520_000,
    direction: "debit",
  },
  {
    day: "22/04/26",
    lines: [
      [72, "POS 416021XXXXXX4417 220426008802 22APR2"],
      [72, "6 09:10:33 HILLTOP HARDWARE AND PAINTS"],
      [72, "LTD"],
    ],
    ref: [289, "0000611222008802"],
    minor: 245_075,
    direction: "debit",
  },
  {
    day: "24/04/26",
    lines: [
      [72, "POS 416021XXXXXX4417 240426 24APR26 20:3"],
      [72, "0:11 METRO PARKING LAKE ROAD"],
    ],
    ref: [289, "0000611424203011"],
    minor: 590,
    direction: "debit",
  },
  {
    day: "26/04/26",
    lines: [[72, "INT PD 416021XXXXXX4417 INTEREST CREDIT"]],
    ref: [291, "000061142600442"],
    minor: 100,
    direction: "credit",
  },
  {
    day: "28/04/26",
    lines: [
      [72, "UPI-LAKESIDE C"],
      [68, "ATERERS-LAKESIDECATERERS1999"],
      [72, "-2@okbanklake-LKVB0004417-611600004417-U"],
      [72, "PI"],
    ],
    ref: [289, "0000611628004417"],
    minor: 120_000,
    direction: "debit",
  },
  {
    day: "03/05/26",
    lines: [
      [72, "41771200000043-TPT-DESIGN 5-HARBOURLINE"],
      [72, "S LIMITED MAY INV"],
    ],
    ref: [289, "0000612303000043"],
    minor: 3_600_000,
    direction: "credit",
  },
  {
    day: "07/05/26",
    lines: [
      [72, "NEFT CR-LKVB0000123-NORTHWIND RETAIL"],
      [68, "PV"],
      [72, "T LTD-STORE DESIGN SECOND PART-RENT"],
      [68, "A"],
      [72, "NW-REF0000123457"],
    ],
    ref: [283, "LKVBN26100704417"],
    minor: 275_000,
    direction: "credit",
  },
  {
    day: "12/05/26",
    lines: [
      [72, "UPI-NIMBUS CLOU"],
      [68, "D-NIMBUSCLOUDHOSTINGINDIA4"],
      [72, "-1@okbanklake-LKVB0004417-612500004417-U"],
      [72, "PI"],
    ],
    ref: [289, "0000612512004417"],
    minor: 2_200_000,
    direction: "debit",
  },
  {
    day: "15/05/26",
    lines: [
      [72, "POS 416021XXXXXX4417 150526 15MAY26 12:4"],
      [72, "1:09 CORNERSTONE CAFE BLUE HILL RD"],
    ],
    ref: [289, "0000612815124109"],
    minor: 47_800,
    direction: "debit",
  },
  {
    day: "18/05/26",
    lines: [[72, "PG AA 416021XXXXXX4417 ONLINE MAPS SUBSC"]],
    ref: [289, "0000613118000417"],
    minor: 885,
    direction: "debit",
  },
  {
    day: "21/05/26",
    lines: [
      [72, "POS 416021XXXXXX4417 210526 21MAY26 19:0"],
      [72, "3:57 HILLTOP HARDWARE"],
    ],
    ref: [289, "0000613421190357"],
    minor: 61_200,
    direction: "debit",
  },
  {
    day: "24/05/26",
    lines: [[72, "PG AA 416021XXXXXX4417 PARKING APP SUBS"]],
    ref: [289, "0000613724000417"],
    minor: 590,
    direction: "debit",
  },
  {
    day: "27/05/26",
    lines: [[72, "INT PD 416021******4417 CASHBACK CREDIT"]],
    ref: [291, "000061402700442"],
    minor: 400,
    direction: "credit",
  },
  {
    day: "30/05/26",
    lines: [
      [72, "NEFT CR-LKVB0000777-BRIGHTLINE MEDIA-LL"],
      [72, "P OCT RETAINER-INV0047"],
    ],
    ref: [286, "LKVB000061433047"],
    minor: 1_975_000,
    direction: "credit",
  },
  {
    day: "02/06/26",
    lines: [[72, "INT PD 416021******4417 INTEREST QTRLY"]],
    ref: [291, "000061460200442"],
    minor: 250,
    direction: "credit",
  },
  {
    day: "05/06/26",
    lines: [
      [72, "UPI-OAKTREE PRI"],
      [68, "NT-OAKTREEPRINTWORKS10042"],
      [72, "-1@okbanklake-LKVB0004417-614800004417-U"],
      [72, "PI"],
    ],
    ref: [289, "0000614805004417"],
    minor: 310_000,
    direction: "debit",
  },
  {
    day: "10/06/26",
    lines: [
      [72, "UPI-RIVERBEND C XXXXXXXXXXXXXXX42"],
      [72, "-1@okbanklake-LKVB0004417-615300004417-U"],
      [72, "PI"],
    ],
    ref: [289, "0000615310004417"],
    minor: 1_850_000,
    direction: "debit",
  },
  {
    day: "18/06/26",
    lines: [
      [72, "POS 416021XXXXXX4417 180626008803 18JUN2"],
      [72, "6 16:20:41 GREENLEAF STATIONERS INDIRANAGAR"],
    ],
    ref: [289, "0000616118008803"],
    minor: 72_500,
    direction: "debit",
  },
  {
    day: "27/06/26",
    lines: [
      [72, "POS 416021XXXXXX4417 270626 27JUN26 11:3"],
      [72, "5:12 SUNRISE PHARMA LAKE ROAD MAIN"],
    ],
    ref: [289, "0000617027113512"],
    minor: 455_000,
    direction: "debit",
  },
];
const OPENING = 20_461_530;
const AMOUNT_RIGHT = { debit: 470, credit: 548 } as const;
const BALANCE_RIGHT = 627;
// Where each row starts on its page, and how far down its narration runs: as the bank lays it out.
const PLACES: ReadonlyArray<{
  readonly page: number;
  readonly y: number;
  readonly lines: ReadonlyArray<number>;
}> = [
  { page: 1, y: 584, lines: [584, 567] },
  { page: 1, y: 550, lines: [550, 533, 516, 498, 481] },
  { page: 1, y: 464, lines: [464, 447] },
  { page: 1, y: 430, lines: [430, 412] },
  { page: 1, y: 395, lines: [395, 378] },
  { page: 1, y: 361, lines: [361, 344, 326, 309] },
  { page: 1, y: 292, lines: [292, 275] },
  { page: 1, y: 258, lines: [258, 240, 223, 206] },
  { page: 1, y: 189, lines: [189, 172, 154] },
  { page: 1, y: 137, lines: [137, 120] },
  { page: 1, y: 103, lines: [103] },
  // Its narration runs on at the top of page 2, before the next row.
  { page: 1, y: 86, lines: [86] },
  { page: 2, y: 552, lines: [552, 535] },
  { page: 2, y: 518, lines: [518, 501, 484, 466, 449] },
  { page: 2, y: 432, lines: [432, 415, 398, 380] },
  { page: 2, y: 363, lines: [363, 346] },
  { page: 2, y: 329, lines: [329] },
  { page: 2, y: 294, lines: [294, 277] },
  { page: 2, y: 260, lines: [260] },
  { page: 2, y: 226, lines: [226] },
  { page: 2, y: 208, lines: [208, 191] },
  { page: 2, y: 174, lines: [174] },
  { page: 2, y: 157, lines: [157, 140, 122, 105] },
  { page: 2, y: 88, lines: [88, 71] },
  { page: 3, y: 587, lines: [587, 570] },
  { page: 3, y: 552, lines: [552, 535] },
];
// Narration lines a row carries over to the top of the next page.
const CARRIED: Readonly<
  Record<number, { readonly page: number; readonly ys: ReadonlyArray<number> }>
> = {
  11: { page: 2, ys: [604, 587, 570] },
  23: { page: 3, ys: [604] },
};

const banner = (page: number): ReadonlyArray<PdfCell> => [
  { x: 292, y: 817, text: `Page No .: ${page}` },
  { x: 340, y: 783, text: "Account Branch : M G ROAD - OLD CITY" },
  { x: 340, y: 775, text: "Address" },
  { x: 397, y: 775, text: ": GROUND FLOOR & FIRST FLOOR,NO.4417," },
  { x: 403, y: 766, text: "R.K.ROAD, LAKEVIEWNAGAR 3RD CROSS," },
  { x: 403, y: 757, text: "NEAR CLOCK TOWER," },
  { x: 340, y: 748, text: "City" },
  { x: 397, y: 748, text: ": LAKEVIEW 560099" },
  { x: 34, y: 745, text: "M/S." },
  { x: 58, y: 745, text: "LAKEVIEW STUDIO" },
  { x: 340, y: 740, text: "State" },
  { x: 397, y: 740, text: ": KARNATAKA" },
  { x: 34, y: 733, text: "14/22 2ND CROSS ROAD LAKE VIEW LAYOUT" },
  { x: 340, y: 731, text: "Phone no." },
  { x: 397, y: 731, text: ": 08012345/08067890" },
  { x: 34, y: 722, text: "OLD AIRPORT ROAD NORTH DOMLUR STAGE" },
  { x: 340, y: 722, text: "OD Limit" },
  { x: 397, y: 722, text: ": 0.00" },
  { x: 340, y: 714, text: "Currency" },
  { x: 397, y: 714, text: ": INR" },
  { x: 34, y: 710, text: "SOUTHEND" },
  { x: 340, y: 705, text: "Email" },
  { x: 397, y: 705, text: ": studio@example.com" },
  { x: 34, y: 698, text: "LAKEVIEW 560099" },
  { x: 340, y: 696, text: "Cust ID" },
  { x: 397, y: 696, text: ": 400123456" },
  { x: 340, y: 688, text: "Account No" },
  { x: 397, y: 688, text: ": 50100012347788" },
  { x: 465, y: 688, text: "PRIME" },
  { x: 34, y: 687, text: "KARNATAKA INDIA" },
  { x: 340, y: 679, text: "A/C Open Date" },
  { x: 397, y: 679, text: ": 12/03/2019" },
  { x: 340, y: 670, text: "Account Status" },
  { x: 397, y: 670, text: ": Regular" },
  { x: 34, y: 669, text: "JOINT HOLDERS :" },
  { x: 340, y: 662, text: "RTGS/NEFT IFSC" },
  { x: 397, y: 661, text: ": LKVB0004417" },
  { x: 476, y: 661, text: "MICR : 560099017" },
  { x: 340, y: 653, text: "Branch Code" },
  { x: 397, y: 653, text: ": 417" },
  { x: 340, y: 644, text: "Account Type" },
  { x: 397, y: 644, text: ": CURRENT ACCOUNT STUDIO(1234)" },
  { x: 34, y: 643, text: "Nominee : NOT REGISTERED" },
  { x: 34, y: 620, text: "From : 01/04/2026" },
  { x: 154, y: 620, text: "To : 30/06/2026" },
  { x: 340, y: 620, text: "Statement of account" },
];
const FOOTER: ReadonlyArray<PdfCell> = [
  { x: 28, y: 50, text: "LAKEVIEW BANK LIMITED" },
  { x: 28, y: 41, text: "*Closing balance includes uncleared amounts on hold" },
  {
    x: 28,
    y: 32,
    text: "Contents of this statement are treated as correct unless an error is reported in 30 days.",
  },
  { x: 28, y: 25, text: "Lakeview statement." },
  { x: 28, y: 18, text: "Registered office address: 1 Lake Road, Lakeview" },
  { x: 28, y: 11, text: "This statement was generated by the bank and needs no signature." },
  { x: 28, y: 3, text: "Deposit insurance: covered up to the statutory limit." },
];
const HEADER: ReadonlyArray<PdfCell> = [
  { x: 40, y: 602, text: "Date" },
  { x: 144, y: 602, text: "Narration" },
  { x: 284, y: 602, text: "Chq./Ref.No." },
  { x: 362, y: 602, text: "Value Dt" },
  { x: 405, y: 602, text: "Withdrawal Amt." },
  { x: 491, y: 602, text: "Deposit Amt." },
  { x: 564, y: 602, text: "Closing Balance" },
];

const iso = (day: string) => `20${day.slice(6, 8)}-${day.slice(3, 5)}-${day.slice(0, 2)}`;
const right = (edge: number, text: string, y: number): PdfCell => ({
  x: Math.round((edge - widthOf(text)) * 100) / 100,
  y,
  text,
});

/** The statement's PDF, and the rows a careful reader gives back for each page. */
export const threePageStatement = () => {
  const cells: Array<Array<PdfCell>> = [[...banner(1), ...HEADER], [...banner(2)], [...banner(3)]];
  const pages: Array<{ page: number; rows: Array<RowRead> }> = [1, 2, 3].map((page) => ({
    page,
    rows: [],
  }));
  let balance = OPENING;
  for (const [at, spec] of ROWS.entries()) {
    const place = PLACES[at]!;
    const page = cells[place.page - 1]!;
    balance += spec.direction === "credit" ? spec.minor : -spec.minor;
    const carried = CARRIED[at];
    const own = spec.lines.slice(0, place.lines.length);
    page.push(
      { x: 34, y: place.y, text: spec.day },
      { x: spec.ref[0], y: place.y, text: spec.ref[1] },
      { x: 362, y: place.y, text: spec.day },
      right(AMOUNT_RIGHT[spec.direction], westernMoney(spec.minor), place.y),
      right(BALANCE_RIGHT, westernMoney(balance), place.y),
      ...own.map(([x, text], line) => ({ x, y: place.lines[line]!, text })),
    );
    if (carried !== undefined)
      cells[carried.page - 1]!.push(
        ...spec.lines
          .slice(place.lines.length)
          .map(([x, text], line) => ({ x, y: carried.ys[line]!, text })),
      );
    pages[place.page - 1]!.rows.push({
      date: iso(spec.day),
      description: spec.lines.map(([, text]) => text).join(" "),
      reference: spec.ref[1],
      amount: westernMoney(spec.minor),
      direction: spec.direction,
      balance: westernMoney(balance),
    });
  }
  const debits = ROWS.filter((row) => row.direction === "debit");
  const credits = ROWS.filter((row) => row.direction === "credit");
  const sum = (rows: ReadonlyArray<Spec>) => rows.reduce((total, row) => total + row.minor, 0);
  cells[2]!.push(
    { x: 68, y: 501, text: "STATEMENT SUMMARY :-" },
    { x: 132, y: 491, text: "Opening Balance" },
    { x: 290, y: 491, text: "Dr Count" },
    { x: 361, y: 491, text: "Cr Count" },
    { x: 425, y: 491, text: "Debits" },
    { x: 501, y: 491, text: "Credits" },
    { x: 572, y: 491, text: "Closing Bal" },
    { x: 144, y: 479, text: westernMoney(OPENING) },
    { x: 302, y: 479, text: String(debits.length) },
    { x: 373, y: 479, text: String(credits.length) },
    right(452, westernMoney(sum(debits)), 479),
    right(530, westernMoney(sum(credits)), 479),
    right(610, westernMoney(balance), 479),
    { x: 82, y: 421, text: "Generated On: 05-Jul-2026 10:15" },
    { x: 262, y: 421, text: "Generated By: 400123456" },
    { x: 441, y: 421, text: "Requesting Branch Code: NET" },
    { x: 475, y: 360, text: "This is a computer generated statement a" },
    { x: 475, y: 343, text: "nd needs no signature." },
  );
  for (const page of cells) page.push(...FOOTER);
  return {
    bytes: pdf(cells.map((page) => page.map((cell) => [{ ...cell, size: SIZE }]))),
    pages,
    opening: westernMoney(OPENING),
    closing: westernMoney(balance),
  };
};
export type RowRead = {
  readonly date: string;
  readonly description: string;
  readonly reference: string;
  readonly amount: string;
  readonly direction: "debit" | "credit";
  readonly balance: string;
};
