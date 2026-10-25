import type { KinPromptProviderKind } from "@t3tools/contracts";

/**
 * Files the target CLI already discovers. Kin must not inject them again.
 * Claude Code reads CLAUDE.md (and ~/.claude/CLAUDE.md). Codex reads AGENTS.md
 * (and ~/.codex/AGENTS.md). Other providers do not, so those files stay.
 */
export function isCliLoadedMarkdown(input: {
  readonly provider: KinPromptProviderKind;
  readonly filePath: string;
  readonly homeDirectory: string;
}): boolean {
  const normalized = input.filePath.replaceAll("\\", "/");
  const home = input.homeDirectory.replaceAll("\\", "/").replace(/\/$/, "");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (input.provider === "claudeAgent") {
    return base === "CLAUDE.md" || normalized.startsWith(`${home}/.claude/`);
  }
  if (input.provider === "codex") {
    return base === "AGENTS.md" || normalized.startsWith(`${home}/.codex/`);
  }
  return false;
}
