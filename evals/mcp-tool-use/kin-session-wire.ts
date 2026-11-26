export const KIN_SESSION_BETAS =
  "advanced-tool-use-2025-11-20,per-turn-control-2026-07-01,extended-cache-ttl-2025-04-11";

export const KIN_SESSION_CACHE = { type: "ephemeral", ttl: "1h" } as const;

export const kinSessionStartText = (standing: string) =>
  `SessionStart hook additional context: ${standing}`;

export const kinPromptSubmitText = (delta: string) =>
  `UserPromptSubmit hook additional context: ${delta}`;

export const kinCompactionSummary = (summary: string) =>
  `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}`;
