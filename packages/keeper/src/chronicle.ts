import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Primary-source record the keeper summarizes. Wills and notes come from
 * lane 2's lineage service. Day entries are the Phase 2 memory-keeper input.
 * A chronicle is never an entry: passes must not summarize their own output.
 */
export type KeeperEntryKind = "will" | "note" | "day";

export interface KeeperEntry {
  readonly id: string;
  readonly kind: KeeperEntryKind;
  readonly at: string;
  readonly body: string;
  readonly houseIds?: readonly string[];
  readonly author?: string;
  readonly flaggedMisleading?: boolean;
}

export interface KeeperTrigger {
  readonly minNewWills?: number;
  readonly minNewNotes?: number;
  readonly minNewEntries?: number;
  /**
   * Host cadence for looking, not a force-run. The count gate still applies.
   * Cron text is stored for the scheduled-task registrar.
   */
  readonly schedule?: string;
}

export interface KeeperOutput {
  readonly path: string;
  readonly maxBytes: number;
  readonly maxAgeHours: number;
}

export interface KeeperModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly reuseSession: boolean;
}

export interface KeeperScope {
  readonly id: string;
  readonly trigger: KeeperTrigger;
  readonly output: KeeperOutput;
  readonly rebuildEvery: number;
  readonly model: KeeperModelConfig;
}

export const ARCHIVIST_MIN_NEW_WILLS = 8;
export const ARCHIVIST_MIN_NEW_NOTES = 30;
export const CHRONICLE_MAX_AGE_HOURS = 12;
export const CHRONICLE_MAX_BYTES = 24 * 1024;
export const ARCHIVIST_REBUILD_EVERY = 4;
export const CHRONICLE_RELATIVE_PATH = ".kin/chronicle.md";
export const LIFE_CHRONICLE_RELATIVE_PATH = ".kin/life-chronicle.md";
/** Hourly look. The 8-will / 30-note gate still decides whether a pass writes. */
export const ARCHIVIST_CHECK_SCHEDULE = "0 * * * *";

/**
 * Cheap-tier alias. Hosts map `cheap` onto the small model they pay for.
 * `inherit` uses the main agent's provider. Both are configurable per scope.
 */
export const DEFAULT_KEEPER_MODEL: KeeperModelConfig = {
  provider: "inherit",
  model: "cheap",
  reuseSession: true,
};

const LONG_LIVED_SESSION_PROVIDERS = new Set([
  "inherit",
  "codex",
  "claude",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "pi",
]);

const utf8 = new TextEncoder();

export const utf8ByteLength = (text: string): number => utf8.encode(text).byteLength;

export const epochMillis = (at: string): number | null => {
  const parsed = DateTime.make(at);
  return Option.isNone(parsed) ? null : DateTime.toEpochMillis(parsed.value);
};

export const providerAllowsLongLivedSession = (provider: string): boolean =>
  LONG_LIVED_SESSION_PROVIDERS.has(provider);

export const archivistScope = (
  projectId: string,
  model: KeeperModelConfig = DEFAULT_KEEPER_MODEL,
): KeeperScope => ({
  id: `repo:${projectId}`,
  trigger: {
    minNewWills: ARCHIVIST_MIN_NEW_WILLS,
    minNewNotes: ARCHIVIST_MIN_NEW_NOTES,
    schedule: ARCHIVIST_CHECK_SCHEDULE,
  },
  output: {
    path: CHRONICLE_RELATIVE_PATH,
    maxBytes: CHRONICLE_MAX_BYTES,
    maxAgeHours: CHRONICLE_MAX_AGE_HOURS,
  },
  rebuildEvery: ARCHIVIST_REBUILD_EVERY,
  model,
});

/** Phase 2 life scope. Same pass rules, different id and source kind. */
export const memoryKeeperScope = (
  userId: string,
  model: KeeperModelConfig = DEFAULT_KEEPER_MODEL,
): KeeperScope => ({
  id: `life:${userId}`,
  trigger: { minNewEntries: 30 },
  output: {
    path: LIFE_CHRONICLE_RELATIVE_PATH,
    maxBytes: CHRONICLE_MAX_BYTES,
    maxAgeHours: CHRONICLE_MAX_AGE_HOURS,
  },
  rebuildEvery: ARCHIVIST_REBUILD_EVERY,
  model,
});

export interface NewCounts {
  readonly wills: number;
  readonly notes: number;
  readonly entries: number;
}

