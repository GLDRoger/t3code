import { assert, it } from "@effect/vitest";

import { OFFICE_CAPS, officeProblem } from "./officeCheck.ts";
import { typeMismatch } from "./returnPath.ts";
import { toXlsx } from "./tables.ts";
import { type Part, relationship, rels, types, zip } from "./zip.testkit.ts";

const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const docx = (
  documentRels: ReadonlyArray<string>,
  more: ReadonlyArray<Part> = [],
  extraTypes = "",
) =>
  zip([
    ["[Content_Types].xml", types("word/document.xml", DOCX_TYPE, extraTypes)],
    ["_rels/.rels", rels(relationship("officeDocument", "word/document.xml"))],
    [
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    ],
    ["word/_rels/document.xml.rels", rels(...documentRels)],
    ...more,
  ]);
const docxParts = (documentRels: ReadonlyArray<string> = []): ReadonlyArray<Part> => [
  ["[Content_Types].xml", types("word/document.xml", DOCX_TYPE)],
  ["_rels/.rels", rels(relationship("officeDocument", "word/document.xml"))],
  ["word/document.xml", "<document/>"],
  ["word/_rels/document.xml.rels", rels(...documentRels)],
];

const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/** A DOCX whose document body is `body`, with more parts beside it. */
const docxBody = (body: string, more: ReadonlyArray<Part> = []) =>
  zip([
    ["[Content_Types].xml", types("word/document.xml", DOCX_TYPE)],
    ["word/document.xml", `<w:document ${W}><w:body><w:p>${body}</w:p></w:body></w:document>`],
    ...more,
  ]);
/** A complex field, its instruction split over runs as Word writes long ones. */
const field = (...instruction: ReadonlyArray<string>) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r>${instruction
    .map((text) => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`)
    .join(
      "",
    )}<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
/** An XLSX with one sheet whose cell A1 holds `formula`, escaped as Excel writes it. */
const xlsx = (formula: string, more: ReadonlyArray<Part> = []) =>
  zip([
    ["[Content_Types].xml", types("xl/workbook.xml", XLSX_TYPE)],
    ["xl/workbook.xml", "<workbook/>"],
    [
      "xl/worksheets/sheet1.xml",
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>${formula.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")}</f></c></row></sheetData></worksheet>`,
    ],
    ...more,
  ]);
const PPTX_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
/** A PPTX with one slide whose shape carries `click`, a DrawingML hyperlink action. */
const pptx = (click: string) =>
  zip([
    ["[Content_Types].xml", types("ppt/presentation.xml", PPTX_TYPE)],
    ["ppt/presentation.xml", '<p:presentation xmlns:p="urn:x"/>'],
    [
      "ppt/slides/slide1.xml",
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_RELS}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Button">${click}</p:cNvPr></p:nvSpPr></p:sp></p:spTree></p:cSld></p:sld>`,
    ],
  ]);
/** A Unicode-path extra field naming a part `name`. */
const unicodePath = (name: string) => {
  const text = Buffer.from(name, "utf8");
  const field = Buffer.alloc(9);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(5 + text.length, 2);
  field.writeUInt8(1, 4);
  return Buffer.concat([field, text]);
};
const descriptor =
  (signed: boolean, wrongSize = 0) =>
  (crc: number, packed: number, size: number) => {
    const fields = Buffer.alloc(16);
    fields.writeUInt32LE(0x08074b50, 0);
    fields.writeUInt32LE(crc, 4);
    fields.writeUInt32LE(packed, 8);
    fields.writeUInt32LE(size + wrongSize, 12);
    return signed ? fields : fields.subarray(4);
  };
/** `bytes` with one change made at `at`, as a hand-edited ZIP would have. */
const patched = (bytes: Buffer, write: (bytes: Buffer) => void) => {
  write(bytes);
  return bytes;
};

