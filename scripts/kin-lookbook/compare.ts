// @effect-diagnostics nodeBuiltinImport:off - compares two look book sets and writes the page a person reads.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { PNG } from "pngjs";

import { type Manifest, readManifest } from "./manifest.ts";

export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** RGBA, row by row. */
  readonly data: Uint8Array;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelDiff {
  readonly differing: number;
  readonly boxes: ReadonlyArray<Box>;
}

const TILE = 16;
/** Per channel, out of 255: the glass blur and antialiased edges vary this much between runs. */
export const NOISE = 16;

/**
 * Pixels that differ beyond rendering noise, and the areas they fall in: differing tiles joined with their neighbours,
 * so one changed control is one outline. Images of different sizes differ everywhere.
 */
export function diffPixels(a: Pixels, b: Pixels): PixelDiff {
  if (a.width !== b.width || a.height !== b.height)
    return {
      differing: Math.max(a.width * a.height, b.width * b.height),
      boxes: [{ x: 0, y: 0, width: b.width, height: b.height }],
    };
  const columns = Math.ceil(a.width / TILE);
  const rows = Math.ceil(a.height / TILE);
  const marked = new Uint8Array(columns * rows);
  let differing = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const at = (y * a.width + x) * 4;
      if (
        Math.abs(a.data[at]! - b.data[at]!) > NOISE ||
        Math.abs(a.data[at + 1]! - b.data[at + 1]!) > NOISE ||
        Math.abs(a.data[at + 2]! - b.data[at + 2]!) > NOISE ||
        Math.abs(a.data[at + 3]! - b.data[at + 3]!) > NOISE
      ) {
        differing++;
        marked[Math.floor(y / TILE) * columns + Math.floor(x / TILE)] = 1;
      }
    }
  const boxes: Array<Box> = [];
  const seen = new Uint8Array(marked.length);
  for (let start = 0; start < marked.length; start++) {
    if (marked[start] === 0 || seen[start] === 1) continue;
    let [left, top, right, bottom] = [columns, rows, 0, 0];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const tile = stack.pop()!;
      const column = tile % columns;
      const row = Math.floor(tile / columns);
      left = Math.min(left, column);
      right = Math.max(right, column);
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const c = column + dx;
          const r = row + dy;
          if (c < 0 || r < 0 || c >= columns || r >= rows) continue;
          const next = r * columns + c;
          if (marked[next] === 1 && seen[next] === 0) {
            seen[next] = 1;
            stack.push(next);
          }
        }
    }
    const x = left * TILE;
    const y = top * TILE;
    boxes.push({
      x,
      y,
      width: Math.min(a.width, (right + 1) * TILE) - x,
      height: Math.min(a.height, (bottom + 1) * TILE) - y,
    });
  }
  return { differing, boxes };
}

export type Verdict = "same" | "changed" | "new" | "missing";

export interface ScreenResult {
  readonly file: string;
  readonly verdict: Verdict;
  readonly differing?: number;
  readonly boxes?: ReadonlyArray<Box>;
}

export interface TabResult {
  readonly person: string;
  readonly accepted: string | null;
  readonly new: string | null;
}

export interface Comparison {
  readonly accepted: Pick<Manifest, "commit" | "capturedAt">;
  readonly new: Pick<Manifest, "commit" | "capturedAt">;
  readonly screens: ReadonlyArray<ScreenResult>;
  /** Tab titles and icons that differ, per person. */
  readonly tabs: ReadonlyArray<TabResult>;
  readonly counts: Readonly<Record<Verdict, number>>;
}

const tabLine = (tab: Manifest["tab"][string] | undefined) =>
  tab === undefined ? null : `${tab.title} · icon ${tab.icon} (${tab.iconSha256 ?? "unread"})`;

