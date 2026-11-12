import { describe, expect, it } from "vite-plus/test";

import {
  KIN_VISUAL_OUTER_DOCUMENT,
  KIN_VISUAL_PAGE_GUIDE,
  kinVisualContentSecurityPolicy,
  kinVisualFileReferences,
  kinVisualHost,
  kinVisualPageDocument,
  readKinVisualMessage,
  resolveKinVisualFileReferences,
} from "./kinVisual.ts";

describe("kinVisualContentSecurityPolicy", () => {
  it("seals the page: no outside host anywhere until the owner allows one, and never for script or frames", () => {
    expect(kinVisualContentSecurityPolicy("page")).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'self'; style-src 'unsafe-inline'; img-src data: blob: 'self'; font-src data: 'self'; media-src data: blob: 'self'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'; sandbox allow-scripts allow-downloads",
    );
    expect(kinVisualContentSecurityPolicy("outer")).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; worker-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-downloads",
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

describe("kinVisualPageDocument", () => {
  it("puts the theme and the helper ahead of the agent's markup and leaves that markup alone", () => {
    const html =
      '<!doctype html><html><head><title>x</title></head><body><p onclick="go()">hi</p></body></html>';
    const page = kinVisualPageDocument(html);
    const helper = page.indexOf('<style id="kin-visual">');
    expect(page.indexOf('<style id="t3-theme">')).toBeGreaterThan(-1);
    expect(helper).toBeGreaterThan(page.indexOf('<style id="t3-theme">'));
    expect(helper).toBeLessThan(page.indexOf("<title>"));
    expect(
      page.endsWith('<title>x</title></head><body><p onclick="go()">hi</p></body></html>'),
    ).toBe(true);
    expect(page).toContain("window.kin=");
  });

  it("runs the WebRTC prelude before any byte the agent wrote", () => {
    for (const html of [
      "<script>first()</script><p>no head</p>",
      "<!-- note --><!DOCTYPE html><script>first()</script>",
    ]) {
      const page = kinVisualPageDocument(html);
      expect(page.indexOf("RTCPeerConnection")).toBeLessThan(page.indexOf("first()"));
      expect(page.indexOf("<script>")).toBe(page.indexOf('<script>(function(){"use strict"'));
    }
  });

  it("drops resource-hint links from the markup and leaves script text alone", () => {
    const page = kinVisualPageDocument(
      `<head><link rel="preconnect" href="https://a.example"><LINK REL='dns-prefetch' href=//b.example><link rel="icon prefetch" href="c"><link rel="stylesheet" href="d.css"></head><script>var s = '<link rel="preconnect" href="https://kept.example">';</script>`,
    );
    expect(page).not.toMatch(/a\.example|b\.example|href="c"/);
    expect(page).toContain('href="d.css"');
    expect(page).toContain("https://kept.example");
  });

  it("holds no agent content in the outer document", () => {
    expect(KIN_VISUAL_OUTER_DOCUMENT).toContain('"sandbox","allow-scripts allow-downloads"');
    expect(KIN_VISUAL_OUTER_DOCUMENT).toContain('"?frame=1"+location.hash');
  });
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
