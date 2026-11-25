import { scanKinDocFences } from "@t3tools/contracts";

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

/**
 * The body's top-level `kin_chart` and `kin_visual` blocks, in order. The server draws them into
 * `embeds` in this order; a reader finds a block's embed by its kind and content.
 */
export function kinDocBlocks(body: string): ReadonlyArray<KinDocBlock> {
  return scanKinDocFences(body).found.map((found) => found.block);
}

/**
 * The body cut around the blocks `kinDocBlocks` finds, so a reader can draw each block in its
 * place. Blank stretches between blocks are left out.
 */
export function kinDocParts(body: string): ReadonlyArray<KinDocPart> {
  const { lines, found } = scanKinDocFences(body);
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
