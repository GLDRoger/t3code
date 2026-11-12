// @effect-diagnostics nodeBuiltinImport:off -- the starter script is run from a temporary folder, as a worker runs it.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

import { typeMismatch } from "./returnPath.ts";
import { STARTER_FILES } from "./starter.ts";
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

/** The starter accountant pack's own workbook writer, run as a worker would run it. */
const starterXlsx = async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-office-"));
  try {
    const script = NodePath.join(root, "build.mjs");
    NodeFS.writeFileSync(script, STARTER_FILES["recipes/accountant-pack/build.mjs"]!);
    const pack = await import(/* @vite-ignore */ NodeURL.pathToFileURL(script).href);
    return {
      book: pack.toXlsx([
        {
          name: "Invoices",
          cells: [
            [{ text: "Key" }, { text: "=1+1" }],
            [{ text: "INV-1" }, { number: "10.00" }],
          ],
        },
      ]) as Buffer,
      toCsv: pack.toCsv as (cells: ReadonlyArray<ReadonlyArray<unknown>>) => string,
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

it("takes plain Office files, the starter pack's workbook and web or email hyperlinks included", async () => {
  const { book } = await starterXlsx();
  assert.isUndefined(typeMismatch("xlsx", book));
  assert.isUndefined(
    typeMismatch(
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
    typeMismatch(
      "pptx",
      zip([
        ["[Content_Types].xml", types("ppt/presentation.xml", PPTX_TYPE)],
        ["_rels/.rels", rels(relationship("officeDocument", "ppt/presentation.xml"))],
        ["ppt/presentation.xml", '<p:presentation xmlns:p="urn:x"/>'],
      ]),
    ),
  );
});

it("refuses Office files that run, embed or load anything, and ZIPs it can't trust", () => {
  const refused: ReadonlyArray<readonly [string, "xlsx" | "docx", Buffer, string]> = [
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
      "carries word/vbaProject.bin, which runs or embeds content",
    ],
    [
      "an ActiveX control",
      "docx",
      docx([], [["word/activeX/activeX1.xml", "<x/>"]]),
      "carries word/activeX/activeX1.xml, which runs or embeds content",
    ],
    [
      "an embedded package",
      "docx",
      docx([], [["word/embeddings/sheet.xlsx", "x"]]),
      "carries word/embeddings/sheet.xlsx, which runs or embeds content",
    ],
    [
      "a macro content type",
      "docx",
      docx([], [], '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>'),
      "declares application/vnd.ms-office.vbaProject, which runs or embeds content",
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
      "declares application/vnd.ms-word.document.macroEnabled.main+xml, which runs or embeds content",
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
      "a part too big to read",
      "docx",
      docx([], [["big/_rels/a.rels", " ".repeat(5 * 1024 * 1024)]]),
      "big/_rels/a.rels is over the size Kin reads",
    ],
  ];
  for (const [what, kind, bytes, reason] of refused)
    assert.strictEqual(
      typeMismatch(kind, bytes),
      `it's a ${kind.toUpperCase()} that ${reason}. Kin takes back Office files with no macros, embedded objects or outside links, plain web and email hyperlinks aside: make it again without them, or return a PDF`,
      what,
    );
});
