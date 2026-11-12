/**
 * What changed between two versions of a doc, as a document to read rather than a patch: whole
 * blocks that stayed, came or went (drawn by the clients' own markdown renderers), and for an
 * edited paragraph, list or table, the words, items and cells that differ, marked in place.
 * Long stretches that are all the same, all new or all gone fold away until asked for.
 */

export type KinDocMark = "same" | "added" | "removed";
export interface KinDocRun {
  readonly text: string;
  readonly mark: KinDocMark;
}
type RowMark = KinDocMark | "changed";

export type KinDocChange =
  /** One or more whole blocks, as markdown. */
  | { readonly type: "block"; readonly mark: KinDocMark; readonly markdown: string }
  /** An edited heading, paragraph or quote: plain words, marked. `level` is 0 unless a heading. */
  | {
      readonly type: "text";
      readonly block: "heading" | "paragraph" | "quote";
      readonly level: number;
      readonly runs: ReadonlyArray<KinDocRun>;
    }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly items: ReadonlyArray<{
        readonly mark: RowMark;
        readonly runs: ReadonlyArray<KinDocRun>;
      }>;
    }
  | {
      readonly type: "table";
      readonly header: ReadonlyArray<ReadonlyArray<KinDocRun>>;
      readonly rows: ReadonlyArray<{
        readonly mark: RowMark;
        readonly cells: ReadonlyArray<ReadonlyArray<KinDocRun>>;
      }>;
    }
  /** An edited code block, a line at a time. */
  | { readonly type: "code"; readonly lines: ReadonlyArray<KinDocRun> };

export type KinDocChangePart =
  | { readonly type: "shown"; readonly id: string; readonly change: KinDocChange }
  | {
      readonly type: "folded";
      readonly id: string;
      readonly mark: KinDocMark;
      /** "12 unchanged paragraphs", "Added section: Pricing". */
      readonly label: string;
      readonly markdown: string;
    };

export interface KinDocChangesView {
  readonly parts: ReadonlyArray<KinDocChangePart>;
  /** Nothing differs but, at most, blank lines. */
  readonly identical: boolean;
}

export const KIN_DOC_CHANGES = {
  formatted: "Document",
  source: "Source",
  showSource: "Show source",
  showDocument: "Show document",
  identical: "These two versions read the same.",
  show: "Show",
  hide: "Hide",
  added: "Added",
  removed: "Removed",
  legend: "Added text is highlighted. Removed text is struck through.",
};

// Blocks

type BlockKind = "heading" | "paragraph" | "list" | "quote" | "table" | "code" | "other";
interface Block {
  readonly kind: BlockKind;
  readonly text: string;
  readonly level: number;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+\S/;
const ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const RULE = /^\s{0,3}(?:[-*_]\s*){3,}$/;
const isTable = (line: string) => line.trimStart().startsWith("|");
const isQuote = (line: string) => line.trimStart().startsWith(">");

function blocksOf(body: string): ReadonlyArray<Block> {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Array<Block> = [];
  const push = (kind: BlockKind, from: number, to: number, level = 0) =>
    blocks.push({ kind, text: lines.slice(from, to).join("\n"), level });
  let at = 0;
  const run = (holds: (line: string) => boolean) => {
    let end = at + 1;
    while (end < lines.length && lines[end]!.trim() !== "" && holds(lines[end]!)) end += 1;
    return end;
  };
  while (at < lines.length) {
    const line = lines[at]!;
    if (line.trim() === "") {
      at += 1;
      continue;
    }
    const fence = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      let end = at + 1;
      while (end < lines.length && !lines[end]!.trimStart().startsWith(fence)) end += 1;
      end = Math.min(end + 1, lines.length);
      push("code", at, end);
      at = end;
      continue;
    }
    const heading = HEADING.exec(line)?.[1];
    if (heading !== undefined) {
      push("heading", at, at + 1, heading.length);
      at += 1;
      continue;
    }
    if (RULE.test(line)) {
      push("other", at, at + 1);
      at += 1;
      continue;
    }
    const starts = (next: string) =>
      FENCE.test(next) || HEADING.test(next) || isTable(next) || ITEM.test(next) || isQuote(next);
    const end = isTable(line)
      ? run(isTable)
      : ITEM.test(line)
        ? run((next) => !FENCE.test(next) && !HEADING.test(next) && !isTable(next))
        : isQuote(line)
          ? run(isQuote)
          : run((next) => !starts(next));
    push(
      isTable(line) ? "table" : ITEM.test(line) ? "list" : isQuote(line) ? "quote" : "paragraph",
      at,
      end,
    );
    at = end;
  }
  return blocks;
}

