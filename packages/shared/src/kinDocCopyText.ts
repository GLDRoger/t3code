import { kinPlainBody, kinThreadLinksAsWords } from "@t3tools/contracts";
import type { PhrasingContent, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const copyParser = unified().use(remarkParse).use(remarkGfm);

const inlineText = (nodes: ReadonlyArray<PhrasingContent>): string =>
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
          return node.value.replace(/<[^>]*>/g, "");
        case "link": {
          const words = inlineText(node.children);
          return /^https?:/i.test(node.url) && words !== node.url && words !== ""
            ? `${words} (${node.url})`
            : words === ""
              ? node.url
              : words;
        }
        case "emphasis":
        case "strong":
        case "delete":
          return inlineText(node.children);
        default:
          return "";
      }
    })
    .join("");

const blockText = (node: RootContent, bullet: string): ReadonlyArray<string> => {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return [inlineText(node.children)];
    case "code":
      return [node.value];
    case "html":
      return [node.value.replace(/<[^>]*>/g, "")];
    case "blockquote":
      return node.children.flatMap((child) => blockText(child, bullet));
    case "list":
      return [
        node.children
          .map((item, index) => {
            const lines = item.children
              .flatMap((child) => blockText(child, bullet))
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
            row.children.map((cell) => inlineText(cell.children).replace(/\s+/g, " ")).join("\t"),
          )
          .join("\n"),
      ];
    default:
      return [];
  }
};

/**
 * A doc's markdown as text to paste anywhere: no marks, a list's items one per line, a table's
 * rows as tab-separated cells, and its charts and visuals left out. With `listMarks`, a bulleted
 * item keeps a plain "- ", as a mail sent from a draft does.
 */
export function kinDocCopyText(
  markdown: string,
  options: { readonly listMarks?: boolean } = {},
): string {
  const tree = copyParser.parse(kinThreadLinksAsWords(kinPlainBody(markdown)));
  return tree.children
    .flatMap((node) => blockText(node, options.listMarks === true ? "- " : ""))
    .filter((block) => block.trim() !== "")
    .join("\n\n");
}
