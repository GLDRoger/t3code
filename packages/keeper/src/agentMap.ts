import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const GENERATED_MAP_MARKER = "<!-- kin:generated agent map -->";
export const HOUSES_TSV_PATH = ".kin/houses.tsv";
export const HOUSE_MAP_OVERLAY_DIR = ".kin/house-maps";

const HOUSE_SLUG = /^[a-z0-9][a-z0-9-]*$/u;

export interface HousePattern {
  readonly pattern: string;
  readonly house: string;
}

export interface HouseMapInput {
  readonly house: string;
  readonly patterns: readonly string[];
  readonly invariants: readonly string[];
  readonly traps: readonly string[];
  readonly summary?: string;
}

export const houseMapRelativePath = (house: string): string => `docs/agent-maps/${house}.md`;

export const isHouseSlug = (house: string): boolean => HOUSE_SLUG.test(house);

/** `pattern<tab>house`. Blank lines and `#` comments are ignored. */
export const parseHousesTsv = (text: string): readonly HousePattern[] => {
  const rows: HousePattern[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const tab = trimmed.indexOf("\t");
    if (tab <= 0) continue;
    const pattern = trimmed.slice(0, tab).trim();
    const house = trimmed.slice(tab + 1).trim();
    if (pattern.length === 0 || house.length === 0) continue;
    rows.push({ pattern, house });
  }
  return rows;
};

const sectionItems = (markdown: string, heading: string): readonly string[] => {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) items.push(trimmed.slice(2).trim());
  }
  return items;
};

const summarySection = (markdown: string): string => {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === "## Summary");
  if (start < 0) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    body.push(line);
  }
  return body.join("\n").trim();
};

/**
 * Byte-stable for a given input. No timestamps or counts. Patterns are sorted
 * so a reordered houses.tsv does not change the map. Invariants and traps keep
 * the overlay's order.
 */
export const renderHouseMap = (input: HouseMapInput): string => {
  const lines = [GENERATED_MAP_MARKER, `# ${input.house}`, ""];
  if (input.summary !== undefined && input.summary.trim().length > 0) {
    lines.push(input.summary.trim(), "");
  }
  lines.push("## Patterns", "");
  const patterns = input.patterns.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (patterns.length === 0) lines.push("- (none)");
  else for (const pattern of patterns) lines.push(`- \`${pattern}\``);
  lines.push("", "## Invariants", "");
  if (input.invariants.length === 0) lines.push("- (none yet)");
  else for (const item of input.invariants) lines.push(`- ${item}`);
  lines.push("", "## Traps", "");
  if (input.traps.length === 0) lines.push("- (none yet)");
  else for (const item of input.traps) lines.push(`- ${item}`);
  lines.push(
    "",
    "## Notes board",
    "",
    `Read and append notes with the lineage toolkit (\`lineage_read\`, \`lineage_add\`), tagged \`${input.house}\`.`,
    "",
    "## Start here",
    "",
    "Read `AGENTS.md`, this map, and the notes board before editing this house.",
    "",
  );
  return `${lines.join("\n")}`;
};

export const housesFromTsv = (
  rows: readonly HousePattern[],
  overlays: ReadonlyMap<string, string>,
): { readonly houses: readonly HouseMapInput[]; readonly rejected: readonly string[] } => {
  const grouped = new Map<string, string[]>();
  const rejected: string[] = [];
  for (const row of rows) {
    if (!isHouseSlug(row.house)) {
      rejected.push(row.house);
      continue;
    }
    const patterns = grouped.get(row.house) ?? [];
    patterns.push(row.pattern);
    grouped.set(row.house, patterns);
  }
  const houses: HouseMapInput[] = [];
  for (const [house, patterns] of grouped) {
    const overlay = overlays.get(house) ?? "";
    const summary = summarySection(overlay);
    houses.push({
      house,
      patterns,
      invariants: sectionItems(overlay, "Invariants"),
      traps: sectionItems(overlay, "Traps"),
      ...(summary.length > 0 ? { summary } : {}),
    });
  }
  houses.sort((a, b) => (a.house < b.house ? -1 : a.house > b.house ? 1 : 0));
  return { houses, rejected };
};

export interface HouseMapWriteResult {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly skipped: readonly string[];
  readonly rejected: readonly string[];
}

const readOptional = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(filePath))) return "";
    return yield* fs.readFileString(filePath);
  });

/**
 * Writes `docs/agent-maps/<house>.md`. A hand-written map without the generated
 * marker is left alone unless `force` is set. Equal bytes are not rewritten,
 * so the file stays stable between generator runs.
 */
export const writeHouseMaps = Effect.fn("AgentMap.writeHouseMaps")(function* (input: {
  readonly projectRoot: string;
  readonly houses: readonly HouseMapInput[];
  readonly force?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const written: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  for (const house of input.houses) {
    if (!isHouseSlug(house.house)) continue;
    const relative = houseMapRelativePath(house.house);
    const target = path.join(input.projectRoot, relative);
    const next = renderHouseMap(house);
    const existing = yield* readOptional(target);
    const generated = existing.startsWith(GENERATED_MAP_MARKER);
    if (existing.length > 0 && !generated && input.force !== true) {
      skipped.push(relative);
      continue;
    }
    if (existing === next) {
      unchanged.push(relative);
      continue;
    }
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, next);
    written.push(relative);
  }
  return { written, unchanged, skipped, rejected: [] } satisfies HouseMapWriteResult;
});

export const generateHouseMaps = Effect.fn("AgentMap.generateHouseMaps")(function* (input: {
  readonly projectRoot: string;
  readonly force?: boolean;
}) {
  const path = yield* Path.Path;
  const tsvPath = path.join(input.projectRoot, HOUSES_TSV_PATH);
  const tsv = yield* readOptional(tsvPath);
  if (tsv.length === 0) {
    return {
      written: [],
      unchanged: [],
      skipped: [],
      rejected: [],
      missingTsv: true,
    };
  }
  const rows = parseHousesTsv(tsv);
  const overlays = new Map<string, string>();
  for (const row of rows) {
    if (!isHouseSlug(row.house) || overlays.has(row.house)) continue;
    const overlayPath = path.join(input.projectRoot, HOUSE_MAP_OVERLAY_DIR, `${row.house}.md`);
    const overlay = yield* readOptional(overlayPath);
    if (overlay.length > 0) overlays.set(row.house, overlay);
  }
  const { houses, rejected } = housesFromTsv(rows, overlays);
  const result = yield* writeHouseMaps({
    projectRoot: input.projectRoot,
    houses,
    ...(input.force === true ? { force: true } : {}),
  });
  return { ...result, rejected, missingTsv: false };
});
