// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous digest; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import type { KinConnectionToolDefinition, KinConnectionToolMode } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import type { McpSchema } from "effect/ai";

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** What a tool's pin covers. `outputSchema` is left out: no model sees it. */
const pinned = (tool: McpSchema.Tool): KinConnectionToolDefinition => ({
  name: tool.name,
  title: tool.title ?? null,
  description: tool.description ?? null,
  inputSchema: tool.inputSchema,
  annotations: tool.annotations ?? null,
});

export const pinDigest = (tool: McpSchema.Tool) => sha256(stableStringify(pinned(tool)));
export const instructionsDigest = (text: string | undefined) =>
  text === undefined || text === "" ? null : sha256(stableStringify({ instructions: text }));

const hint = (tool: McpSchema.Tool, name: "destructiveHint" | "readOnlyHint" | "openWorldHint") =>
  tool.annotations?.[name];

/** The server's own labels only pre-select a mark; the owner's mark decides. */
// `destructiveHint` means something only when `readOnlyHint` is false (MCP spec).
export const suggestedMode = (tool: McpSchema.Tool): KinConnectionToolMode =>
  hint(tool, "readOnlyHint") === true
    ? "read"
    : hint(tool, "destructiveHint") === true
      ? "off"
      : "ask";

/**
 * Only a tool that says it reaches beyond its vendor counts as open; most servers set no hint,
 * and a server that may reach anywhere is the connection's `open` reach instead. `sent` is the
 * hint as sent; without it the decoded one, where unset reads as `true`, errs towards open.
 */
export const openWorld = (tool: McpSchema.Tool, sent: ReadonlyMap<string, boolean>) =>
  sent.get(tool.name) ?? hint(tool, "openWorldHint") === true;

export type StoredTool = {
  readonly name: string;
  readonly pinDigest: string;
  readonly acceptedDigest: string | null;
  readonly definitionJson: string;
  readonly removedAt: number | null;
};

export type ToolChange =
  | { readonly _tag: "added"; readonly tool: McpSchema.Tool }
  | { readonly _tag: "changed"; readonly tool: McpSchema.Tool }
  | { readonly _tag: "same"; readonly tool: McpSchema.Tool; readonly returned: boolean }
  | { readonly _tag: "removed"; readonly name: string };

/**
 * What a fresh listing means for the stored tools. A changed pin keeps the accepted digest, so
 * the tool stops being callable until the owner accepts it; a new tool arrives off.
 */
export const reconcile = (
  stored: ReadonlyArray<StoredTool>,
  listed: ReadonlyArray<McpSchema.Tool>,
): ReadonlyArray<ToolChange> => {
  const byName = new Map(stored.map((row) => [row.name, row]));
  const seen = new Set<string>();
  const changes: Array<ToolChange> = [];
  for (const tool of listed) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    const before = byName.get(tool.name);
    if (before === undefined) changes.push({ _tag: "added", tool });
    else if (before.pinDigest !== pinDigest(tool)) changes.push({ _tag: "changed", tool });
    else changes.push({ _tag: "same", tool, returned: before.removedAt !== null });
  }
  for (const row of stored)
    if (!seen.has(row.name) && row.removedAt === null)
      changes.push({ _tag: "removed", name: row.name });
  return changes;
};
