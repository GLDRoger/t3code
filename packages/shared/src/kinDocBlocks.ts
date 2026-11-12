/** A doc's ```kin_chart block holds the JSON `kin_chart` takes; ```kin_visual <title> a page. */
const KIN_DOC_CHART_LANGUAGE = "kin_chart";
const KIN_DOC_VISUAL_LANGUAGE = "kin_visual";

export interface KinDocBlock {
  readonly kind: "chart" | "visual";
  /** The words after the language: a visual's title. */
  readonly info: string;
  readonly content: string;
}

/** A stretch of a body: markdown as written, or one of its blocks. */
export type KinDocPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "block"; readonly block: KinDocBlock };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface FoundBlock {
  readonly block: KinDocBlock;
  /** The opening fence's line. */
  readonly from: number;
  /** The closing fence's line. */
  readonly to: number;
}

function scan(body: string) {
  const found: Array<FoundBlock> = [];
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let open: { fence: string; kind: KinDocBlock["kind"] | null; info: string; from: number } | null =
    null;
  lines.forEach((line, index) => {
    const match = FENCE.exec(line);
    if (open !== null) {
      const fence = match?.[1];
      if (
        fence === undefined ||
        fence[0] !== open.fence[0] ||
        fence.length < open.fence.length ||
        match![2]!.trim() !== ""
      )
        return;
      if (open.kind !== null)
        found.push({
          block: {
            kind: open.kind,
            info: open.info,
            content: lines.slice(open.from + 1, index).join("\n"),
          },
          from: open.from,
          to: index,
        });
      open = null;
      return;
    }
    if (match === null) return;
    const fence = match[1]!;
    const rest = match[2]!.trim();
    // A backtick fence's info string has no backtick, as CommonMark has it.
    if (fence[0] === "`" && rest.includes("`")) return;
    const language = rest.split(/\s+/, 1)[0] ?? "";
    const kind =
      language === KIN_DOC_CHART_LANGUAGE
        ? "chart"
        : language === KIN_DOC_VISUAL_LANGUAGE
          ? "visual"
          : null;
    open = { fence, kind, info: rest.slice(language.length).trim(), from: index };
  });
  return { lines, found };
}

/**
 * The body's top-level `kin_chart` and `kin_visual` blocks, in order. The server draws them into
 * `embeds` in this order; a reader finds a block's embed by its kind and content.
 */
export function kinDocBlocks(body: string): ReadonlyArray<KinDocBlock> {
  return scan(body).found.map((found) => found.block);
}

/**
 * The body cut around the blocks `kinDocBlocks` finds, so a reader can draw each block in its
 * place. Blank stretches between blocks are left out.
 */
export function kinDocParts(body: string): ReadonlyArray<KinDocPart> {
  const { lines, found } = scan(body);
  const parts: Array<KinDocPart> = [];
  const text = (from: number, to: number) => {
    const held = lines.slice(from, to).join("\n");
    if (held.trim() !== "") parts.push({ type: "text", text: held });
  };
  let at = 0;
  for (const { block, from, to } of found) {
    text(at, from);
    parts.push({ type: "block", block });
    at = to + 1;
  }
  text(at, lines.length);
  return parts;
}

/** Which of `blocks` a reader's code block is: the first of that kind with the same text. */
export function kinDocBlockIndex(
  blocks: ReadonlyArray<KinDocBlock>,
  kind: KinDocBlock["kind"],
  content: string,
): number {
  const text = content.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return blocks.findIndex((block) => block.kind === kind && block.content === text);
}
