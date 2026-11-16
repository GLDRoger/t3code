import { describe, expect, it } from "vite-plus/test";

import {
  KIN_VISUAL_OUTER_DOCUMENT,
  KIN_VISUAL_PAGE_GUIDE,
  kinVisualContentSecurityPolicy,
  kinVisualFileReferences,
  kinVisualHost,
  kinVisualHostUnicode,
  kinVisualPageDocument,
  kinVisualSaveFile,
  readKinVisualMessage,
  resolveKinVisualFileReferences,
} from "./kinVisual.ts";

describe("kinVisualContentSecurityPolicy", () => {
  it("seals the page: no outside host anywhere until the owner allows one, and never for script or frames", () => {
    expect(kinVisualContentSecurityPolicy("page")).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'self'; style-src 'unsafe-inline'; img-src data: blob: 'self'; font-src data: 'self'; media-src data: blob: 'self'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'; require-trusted-types-for 'script'; trusted-types default kin; sandbox allow-scripts",
    );
    expect(kinVisualContentSecurityPolicy("outer")).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; worker-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
    );
    const allowed = kinVisualContentSecurityPolicy("page", [
      "tiles.example.com",
      // Anything that is not a bare host is dropped, so a stored row cannot widen a directive.
      "evil.example.com; script-src *",
      "*",
      "https://x.example.com",
    ]);
    expect(allowed).toContain("img-src data: blob: 'self' https://tiles.example.com;");
    expect(allowed).toContain("connect-src https://tiles.example.com;");
    expect(allowed).toContain("script-src 'unsafe-inline' 'unsafe-eval' 'self';");
    expect(allowed).toContain("frame-src 'none'");
    expect(allowed).not.toMatch(/evil|\*|x\.example/);
  });
});