/** `sinceMillis` null counts every parseable entry (there has been no pass yet). */
export const countNew = (
  entries: readonly KeeperEntry[],
  sinceMillis: number | null,
): NewCounts => {
  let wills = 0;
  let notes = 0;
  let total = 0;
  for (const entry of entries) {
    const at = epochMillis(entry.at);
    if (at === null) continue;
    if (sinceMillis !== null && at <= sinceMillis) continue;
    total += 1;
    if (entry.kind === "will") wills += 1;
    else if (entry.kind === "note") notes += 1;
  }
  return { wills, notes, entries: total };
};

export const shouldRunPass = (counts: NewCounts, trigger: KeeperTrigger): boolean => {
  if (trigger.minNewWills !== undefined && counts.wills >= trigger.minNewWills) return true;
  if (trigger.minNewNotes !== undefined && counts.notes >= trigger.minNewNotes) return true;
  if (trigger.minNewEntries !== undefined && counts.entries >= trigger.minNewEntries) return true;
  return false;
};

export const compareEntries = (a: KeeperEntry, b: KeeperEntry): number => {
  const left = epochMillis(a.at);
  const right = epochMillis(b.at);
  if (left === null && right === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (left !== right) return left - right;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
};

/** Drops unparseable timestamps and returns a new array sorted by time, then id. */
export const validEntries = (entries: readonly KeeperEntry[]): readonly KeeperEntry[] =>
  entries
    .filter((entry) => epochMillis(entry.at) !== null)
    .slice()
    .sort(compareEntries);

export interface SessionPlan {
  readonly sessionId: string;
  readonly reused: boolean;
}

/**
 * Reuse the previous session when the provider allows it and this pass is not
 * a rebuild. A rebuild drops the session so the model cannot continue from its
 * own earlier summary.
 */
export const planSession = (input: {
  readonly scopeId: string;
  readonly pass: number;
  readonly rebuilt: boolean;
  readonly previousSessionId: string | null;
  readonly model: KeeperModelConfig;
}): SessionPlan => {
  const allow = input.model.reuseSession && providerAllowsLongLivedSession(input.model.provider);
  if (allow && !input.rebuilt && input.previousSessionId !== null) {
    return { sessionId: input.previousSessionId, reused: true };
  }
  return { sessionId: `${input.scopeId}#${input.pass}`, reused: false };
};

export const passNumber = (
  previousPass: number | null,
  rebuildEvery: number,
): {
  readonly pass: number;
  readonly rebuilt: boolean;
} => {
  const pass = (previousPass ?? 0) + 1;
  const every = rebuildEvery > 0 ? rebuildEvery : 1;
  return { pass, rebuilt: pass % every === 0 };
};

const AS_OF_LINE = /^As of (\S+)$/;

export const parseAsOf = (text: string): string | null => {
  const first = text.split(/\r?\n/u, 1)[0] ?? "";
  const stamp = AS_OF_LINE.exec(first)?.[1];
  if (stamp === undefined) return null;
  const parsed = DateTime.make(stamp);
  if (Option.isNone(parsed)) return null;
  return DateTime.formatIso(parsed.value);
};

export type ChronicleIgnoreReason = "no-timestamp" | "stale" | "too-large";

export type ChronicleVerdict =
  | {
      readonly status: "fresh";
      readonly asOf: string;
      readonly text: string;
      readonly bytes: number;
    }
  | {
      readonly status: "ignored";
      readonly reason: ChronicleIgnoreReason;
      readonly bytes: number;
    };

const HOUR_MS = 60 * 60 * 1000;

/**
 * Readers use this, not the writer. A chronicle with no As-of line, older than
 * the max age, or larger than the max byte size is ignored.
 * Age equal to the max is still fresh. Size equal to the max is still fresh.
 */
export const readChronicle = (
  text: string,
  now: DateTime.DateTime,
  limits: { readonly maxAgeHours: number; readonly maxBytes: number } = {
    maxAgeHours: CHRONICLE_MAX_AGE_HOURS,
    maxBytes: CHRONICLE_MAX_BYTES,
  },
): ChronicleVerdict => {
  const bytes = utf8ByteLength(text);
  if (bytes > limits.maxBytes) return { status: "ignored", reason: "too-large", bytes };
  const asOf = parseAsOf(text);
  if (asOf === null) return { status: "ignored", reason: "no-timestamp", bytes };
  const asOfMillis = epochMillis(asOf);
  if (asOfMillis === null) return { status: "ignored", reason: "no-timestamp", bytes };
  const ageMs = DateTime.toEpochMillis(now) - asOfMillis;
  if (ageMs > limits.maxAgeHours * HOUR_MS) return { status: "ignored", reason: "stale", bytes };
  return { status: "fresh", asOf, text, bytes };
};

export const formatChronicle = (asOfIso: string, body: string): string => {
  const trimmed = body.trim();
  return trimmed.length === 0 ? `As of ${asOfIso}\n` : `As of ${asOfIso}\n\n${trimmed}\n`;
};

const TRUNCATION_NOTE = "\n\n[truncated]\n";

const truncateUtf8 = (text: string, maxBytes: number): string => {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8ByteLength(chars.slice(0, mid).join("")) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("");
};

/** Keeps the As-of line and stays within `maxBytes` so readers will accept the file. */
export const fitChronicle = (text: string, maxBytes: number): string => {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const newline = text.indexOf("\n");
  const header = newline === -1 ? text : text.slice(0, newline + 1);
  const noteBytes = utf8ByteLength(TRUNCATION_NOTE);
  if (utf8ByteLength(header) + noteBytes > maxBytes) return truncateUtf8(header, maxBytes);
  const trimmed = truncateUtf8(text, maxBytes - noteBytes).replace(/\s+$/u, "");
  const withNote = `${trimmed}${TRUNCATION_NOTE}`;
  if (utf8ByteLength(withNote) <= maxBytes) return withNote;
  return truncateUtf8(header, maxBytes);
};

/**
 * Wills strictly newer than the chronicle's As-of time, oldest first.
 * Bodies are copied through unchanged. Equal timestamps stay in the chronicle.
 */
export const renderVerbatimWills = (entries: readonly KeeperEntry[], asOfIso: string): string => {
  const asOf = epochMillis(asOfIso);
  if (asOf === null) return "";
  const wills = entries
    .filter((entry) => entry.kind === "will" && (epochMillis(entry.at) ?? -1) > asOf)
    .slice()
    .sort(compareEntries);
  if (wills.length === 0) return "";
  const blocks = wills.map((will) => `### ${will.id}\n${will.at}\n${will.body}`);
  return `## Wills since the chronicle\n\n${blocks.join("\n\n")}\n`;
};

const collapse = (body: string): string => {
  const flat = body.replace(/\s+/gu, " ").trim();
  return flat.length <= 160 ? flat : `${flat.slice(0, 157)}...`;
};

/**
 * Compact digest of primary sources. Used when no model adapter is wired.
 * It reads entry bodies, never a previous chronicle.
 */
export const deterministicDigest = (entries: readonly KeeperEntry[]): string => {
  const lines = ["# Digest", "", "Primary sources only."];
  const titles: Record<KeeperEntryKind, string> = {
    will: "Wills",
    note: "Notes",
    day: "Days",
  };
  for (const kind of ["will", "note", "day"] as const) {
    const group = entries.filter((entry) => entry.kind === kind);
    if (group.length === 0) continue;
    lines.push("", `## ${titles[kind]}`);
    for (const entry of group) {
      const flag = entry.flaggedMisleading === true ? " flagged-misleading" : "";
      lines.push(`- ${entry.id} ${entry.at}${flag} ${collapse(entry.body)}`);
    }
  }
  return lines.join("\n");
};

/**
 * User message for a cheap-model adapter. Contains the raw entries and an
 * instruction to ignore earlier summaries. The chronicle file is not an input.
 */
export const renderSummarizerPrompt = (input: {
  readonly rebuilt: boolean;
  readonly entries: readonly KeeperEntry[];
  readonly model: KeeperModelConfig;
}): string => {
  const lines = [
    "You are the Kin keeper.",
    "Summarize only the primary sources below.",
    "Do not summarize a previous chronicle or your own earlier summary.",
    "Write a stable digest. No greetings. No timestamps other than those on the sources.",
    `Model: ${input.model.provider}/${input.model.model}`,
  ];
  if (input.rebuilt) {
    lines.push("This pass rebuilds from the raw sources. Ignore any earlier session turns.");
  }
  lines.push("", "Sources:");
  for (const entry of input.entries) {
    const houses = entry.houseIds?.join(",") ?? "";
    const flag = entry.flaggedMisleading === true ? " flagged-misleading" : "";
    lines.push("", `## ${entry.kind} ${entry.id}`, entry.at);
    if (houses.length > 0 || flag.length > 0) {
      lines.push(`houses: ${houses}${flag}`.trim());
    }
    lines.push(entry.body);
  }
  return `${lines.join("\n")}\n`;
};
