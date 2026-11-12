// @effect-diagnostics nodeBuiltinImport:off -- fixtures plant links and odd files the way a worker could.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { takeOutputs, typeMismatch } from "./returnPath.ts";

const pdf = Buffer.from(
  "%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Pages >> endobj\n%%EOF\n",
);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const xlsx = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("....[Content_Types].xml....xl/workbook.xml....xl/worksheets/sheet1.xml"),
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
        ["link.pdf", "it's a link"],
        ["hard.pdf", "it has another link to it (a hard link)"],
        ["lies.pdf", "its bytes aren't a PDF file"],
        ["big.pdf", "it's over the 0 MB cap"],
        ["folder.pdf", "it isn't a regular file"],
        ["missing.pdf", "it was named but isn't there"],
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

it("checks leading bytes and refuses unsafe SVG and macro workbooks", () => {
  assert.isUndefined(typeMismatch("pdf", pdf));
  assert.isDefined(
    typeMismatch("xlsx", Buffer.from("PK\x03\x04[Content_Types].xml word/document.xml")),
  );
  assert.strictEqual(
    typeMismatch("xlsx", Buffer.concat([xlsx, Buffer.from("xl/vbaProject.bin")])),
    "it carries macros or ActiveX controls",
  );
  assert.isUndefined(
    typeMismatch("svg", Buffer.from('<svg viewBox="0 0 1 1"><rect fill="#000"/></svg>')),
  );
  for (const svg of [
    "<svg><script>alert(1)</script></svg>",
    '<svg onload="x()"></svg>',
    '<svg><a href="https://example.com">x</a></svg>',
    '<svg><image href="file:///etc/passwd"/></svg>',
  ])
    assert.strictEqual(
      typeMismatch("svg", Buffer.from(svg)),
      "it's an SVG with scripts, links or embedded documents",
    );
  assert.strictEqual(
    typeMismatch("csv", Buffer.from([0x61, 0x00, 0x62])),
    "it isn't plain UTF-8 text",
  );
  assert.isDefined(typeMismatch("json", Buffer.from("{not json")));
});