/** Two sets compared, screen by screen, by their manifests and decoded pixels. */
export function compareManifests(
  accepted: Manifest,
  next: Manifest,
  pixels: (set: "accepted" | "new", file: string) => Pixels,
): Comparison {
  const before = new Set(accepted.screens.map((screen) => screen.file));
  const after = new Set(next.screens.map((screen) => screen.file));
  const screens: Array<ScreenResult> = [];
  for (const file of [...new Set([...before, ...after])].sort()) {
    if (!after.has(file)) screens.push({ file, verdict: "missing" });
    else if (!before.has(file)) screens.push({ file, verdict: "new" });
    else {
      const diff = diffPixels(pixels("accepted", file), pixels("new", file));
      screens.push(
        diff.differing === 0
          ? { file, verdict: "same" }
          : { file, verdict: "changed", differing: diff.differing, boxes: diff.boxes },
      );
    }
  }
  const tabs: Array<TabResult> = [];
  for (const person of [
    ...new Set([...Object.keys(accepted.tab), ...Object.keys(next.tab)]),
  ].sort()) {
    const was = tabLine(accepted.tab[person]);
    const now = tabLine(next.tab[person]);
    if (was !== now) tabs.push({ person, accepted: was, new: now });
  }
  const counts = { same: 0, changed: 0, new: 0, missing: 0 };
  for (const screen of screens) counts[screen.verdict]++;
  counts.changed += tabs.length;
  return {
    accepted: { commit: accepted.commit, capturedAt: accepted.capturedAt },
    new: { commit: next.commit, capturedAt: next.capturedAt },
    screens,
    tabs,
    counts,
  };
}

export const anythingChanged = (comparison: Comparison) =>
  comparison.counts.changed + comparison.counts.new + comparison.counts.missing > 0;

const decode = (path: string): Pixels => PNG.sync.read(NodeFS.readFileSync(path));

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function figure(src: string, label: string, boxes: ReadonlyArray<Box>, size: Pixels | null) {
  const outlines =
    size === null
      ? ""
      : boxes
          .map(
            (box) =>
              `<span class="box" style="left:${(100 * box.x) / size.width}%;top:${(100 * box.y) / size.height}%;width:${(100 * box.width) / size.width}%;height:${(100 * box.height) / size.height}%"></span>`,
          )
          .join("");
  return `<figure><figcaption>${escapeHtml(label)}</figcaption><a href="${src}"><span class="frame"><img src="${src}" alt="${escapeHtml(label)}" loading="lazy">${outlines}</span></a></figure>`;
}

