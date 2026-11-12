// @effect-diagnostics nodeBuiltinImport:off -- the starter chart writer is run from a temporary folder, as a worker runs it.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it, vi } from "@effect/vitest";
import { SaxesParser } from "saxes";

import { STARTER_FILES } from "./starter.ts";
import { svgProblem } from "./svgCheck.ts";

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;

it("reads every presentation attribute as CSS, so an escaped url() can't slip through", () => {
  for (const body of [
    '<defs><pattern id="p"/></defs><rect fill="url(#p)" stroke="url( \'#p\' )" font-family="Libertinus Serif"/>',
    '<defs><filter id="f"/><mask id="m"/><clipPath id="c"/><marker id="k"/></defs><path filter="url(#f)" mask="url(#m)" clip-path="url(#c)" marker-start="url(#k)" d="M0 0"/>',
    '<filter id="f"><feColorMatrix values="1 0 0 0 0"/></filter>',
  ])
    assert.isUndefined(svgProblem(svg(body)), body);
  const OUTSIDE = "a url() to something outside the file";
  for (const [body, why] of [
    ['<rect fill="u\\72l(https://example.invalid/paint.svg#p)"/>', "CSS escapes"],
    ['<rect fill="u&#x5c;72l(https://example.invalid/paint.svg#p)"/>', "CSS escapes"],
    ['<rect stroke="url(https://example.invalid/p.svg#p)"/>', OUTSIDE],
    ['<rect stroke="u/**/rl(https://example.invalid/p.svg#p)"/>', OUTSIDE],
    ['<rect filter="url(https://example.invalid/f.svg#f)"/>', OUTSIDE],
    ['<rect mask="url(//example.invalid/m.svg#m)"/>', OUTSIDE],
    ["<rect clip-path=\"url('https://example.invalid/c.svg#c')\"/>", OUTSIDE],
    ['<path marker-start="url(https://example.invalid/k.svg#k)" d="M0 0"/>', OUTSIDE],
    ['<rect cursor="url(https://example.invalid/c.cur)"/>', "a cursor attribute"],
    [
      '<text font-family="x" font-size="image(https://example.invalid/a.png)">a</text>',
      "CSS that loads or runs something",
    ],
    ['<filter id="f"><feColorMatrix values="url(https://example.invalid/v)"/></filter>', OUTSIDE],
    ['<rect><set attributeName="fill" to="url(https://example.invalid/p.svg#p)"/></rect>', "<set>"],
    [
      '<rect><animate attributeName="stroke" values="u\\72l(https://example.invalid/p)"/></rect>',
      "<animate>",
    ],
  ] as const)
    assert.strictEqual(svgProblem(svg(body)), why, body);
});

it("stops reading at the first problem", () => {
  const on = SaxesParser.prototype.on;
  let opened = 0;
  using _counting = vi.spyOn(SaxesParser.prototype, "on").mockImplementation(function (
    this: SaxesParser,
    name,
    handler,
  ) {
    const counted = (...args: Array<never>) => {
      if (name === "opentag") opened += 1;
      return (handler as (...args: Array<never>) => void)(...args);
    };
    on.call(this, name, counted as typeof handler);
  });
  const refused = svg(`<script/>${"<g/>".repeat(10_000)}`);
  assert.strictEqual(svgProblem(refused), "<script>");
  assert.strictEqual(opened, 2);
});

it("takes the starter report's own bar and line charts", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-svg-"));
  try {
    const script = NodePath.join(root, "build.mjs");
    NodeFS.writeFileSync(script, STARTER_FILES["recipes/report/build.mjs"]!);
    const { chartSvg } = await import(/* @vite-ignore */ NodeURL.pathToFileURL(script).href);
    for (const kind of ["bar", "line"])
      assert.isUndefined(
        svgProblem(
          chartSvg([
            { kind, label: "Q1 & <Q2>", series: "Sales", value: "12.5" },
            { kind, label: "Q3", series: "Costs", value: "-3" },
          ]),
        ),
        kind,
      );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
