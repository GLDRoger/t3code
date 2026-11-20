/**
 * A web page's HTML as the text a reader sees, in one forward pass: every search starts where the
 * last one ended, so an unclosed tag, comment or script costs one scan of what is left, never a
 * rescan. Scripts, styles and hidden elements are dropped; each link keeps its address.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: String.fromCodePoint(0x2014),
  ndash: "\u2013",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
};
// Bounded lookahead: an `&` is followed at most 32 characters.
const ENTITY = /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi;
const decode = (text: string) =>
  text.includes("&")
    ? text.replace(ENTITY, (whole, name: string) => {
        if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
        const code =
          name[1] === "x" || name[1] === "X"
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      })
    : text;

/** Elements whose content is not markup: skipped to their closing tag. */
const RAW = new Set([
  "script",
  "style",
  "title",
  "noscript",
  "template",
  "iframe",
  "object",
  "xmp",
]);
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const BLOCK = new Set([
  "p",
  "div",
  "br",
  "hr",
  "tr",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "table",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "aside",
  "main",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "pre",
  "form",
  "figure",
  "figcaption",
]);
// As mail's: text a reader never sees can still talk to an agent.
const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|max-height\s*:\s*0(?![.\d])/i;

const isNameChar = (code: number) =>
  (code >= 97 && code <= 122) ||
  (code >= 65 && code <= 90) ||
  (code >= 48 && code <= 57) ||
  code === 45;
const isSpace = (code: number) =>
  code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

export type PageText = {
  readonly title: string;
  readonly text: string;
  /** Each link's address as the page gives it, resolved against the page, at most `links`. */
  readonly links: ReadonlyArray<string>;
  /** The text ran past `chars`; scanning stopped there. */
  readonly cut: boolean;
};

