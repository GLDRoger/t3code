import { SaxesParser } from "saxes";

/**
 * Whether an SVG is only a drawing: parsed as namespace-aware XML, every element and attribute on
 * a fixed list of shapes, text, paint and filters, every reference inside the file. Anything that
 * runs, loads, links or isn't on the list is refused, so a viewer has nothing to fetch or execute.
 */

const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const MAX_ELEMENTS = 500_000;
const MAX_DEPTH = 256;

const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "style",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "clipPath",
  "mask",
  "marker",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feFuncR",
  "feFuncG",
  "feFuncB",
  "feFuncA",
  "feComposite",
  "feDropShadow",
  "feFlood",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
]);

const ATTRIBUTES = new Set([
  "id",
  "class",
  "lang",
  "role",
  "aria-label",
  "aria-hidden",
  "version",
  "baseProfile",
  "viewBox",
  "preserveAspectRatio",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "fr",
  "dx",
  "dy",
  "width",
  "height",
  "d",
  "points",
  "pathLength",
  "transform",
  "style",
  "type",
  "media",
  "href",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "color",
  "display",
  "visibility",
  "overflow",
  "clip-path",
  "clip-rule",
  "mask",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",
  "paint-order",
  "vector-effect",
  "shape-rendering",
  "text-rendering",
  "image-rendering",
  "color-interpolation",
  "color-interpolation-filters",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "letter-spacing",
  "word-spacing",
  "writing-mode",
  "direction",
  "unicode-bidi",
  "white-space",
  "rotate",
  "textLength",
  "lengthAdjust",
  "startOffset",
  "method",
  "spacing",
  "side",
  "path",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "filterUnits",
  "primitiveUnits",
  "in",
  "in2",
  "result",
  "mode",
  "operator",
  "k1",
  "k2",
  "k3",
  "k4",
  "values",
  "tableValues",
  "slope",
  "intercept",
  "amplitude",
  "exponent",
  "stdDeviation",
  "edgeMode",
  "radius",
  "flood-color",
  "flood-opacity",
  "lighting-color",
]);

/** Attributes that are names or labels, never read as CSS; every other attribute is. */
const PLAIN = new Set(["id", "class", "lang", "role", "aria-label", "aria-hidden", "href"]);

/** A reference inside this file: `#name`, after the trimming a URL parser does. */
const internal = (value: string) => /^#[^\s#]*$/.test(value.trim());

/** Why this CSS could load or run something, or `undefined` when it can only paint. */
const cssProblem = (css: string): string | undefined => {
  // Escapes and comments are how a keyword is split or spelled so a check misses it.
  if (css.includes("\\")) return "CSS escapes";
  const open = css.indexOf("/*");
  if (open !== -1 && css.indexOf("*/", open + 2) === -1) return "an unclosed CSS comment";
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase();
  for (const match of text.matchAll(/@([a-z-]*)/g))
    if (match[1] !== "media" && match[1] !== "keyframes") return `@${match[1]} in its CSS`;
  if (
    /expression\s*\(|javascript:|behavior\s*:|-moz-binding|image-set\s*\(|image\s*\(|cross-fade\s*\(|element\s*\(|src\s*\(/.test(
      text,
    )
  )
    return "CSS that loads or runs something";
  for (const match of text.matchAll(/url\s*\(\s*(['"]?)([^'")]*)/g))
    if (!internal(match[2] ?? "")) return "a url() to something outside the file";
  return undefined;
};

/** Why `text` isn't a plain drawing, or `undefined` when it is. Reading stops at the first. */
export const svgProblem = (text: string): string | undefined => {
  const parser = new SaxesParser({ xmlns: true, position: false });
  let problem: string | undefined;
  const refuse = (reason: string): never => {
    problem = reason;
    throw new Error(reason);
  };
  const stack: Array<string> = [];
  let elements = 0;
  let style: Array<string> | undefined;
  parser.on("xmldecl", (decl) => {
    if (decl.encoding !== undefined && decl.encoding.toLowerCase() !== "utf-8")
      refuse(`a ${decl.encoding} encoding`);
  });
  parser.on("doctype", () => refuse("a DOCTYPE"));
  parser.on("processinginstruction", () => refuse("a processing instruction"));
  parser.on("opentag", (tag) => {
    elements += 1;
    if (elements > MAX_ELEMENTS || stack.length >= MAX_DEPTH) refuse("too many elements");
    if (tag.uri !== SVG) refuse(`<${tag.name}>, which isn't SVG`);
    if (stack.length === 0 && tag.local !== "svg") refuse("no <svg> at its root");
    if (!ELEMENTS.has(tag.local)) refuse(`<${tag.name}>`);
    if (style !== undefined) refuse("an element inside <style>");
    for (const attribute of Object.values(tag.attributes)) {
      const { uri, local, name, value } = attribute;
      if (uri === XMLNS) continue;
      const allowed =
        uri === ""
          ? ATTRIBUTES.has(local)
          : uri === XLINK
            ? local === "href"
            : uri === XML && (local === "space" || local === "lang");
      if (!allowed) refuse(`a ${name} attribute`);
      if (local === "href" && !internal(value)) refuse("a link to something outside the file");
      const css = uri === "" && !PLAIN.has(local) ? cssProblem(value) : undefined;
      if (css !== undefined) refuse(css);
    }
    stack.push(tag.local);
    if (tag.local === "style") style = [];
  });
  parser.on("text", (data) => style?.push(data));
  parser.on("cdata", (data) => style?.push(data));
  parser.on("closetag", (tag) => {
    stack.pop();
    if (tag.local === "style" && style !== undefined) {
      const css = cssProblem(style.join(""));
      if (css !== undefined) refuse(css);
      style = undefined;
    }
  });
  parser.on("error", () => refuse("XML that isn't well formed"));
  try {
    parser.write(text).close();
  } catch {
    problem ??= "XML that isn't well formed";
  }
  if (problem === undefined && elements === 0) problem = "no <svg> at its root";
  return problem;
};
