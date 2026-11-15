// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous digest; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import type { KinConnectionToolDefinition, KinConnectionToolMode } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Predicate from "effect/Predicate";

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/**
 * One tool as its server listed it: `definition` is the JSON as sent, nothing filled in, so a
 * hint the server dropped reads as dropped. Its classification comes from the same object.
 */
export type ListedTool = {
  readonly name: string;
  readonly definition: Readonly<Record<string, unknown>>;
  /** The server said `openWorldHint: true`, or Kin couldn't read the hint as sent. */
  readonly openWorld: boolean;
};

const field = (value: unknown, name: string) =>
  Predicate.hasProperty(value, name) ? value[name] : undefined;
const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);

/** What a tool's pin covers, as sent. `outputSchema` is left out: no model sees it. */
const pinned = (definition: unknown): KinConnectionToolDefinition => ({
  name: String(field(definition, "name")),
  title: textOrNull(field(definition, "title")),
  description: textOrNull(field(definition, "description")),
  inputSchema: field(definition, "inputSchema"),
  annotations: field(definition, "annotations") ?? null,
});

export const pinDigest = (definition: unknown) => sha256(stableStringify(pinned(definition)));
export const instructionsDigest = (text: string | undefined) =>
  text === undefined || text === "" ? null : sha256(stableStringify({ instructions: text }));

/**
 * Whether a parsed value prints back as the one sent: an infinite, `-0` or unsafe integer parses
 * to a number that two different definitions share, so their pins would match.
 */
export const faithful = (value: unknown, depth = 0): boolean => {
  if (depth > 64) return false;
  if (typeof value === "number")
    return (
      Number.isFinite(value) &&
      !Object.is(value, -0) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
  if (Array.isArray(value)) return value.every((entry) => faithful(entry, depth + 1));
  if (Predicate.isObject(value))
    return Object.values(value).every((entry) => faithful(entry, depth + 1));
  return true;
};

/**
 * Open when the server said `openWorldHint: true`, or sent a hint that isn't a boolean. No hint
 * is closed: most servers set none, and a server that may reach anywhere is `open` reach instead.
 */
export const sentOpenWorld = (definition: unknown) => {
  const hint = field(field(definition, "annotations"), "openWorldHint");
  return hint !== undefined && hint !== false;
};

/** The server's own labels only pre-select a mark; the owner's mark decides. */
// `destructiveHint` means something only when `readOnlyHint` is false (MCP spec).
export const suggestedMode = (definition: unknown): KinConnectionToolMode => {
  const annotations = field(definition, "annotations");
  return field(annotations, "readOnlyHint") === true
    ? "read"
    : field(annotations, "destructiveHint") === true
      ? "off"
      : "ask";
};

export type StoredTool = {
  readonly name: string;
  readonly pinDigest: string;
  readonly acceptedDigest: string | null;
  readonly definitionJson: string;
  readonly removedAt: number | null;
};

export type ToolChange =
  | { readonly _tag: "added"; readonly tool: ListedTool }
  | { readonly _tag: "changed"; readonly tool: ListedTool }
  | { readonly _tag: "same"; readonly tool: ListedTool; readonly returned: boolean }
  | { readonly _tag: "removed"; readonly name: string };

/**
 * What a fresh listing means for the stored tools. A changed pin keeps the accepted digest, so
 * the tool stops being callable until the owner accepts it; a new tool arrives off. The
 * gateway refuses a listing that names a tool twice, so each name here is one occurrence.
 */
export const reconcile = (
  stored: ReadonlyArray<StoredTool>,
  listed: ReadonlyArray<ListedTool>,
): ReadonlyArray<ToolChange> => {
  const byName = new Map(stored.map((row) => [row.name, row]));
  const seen = new Set<string>();
  const changes: Array<ToolChange> = [];
  for (const tool of listed) {
    seen.add(tool.name);
    const before = byName.get(tool.name);
    if (before === undefined) changes.push({ _tag: "added", tool });
    else if (before.pinDigest !== pinDigest(tool.definition))
      changes.push({ _tag: "changed", tool });
    else changes.push({ _tag: "same", tool, returned: before.removedAt !== null });
  }
  for (const row of stored)
    if (!seen.has(row.name) && row.removedAt === null)
      changes.push({ _tag: "removed", name: row.name });
  return changes;
};
