// @effect-diagnostics nodeBuiltinImport:off - writes and reads look book sets in a temporary folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { PNG } from "pngjs";

import { anythingChanged, compareManifests, compareSets, diffPixels, NOISE } from "./compare.ts";
import { fileOf, type Manifest, readManifest, writeManifest } from "./manifest.ts";

const blank = (width: number, height: number, paint?: (x: number, y: number) => number) => {
  const data = new Uint8Array(width * height * 4).fill(255);
  if (paint !== undefined)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) data[(y * width + x) * 4] = paint(x, y);
  return { width, height, data };
};

const manifest = (files: ReadonlyArray<string>, title = "Kin"): Manifest => ({
  version: 1,
  surface: "web",
  commit: "0123456789abcdef",
  shortCommit: "0123456789",
  capturedAt: "2030-06-04T02:35:00.000Z",
  frozenAt: "2030-06-04T02:35:00.000Z",
  timeZone: "Asia/Kolkata",
  sizes: [{ name: "wide", width: 1440, height: 900 }],
  screens: files.map((file) => ({
    name: file.split(".")[0]!,
    size: "wide",
    file,
    person: "owner",
    masked: [],
  })),
  tab: { owner: { title, icon: "/favicon.svg", iconSha256: "abc" } },
  failed: [],
});

describe("kin look book", () => {
  it("finds no change between equal images, or within rendering noise", () => {
    assert.deepStrictEqual(diffPixels(blank(40, 40), blank(40, 40)), { differing: 0, boxes: [] });
    assert.strictEqual(
      diffPixels(
        blank(40, 40),
        blank(40, 40, () => 255 - NOISE),
      ).differing,
      0,
    );
  });

  it("outlines each changed area once", () => {
    const changed = blank(100, 100, (x, y) =>
      (x >= 5 && x < 20 && y >= 5 && y < 10) || (x >= 80 && y >= 80) ? 0 : 255,
    );
    const diff = diffPixels(blank(100, 100), changed);
    assert.strictEqual(diff.differing, 15 * 5 + 20 * 20);
    assert.deepStrictEqual(diff.boxes, [
      { x: 0, y: 0, width: 32, height: 16 },
      { x: 80, y: 80, width: 20, height: 20 },
    ]);
  });

  it("treats a different size as changed everywhere", () => {
    const diff = diffPixels(blank(10, 10), blank(10, 12));
    assert.deepStrictEqual(diff.boxes, [{ x: 0, y: 0, width: 10, height: 12 }]);
  });

  it("sorts screens into same, changed, new and missing, and counts a changed tab", () => {
    const pixels = (set: "accepted" | "new", file: string) =>
      file === "money.wide.png" && set === "new" ? blank(20, 20, () => 0) : blank(20, 20);
    const comparison = compareManifests(
      manifest(["chats-list.wide.png", "money.wide.png", "invite.wide.png"]),
      manifest(["chats-list.wide.png", "money.wide.png", "docs.wide.png"], "T3 Kin"),
      pixels,
    );
    assert.deepStrictEqual(
      comparison.screens.map((screen) => [screen.file, screen.verdict]),
      [
        ["chats-list.wide.png", "same"],
        ["docs.wide.png", "new"],
        ["invite.wide.png", "missing"],
        ["money.wide.png", "changed"],
      ],
    );
    assert.deepStrictEqual(comparison.counts, { same: 1, changed: 2, new: 1, missing: 1 });
    assert.strictEqual(comparison.tabs[0]?.new?.startsWith("T3 Kin"), true);
    assert.isTrue(anythingChanged(comparison));
    assert.isFalse(
      anythingChanged(
        compareManifests(manifest(["a.wide.png"]), manifest(["a.wide.png"]), () => blank(4, 4)),
      ),
    );
  });

  it("writes a manifest it reads back, refuses a folder without one, and writes the page", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-lookbook-test-"));
    try {
      const accepted = NodePath.join(root, "accepted");
      const next = NodePath.join(root, "new");
      for (const [dir, red] of [
        [accepted, 255],
        [next, 0],
      ] as const) {
        NodeFS.mkdirSync(dir);
        const png = new PNG({ width: 8, height: 8 });
        png.data.fill(255);
        png.data[0] = red;
        NodeFS.writeFileSync(NodePath.join(dir, fileOf("money", "wide")), PNG.sync.write(png));
        writeManifest(dir, manifest([fileOf("money", "wide")]));
      }
      assert.deepStrictEqual(readManifest(next), manifest(["money.wide.png"]));
      assert.throws(() => readManifest(root), /no readable manifest/);
      const out = NodePath.join(root, "out");
      const comparison = compareSets(accepted, next, out);
      assert.strictEqual(comparison.counts.changed, 1);
      const html = NodeFS.readFileSync(NodePath.join(out, "index.html"), "utf8");
      assert.include(html, 'src="accepted/money.wide.png"');
      assert.include(html, 'class="box"');
      assert.isTrue(NodeFS.existsSync(NodePath.join(out, "new", "money.wide.png")));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
