/**
 * `.kin/houses.tsv` maps a lane-name regex to a house.
 *
 * Columns, tab-separated: pattern, house, optional agent-map path.
 * Blank lines and `#` comments are ignored. A header row whose first cell is
 * `pattern`, `regex`, or `lane` is skipped.
 *
 * The old `lineages.tsv` file uses the same shape with the house column named
 * `lineage` (or `line`). `importLineagesTsv` rewrites that file into houses.tsv
 * text.
 */

export interface KinHousePatternRule {
  readonly pattern: string;
  readonly houseName: string;
  readonly agentMapPath: string | null;
}

export interface KinHouseCatalog {
  readonly rules: ReadonlyArray<KinHousePatternRule>;
  readonly houses: ReadonlyArray<{
    readonly name: string;
    readonly patterns: ReadonlyArray<string>;
    readonly agentMapPath: string | null;
  }>;
}

const HEADER_PATTERN = new Set(["pattern", "regex", "lane", "lane_pattern"]);
const HEADER_HOUSE = new Set(["house", "lineage", "line", "lineage_name", "name"]);

class KinHousesTsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KinHousesTsvError";
  }
}

export function parseHousesTsv(text: string): KinHouseCatalog {
  return catalogFromRows(readRows(text));
}

export function parseLineagesTsv(text: string): KinHouseCatalog {
  return catalogFromRows(readRows(text));
}

/** Old lineages.tsv rows become houses.tsv text, pattern then house. */
export function importLineagesTsv(text: string): string {
  const catalog = parseLineagesTsv(text);
  const lines = ["pattern\thouse\tagent_map"];
  for (const rule of catalog.rules) {
    lines.push(`${rule.pattern}\t${rule.houseName}\t${rule.agentMapPath ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export function patternMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

export function houseForLaneLabel(
  rules: ReadonlyArray<KinHousePatternRule>,
  label: string,
): KinHousePatternRule | undefined {
  return rules.find((rule) => patternMatches(rule.pattern, label));
}

function readRows(
  text: string,
): Array<{ pattern: string; houseName: string; agentMapPath: string | null }> {
  const rows: Array<{ pattern: string; houseName: string; agentMapPath: string | null }> = [];
  let headerSeen = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const cells = rawLine.split("\t").map((cell) => cell.trim());
    if (
      cells.length < 2 ||
      cells[0] === undefined ||
      cells[1] === undefined ||
      cells[1].length === 0
    ) {
      throw new KinHousesTsvError(`Expected pattern and house columns: ${line}`);
    }
    if (
      !headerSeen &&
      HEADER_PATTERN.has(cells[0].toLowerCase()) &&
      HEADER_HOUSE.has(cells[1].toLowerCase())
    ) {
      headerSeen = true;
      continue;
    }
    headerSeen = true;
    const agentMapPath = cells[2] !== undefined && cells[2].length > 0 ? cells[2] : null;
    rows.push({ pattern: cells[0], houseName: cells[1], agentMapPath });
  }
  return rows;
}

function catalogFromRows(
  rows: ReadonlyArray<{ pattern: string; houseName: string; agentMapPath: string | null }>,
): KinHouseCatalog {
  const byName = new Map<string, { patterns: Array<string>; agentMapPath: string | null }>();
  for (const row of rows) {
    const existing = byName.get(row.houseName) ?? { patterns: [], agentMapPath: null };
    existing.patterns.push(row.pattern);
    if (existing.agentMapPath === null && row.agentMapPath !== null) {
      existing.agentMapPath = row.agentMapPath;
    }
    byName.set(row.houseName, existing);
  }
  const houses = [...byName.entries()]
    .sort((left, right) => compareByte(left[0], right[0]))
    .map(([name, house]) => ({
      name,
      patterns: house.patterns,
      agentMapPath: house.agentMapPath,
    }));
  return { rules: rows, houses };
}

function compareByte(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
