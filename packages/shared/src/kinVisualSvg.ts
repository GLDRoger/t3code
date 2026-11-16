import { SaxesParser } from "saxes";

/**
 * An SVG a visual hands the reader, cleaned before it is written: opened from disk it is a page
 * of its own, outside the seal. Parsed as namespace-aware XML and written out again with only SVG
 * elements, no script, foreignObject, event handler, outside reference or animation of a link.
 * CSS the cleaner can't be certain of refuses the save instead of being rewritten.
 */

const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const MAX_ELEMENTS = 500_000;
const MAX_DEPTH = 256;
// What runs or holds another document; `handler` and `listener` are SVG Tiny's script hooks.
const DROPPED = new Set(["script", "foreignObject", "handler", "listener"]);
const ANIMATIONS = new Set(["set", "animate", "animateMotion", "animateTransform"]);
const IMAGES = new Set(["image", "feImage"]);
const RASTER = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]*$/;
/** Attributes that are names or labels, never read as CSS; every other one may be. */
const PLAIN = /^(?:id|class|lang|role|aria-[a-z-]+|data-[\w.-]+)$/;

const NOT_SVG = "it isn't a well-formed SVG file";
const RISKY_STYLE = "its styles could load something from outside the file";

/** A reference inside this file: `#name`, after the trimming a URL parser does. */
const internal = (value: string) => /^#[^\s#]*$/.test(value.trim());

/** Whether CSS could load or run something: escapes and comments are how a check is dodged. */
const cssLoads = (css: string) => {
  if (css.includes("\\")) return true;
  const open = css.indexOf("/*");
  if (open !== -1 && css.indexOf("*/", open + 2) === -1) return true;
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase();
  if (
    /expression\s*\(|javascript:|behavior\s*:|-moz-binding|image-set\s*\(|image\s*\(|cross-fade\s*\(|element\s*\(|src\s*\(/.test(
      text,
    )
  )
    return true;
  for (const match of text.matchAll(/url\s*\(\s*(['"]?)([^'")]*)/g))
    if (!internal(match[2] ?? "")) return true;
  return false;
};
const styleLoads = (css: string) =>
  cssLoads(css) ||
  Array.from(css.toLowerCase().matchAll(/@([a-z-]*)/g)).some(
    (match) => match[1] !== "media" && match[1] !== "keyframes",
  );

const escapeText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeValue = (text: string) =>
  escapeText(text)
    .replaceAll('"', "&quot;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");

type Attribute = {
  readonly name: string;
  readonly uri: string;
  readonly local: string;
  readonly value: string;
};
const kept = (element: string, attribute: Attribute) => {
  const { uri, local, value } = attribute;
  if (uri === XMLNS) return true;
  if (local.toLowerCase().startsWith("on")) return false;
  if (local === "href" && (uri === "" || uri === XLINK))
    return internal(value) || (IMAGES.has(element) && RASTER.test(value.trim()));
  if (uri === XML) return local === "space" || local === "lang";
  if (uri !== "") return false;
  return PLAIN.test(local) || !cssLoads(value);
};
const animatesLink = (attributes: ReadonlyArray<Attribute>) =>
  attributes.some((attribute) => {
    if (attribute.uri !== "" || attribute.local !== "attributeName") return false;
    const target = attribute.value.trim().toLowerCase();
    const local = target.slice(target.lastIndexOf(":") + 1);
    return local === "href" || local.startsWith("on");
  });

export function cleanKinVisualSvg(
  text: string,
): { readonly svg: string } | { readonly error: string } {
  const parser = new SaxesParser({ xmlns: true, position: false });
  let problem: string | undefined;
  const refuse = (reason: string): never => {
    problem ??= reason;
    throw new Error(reason);
  };
  const out: Array<string> = [];
  // Each open element, and whether it is written: one left out takes everything inside it.
  const open: Array<{ readonly name: string; readonly written: boolean }> = [];
  let skipping = 0;
  let elements = 0;
  let style: Array<string> | undefined;
  parser.on("opentag", (tag) => {
    elements += 1;
    if (elements > MAX_ELEMENTS || open.length >= MAX_DEPTH) refuse("it has too many elements");
    if (open.length === 0 && (tag.uri !== SVG || tag.local !== "svg"))
      refuse("it isn't an SVG drawing");
    if (style !== undefined) refuse(RISKY_STYLE);
    const attributes = Object.values(tag.attributes);
    const written =
      skipping === 0 &&
      tag.uri === SVG &&
      !DROPPED.has(tag.local) &&
      !(ANIMATIONS.has(tag.local) && animatesLink(attributes));
    open.push({ name: tag.name, written });
    if (!written) {
      skipping += 1;
      return;
    }
    const pairs = attributes
      .filter((attribute) => kept(tag.local, attribute))
      .map((attribute) => ` ${attribute.name}="${escapeValue(attribute.value)}"`);
    out.push(`<${tag.name}${pairs.join("")}>`);
    if (tag.local === "style") style = [];
  });
  const textOf = (data: string) => {
    if (skipping > 0) return;
    style?.push(data);
    out.push(escapeText(data));
  };
  parser.on("text", textOf);
  parser.on("cdata", textOf);
  parser.on("closetag", () => {
    const element = open.pop();
    if (element === undefined) return;
    if (!element.written) {
      skipping -= 1;
      return;
    }
    if (style !== undefined) {
      if (styleLoads(style.join(""))) refuse(RISKY_STYLE);
      style = undefined;
    }
    out.push(`</${element.name}>`);
  });
  parser.on("error", () => refuse(NOT_SVG));
  try {
    parser.write(text).close();
  } catch {
    problem ??= NOT_SVG;
  }
  if (problem === undefined && elements === 0) problem = NOT_SVG;
  return problem === undefined ? { svg: out.join("") } : { error: problem };
}

/** The bytes a visual's save writes: an SVG cleaned, any other type as the page made it. */
export function kinVisualSaveBytes(
  mimeType: string,
  bytes: Uint8Array<ArrayBuffer>,
): { readonly bytes: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  if (mimeType !== "image/svg+xml") return { bytes };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { error: NOT_SVG };
  }
  const cleaned = cleanKinVisualSvg(text);
  return "error" in cleaned ? cleaned : { bytes: new TextEncoder().encode(cleaned.svg) };
}