/** The page: counts, then each changed screen side by side with its changes outlined. */
export function renderReport(comparison: Comparison, sizes: (file: string) => Pixels | null) {
  const { counts } = comparison;
  const changed = comparison.screens.filter((screen) => screen.verdict === "changed");
  const added = comparison.screens.filter((screen) => screen.verdict === "new");
  const missing = comparison.screens.filter((screen) => screen.verdict === "missing");
  const short = (commit: string) => commit.slice(0, 10);
  const section = (title: string, body: string) =>
    body === "" ? "" : `<h2>${escapeHtml(title)}</h2>${body}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kin look book: ${short(comparison.new.commit)} against ${short(comparison.accepted.commit)}</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#14213d;background:#fbf8f1}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px}
.meta{color:#5b6475;margin:0 0 16px}
.counts{display:flex;gap:12px;margin:0 0 8px}.counts div{padding:8px 14px;border-radius:8px;background:#fff;border:1px solid #e3ddd0}
.counts b{display:block;font-size:22px}.changed b{color:#b54708}.new b,.missing b{color:#1f4e9c}
.screen{margin:0 0 28px;padding:12px;background:#fff;border:1px solid #e3ddd0;border-radius:10px}
.screen h3{margin:0 0 8px;font-size:14px}.pair{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
figure{margin:0;flex:1 1 0;min-width:240px;max-width:720px}figcaption{color:#5b6475;margin:0 0 4px}
.frame{position:relative;display:block;border:1px solid #d9d2c3}.frame img{display:block;width:100%;height:auto}
.box{position:absolute;outline:3px solid #e8590c;outline-offset:1px;pointer-events:none}
ul{padding-left:20px}code{font-size:12px}
</style></head><body>
<h1>Kin look book</h1>
<p class="meta">New ${escapeHtml(short(comparison.new.commit))} (${escapeHtml(comparison.new.capturedAt)}) against accepted ${escapeHtml(short(comparison.accepted.commit))} (${escapeHtml(comparison.accepted.capturedAt)}).</p>
<div class="counts">${(["same", "changed", "new", "missing"] as const).map((verdict) => `<div class="${verdict}"><b>${counts[verdict]}</b>${verdict}</div>`).join("")}</div>
${counts.changed + counts.new + counts.missing === 0 ? "<p>Nothing changed.</p>" : ""}
${section(
  "Browser tab",
  comparison.tabs
    .map(
      (tab) =>
        `<div class="screen"><h3>${escapeHtml(tab.person)}</h3><ul><li>Accepted: ${escapeHtml(tab.accepted ?? "none")}</li><li>New: ${escapeHtml(tab.new ?? "none")}</li></ul></div>`,
    )
    .join(""),
)}
${section(
  `Changed (${changed.length})`,
  changed
    .map(
      (screen) =>
        `<div class="screen"><h3>${escapeHtml(screen.file)} · ${screen.differing} pixels in ${screen.boxes!.length} area${screen.boxes!.length === 1 ? "" : "s"}</h3><div class="pair">${figure(`accepted/${screen.file}`, "Accepted", screen.boxes!, sizes(screen.file))}${figure(`new/${screen.file}`, "New", screen.boxes!, sizes(screen.file))}</div></div>`,
    )
    .join(""),
)}
${section(
  `New (${added.length})`,
  added
    .map(
      (screen) =>
        `<div class="screen"><h3>${escapeHtml(screen.file)}</h3><div class="pair">${figure(`new/${screen.file}`, "New", [], null)}</div></div>`,
    )
    .join(""),
)}
${section(
  `Missing (${missing.length})`,
  missing
    .map(
      (screen) =>
        `<div class="screen"><h3>${escapeHtml(screen.file)}</h3><div class="pair">${figure(`accepted/${screen.file}`, "Accepted, not in the new set", [], null)}</div></div>`,
    )
    .join(""),
)}
</body></html>
`;
}

/** Compares two set folders and writes `index.html` with copies of the images it shows. */
export function compareSets(acceptedDir: string, newDir: string, outDir: string): Comparison {
  const accepted = readManifest(acceptedDir);
  const next = readManifest(newDir);
  const dirOf = (set: "accepted" | "new") => (set === "accepted" ? acceptedDir : newDir);
  const cache = new Map<string, Pixels>();
  const pixels = (set: "accepted" | "new", file: string) => {
    const key = `${set}/${file}`;
    let found = cache.get(key);
    if (found === undefined) {
      found = decode(NodePath.join(dirOf(set), file));
      cache.set(key, found);
    }
    return found;
  };
  const comparison = compareManifests(accepted, next, pixels);
  NodeFS.mkdirSync(outDir, { recursive: true });
  for (const set of ["accepted", "new"] as const) {
    NodeFS.rmSync(NodePath.join(outDir, set), { recursive: true, force: true });
    NodeFS.mkdirSync(NodePath.join(outDir, set), { recursive: true });
  }
  for (const screen of comparison.screens) {
    if (screen.verdict === "same") continue;
    for (const set of ["accepted", "new"] as const) {
      const from = NodePath.join(dirOf(set), screen.file);
      if (NodeFS.existsSync(from))
        NodeFS.copyFileSync(from, NodePath.join(outDir, set, screen.file));
    }
  }
  const html = renderReport(
    comparison,
    (file) => cache.get(`new/${file}`) ?? cache.get(`accepted/${file}`) ?? null,
  );
  NodeFS.writeFileSync(NodePath.join(outDir, "index.html"), html);
  NodeFS.writeFileSync(
    NodePath.join(outDir, "comparison.json"),
    `${JSON.stringify(comparison, null, 2)}\n`,
  );
  return comparison;
}
