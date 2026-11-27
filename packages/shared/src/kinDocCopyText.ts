import { kinPlainBody, kinThreadLinksAsWords } from "@t3tools/contracts";
import type { PhrasingContent, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const copyParser = unified().use(remarkParse).use(remarkGfm);

/** A mail keeps what its reader would miss: each link's target, typed `<...>` text, footnotes. */
type Mail = { readonly targets: ReadonlyMap<string, string> };

const HTML_TAGS: ReadonlySet<string> = new Set(
  (
    "a abbr address area article aside audio b base bdi bdo big blockquote body br button canvas " +
    "caption center cite code col colgroup data datalist dd del details dfn dialog div dl dt em " +
    "embed fieldset figcaption figure font footer form h1 h2 h3 h4 h5 h6 head header hr html i " +
    "iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript " +
    "object ol optgroup option output p param picture pre progress q rp rt ruby s samp script " +
    "section select small source span strike strong style sub summary sup svg table tbody td " +
    "template textarea tfoot th thead time title tr track tt u ul var video wbr"
  ).split(" "),
);
const TAG = /<!--[\s\S]*?-->|<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>|<[^>]*>/g;
/** Markup taken out; for a mail, only real tags and comments, so `<PO number>` stays as typed. */
const withoutTags = (html: string, mail: Mail | undefined) =>
  mail === undefined
    ? html.replace(/<[^>]*>/g, "")
    : html.replace(TAG, (tag, name: string | undefined) =>
        tag.startsWith("<!--") || (name !== undefined && HTML_TAGS.has(name.toLowerCase()))
          ? ""
          : tag,
      );

/** Words and the link's target, the target only where the words aren't it already. */
const linked = (words: string, url: string, mail: Mail | undefined) => {
  if (words === "") return url;
  if (mail === undefined)
    return /^https?:/i.test(url) && words !== url ? `${words} (${url})` : words;
  return url === "" || words === url || words === url.replace(/^(mailto|tel):/i, "")
    ? words
    : `${words} (${url})`;
};

const inlineText = (nodes: ReadonlyArray<PhrasingContent>, mail?: Mail): string =>
  nodes
    .map((node): string => {
      switch (node.type) {
        case "text":
        case "inlineCode":
          return node.value;
        case "break":
          return "\n";
        case "image":
          return node.alt ?? "";
        case "html":
          return withoutTags(node.value, mail);
        case "link":
          return linked(inlineText(node.children, mail), node.url, mail);
        case "linkReference": {
          if (mail === undefined) return "";
          const words = inlineText(node.children, mail);
          const url = mail.targets.get(node.identifier);
          return url === undefined ? words : linked(words, url, mail);
        }
        case "footnoteReference":
          return mail === undefined ? "" : `[${node.label ?? node.identifier}]`;
        case "emphasis":
        case "strong":
        case "delete":
          return inlineText(node.children, mail);
        default:
          return "";
      }
    })
    .join("");

const blockText = (node: RootContent, bullet: string, mail?: Mail): ReadonlyArray<string> => {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return [inlineText(node.children, mail)];
    case "code":
      return [node.value];
    case "html":
      return [withoutTags(node.value, mail)];
    case "blockquote":
      return node.children.flatMap((child) => blockText(child, bullet, mail));
    case "footnoteDefinition":
      return mail === undefined
        ? []
        : [
            `[${node.label ?? node.identifier}] ${node.children
              .flatMap((child) => blockText(child, bullet, mail))
              .join("\n")}`,
          ];
    case "list":
      return [
        node.children
          .map((item, index) => {
            const lines = item.children
              .flatMap((child) => blockText(child, bullet, mail))
              .filter((line) => line !== "");
            const number = node.ordered === true ? `${(node.start ?? 1) + index}. ` : bullet;
            return `${number}${lines.join("\n")}`;
          })
          .join("\n"),
      ];
    case "table":
      return [
        node.children
          .map((row) =>
            row.children
              .map((cell) => inlineText(cell.children, mail).replace(/\s+/g, " "))
              .join("\t"),
          )
          .join("\n"),
      ];
    default:
      return [];
  }
};

const targetsOf = (tree: Root): ReadonlyMap<string, string> =>
  new Map(
    tree.children.flatMap((node) =>
      node.type === "definition" ? [[node.identifier, node.url] as const] : [],
    ),
  );

/**
 * A doc's markdown as text to paste anywhere: no marks, a list's items one per line, a table's
 * rows as tab-separated cells, and its charts and visuals left out. With `listMarks`, as a mail
 * sent from a draft is: a bulleted item keeps a plain "- ", every link its target, text in angle
 * brackets that is no real tag stays as typed, and footnotes stay.
 */
export function kinDocCopyText(
  markdown: string,
  options: { readonly listMarks?: boolean } = {},
): string {
  const tree = copyParser.parse(kinThreadLinksAsWords(kinPlainBody(markdown)));
  const mail = options.listMarks === true ? { targets: targetsOf(tree) } : undefined;
  return tree.children
    .flatMap((node) => blockText(node, mail === undefined ? "" : "- ", mail))
    .filter((block) => block.trim() !== "")
    .join("\n\n");
}