describe("kinVisualHost", () => {
  it.each([
    ["Tiles.Example.com", "tiles.example.com"],
    ["https://fonts.example.com/css?family=x", "fonts.example.com"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
  ])("reads %s as %s", (input, host) => expect(kinVisualHost(input)).toBe(host));

  it.each([
    "localhost",
    "kin-secret-q3.localhost",
    "printer.local",
    "db.internal",
    "nas.home.arpa",
    "router.lan",
    "localhost.localdomain",
    "10.0.0.1",
    "example.com:8443",
    "*.example.com",
    "http://example.com",
    "example.com; script-src *",
    "exa mple.com",
    "'self'",
    "",
  ])("refuses %s", (input) => expect(kinVisualHost(input)).toBeNull());
});

/** What a page document hands the prelude's own `document.write`: the markup and the hosts. */
const writeCall = (page: string) => {
  const call = "<script>document.write(";
  expect(page.endsWith(")</script>")).toBe(true);
  return JSON.parse(
    `[${page.slice(page.lastIndexOf(call) + call.length, -")</script>".length)}]`,
  ) as [string, string];
};
const written = (page: string) => writeCall(page)[0];

describe("kinVisualPageDocument", () => {
  it("puts the theme and the helper ahead of the agent's markup and leaves that markup alone", () => {
    const html =
      '<!doctype html><html><head><title>x</title></head><body><p onclick="go()">hi</p></body></html>';
    const page = written(kinVisualPageDocument(html));
    const helper = page.indexOf('<style id="kin-visual">');
    expect(page.indexOf('<style id="t3-theme">')).toBeGreaterThan(-1);
    expect(helper).toBeGreaterThan(page.indexOf('<style id="t3-theme">'));
    expect(helper).toBeLessThan(page.indexOf("<title>"));
    expect(
      page.endsWith('<title>x</title></head><body><p onclick="go()">hi</p></body></html>'),
    ).toBe(true);
    expect(page).toContain("window.kin=");
  });

  it("hands every byte the agent wrote to the prelude, and none of it can close the script early", () => {
    for (const html of [
      "<script>first()</script><p>no head</p></script><script>evil()</script>",
      "<!-- note --><!DOCTYPE html><script>first()</script>",
    ]) {
      const page = kinVisualPageDocument(html);
      expect(page.startsWith('<!doctype html><script>(function(){"use strict";')).toBe(true);
      expect(page.split("</script>")).toHaveLength(3);
      expect(page.split("<script>")).toHaveLength(3);
      expect(written(page)).toContain("<script>first()</script>");
    }
  });

  it("tells the prelude which outside hosts the response allows, and only bare ones", () => {
    expect(
      writeCall(kinVisualPageDocument("<p>x</p>", ["tiles.example.com", "x.com; script-src *"]))[1],
    ).toBe("https://tiles.example.com");
    expect(writeCall(kinVisualPageDocument("<p>x</p>"))[1]).toBe("");
  });

  it("holds no agent content in the outer document, and its frame cannot download", () => {
    expect(KIN_VISUAL_OUTER_DOCUMENT).toContain('"sandbox","allow-scripts")');
    expect(KIN_VISUAL_OUTER_DOCUMENT).not.toContain("allow-downloads");
    expect(KIN_VISUAL_OUTER_DOCUMENT).toContain('"?frame=1"+location.hash');
  });
});

describe("kinVisualHostUnicode", () => {
  it.each([
    ["xn--bcher-kva.example", "bücher.example"],
    ["xn--80ak6aa92e.com", "аррӏе.com"],
    ["plain.example", null],
    ["xn--zz.example", null],
  ])("reads %s as %s", (host, unicode) => expect(kinVisualHostUnicode(host)).toBe(unicode));
});

describe("kinVisualSaveFile", () => {
  it.each([
    ["rows", "text/csv", "rows.csv"],
    ["Chart.PNG", "image/png", "Chart.png"],
    ["Kin invoice.pdf.command", "text/csv; charset=utf-8", "Kin invoice.pdf.command.csv"],
    ["../../etc/passwd", "text/plain", "etc-passwd.txt"],
    ["report\u202Efdp.json", "application/json", "reportfdp.json"],
    ["a\u0000b\nc.svg", "image/svg+xml", "abc.svg"],
    ["...", "application/pdf", "visual.pdf"],
  ])("saves %j as %s to %s", (name, mimeType, saved) =>
    expect(kinVisualSaveFile(name, mimeType)?.name).toBe(saved),
  );

  it.each([
    ["page.html", "text/html"],
    ["Kin invoice.pdf.command", "application/x-sh"],
    ["run.js", "text/javascript"],
    ["x", "application/octet-stream"],
  ])("refuses %s as %s", (name, mimeType) => expect(kinVisualSaveFile(name, mimeType)).toBeNull());
});

describe("chat file references", () => {
  it("finds each id once and swaps in only the URLs it was given", () => {
    const html =
      '<img src="kin-file:kin-chat-a"><video src="kin-file:kin-chat-b"></video><img src=kin-file:kin-chat-a>';
    expect(kinVisualFileReferences(html)).toEqual(["kin-chat-a", "kin-chat-b"]);
    expect(resolveKinVisualFileReferences(html, { "kin-chat-a": "/api/assets/t/file" })).toBe(
      '<img src="/api/assets/t/file"><video src="kin-file:kin-chat-b"></video><img src=/api/assets/t/file>',
    );
    expect(resolveKinVisualFileReferences("kin-file:constructor", {})).toBe("kin-file:constructor");
  });
});

describe("readKinVisualMessage", () => {
  it("reads only a height, a web link, a host or a file to save, and only from the outer document's envelope", () => {
    expect(readKinVisualMessage({ kinVisual: true, type: "height", height: 412.4 })).toEqual({
      type: "height",
      height: 412.4,
    });
    expect(
      readKinVisualMessage({ kinVisual: true, type: "link", url: "https://example.com/a?b=1" }),
    ).toEqual({ type: "link", url: "https://example.com/a?b=1" });
    expect(
      readKinVisualMessage({ kinVisual: true, type: "blocked", host: "CDN.example.com" }),
    ).toEqual({ type: "blocked", host: "cdn.example.com" });
    const save = { type: "save", name: "rows.csv", mimeType: "text/csv", data: "YSxiCjEsMgo=" };
    expect(readKinVisualMessage({ kinVisual: true, ...save })).toEqual(save);
    for (const forged of [
      { kinVisual: true, ...save, mimeType: "text/html; x" },
      { kinVisual: true, ...save, name: "" },
      { kinVisual: true, ...save, data: "not base64!" },
      { kinVisual: true, ...save, data: "A".repeat(12 * 1024 * 1024) },
      { type: "height", height: 10 },
      { kinVisual: true, type: "height", height: -1 },
      { kinVisual: true, type: "link", url: "javascript:alert(1)" },
      { kinVisual: true, type: "link", url: "kin://approve" },
      { kinVisual: true, type: "link", url: `https://example.com/${"a".repeat(2100)}` },
      { kinVisual: true, type: "blocked", host: "example.com; script-src *" },
      { kinVisual: true, type: "approve", widgetId: "approval:1" },
      { jsonrpc: "2.0", method: "ui/open-link", params: { url: "https://example.com" } },
      "height",
      null,
    ]) {
      expect(readKinVisualMessage(forged)).toBeUndefined();
    }
  });
});

describe("KIN_VISUAL_PAGE_GUIDE", () => {
  it("gives the exact script tag for each library and never a CDN", () => {
    for (const tag of [
      '<script src="/api/kin/visual-lib/6.1.0/echarts.js"></script>',
      '<script src="/api/kin/visual-lib/12.2.0/mermaid.js"></script>',
      '<script src="/api/kin/visual-lib/7.9.0/d3.js"></script>',
    ]) {
      expect(KIN_VISUAL_PAGE_GUIDE).toContain(tag);
    }
    expect(KIN_VISUAL_PAGE_GUIDE).not.toMatch(/https?:\/\//);
    expect(KIN_VISUAL_PAGE_GUIDE).not.toMatch(/\blead\b/i);
  });
});
