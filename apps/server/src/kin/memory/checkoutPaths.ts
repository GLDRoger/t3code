export const itemFolders = [
  "objectives",
  "commitments",
  "deferrals",
  "decisions",
  "people",
  "claims",
] as const;

// Lowercased: macOS and Windows resolve `claude.md` to `CLAUDE.md`.
const agentConfigNames = new Set([
  "claude.md",
  "claude.local.md",
  "agents.md",
  "agents.override.md",
  "agent.md",
  "gemini.md",
  "skill.md",
]);
// ASCII only: Windows splits on `\` and resolves `:` streams, and APFS opens `AGENTſ.md` as `AGENTS.md`.
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const isItemPath = (path: string) =>
  path.endsWith(".md") && itemFolders.some((folder) => path.startsWith(`${folder}/`));
const isJournalPath = (path: string) => path.startsWith("journal/") && path.endsWith(".md");

/**
 * What a provider checkout of memory may hold. Claude Code and Codex load `.claude/`, `.mcp.json`,
 * `.codex/`, `CLAUDE.md`, `AGENTS.md` and skills from their working directory at any depth.
 */
export const isCheckoutPath = (path: string) => {
  const segments = path.split("/");
  if (!segments.every((segment) => safeSegment.test(segment))) return false;
  if (agentConfigNames.has(segments.at(-1)!.toLowerCase())) return false;
  return path === "rules.md" || path === "INDEX.md" || isItemPath(path) || isJournalPath(path);
};
