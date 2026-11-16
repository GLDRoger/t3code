// @effect-diagnostics nodeBuiltinImport:off -- fixtures plant links and odd files the way a worker could.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { takeOutputs, typeMismatch } from "./returnPath.ts";
import { types, zip } from "./zip.testkit.ts";

const pdf = Buffer.from(
  "%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Pages >> endobj\n%%EOF\n",
);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const xlsx = zip([
  [
    "[Content_Types].xml",
    types(
      "xl/workbook.xml",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    ),
  ],
  ["xl/workbook.xml", "<workbook/>"],
]);

const worktree = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-return-"))),
  (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);

it.effect("takes only named, plain, regular files of the type their names say", () =>
  Effect.gen(function* () {
    const root = yield* worktree;
    const out = NodePath.join(root, "out");
    NodeFS.mkdirSync(out);
    NodeFS.writeFileSync(NodePath.join(out, "invoice.pdf"), pdf);
    NodeFS.writeFileSync(NodePath.join(out, "chart.png"), png);
    NodeFS.writeFileSync(NodePath.join(out, "pack.xlsx"), xlsx);
    NodeFS.writeFileSync(
      NodePath.join(out, "macro.xlsx"),
      zip([
        [
          "[Content_Types].xml",
          types(
            "xl/workbook.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
          ),
        ],
        ["xl/workbook.xml", "<workbook/>"],
        ["xl/vbaProject.bin", "macro"],
      ]),
    );
    NodeFS.writeFileSync(NodePath.join(out, "unnamed.pdf"), pdf);
    NodeFS.writeFileSync(NodePath.join(root, "secret.pdf"), pdf);
    NodeFS.symlinkSync(NodePath.join(root, "secret.pdf"), NodePath.join(out, "link.pdf"));
    NodeFS.linkSync(NodePath.join(root, "secret.pdf"), NodePath.join(out, "hard.pdf"));
    NodeFS.writeFileSync(NodePath.join(out, "lies.pdf"), png);
    NodeFS.writeFileSync(NodePath.join(out, "big.pdf"), Buffer.concat([pdf, Buffer.alloc(4096)]));
    NodeFS.writeFileSync(NodePath.join(out, "page.html"), "<p>hi</p>");
    NodeFS.mkdirSync(NodePath.join(out, "folder.pdf"));
    const result = yield* takeOutputs({
      worktree: root,
      named: [
        "out/invoice.pdf",
        "chart.png",
        "out/pack.xlsx",
        "out/macro.xlsx",
        "out/link.pdf",
        "out/hard.pdf",
        "out/lies.pdf",
        "out/big.pdf",
        "out/page.html",
        "out/folder.pdf",
        "out/missing.pdf",
        "../secret.pdf",
        "out/../secret.pdf",
        "/etc/passwd",
        "out/sub/inner.pdf",
        "secret.exe",
      ],
      caps: { files: 20, fileBytes: 1024, totalBytes: 10_000 },
    });
    assert.deepStrictEqual(
      result.taken.map((one) => [one.name, one.mimeType, one.pages]),
      [
        ["invoice.pdf", "application/pdf", 1],
        ["chart.png", "image/png", null],
        ["pack.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", null],
      ],
    );
    assert.deepStrictEqual(
      result.refused.map((one) => [one.name, one.reason]),
      [
        [
          "page.html",
          "a worker's HTML page doesn't come back as a file: make a PDF or a PNG of it, or the agent sends a page itself with kin_visual",
        ],
        ["../secret.pdf", "it isn't a plain file name in out/"],
        ["out/../secret.pdf", "it isn't a plain file name in out/"],
        ["/etc/passwd", "it isn't a plain file name in out/"],
        ["out/sub/inner.pdf", "it isn't a plain file name in out/"],
        ["secret.exe", ".exe isn't a file type Kin takes back"],
        [
          "macro.xlsx",
          "it's a XLSX that carries xl/vbaProject.bin, which runs, embeds or fetches content",
        ],
        ["link.pdf", "it's a link"],
        ["hard.pdf", "it has another link to it (a hard link)"],
        ["lies.pdf", "its bytes aren't a PDF file"],
        ["big.pdf", "it's over the 0 MB cap"],
        ["folder.pdf", "it isn't a regular file"],
        ["missing.pdf", "it was named but isn't there"],
      ],
    );
    // How to make it again is the worker's to read, kept apart from what the owner sees.
    assert.deepStrictEqual(
      result.refused.flatMap((one) => (one.retry === undefined ? [] : [[one.name, one.retry]])),
      [
        [
          "macro.xlsx",
          "Kin takes back Office files with no macros, embedded objects or outside links, plain web and email hyperlinks aside: make it again without them, or return a PDF.",
        ],
      ],
    );
    // What was never named stays where it is.
    assert.isFalse(result.taken.some((one) => one.name === "unnamed.pdf"));
  }).pipe(Effect.scoped),
);