it("takes plain Office files, the starter pack's workbook and web or email hyperlinks included", async () => {
  const book = toXlsx([
    {
      name: "Invoices",
      cells: [
        [{ text: "Key" }, { text: "=1+1" }],
        [{ text: "INV-1" }, { number: "10.00", currency: "INR" }],
      ],
    },
  ]);
  assert.isUndefined(await typeMismatch("xlsx", book));
  assert.isUndefined(
    await typeMismatch(
      "docx",
      docx([
        relationship("hyperlink", "https://example.invalid/pay", true),
        relationship("hyperlink", "mailto:accounts@example.invalid", true),
        relationship("image", "media/logo.png"),
      ]),
    ),
  );
  const PPTX_TYPE =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
  assert.isUndefined(
    await typeMismatch(
      "pptx",
      zip([
        ["[Content_Types].xml", types("ppt/presentation.xml", PPTX_TYPE)],
        ["_rels/.rels", rels(relationship("officeDocument", "ppt/presentation.xml"))],
        ["ppt/presentation.xml", '<p:presentation xmlns:p="urn:x"/>'],
      ]),
    ),
  );
  for (const [what, kind, bytes] of [
    [
      "a relationship with a prefixed package namespace",
      "docx",
      docx([
        `<r:Relationship xmlns:r="${RELS}" Id="r9" Type="${OFFICE_RELS}/hyperlink" Target="https://example.invalid/pay" TargetMode="External"/>`,
      ]),
    ],
    ["a signed data descriptor", "docx", zip(docxParts(), { descriptor: descriptor(true) })],
    ["an unsigned data descriptor", "docx", zip(docxParts(), { descriptor: descriptor(false) })],
    ["a matching Unicode-path name", "docx", zip(docxParts(), { extra: unicodePath })],
    [
      "page, page-count and table-of-contents fields",
      "docx",
      docxBody(
        `${field(" PAGE ")}<w:fldSimple w:instr=" NUMPAGES "/><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${field(" PAGEREF _Toc1 \\h ")}<w:r><w:fldChar w:fldCharType="end"/></w:r>${field(' HYPERLINK "https://example.invalid/pay" ')}`,
        [
          [
            "word/header1.xml",
            `<w:hdr ${W}>${field(" ", "IF ", "1 = 1 ", field("MERGEFIELD Name"))}</w:hdr>`,
          ],
        ],
      ),
    ],
    ["a SUM formula", "xlsx", xlsx("SUM(A2:A9)*2")],
    [
      "a web HYPERLINK formula",
      "xlsx",
      xlsx('HYPERLINK("https://example.invalid/pay?a=1&b=2", "Pay")'),
    ],
    ["FILTERXML on text in the file", "xlsx", xlsx('FILTERXML("<a>1</a>","//a")')],
    ["a sheet name with a bar in it", "xlsx", xlsx("'Q1|Q2'!A1+1")],
    [
      "a jump to another slide",
      "pptx",
      pptx('<a:hlinkClick r:id="" action="ppaction://hlinkshowjump?jump=nextslide"/>'),
    ],
    [
      "an SVG image that only draws",
      "docx",
      docxBody("", [
        [
          "word/media/image1.svg",
          '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#000"/></svg>',
        ],
      ]),
    ],
  ] as const)
    assert.isUndefined(await typeMismatch(kind, bytes), what);
});

