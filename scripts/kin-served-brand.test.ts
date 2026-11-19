import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { checkServedBrand } from "./kin-served-brand.ts";

const FAVICON = '<link rel="icon" href="/favicon.ico" sizes="48x48" />';
const APPLE = '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />';
const MANIFEST = '<link rel="manifest" href="/manifest.webmanifest" />';
const TITLE = "<title>Kin</title>";
const HEAD_END = "</head>";

type Edit = (client: { html: string; manifest: string }) => void;
const inHtml =
  (from: string, to: string): Edit =>
  (client) => {
    if (!client.html.includes(from)) throw new Error(`index.html has no ${from}`);
    client.html = client.html.replace(from, to);
  };
const inManifest =
  (from: string, to: string): Edit =>
  (client) => {
    if (!client.manifest.includes(from)) throw new Error(`the manifest has no ${from}`);
    client.manifest = client.manifest.replace(from, to);
  };

// Each edit is made to the real index.html and manifest as the web scope brands them.
const CASES: ReadonlyArray<readonly [string, ReadonlyArray<Edit>, string | undefined]> = [
  ["the page as Vite builds it", [], undefined],
  ["a cache-busting query", [inHtml('href="/favicon.ico"', 'href="/favicon.ico?v=2"')], undefined],
  [
    "Kin only in <noscript>, inert with scripts on",
    [inHtml(TITLE, "<noscript><title>Kin</title></noscript><title>T3 Code</title>")],
    '<title> is "T3 Code"',
  ],
  [
    "Kin only in a script string",
    [inHtml(TITLE, '<script>const t = "<title>Kin</title>";</script><title>T3 Code</title>')],
    '<title> is "T3 Code"',
  ],
  [
    "Kin only in a template or a comment",
    [inHtml(TITLE, "<template><title>Kin</title></template><!-- <title>Kin</title> -->")],
    "<head> has 0 <title> elements",
  ],
  ["two titles", [inHtml(TITLE, `${TITLE}<title>T3 Code</title>`)], "2 <title> elements"],
  [
    "icon links only inside noscript",
    [inHtml(FAVICON, ""), inHtml(TITLE, `<noscript>${FAVICON}</noscript>${TITLE}`)],
    'links no favicon (<link rel="icon">)',
  ],
  ["no apple-touch icon link", [inHtml(APPLE, "")], "links no apple-touch icon"],
  ["no manifest link", [inHtml(MANIFEST, "")], "links no install manifest"],
  [
    "a manifest without icons",
    [inManifest('"icons": [', '"icons": [], "was": [')],
    "lists no install icons",
  ],
  [
    "an external icon URL",
    [inHtml('href="/favicon.ico"', 'href="https://kin.invalid/favicon.ico"')],
    "only a root-relative path",
  ],
  [
    "a protocol-relative icon URL",
    [inHtml('href="/favicon.ico"', 'href="//kin.invalid/favicon.ico"')],
    "only a root-relative path",
  ],
  [
    "a relative icon path, which resolves under a deep link",
    [inHtml('href="/favicon.ico"', 'href="favicon.ico"')],
    "only a root-relative path",
  ],
  [
    "a relative manifest icon",
    [inManifest('"src": "/icon-192x192.png"', '"src": "icon-192x192.png"')],
    "manifest.webmanifest: an icon names",
  ],
  [
    "a <base> element",
    [inHtml(TITLE, `<base href="https://kin.invalid/" />${TITLE}`)],
    "has a <base> element",
  ],
  [
    "a percent-encoded path the server looks up undecoded",
    [inHtml('href="/favicon.ico"', 'href="/%66avicon.ico"')],
    "%66avicon.ico (linked from index.html) is missing from the client",
  ],
  [
    "a path in another case, found only on a case-insensitive disk",
    [inHtml('href="/favicon.ico"', 'href="/FAVICON.ico"')],
    "FAVICON.ico (linked from index.html) is missing from the client",
  ],
  [
    "a dot segment",
    [inHtml('href="/favicon.ico"', 'href="/assets/../favicon.ico"')],
    "empty or dot segment",
  ],
  ["markup a head can't hold", [inHtml(HEAD_END, `<div>Kin</div>${HEAD_END}`)], "can't read"],
  [
    "a script whose end the check can't be sure of",
    [inHtml(HEAD_END, `<script>"<!--<script>"</script>${HEAD_END}`)],
    "can't read",
  ],
];

describe("checkServedBrand", () => {
  it.effect("reads the page's head as a browser does and requires Kin's name and icons", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkout = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const kinIcons = path.join(checkout, "branding/assets/apps/web/public");
      const page = (yield* fs.readFileString(path.join(checkout, "apps/web/index.html")))
        .replace("<title>T3 Code</title>", TITLE)
        // What the build adds to the head.
        .replace(
          HEAD_END,
          `<script type="module" crossorigin src="/assets/index-a1.js"></script>\n${HEAD_END}`,
        );
      const manifest = (yield* fs.readFileString(
        path.join(checkout, "apps/web/public/manifest.webmanifest"),
      )).replaceAll('"T3 Code"', '"Kin"');
      for (const [name, edits, problem] of CASES) {
        const client = yield* fs.makeTempDirectoryScoped({ prefix: "kin-served-brand-" });
        for (const icon of yield* fs.readDirectory(kinIcons))
          yield* fs.copyFile(path.join(kinIcons, icon), path.join(client, icon));
        const files = { html: page, manifest };
        for (const edit of edits) edit(files);
        yield* fs.writeFileString(path.join(client, "index.html"), files.html);
        yield* fs.writeFileString(path.join(client, "manifest.webmanifest"), files.manifest);
        const problems = (yield* checkServedBrand(client, kinIcons)).join("\n");
        if (problem === undefined) assert.strictEqual(problems, "", name);
        else assert.include(problems, problem, name);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails on an icon that isn't Kin's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkout = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const kinIcons = path.join(checkout, "branding/assets/apps/web/public");
      const client = yield* fs.makeTempDirectoryScoped({ prefix: "kin-served-brand-" });
      for (const icon of yield* fs.readDirectory(kinIcons))
        yield* fs.copyFile(path.join(kinIcons, icon), path.join(client, icon));
      yield* fs.copyFile(
        path.join(checkout, "assets/dev/blueprint-web-favicon.ico"),
        path.join(client, "favicon.ico"),
      );
      yield* fs.writeFileString(
        path.join(client, "index.html"),
        `<!doctype html><html><head>${FAVICON}${APPLE}${MANIFEST}${TITLE}</head></html>`,
      );
      yield* fs.writeFileString(
        path.join(client, "manifest.webmanifest"),
        '{ "name": "Kin", "short_name": "Kin", "icons": [{ "src": "/icon-192x192.png" }] }',
      );
      assert.deepStrictEqual(yield* checkServedBrand(client, kinIcons), [
        `favicon.ico is not Kin's icon (${kinIcons}/favicon.ico)`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