it.effect("refuses everything when out/ is a link, and past the count and total caps", () =>
  Effect.gen(function* () {
    const root = yield* worktree;
    const elsewhere = NodePath.join(root, "elsewhere");
    NodeFS.mkdirSync(elsewhere);
    NodeFS.writeFileSync(NodePath.join(elsewhere, "a.pdf"), pdf);
    NodeFS.symlinkSync(elsewhere, NodePath.join(root, "out"));
    const linked = yield* takeOutputs({ worktree: root, named: ["out/a.pdf"] });
    assert.deepStrictEqual(linked, {
      taken: [],
      refused: [{ name: "a.pdf", reason: "out/ isn't a plain folder" }],
    });
    NodeFS.rmSync(NodePath.join(root, "out"));
    NodeFS.mkdirSync(NodePath.join(root, "out"));
    for (const name of ["a.pdf", "b.pdf", "c.pdf"])
      NodeFS.writeFileSync(NodePath.join(root, "out", name), pdf);
    const capped = yield* takeOutputs({
      worktree: root,
      named: ["a.pdf", "b.pdf", "c.pdf"],
      caps: { files: 2, fileBytes: 1024, totalBytes: pdf.length + 10 },
    });
    assert.deepStrictEqual(
      capped.taken.map((one) => one.name),
      ["a.pdf"],
    );
    assert.deepStrictEqual(capped.refused, [
      { name: "c.pdf", reason: "a job returns at most 2 files" },
      { name: "b.pdf", reason: "the job's files together are over the 0 MB cap" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("reads only the out/ it checked, even when out/ is swapped right after", () =>
  Effect.gen(function* () {
    const root = yield* worktree;
    const out = NodePath.join(root, "job", "out");
    const other = NodePath.join(root, "another-job");
    NodeFS.mkdirSync(out, { recursive: true });
    NodeFS.mkdirSync(other);
    NodeFS.writeFileSync(NodePath.join(other, "secret.txt"), "private other-job input");
    NodeFS.writeFileSync(NodePath.join(out, "mine.txt"), "mine");
    const real = NodeFS.realpathSync(out);
    let swapped = false;
    const swap = (path: unknown) => {
      if (swapped || String(path) !== real) return;
      swapped = true;
      NodeFS.renameSync(out, `${out}-old`);
      NodeFS.symlinkSync(other, out);
    };
    // The swap lands right after Kin first looks at out/, before it reads the files in it.
    const open = NodeFS.promises.open.bind(NodeFS.promises);
    const realpath = NodeFS.promises.realpath.bind(NodeFS.promises);
    using _open = vi
      .spyOn(NodeFS.promises, "open")
      .mockImplementation(async (path: NodeFS.PathLike, flags?: string | number) => {
        const handle = await open(path, flags);
        swap(path);
        return handle;
      });
    using _realpath = vi
      .spyOn(NodeFS.promises, "realpath")
      .mockImplementation(async (path: NodeFS.PathLike) => {
        const resolved = await realpath(path);
        swap(path);
        return resolved;
      });
    const result = yield* takeOutputs({
      worktree: NodePath.join(root, "job"),
      named: ["secret.txt", "mine.txt"],
    });
    // Linux reads through the open directory and takes mine.txt; elsewhere the swap refuses all.
    assert.notInclude(
      result.taken.map((one) => Buffer.from(one.bytes).toString()),
      "private other-job input",
    );
    assert.isTrue(result.refused.some((one) => one.name === "secret.txt"));
  }).pipe(Effect.scoped),
);

it("checks leading bytes and text", async () => {
  assert.isUndefined(await typeMismatch("pdf", pdf));
  assert.isDefined(
    await typeMismatch("xlsx", Buffer.from("PK\x03\x04[Content_Types].xml word/document.xml")),
  );
  assert.isUndefined(await typeMismatch("xlsx", xlsx));
  assert.strictEqual(
    await typeMismatch("csv", Buffer.from([0x61, 0x00, 0x62])),
    "it isn't plain UTF-8 text",
  );
  assert.isDefined(await typeMismatch("json", Buffer.from("{not json")));
  // A cell a spreadsheet would run as a formula, unless it is a plain number or starts with '.
  assert.isUndefined(
    await typeMismatch("csv", Buffer.from('a,-5,"1,000.50",+3.5\r\n\'=1+1,"\'@x","a ""=q"""\r\n')),
  );
  const fix =
    "a spreadsheet would run it as a formula. Write that cell with a leading ' (as the starter recipes do) or as a plain number";
  for (const [csv, where] of [
    ["a,b\r\nc,=1+1\r\n", 'row 2, column 2 starts with "="'],
    ['"=HYPERLINK(""x"")",b\n', 'row 1, column 1 starts with "="'],
    ["a,@SUM(A1)", 'row 1, column 2 starts with "@"'],
    ["a\n-x", 'row 2, column 1 starts with "-"'],
    ["+cmd", 'row 1, column 1 starts with "+"'],
    ['"\tx"', "row 1, column 1 starts with a tab"],
    ['"\rx"', "row 1, column 1 starts with a carriage return"],
    ["a,  =1", 'row 1, column 2 starts with "="'],
  ] as const)
    assert.strictEqual(await typeMismatch("csv", Buffer.from(csv)), `${where}: ${fix}`, csv);
});

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XL = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
it("takes an SVG only when it parses as a drawing made of listed parts", async () => {
  const svg = (body: string, root = `<svg ${NS} ${XL} viewBox="0 0 10 10">`) =>
    Buffer.from(`${root}${body}</svg>`);
  // What recipes, Typst and charting libraries write.
  for (const body of [
    '<rect fill="#000" width="1" height="1"/>',
    '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url(#g)" style="stroke: url( \'#g\' ); fill-opacity: .5"/>',
    '<defs><symbol id="a"><path d="M0 0L1 1"/></symbol></defs><use xlink:href="#a" x="1"/><use href=" #a"/>',
    '<style type="text/css"><![CDATA[ *{stroke-linejoin: round;} @media print { rect { fill: #000 } } ]]></style><text x="1" xml:space="preserve">a &amp; b &#x41;<tspan>c@d</tspan></text>',
    "<!-- a comment --><g><title>t</title><desc>d</desc></g>",
  ])
    assert.isUndefined(await typeMismatch("svg", svg(body)), body);
  assert.isUndefined(
    await typeMismatch("svg", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<svg ${NS}/>`)),
  );
  const refused = [
    ["<script>alert(1)</script>", "<script>"],
    ['<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>', "<s:script>"],
    ["<SCRIPT>alert(1)</SCRIPT>", "<SCRIPT>"],
    ['<g><script xlink:href="data:,alert(1)"/></g>', "<script>"],
    [
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>',
      "<foreignObject>",
    ],
    ['<h:iframe xmlns:h="http://www.w3.org/1999/xhtml"/>', "<h:iframe>, which isn't SVG"],
    ['<rect onload="x()"/>', "a onload attribute"],
    ['<rect ONLOAD="x()"/>', "a ONLOAD attribute"],
    [
      '<rect ev:event="click" xmlns:ev="http://www.w3.org/2001/xml-events"/>',
      "a ev:event attribute",
    ],
    ['<a href="https://example.invalid">x</a>', "<a>"],
    ['<image href="data:image/png;base64,AA=="/>', "<image>"],
    ['<use href="https://example.invalid/x.svg#a"/>', "a link to something outside the file"],
    ['<use xlink:href="&#x68;ttps://example.invalid#a"/>', "a link to something outside the file"],
    ['<use href="javascript:alert(1)"/>', "a link to something outside the file"],
    ['<set attributeName="href" to="javascript:alert(1)"/>', "<set>"],
    ['<animate attributeName="href"/>', "<animate>"],
    ['<feImage href="https://example.invalid"/>', "<feImage>"],
    ['<rect fill="url(https://example.invalid/t.png)"/>', "a url() to something outside the file"],
    ["<rect fill=\"URL( '//example.invalid' )\"/>", "a url() to something outside the file"],
    ['<rect style="fill: url(x.svg#a)"/>', "a url() to something outside the file"],
    ["<rect style=\"background: image-set('x.png' 1x)\"/>", "CSS that loads or runs something"],
    ['<rect style="width: expression(alert(1))"/>', "CSS that loads or runs something"],
    ['<style>@import "https://example.invalid/t.css";</style>', "@import in its CSS"],
    ["<style>@im<!-- split -->port url(x.css);</style>", "@import in its CSS"],
    ["<style><![CDATA[@import url(x.css);]]></style>", "@import in its CSS"],
    ["<style>@im/**/port url(x.css);</style>", "@import in its CSS"],
    ["<style>@\\69mport url(x.css);</style>", "CSS escapes"],
    ["<style>@font-face { font-family: x }</style>", "@font-face in its CSS"],
    [
      "<style>rect { fill: url(&quot;x.png&quot;) }</style>",
      "a url() to something outside the file",
    ],
    ["<style>/* never closed </style>", "an unclosed CSS comment"],
    ["<style><g/></style>", "an element inside <style>"],
    ["<text>&xxe;</text>", "XML that isn't well formed"],
    ["<g>", "XML that isn't well formed"],
  ] as const;
  for (const [body, why] of refused)
    assert.strictEqual(await typeMismatch("svg", svg(body)), `it's an SVG with ${why}`, body);
  for (const [text, why] of [
    [`<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}>&x;</svg>`, "a DOCTYPE"],
    [
      `<?xml-stylesheet href="https://example.invalid/t.css"?><svg ${NS}/>`,
      "a processing instruction",
    ],
    [`<?xml version="1.0" encoding="ISO-8859-1"?><svg ${NS}/>`, "a ISO-8859-1 encoding"],
    ['<svg viewBox="0 0 1 1"/>', "<svg>, which isn't SVG"],
    [`<g ${NS}><svg/></g>`, "no <svg> at its root"],
  ] as const)
    assert.strictEqual(
      await typeMismatch("svg", Buffer.from(text)),
      `it's an SVG with ${why}`,
      text,
    );
  assert.strictEqual(
    await typeMismatch("svg", Buffer.from("not xml")),
    "its bytes aren't a SVG file",
  );
});
