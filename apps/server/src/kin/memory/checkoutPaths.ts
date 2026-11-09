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
  "skill.md",
]);

export const isItemPath = (path: string) =>
  path.endsWith(".md") && itemFolders.some((folder) => path.startsWith(`${folder}/`));
const isJournalPath = (path: string) => path.startsWith("journal/") && path.endsWith(".md");

/**
 * What a provider checkout of memory may hold. Claude Code and Codex load `.claude/`, `.mcp.json`,
 * `.codex/`, `CLAUDE.md`, `AGENTS.md` and skills from their working directory at any depth.
 */
export const isCheckoutPath = (path: string) => {
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment.startsWith("."))) return false;
  if (agentConfigNames.has(segments.at(-1)!.toLowerCase())) return false;
  return path === "rules.md" || path === "INDEX.md" || isItemPath(path) || isJournalPath(path);
};
