/** A doc's ```kin_chart block holds the JSON `kin_chart` takes; ```kin_visual <title> a page. */
const KIN_DOC_CHART_LANGUAGE = "kin_chart";
const KIN_DOC_VISUAL_LANGUAGE = "kin_visual";

export interface KinDocBlock {
  readonly kind: "chart" | "visual";
  /** The words after the language: a visual's title. */
  readonly info: string;
  readonly content: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The body's top-level `kin_chart` and `kin_visual` blocks, in order. The server draws them into
 * `embeds` in this order; a reader finds a block's embed by its kind and content.
 */
export function kinDocBlocks(body: string): ReadonlyArray<KinDocBlock> {
  const blocks: Array<KinDocBlock> = [];
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let open: { fence: string; kind: KinDocBlock["kind"] | null; info: string; from: number } | null =
    null;
  lines.forEach((line, index) => {
    const found = FENCE.exec(line);
    if (open !== null) {
      const fence = found?.[1];
      if (
        fence === undefined ||
        fence[0] !== open.fence[0] ||
        fence.length < open.fence.length ||
        found![2]!.trim() !== ""
      )
        return;
      if (open.kind !== null)
        blocks.push({
          kind: open.kind,
          info: open.info,
          content: lines.slice(open.from, index).join("\n"),
        });
      open = null;
      return;
    }
    if (found === null) return;
    const fence = found[1]!;
    const rest = found[2]!.trim();
    // A backtick fence's info string has no backtick, as CommonMark has it.
    if (fence[0] === "`" && rest.includes("`")) return;
    const language = rest.split(/\s+/, 1)[0] ?? "";
    const kind =
      language === KIN_DOC_CHART_LANGUAGE
        ? "chart"
        : language === KIN_DOC_VISUAL_LANGUAGE
          ? "visual"
          : null;
    open = { fence, kind, info: rest.slice(language.length).trim(), from: index + 1 };
  });
  return blocks;
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