export const pageText = (
  html: string,
  base: URL,
  limits: { readonly chars: number; readonly links: number; readonly title: number },
): PageText => {
  const n = html.length;
  const out: Array<string> = [];
  let length = 0;
  let space = false;
  let breaks = 0;
  let bullet = false;
  let cut = false;
  let title: string | undefined;
  const links = new Set<string>();
  let openLink: string | undefined;
  // Inside a hidden element: its name and how deep the same name nests in it.
  let skip: string | undefined;
  let depth = 0;

  const push = (piece: string) => {
    if (length > 0) {
      if (breaks > 0) {
        out.push(breaks > 1 ? "\n\n" : "\n");
        length += breaks > 1 ? 2 : 1;
      } else if (space) {
        out.push(" ");
        length += 1;
      }
    }
    if (bullet) {
      out.push("- ");
      length += 2;
    }
    breaks = 0;
    space = false;
    bullet = false;
    out.push(piece);
    length += piece.length;
    if (length > limits.chars) cut = true;
  };
  const words = (run: string) => {
    const text = decode(run).replace(/[\s ]+/g, " ");
    const trimmed = text.trim();
    if (trimmed === "") {
      if (text !== "") space = true;
      return;
    }
    if (text.startsWith(" ")) space = true;
    push(trimmed);
    if (text.endsWith(" ")) space = true;
  };
  const block = () => {
    breaks = Math.min(breaks + 1, 2);
  };
  const closeLink = () => {
    if (openLink === undefined) return;
    space = true;
    push(`(${openLink})`);
    openLink = undefined;
  };
  const hrefOf = (value: string) => {
    const href = decode(value).trim();
    if (href === "" || !URL.canParse(href, base.href)) return undefined;
    const url = new URL(href, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  };

  let i = 0;
  while (i < n) {
    if (cut) break;
    const lt = html.indexOf("<", i);
    const end = lt < 0 ? n : lt;
    if (end > i && skip === undefined) words(html.slice(i, end));
    if (lt < 0) break;
    i = lt;
    const next = html.charCodeAt(i + 1);
    if (next === 33 || next === 63) {
      // `<!--…-->`, `<!doctype>`, `<?…?>`: dropped.
      const close = html.startsWith("<!--", i) ? "-->" : ">";
      const at = html.indexOf(close, i + 2);
      i = at < 0 ? n : at + close.length;
      continue;
    }
    const closing = next === 47;
    let p = closing ? i + 2 : i + 1;
    const nameStart = p;
    while (p < n && isNameChar(html.charCodeAt(p))) p += 1;
    if (p === nameStart) {
      // A `<` that opens no tag is text.
      if (skip === undefined) words("<");
      i += 1;
      continue;
    }
    const name = html.slice(nameStart, p).toLowerCase();
    if (closing) {
      const at = html.indexOf(">", p);
      i = at < 0 ? n : at + 1;
      if (skip !== undefined) {
        if (name === skip && --depth === 0) skip = undefined;
        continue;
      }
      if (name === "a") closeLink();
      if (BLOCK.has(name)) block();
      continue;
    }
    // Attributes, each read once; an unclosed tag ends the page.
    let href: string | undefined;
    let hidden = false;
    let selfClosing = false;
    let open = true;
    for (;;) {
      while (p < n && isSpace(html.charCodeAt(p))) p += 1;
      if (p >= n) {
        open = false;
        break;
      }
      const c = html.charCodeAt(p);
      if (c === 62) {
        p += 1;
        break;
      }
      if (c === 47) {
        selfClosing = html.charCodeAt(p + 1) === 62;
        p += 1;
        continue;
      }
      const attrStart = p;
      while (p < n) {
        const d = html.charCodeAt(p);
        if (isSpace(d) || d === 61 || d === 62 || d === 47) break;
        p += 1;
      }
      if (p === attrStart) p += 1;
      const attr = html.slice(attrStart, p).toLowerCase();
      while (p < n && isSpace(html.charCodeAt(p))) p += 1;
      let value = "";
      if (html.charCodeAt(p) === 61) {
        p += 1;
        while (p < n && isSpace(html.charCodeAt(p))) p += 1;
        const q = html.charCodeAt(p);
        if (q === 34 || q === 39) {
          const at = html.indexOf(q === 34 ? '"' : "'", p + 1);
          if (at < 0) {
            p = n;
            open = false;
            break;
          }
          value = html.slice(p + 1, at);
          p = at + 1;
        } else {
          const valueStart = p;
          while (p < n && !isSpace(html.charCodeAt(p)) && html.charCodeAt(p) !== 62) p += 1;
          value = html.slice(valueStart, p);
        }
      }
      if (attr === "hidden") hidden = true;
      else if (attr === "style" && HIDDEN_STYLE.test(value)) hidden = true;
      else if (attr === "href" && name === "a") href = hrefOf(value);
    }
    i = p;
    if (!open) break;
    if (RAW.has(name) && !selfClosing) {
      // Its content runs to the first `</name`, whatever case.
      let at = html.indexOf("</", i);
      while (
        at >= 0 &&
        !(
          html.slice(at + 2, at + 2 + name.length).toLowerCase() === name &&
          !isNameChar(html.charCodeAt(at + 2 + name.length))
        )
      )
        at = html.indexOf("</", at + 2);
      const content = html.slice(i, at < 0 ? n : at);
      if (name === "title" && title === undefined)
        title = decode(content).replace(/\s+/g, " ").trim().slice(0, limits.title);
      const gt = at < 0 ? -1 : html.indexOf(">", at);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (skip !== undefined) {
      if (name === skip && !selfClosing && !VOID.has(name)) depth += 1;
      continue;
    }
    if (hidden && !selfClosing && !VOID.has(name)) {
      skip = name;
      depth = 1;
      continue;
    }
    if (name === "a") {
      closeLink();
      if (href !== undefined) {
        openLink = href;
        if (links.size < limits.links) links.add(href);
      }
    }
    if (name === "li") {
      block();
      bullet = true;
    } else if (BLOCK.has(name)) block();
  }
  if (!cut) closeLink();
  const text = out.join("");
  return {
    title: title ?? "",
    text: cut ? text.slice(0, limits.chars) : text,
    links: [...links],
    cut,
  };
};
