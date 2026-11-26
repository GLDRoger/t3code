import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { signed } from "./agentMark.ts";

const markdown = unified().use(remarkParse).use(remarkGfm);
const MAX_COMMENT = 2_000;

// Words under eval: change them only with the triage cases.
const COMMENT_RULE = {
  links: (repo: string) => `Kin posts links only into ${repo} on GitHub.`,
  image: "Kin does not post images.",
  html: "Kin does not post raw HTML.",
  slash: "Kin does not post lines starting with /.",
  length: "Kin posts at most 2,000 characters.",
  empty: "Kin needs a comment body.",
  mention: (name: string) => `Kin wrote ${name} as text, so it notified no one.`,
};

const intoRepo = (value: string, repo: string) => {
  if (!/^https:\/\//i.test(value)) return false;
  const url = URL.parse(value);
  if (
    url === null ||
    url.origin !== "https://github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    /%2f|%5c|%25/i.test(url.pathname)
  )
    return false;
  const path = url.pathname.toLowerCase();
  const root = `/${repo.toLowerCase()}`;
  return path === root || path.startsWith(`${root}/`);
};

type Markdown = ReturnType<typeof markdown.parse>;
const markdownNodes = (tree: Markdown) => {
  type Node = Markdown | Markdown["children"][number];
  const pending: Node[] = [tree];
  const nodes: Node[] = [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodes.push(node);
    if ("children" in node) {
      for (const child of node.children) pending.push(child);
    }
  }
  return nodes;
};

type CommentText =
  | { readonly body: string; readonly notes: ReadonlyArray<string> }
  | { readonly refusal: string };

export const issueCommentText = (
  input: string,
  agentName: string,
  repo: string,
  people: ReadonlySet<string> | undefined,
): CommentText => {
  const body = input.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trimEnd();
  if (body.trim() === "") return { refusal: COMMENT_RULE.empty };
  if (Array.from(body).length > MAX_COMMENT) return { refusal: COMMENT_RULE.length };
  let safe = body;
  const defused = new Set<string>();
  if (people !== undefined) {
    const nodes = markdownNodes(markdown.parse(body));
    const literalTicks = new Set<number>();
    for (const node of nodes) {
      if (node.type === "text")
        for (const ticks of node.value.matchAll(/`+/g)) literalTicks.add(ticks[0].length);
    }
    let ticks = 1;
    while (literalTicks.has(ticks)) ticks += 1;
    const delimiter = "`".repeat(ticks);
    const edits: { start: number; end: number; replacement: string }[] = [];
    const code: { start: number; end: number }[] = [];
    for (const node of nodes) {
      if (node.type === "html") return { refusal: COMMENT_RULE.html };
      if (node.type === "image" || node.type === "imageReference")
        return { refusal: COMMENT_RULE.image };
      if ((node.type === "link" || node.type === "definition") && !intoRepo(node.url, repo))
        return { refusal: COMMENT_RULE.links(repo) };
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      if (node.type === "code" || node.type === "inlineCode") code.push({ start, end });
      if (node.type !== "text") continue;
      for (const match of node.value.matchAll(/\b([\w.-]+\/[\w.-]+)#\d+/g)) {
        if (match[1]?.toLowerCase() !== repo.toLowerCase())
          return { refusal: COMMENT_RULE.links(repo) };
      }
      for (const match of body
        .slice(start, end)
        .matchAll(/(?:@|&#0*64;?|&#x0*40;?|&commat;)([\w-]+(?:\/[\w-]+)?)/gi)) {
        const login = match[1]!;
        if (people.has(login.toLowerCase())) continue;
        const at = start + match.index;
        const end = at + match[0].length;
        const before = body[at - 1] === "`" ? " " : "";
        const after = body[end] === "`" ? " " : "";
        edits.push({
          start: at,
          end,
          replacement: `${before}${delimiter}@${login}${delimiter}${after}`,
        });
        defused.add(`@${login}`);
      }
    }
    for (const match of body.matchAll(/^[^\S\r\n]*\//gm)) {
      const slash = match.index + match[0].length - 1;
      if (!code.some(({ start, end }) => slash >= start && slash < end))
        return { refusal: COMMENT_RULE.slash };
    }
    for (const { start, end, replacement } of edits.toSorted((a, b) => b.start - a.start)) {
      safe = safe.slice(0, start) + replacement + safe.slice(end);
    }
  }
  const posted = signed(safe, agentName);
  if (Array.from(posted).length > MAX_COMMENT) return { refusal: COMMENT_RULE.length };
  return { body: posted, notes: [...defused].map(COMMENT_RULE.mention) };
};