it("refuses Office files that run, embed or load anything, and ZIPs it can't trust", async () => {
  const refused: ReadonlyArray<readonly [string, "xlsx" | "docx" | "pptx", Buffer, string]> = [
    [
      "an external template",
      "docx",
      zip([
        ...docxParts(),
        ["word/settings.xml", "<settings/>"],
        [
          "word/_rels/settings.xml.rels",
          rels(relationship("attachedTemplate", "https://example.invalid/t.dotm", true)),
        ],
      ]),
      "has a attachedTemplate relationship",
    ],
    [
      "an outside image",
      "docx",
      docx([relationship("image", "https://example.invalid/pixel.png", true)]),
      "links a image from outside the file",
    ],
    [
      "a file hyperlink",
      "docx",
      docx([relationship("hyperlink", "file:///etc/passwd", true)]),
      "has a hyperlink that isn't a web or email address",
    ],
    [
      "a UNC hyperlink",
      "docx",
      docx([relationship("hyperlink", "\\\\host\\share", true)]),
      "has a hyperlink that isn't a web or email address",
    ],
    [
      "an OLE object",
      "docx",
      docx([relationship("oleObject", "embeddings/x.bin")]),
      "has a oleObject relationship",
    ],
    [
      "an altChunk",
      "docx",
      docx([relationship("aFChunk", "x.html")]),
      "has a aFChunk relationship",
    ],
    [
      "a frame",
      "docx",
      docx([relationship("frame", "https://example.invalid", true)]),
      "has a frame relationship",
    ],
    [
      "a macro project",
      "docx",
      docx([], [["word/vbaProject.bin", "x"]]),
      "carries word/vbaProject.bin, which runs, embeds or fetches content",
    ],
    [
      "an ActiveX control",
      "docx",
      docx([], [["word/activeX/activeX1.xml", "<x/>"]]),
      "carries word/activeX/activeX1.xml, which runs, embeds or fetches content",
    ],
    [
      "an embedded package",
      "docx",
      docx([], [["word/embeddings/sheet.xlsx", "x"]]),
      "carries word/embeddings/sheet.xlsx, which runs, embeds or fetches content",
    ],
    [
      "a macro content type",
      "docx",
      docx([], [], '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>'),
      "declares application/vnd.ms-office.vbaProject, which runs, embeds or fetches content",
    ],
    [
      "a macro-enabled main part",
      "docx",
      zip([
        [
          "[Content_Types].xml",
          types("word/document.xml", "application/vnd.ms-word.document.macroEnabled.main+xml"),
        ],
        ["word/document.xml", "<d/>"],
      ]),
      "declares application/vnd.ms-word.document.macroEnabled.main+xml, which runs, embeds or fetches content",
    ],
    ["the wrong main part", "xlsx", docx([]), "no xl/workbook.xml"],
    ["an encrypted part", "docx", zip(docxParts(), { flags: 1 }), "an encrypted part"],
    [
      "a CRC that lies",
      "docx",
      zip(docxParts(), { crc: 1 }),
      "[Content_Types].xml doesn't match its ZIP directory",
    ],
    [
      "a climbing name",
      "docx",
      zip([...docxParts(), ["../../x.xml", "<x/>"]]),
      'a part named "../../x.xml"',
    ],
    ["a rooted name", "docx", zip([...docxParts(), ["/x.xml", "<x/>"]]), 'a part named "/x.xml"'],
    [
      "a backslash name",
      "docx",
      zip([...docxParts(), ["word\\x.xml", "<x/>"]]),
      'a part named "word\\\\x.xml"',
    ],
    [
      "two parts with one name",
      "docx",
      zip([...docxParts(), ["WORD/document.xml", "<x/>"]]),
      'two parts named "WORD/document.xml"',
    ],
    [
      "data after the directory",
      "docx",
      zip(docxParts(), { after: Buffer.from("<html>") }),
      "data after its ZIP directory",
    ],
    [
      "data before the directory",
      "docx",
      zip(docxParts(), { before: Buffer.from("smuggled") }),
      "data between its parts and its ZIP directory",
    ],
    [
      "a ZIP64 locator",
      "docx",
      (() => {
        // The locator sits just before the end record, where a ZIP64 reader looks for it.
        const bytes = zip(docxParts());
        bytes.writeUInt32LE(0x07064b50, bytes.length - 42);
        return bytes;
      })(),
      "a ZIP64 directory",
    ],
    [
      "a DOCTYPE in a part",
      "docx",
      docx([], [["x/_rels/y.rels", '<!DOCTYPE r [<!ENTITY a "b">]><r/>']]),
      "x/_rels/y.rels isn't well-formed XML",
    ],
    [
      "too many parts",
      "docx",
      zip([...docxParts(), ...Array.from({ length: 2000 }, (_, i): Part => [`x/${i}.xml`, ""])]),
      "more than 2000 parts",
    ],
    [
      "a part that unpacks far past its packed size",
      "docx",
      docx([], [["big/_rels/a.rels", " ".repeat(5 * 1024 * 1024)]]),
      "has big/_rels/a.rels, which unpacks to far more than any real document does",
    ],
    [
      "a foreign TargetMode shadowing the real one",
      "docx",
      zip([
        ["[Content_Types].xml", types("word/document.xml", DOCX_TYPE)],
        ["word/document.xml", "<document/>"],
        [
          "word/_rels/document.xml.rels",
          rels(
            '<Relationship xmlns:e="urn:evil" Id="r1" ' +
              'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
              'Target="https://example.invalid/tracker.png" ' +
              'TargetMode="External" e:TargetMode="Internal"/>',
          ),
        ],
      ]),
      "links a image from outside the file",
    ],
    [
      "a foreign Target shadowing the real one",
      "docx",
      docx([
        `<Relationship xmlns:e="urn:evil" Id="r1" Type="${OFFICE_RELS}/hyperlink" Target="file:///etc/passwd" e:Target="https://example.invalid" TargetMode="External"/>`,
      ]),
      "has a hyperlink that isn't a web or email address",
    ],
    [
      "a foreign ContentType shadowing a macro type",
      "docx",
      docx(
        [],
        [],
        '<Default xmlns:e="urn:evil" Extension="bin" ContentType="application/vnd.ms-office.vbaProject" e:ContentType="application/xml"/>',
      ),
      "declares application/vnd.ms-office.vbaProject, which runs, embeds or fetches content",
    ],
    [
      "a relationship in another namespace",
      "docx",
      docx([
        `<e:Relationship xmlns:e="urn:evil" Id="r1" Type="${OFFICE_RELS}/image" Target="https://example.invalid/t.png" TargetMode="External"/>`,
      ]),
      "has <e:Relationship>, which Kin doesn't read there (in word/_rels/document.xml.rels)",
    ],
    [
      "a prefixed package relationship that loads from outside",
      "docx",
      docx([
        `<r:Relationship xmlns:r="${RELS}" Id="r1" Type="${OFFICE_RELS}/image" Target="https://example.invalid/t.png" TargetMode="External"/>`,
      ]),
      "links a image from outside the file",
    ],
    [
      "an internal relationship to a web address",
      "docx",
      docx([relationship("image", "https://example.invalid/t.png")]),
      "has a image relationship inside the file that points outside it",
    ],
    [
      "an internal relationship to a UNC path",
      "docx",
      docx([relationship("image", "\\\\host\\share\\t.png")]),
      "has a image relationship inside the file that points outside it",
    ],
    [
      "a padded TargetMode",
      "docx",
      docx([
        `<Relationship Id="r1" Type="${OFFICE_RELS}/image" Target="https://example.invalid/t.png" TargetMode=" External "/>`,
      ]),
      "links a image from outside the file",
    ],
    [
      "a web link with a password",
      "docx",
      docx([relationship("hyperlink", "https://user:secret@example.invalid/pay", true)]),
      "has a web link that carries a user name or password",
    ],
    [
      "a local header saying stored where the directory says deflated",
      "docx",
      patched(
        zip([
          ["[Content_Types].xml", types("word/document.xml", DOCX_TYPE)],
          ["word/document.xml", "<document/>"],
        ]),
        (bytes) => bytes.writeUInt16LE(0, 8),
      ),
      'has a part, "[Content_Types].xml", whose two ZIP headers disagree',
    ],
    [
      "a local size that disagrees",
      "docx",
      patched(zip(docxParts()), (bytes) => bytes.writeUInt32LE(bytes.readUInt32LE(22) + 1, 22)),
      'has a part, "[Content_Types].xml", whose two ZIP headers disagree',
    ],
    [
      "a local CRC that disagrees",
      "docx",
      patched(zip(docxParts()), (bytes) => bytes.writeUInt32LE(1, 14)),
      'has a part, "[Content_Types].xml", whose two ZIP headers disagree',
    ],
    [
      "a local UTF-8 flag the directory lacks",
      "docx",
      patched(zip(docxParts()), (bytes) => bytes.writeUInt16LE(0x0800, 6)),
      'has a part, "[Content_Types].xml", whose two ZIP headers disagree',
    ],
    [
      "a data descriptor that disagrees",
      "docx",
      zip(docxParts(), { descriptor: descriptor(true, 1) }),
      'has a part, "[Content_Types].xml", whose sizes after its data disagree',
    ],
    [
      "two names one Unicode form apart",
      "docx",
      zip([...docxParts(), ["word/caf\u00e9.xml", "<x/>"], ["word/cafe\u0301.xml", "<x/>"]], {
        flags: 0x0800,
      }),
      'two parts named "word/cafe\u0301.xml"',
    ],
    [
      "a name with a trailing dot",
      "docx",
      zip([...docxParts(), ["word/document.xml.", "<x/>"]]),
      'a part named "word/document.xml."',
    ],
    [
      "a folder with a trailing space",
      "docx",
      zip([...docxParts(), ["word /document.xml", "<x/>"]]),
      'a part named "word /document.xml"',
    ],
    [
      "a Unicode-path name that disagrees",
      "docx",
      zip(docxParts(), { extra: () => unicodePath("word/other.xml") }),
      'has a part with two different names, one of them "[Content_Types].xml"',
    ],
    [
      "a non-ASCII name not marked UTF-8",
      "docx",
      zip([...docxParts(), ["word/caf\u00e9.xml", "<x/>"]]),
      "has a part name that isn't marked as UTF-8",
    ],
    [
      "INCLUDEPICTURE split over runs",
      "docx",
      docxBody(field(" INCLUDE", 'PICTURE "https://example.invalid/p.png" \\d ')),
      "has an INCLUDEPICTURE field, which fetches or runs content (in word/document.xml)",
    ],
    [
      "DDEAUTO as a simple field",
      "docx",
      docxBody(`<w:fldSimple w:instr=' DDEAUTO c:\\\\windows\\\\cmd.exe "/k calc" '/>`),
      "has a DDEAUTO field, which fetches or runs content (in word/document.xml)",
    ],
    [
      "DDE in a footer",
      "docx",
      docxBody("", [["word/footer1.xml", `<w:ftr ${W}>${field('DDE "excel" "x"')}</w:ftr>`]]),
      "has a DDE field, which fetches or runs content (in word/footer1.xml)",
    ],
    [
      "INCLUDETEXT in a header",
      "docx",
      docxBody("", [
        [
          "word/header1.xml",
          `<w:hdr ${W}><w:fldSimple w:instr='includetext "https://example.invalid/a.docx"'/></w:hdr>`,
        ],
      ]),
      "has an INCLUDETEXT field, which fetches or runs content (in word/header1.xml)",
    ],
    [
      "LINK in the body",
      "docx",
      docxBody(field('LINK Excel.Sheet.8 "https://example.invalid/b.xls" "" \\a')),
      "has a LINK field, which fetches or runs content (in word/document.xml)",
    ],
    [
      "IMPORT in the body",
      "docx",
      docxBody(field('IMPORT "https://example.invalid/p.wmf"')),
      "has an IMPORT field, which fetches or runs content (in word/document.xml)",
    ],
    [
      "a field whose name a nested field writes",
      "docx",
      docxBody(field(" ", field('QUOTE "INCLUDEPICTURE"'), ' "https://example.invalid/p.png"')),
      "has a field whose name another field writes (in word/document.xml)",
    ],
    [
      "a foreign instr shadowing the real one",
      "docx",
      docxBody(`<w:fldSimple xmlns:e="urn:evil" w:instr="PAGE" e:instr="INCLUDETEXT x"/>`),
      "has two instr attributes on one element (in word/document.xml)",
    ],
    [
      "a form field that runs a macro on entry",
      "docx",
      docxBody(
        '<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:entryMacro w:val="AutoRun"/></w:ffData></w:fldChar></w:r>',
      ),
      "has a form field that runs a macro (in word/document.xml)",
    ],
    [
      "an Excel 4 macro sheet",
      "xlsx",
      xlsx("1", [["xl/macrosheets/sheet1.xml", '<xm:macrosheet xmlns:xm="urn:x"/>']]),
      "carries xl/macrosheets/sheet1.xml, which runs, embeds or fetches content",
    ],
    [
      "a mail merge",
      "docx",
      docxBody("", [["word/settings.xml", `<w:settings ${W}><w:mailMerge/></w:settings>`]]),
      "has a mail merge, which loads data from outside the file (in word/settings.xml)",
    ],
    [
      "an outside picture in legacy drawing markup",
      "docx",
      docxBody(
        '<v:imagedata xmlns:v="urn:schemas-microsoft-com:vml" src="https://example.invalid/p.png"/>',
      ),
      "has a link to something outside the file (in word/document.xml)",
    ],
    [
      "an SVG image that loads from outside",
      "docx",
      docxBody("", [
        [
          "word/media/image1.svg",
          '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.invalid/p)"/></svg>',
        ],
      ]),
      "has word/media/image1.svg, an SVG with a url() to something outside the file",
    ],
    [
      "WEBSERVICE",
      "xlsx",
      xlsx('_xlfn.WEBSERVICE("https://example.invalid/a")'),
      "has a formula that calls WEBSERVICE, which fetches or runs content (in xl/worksheets/sheet1.xml)",
    ],
    [
      "FILTERXML over a web call",
      "xlsx",
      xlsx('_xlfn.FILTERXML(_xlfn.WEBSERVICE("https://example.invalid/a"),"//a")'),
      "has a formula that calls WEBSERVICE, which fetches or runs content (in xl/worksheets/sheet1.xml)",
    ],
    [
      "RTD",
      "xlsx",
      xlsx('rtd("example.server",,"topic")'),
      "has a formula that calls RTD, which fetches or runs content (in xl/worksheets/sheet1.xml)",
    ],
    [
      "IMAGE",
      "xlsx",
      xlsx('_xlfn.IMAGE("https://example.invalid/p.png")'),
      "has a formula that calls IMAGE, which fetches or runs content (in xl/worksheets/sheet1.xml)",
    ],
    [
      "a DDE reference",
      "xlsx",
      xlsx("cmd|' /c calc'!A0"),
      "has a formula that talks to another program (in xl/worksheets/sheet1.xml)",
    ],
    [
      "a file HYPERLINK formula",
      "xlsx",
      xlsx('HYPERLINK("file:///etc/passwd","x")'),
      "has a hyperlink that isn't a web or email address in a formula (in xl/worksheets/sheet1.xml)",
    ],
    [
      "a HYPERLINK formula with a computed address",
      "xlsx",
      xlsx('HYPERLINK(A2&"x")'),
      "has a HYPERLINK formula whose address Kin can't see (in xl/worksheets/sheet1.xml)",
    ],
    [
      "an external-link part",
      "xlsx",
      xlsx("1", [["xl/externalLinks/externalLink1.xml", "<externalLink/>"]]),
      "carries xl/externalLinks/externalLink1.xml, which runs, embeds or fetches content",
    ],
    [
      "a data connection",
      "xlsx",
      xlsx("1", [["xl/connections.xml", "<connections/>"]]),
      "carries xl/connections.xml, which runs, embeds or fetches content",
    ],
    [
      "a slide action that runs a program",
      "pptx",
      pptx('<a:hlinkClick r:id="rId9" action="ppaction://program"/>'),
      "has an action that runs a program or macro (in ppt/slides/slide1.xml)",
    ],
    [
      "a slide hover that runs a macro",
      "pptx",
      pptx('<a:hlinkMouseOver r:id="" action="ppaction://macro?name=Run"/>'),
      "has an action that runs a program or macro (in ppt/slides/slide1.xml)",
    ],
  ];
  for (const [what, kind, bytes, reason] of refused)
    assert.strictEqual(
      await typeMismatch(kind, bytes),
      `it's a ${kind.toUpperCase()} that ${reason}`,
      what,
    );
});

it("streams a sheet of real size, and refuses a part or a file past the budget", async () => {
  // Generated rows, about 40 MiB of sheet XML: a big month, still a plain workbook.
  const rows: Array<string> = [];
  let size = 0;
  for (let n = 1; size < 40 * 1024 * 1024; n += 1) {
    const row = `<row r="${n}"><c r="A${n}" t="inlineStr"><is><t>Invented row ${n}</t></is></c><c r="B${n}"><v>${n}.25</v></c></row>`;
    rows.push(row);
    size += row.length;
  }
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
  const book = xlsx("1", [["xl/worksheets/sheet2.xml", sheet]]);
  assert.isAbove(sheet.length, 40 * 1024 * 1024);
  assert.isUndefined(await typeMismatch("xlsx", book));
  const mib = 1024 * 1024;
  assert.strictEqual(
    await officeProblem("xlsx", book, { ...OFFICE_CAPS, partBytes: 32 * mib }),
    "has xl/worksheets/sheet2.xml, which is too large for Kin to check",
  );
  assert.strictEqual(
    await officeProblem("xlsx", book, { ...OFFICE_CAPS, inflatedBytes: 40 * mib }),
    "has more XML than Kin checks in one file",
  );
});
