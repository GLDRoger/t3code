// Invented attachments for provider-conformance.sh: node provider-fixtures.mjs <apps/server dir> <out dir>
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

const [server, out] = process.argv.slice(2);
const { createCanvas } = NodeModule.createRequire(NodePath.join(server, "package.json"))(
  "@napi-rs/canvas",
);

// A screenshot: a heading, a ticket line and a bar chart whose tallest bar is August.
{
  const canvas = createCanvas(1200, 800);
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 1200, 800);
  g.fillStyle = "#111111";
  g.font = "bold 40px Helvetica";
  g.fillText("Marigold Bakery: Q3 orders", 60, 80);
  g.font = "28px Helvetica";
  g.fillText("Ticket KX-4471 is waiting on the oven supplier.", 60, 140);
  const bars = [
    ["Jul", 120, "#2e7d32"],
    ["Aug", 310, "#1565c0"],
    ["Sep", 205, "#c62828"],
  ];
  bars.forEach(([month, value, colour], index) => {
    const x = 220 + index * 290;
    g.fillStyle = colour;
    g.fillRect(x, 700 - value, 160, value);
    g.fillStyle = "#111111";
    g.fillText(month, x + 50, 745);
  });
  NodeFS.writeFileSync(NodePath.join(out, "chart.png"), canvas.toBuffer("image/png"));
}

const pdf = (objects) => {
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const body = Buffer.isBuffer(object) ? object : Buffer.from(object, "binary");
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(chunk);
    length += chunk.length;
  });
  const entries = offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
};
const pages = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";

// A scanned page: the words are pixels only, with no text layer.
{
  const canvas = createCanvas(1275, 1650);
  const g = canvas.getContext("2d");
  g.fillStyle = "#f7f5ef";
  g.fillRect(0, 0, 1275, 1650);
  g.fillStyle = "#1a1a1a";
  g.font = "bold 44px Times New Roman";
  g.fillText("Lease addendum (scanned)", 110, 170);
  g.font = "32px Times New Roman";
  g.fillText("Tenant: Ishaan Verma, Flat 7C, Juniper Court.", 110, 260);
  g.fillText("The parking bay assigned to the tenant is P-19.", 110, 316);
  const jpeg = canvas.toBuffer("image/jpeg", 85);
  const draw = "q 612 0 0 792 0 0 cm /Im1 Do Q";
  NodeFS.writeFileSync(
    NodePath.join(out, "scanned.pdf"),
    pdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      pages,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 1275 /Height 1650 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        ),
        jpeg,
        Buffer.from("\nendstream"),
      ]),
      `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    ]),
  );
}

// A text PDF.
{
  const lines = [
    "Supplier agreement: Copperleaf Linens",
    "Notice period: 30 days, in writing.",
    "Late delivery credit: 4 percent of the invoice.",
  ];
  const text = `BT /F1 18 Tf 72 720 Td ${lines.map((line, index) => `${index ? "0 -28 Td " : ""}(${line}) Tj`).join(" ")} ET`;
  NodeFS.writeFileSync(
    NodePath.join(out, "text.pdf"),
    pdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      pages,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    ]),
  );
}

// Compressed object streams: "Pantry lease: notice period 45 days", "Late delivery credit: 7%".
NodeFS.copyFileSync(
  NodePath.join(server, "src/kin/lead/turn/fixtures/object-streams.pdf"),
  NodePath.join(out, "compressed.pdf"),
);

// A one-sheet workbook, deflated as Excel writes it.
{
  const rows = [
    ["Week", "Orders"],
    ["Week 1", 120],
    ["Week 2", 95],
    ["Week 3", 143],
  ];
  const cell = (value, ref) =>
    typeof value === "number"
      ? `<c r="${ref}"><v>${value}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const sheet = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row.map((value, c) => cell(value, `${"AB"[c]}${r + 1}`)).join("")}</row>`,
    )
    .join("");
  const xml = '<?xml version="1.0" encoding="UTF-8"?>';
  const rels = "http://schemas.openxmlformats.org/package/2006/relationships";
  const officeRels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const files = {
    "[Content_Types].xml": `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `${xml}<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${officeRels}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${xml}<workbook xmlns="${main}" xmlns:r="${officeRels}"><sheets><sheet name="Orders" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${xml}<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${officeRels}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `${xml}<worksheet xmlns="${main}"><sheetData>${sheet}</sheetData></worksheet>`,
  };
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const packed = NodeZlib.deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(NodeZlib.crc32(raw), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(NodeZlib.crc32(raw), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  NodeFS.writeFileSync(
    NodePath.join(out, "orders.xlsx"),
    Buffer.concat([...local, directory, end]),
  );
}
