// @effect-diagnostics nodeBuiltinImport:off -- the chart fixtures are read from disk.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { cleanKinVisualSvg, kinVisualSaveBytes } from "./kinVisualSvg.ts";

const svg = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${inner}</svg>`;
const cleaned = (text: string) => {
  const out = cleanKinVisualSvg(text);
  return "svg" in out ? out.svg : `refused: ${out.error}`;
};
const fixture = (name: string) =>
  NodeFS.readFileSync(new URL(`./__fixtures__/kinVisualSvg/${name}.svg`, import.meta.url), "utf8");
const tags = (text: string, name: string) =>
  Array.from(text.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g")), (match) =>
    match[0].replace(/\s+>$/, ">"),
  );

describe("cleanKinVisualSvg", () => {
  it.each([
    ["a script", "<script>alert(1)</script><rect/>", "<rect></rect>"],
    ["a prefixed script", '<s:script xmlns:s="http://www.w3.org/2000/svg">x()</s:script>', ""],
    [
      "foreignObject",
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onclick="x()">Hi</div></foreignObject>',
      "",
    ],
    ["an XHTML script", '<h:script xmlns:h="http://www.w3.org/1999/xhtml">x()</h:script>', ""],
    ["event handlers", '<rect onclick="x()" OnLoad="y()" width="2"/>', '<rect width="2"></rect>'],
    [
      "a javascript: link",
      '<a href="javascript:alert(1)"><text>Go</text></a>',
      "<a><text>Go</text></a>",
    ],
    ["an outside xlink:href", '<use xlink:href="https://x.example/a.svg#a"/>', "<use></use>"],
    [
      "same-document references",
      '<use href="#a" xlink:href="#b"/>',
      '<use href="#a" xlink:href="#b"></use>',
    ],
    [
      "a data: image",
      '<image href="data:image/png;base64,iVBORw0KGgo="/>',
      '<image href="data:image/png;base64,iVBORw0KGgo="></image>',
    ],
    ["a data: SVG image", '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>', "<image></image>"],
    ["a data: page link", '<a href="data:text/html,hi"></a>', "<a></a>"],
    [
      "an outside url()",
      '<rect fill="url(https://x.example/p.svg#g)" stroke="url(#g)"/>',
      '<rect stroke="url(#g)"></rect>',
    ],
    ["an escaped url()", '<rect style="fill:u\\72l(https://x.example/p)"/>', "<rect></rect>"],
    [
      "an animation that sets a link",
      '<a href="#x"><set attributeName="href" to="javascript:alert(1)"/></a>',
      '<a href="#x"></a>',
    ],
    [
      "an outside base",
      '<g xml:base="https://x.example/"><use href="#a"/></g>',
      '<g><use href="#a"></use></g>',
    ],
    [
      "an unknown namespace's attribute",
      '<rect xmlns:ev="http://www.w3.org/2001/xml-events" ev:event="click"/>',
      '<rect xmlns:ev="http://www.w3.org/2001/xml-events"></rect>',
    ],
    ["comments", "<!-- x --><rect/>", "<rect></rect>"],
    [
      "text that reads as markup",
      "<text>a &lt;b&gt; &amp; c</text>",
      "<text>a &lt;b&gt; &amp; c</text>",
    ],
  ])("takes out %s", (_, inner, kept) => expect(cleaned(svg(inner))).toBe(svg(kept)));

  it("takes out what sits outside the drawing", () =>
    expect(
      cleaned(
        `<?xml version="1.0"?><?xml-stylesheet href="https://x.example/s.css"?><!DOCTYPE svg>${svg("<rect/>")}`,
      ),
    ).toBe(svg("<rect></rect>")));

  it.each([
    ["@import", "<style>@import url(https://x.example/s.css);</style>"],
    ["an escaped @import", '<style>@\\69mport "https://x.example/s.css";</style>'],
    ["an outside url() in a style", "<style>rect{fill:url(https://x.example/p)}</style>"],
    ["an unclosed comment in a style", "<style>/* rect{fill:red}</style>"],
    ["an element inside a style", "<style><a/>rect{}</style>"],
  ])("refuses %s, which it can't clean with certainty", (_, inner) =>
    expect(cleaned(svg(inner))).toMatch(/^refused: its styles could load/),
  );

  it.each([
    ["markup that isn't well formed", "<svg"],
    ["a page that isn't SVG", '<html xmlns="http://www.w3.org/1999/xhtml"></html>'],
    ["an entity it would have to expand", `<!DOCTYPE svg [<!ENTITY e "x">]>${svg("&e;")}`],
  ])("refuses %s", (_, text) => expect(cleaned(text)).toMatch(/^refused: /));

  it("keeps an ECharts chart and a Mermaid diagram as they draw", () => {
    for (const name of ["echarts", "mermaid"]) {
      const original = fixture(name);
      const kept = cleaned(original);
      for (const tag of ["path", "rect", "text", "tspan", "g", "style", "marker", "line"])
        expect(tags(kept, tag), `${name} <${tag}>`).toEqual(tags(original, tag));
      expect(cleaned(kept), name).toBe(kept);
    }
    const mermaid = cleaned(fixture("mermaid"));
    for (const label of [">Visit<", ">Trial?<", ">Paid<", "> plan<"])
      expect(mermaid).toContain(label);
    expect(mermaid).toContain('marker-end="url(#kins_flowchart-v2-pointEnd-margin)"');
    expect(mermaid).toContain("@keyframes dash");
    // With HTML labels Mermaid draws text in a foreignObject, which goes: kin.mermaid draws SVG text.
    const htmlLabels = cleaned(fixture("mermaid-html-labels"));
    expect(htmlLabels).toMatch(/^<svg /);
    expect(htmlLabels).not.toContain("foreignObject");
  });
});

describe("kinVisualSaveBytes", () => {
  it("writes an SVG cleaned, any other type as it came, and refuses an SVG that isn't UTF-8", () => {
    const text = new TextEncoder().encode(svg("<script>x()</script><rect/>"));
    const out = kinVisualSaveBytes("image/svg+xml", text);
    expect("bytes" in out ? new TextDecoder().decode(out.bytes) : out.error).toBe(
      svg("<rect></rect>"),
    );
    const csv = new TextEncoder().encode("a,b\n");
    expect(kinVisualSaveBytes("text/csv", csv)).toEqual({ bytes: csv });
    expect(kinVisualSaveBytes("image/svg+xml", Uint8Array.of(0x3c, 0xff, 0x3e))).toEqual({
      error: "it isn't a well-formed SVG file",
    });
  });
});