/** A block's words without the marks that format them, which is what a reader compares. */
const plain = (text: string) =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])([*_])(?=\S)(.+?)\2(?=$|[\s).,;:!?])/g, "$1$3")
    .replace(/`([^`]+)`/g, "$1");

const flat = (text: string) => plain(text).replace(/\s+/g, " ").trim();

// Differences

type Op =
  | { readonly op: "same"; readonly a: number; readonly b: number }
  | { readonly op: "removed"; readonly a: number }
  | { readonly op: "added"; readonly b: number };

/** Past this many comparisons the middle is taken as replaced whole, which stays quick. */
const LCS_CAP = 1_500_000;

/** A longest-common-subsequence diff of two lists by key; removals come before additions. */
function diff(a: ReadonlyArray<string>, b: ReadonlyArray<string>): ReadonlyArray<Op> {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const ops: Array<Op> = [];
  for (let index = 0; index < head; index += 1) ops.push({ op: "same", a: index, b: index });
  if (n * m > LCS_CAP || n === 0 || m === 0) {
    for (let i = 0; i < n; i += 1) ops.push({ op: "removed", a: head + i });
    for (let j = 0; j < m; j += 1) ops.push({ op: "added", b: head + j });
  } else {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1)
      for (let j = m - 1; j >= 0; j -= 1)
        table[i * width + j] =
          a[head + i] === b[head + j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[head + i] === b[head + j]) {
        ops.push({ op: "same", a: head + i, b: head + j });
        i += 1;
        j += 1;
      } else if (i < n && (j === m || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
        ops.push({ op: "removed", a: head + i });
        i += 1;
      } else {
        ops.push({ op: "added", b: head + j });
        j += 1;
      }
    }
  }
  for (let index = 0; index < tail; index += 1)
    ops.push({ op: "same", a: a.length - tail + index, b: b.length - tail + index });
  return ops;
}

const joined = (runs: ReadonlyArray<KinDocRun>): ReadonlyArray<KinDocRun> => {
  const out: Array<KinDocRun> = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (run.text === "") continue;
    if (last !== undefined && last.mark === run.mark)
      out[out.length - 1] = { text: last.text + run.text, mark: run.mark };
    else out.push(run);
  }
  return out;
};

/** Two texts word by word: what stayed, with what went and came marked between. */
export function kinDocWordRuns(before: string, after: string): ReadonlyArray<KinDocRun> {
  const words = (text: string) => text.match(/\s+|[^\s]+/g) ?? [];
  const a = words(before);
  const b = words(after);
  return joined(
    diff(a, b).map((op) =>
      op.op === "same"
        ? { text: b[op.b]!, mark: "same" as const }
        : op.op === "removed"
          ? { text: a[op.a]!, mark: "removed" as const }
          : { text: b[op.b]!, mark: "added" as const },
    ),
  );
}

const whole = (text: string, mark: KinDocMark): ReadonlyArray<KinDocRun> =>
  text === "" ? [] : [{ text, mark }];

/** How alike two texts are by the words they share, 0 to 1. */
function alike(a: string, b: string): number {
  const left = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const right = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

/**
 * Walks a diff and, inside each stretch of removals then additions, pairs a removed thing with the
 * first later addition that is enough like it: an edit, rather than one gone and another new.
 */
function paired<T>(
  ops: ReadonlyArray<Op>,
  a: ReadonlyArray<T>,
  b: ReadonlyArray<T>,
  pairs: (before: T, after: T) => boolean,
): ReadonlyArray<
  | { readonly mark: KinDocMark; readonly item: T }
  | { readonly mark: "changed"; readonly before: T; readonly after: T }
> {
  const out: Array<
    | { readonly mark: KinDocMark; readonly item: T }
    | { readonly mark: "changed"; readonly before: T; readonly after: T }
  > = [];
  let at = 0;
  while (at < ops.length) {
    const op = ops[at]!;
    if (op.op === "same") {
      out.push({ mark: "same", item: b[op.b]! });
      at += 1;
      continue;
    }
    const removed: Array<T> = [];
    const added: Array<T> = [];
    while (at < ops.length && ops[at]!.op !== "same") {
      const next = ops[at]!;
      if (next.op === "removed") removed.push(a[next.a]!);
      else if (next.op === "added") added.push(b[next.b]!);
      at += 1;
    }
    let from = 0;
    for (const before of removed) {
      let found = -1;
      for (let index = from; index < added.length && found < 0; index += 1)
        if (pairs(before, added[index]!)) found = index;
      if (found < 0) {
        out.push({ mark: "removed", item: before });
        continue;
      }
      for (let index = from; index < found; index += 1)
        out.push({ mark: "added", item: added[index]! });
      out.push({ mark: "changed", before, after: added[found]! });
      from = found + 1;
    }
    for (let index = from; index < added.length; index += 1)
      out.push({ mark: "added", item: added[index]! });
  }
  return out;
}

// Lists, tables and code

const itemsOf = (text: string): ReadonlyArray<string> => {
  const items: Array<string> = [];
  for (const line of text.split("\n")) {
    if (ITEM.test(line) || items.length === 0) items.push(flat(line.replace(ITEM, "")));
    else items[items.length - 1] = `${items[items.length - 1]} ${flat(line)}`;
  }
  return items;
};

function listChange(before: Block, after: Block): KinDocChange {
  const a = itemsOf(before.text);
  const b = itemsOf(after.text);
  return {
    type: "list",
    ordered: /^\s*\d/.test(after.text),
    items: paired(diff(a, b), a, b, (left, right) => alike(left, right) >= 0.4).map((row) =>
      row.mark === "changed"
        ? { mark: "changed" as const, runs: kinDocWordRuns(row.before, row.after) }
        : { mark: row.mark, runs: whole(row.item, row.mark) },
    ),
  };
}

const SEPARATOR = /^:?-{1,}:?$/;
const rowsOf = (text: string): ReadonlyArray<ReadonlyArray<string>> =>
  text
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split(/(?<!\\)\|/)
        .map((cell) => flat(cell.replace(/\\\|/g, "|"))),
    )
    .filter((cells) => !cells.every((cell) => SEPARATOR.test(cell)));

function tableChange(before: Block, after: Block): KinDocChange {
  const a = rowsOf(before.text);
  const b = rowsOf(after.text);
  const width = Math.max(...a.map((row) => row.length), ...b.map((row) => row.length), 1);
  const cellsOf = (row: ReadonlyArray<string>, mark: KinDocMark) =>
    Array.from({ length: width }, (_, index) => whole(row[index] ?? "", mark));
  const changed = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
    Array.from({ length: width }, (_, index) => {
      const was = left[index] ?? "";
      const is = right[index] ?? "";
      return was === is ? whole(is, "same") : [...whole(was, "removed"), ...whole(is, "added")];
    });
  const key = (row: ReadonlyArray<string>) => row.join("\u0001");
  const [headBefore = [], ...bodyBefore] = a;
  const [headAfter = [], ...bodyAfter] = b;
  const rows = paired(
    diff(bodyBefore.map(key), bodyAfter.map(key)),
    bodyBefore,
    bodyAfter,
    // The same row edited keeps its first cell, or most of its words.
    (left, right) => left[0] === right[0] || alike(left.join(" "), right.join(" ")) >= 0.5,
  );
  return {
    type: "table",
    header: changed(headBefore, headAfter),
    rows: rows.map((row) =>
      row.mark === "changed"
        ? { mark: "changed" as const, cells: changed(row.before, row.after) }
        : { mark: row.mark, cells: cellsOf(row.item, row.mark) },
    ),
  };
}

function codeChange(before: Block, after: Block): KinDocChange {
  const a = before.text.split("\n");
  const b = after.text.split("\n");
  return {
    type: "code",
    lines: diff(a, b).map((op) =>
      op.op === "same"
        ? { text: b[op.b]!, mark: "same" as const }
        : op.op === "removed"
          ? { text: a[op.a]!, mark: "removed" as const }
          : { text: b[op.b]!, mark: "added" as const },
    ),
  };
}

const unmarked = (block: Block) =>
  block.kind === "heading"
    ? block.text.replace(/^\s*#{1,6}\s+/, "").replace(/\s+#+\s*$/, "")
    : block.kind === "quote"
      ? block.text.replace(/^\s*>\s?/gm, "")
      : block.text;

function edited(before: Block, after: Block): KinDocChange {
  if (after.kind === "list") return listChange(before, after);
  if (after.kind === "table") return tableChange(before, after);
  if (after.kind === "code") return codeChange(before, after);
  return {
    type: "text",
    block: after.kind === "heading" ? "heading" : after.kind === "quote" ? "quote" : "paragraph",
    level: after.kind === "heading" ? after.level : 0,
    runs: kinDocWordRuns(flat(unmarked(before)), flat(unmarked(after))),
  };
}

const pairs = (before: Block, after: Block) => {
  if (before.kind !== after.kind || before.kind === "other") return false;
  if (before.kind === "table") {
    const head = (block: Block) => rowsOf(block.text)[0]?.join("\u0001");
    return head(before) === head(after) || alike(before.text, after.text) >= 0.5;
  }
  // A heading is short: one shared word is already the same heading reworded.
  return (
    alike(flat(unmarked(before)), flat(unmarked(after))) >= (before.kind === "heading" ? 0.3 : 0.5)
  );
};

// Folding

/** Unchanged blocks kept on each side of a change, so it reads in its place. */
const CONTEXT = 1;
const LONG_BLOCKS = 6;
const LONG_CHARS = 1_200;

const count = (blocks: number) => (blocks === 1 ? "1 paragraph" : `${blocks} paragraphs`);

/** The formatted comparison of two versions' markdown. */
export function kinDocChanges(before: string, after: string): KinDocChangesView {
  const a = blocksOf(before);
  const b = blocksOf(after);
  const steps = paired(
    diff(
      a.map((block) => block.text),
      b.map((block) => block.text),
    ),
    a,
    b,
    pairs,
  );
  const parts: Array<KinDocChangePart> = [];
  const id = () => `part-${parts.length}`;
  const markdownOf = (blocks: ReadonlyArray<Block>) =>
    blocks.map((block) => block.text).join("\n\n");
  const show = (blocks: ReadonlyArray<Block>, mark: KinDocMark) => {
    if (blocks.length > 0)
      parts.push({
        type: "shown",
        id: id(),
        change: { type: "block", mark, markdown: markdownOf(blocks) },
      });
  };
  const fold = (blocks: ReadonlyArray<Block>, mark: KinDocMark) => {
    const heading = blocks[0]?.kind === "heading" ? flat(unmarked(blocks[0])) : null;
    const word = mark === "added" ? KIN_DOC_CHANGES.added : KIN_DOC_CHANGES.removed;
    parts.push({
      type: "folded",
      id: id(),
      mark,
      label:
        mark === "same"
          ? `${count(blocks.length)} unchanged`
          : heading === null
            ? `${word}, ${count(blocks.length)}`
            : `${word} section: ${heading}`,
      markdown: markdownOf(blocks),
    });
  };
  let at = 0;
  while (at < steps.length) {
    const step = steps[at]!;
    if (step.mark === "changed") {
      parts.push({ type: "shown", id: id(), change: edited(step.before, step.after) });
      at += 1;
      continue;
    }
    const blocks: Array<Block> = [];
    const mark = step.mark;
    while (at < steps.length) {
      const next = steps[at]!;
      if (next.mark !== mark) break;
      blocks.push(next.item);
      at += 1;
    }
    if (mark === "same") {
      const lead = parts.length === 0 ? 0 : CONTEXT;
      const trail = at >= steps.length ? 0 : CONTEXT;
      if (blocks.length <= lead + trail + 1) {
        show(blocks, mark);
        continue;
      }
      show(blocks.slice(0, lead), mark);
      fold(blocks.slice(lead, blocks.length - trail), mark);
      show(blocks.slice(blocks.length - trail), mark);
      continue;
    }
    const long =
      blocks.length > LONG_BLOCKS ||
      blocks.reduce((sum, block) => sum + block.text.length, 0) > LONG_CHARS;
    if (long) fold(blocks, mark);
    else show(blocks, mark);
  }
  return { parts, identical: steps.every((step) => step.mark === "same") };
}
