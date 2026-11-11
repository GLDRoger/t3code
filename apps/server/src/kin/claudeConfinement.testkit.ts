import type * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

/** What a lead must never inherit from the server's environment (`~/.t3/service.env`, the unit). */
export const kinSecretVariables = [
  "KIN_GITHUB_APP_ID",
  "KIN_GITHUB_REPOS",
  "KIN_MEMORY_SSH_COMMAND",
  "KIN_MEMORY_CREDENTIAL_HELPER",
  "KIN_MEMORY_REPOSITORIES",
  "KIN_APNS_KEY_FILE",
  "KIN_APNS_KEY_ID",
  "KIN_APNS_TEAM_ID",
  "KIN_WORKER_ENVIRONMENT_ID",
  "KIN_CHECKOUT",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_ASKPASS",
  "SSH_AUTH_SOCK",
  "T3CODE_HOME",
  "T3CODE_DEV_AUTH_TOKEN",
  "T3CODE_OTLP_HEADERS",
  "NODE_OPTIONS",
  "OPENAI_API_KEY",
];

/** Runs the session's PreToolUse hooks the way Claude Code would; `true` when none denies. */
export const hookAllows = async (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined,
  tool_name: string,
  tool_input: unknown,
) => {
  const matchers = options?.hooks?.PreToolUse ?? [];
  if (matchers.length === 0) return true;
  for (const matcher of matchers)
    for (const hook of matcher.hooks) {
      const output = await hook(
        {
          hook_event_name: "PreToolUse",
          session_id: "session",
          transcript_path: "",
          cwd: options?.cwd ?? "",
          tool_name,
          tool_input,
          tool_use_id: "tool",
        },
        "tool",
        { signal: new AbortController().signal },
      );
      if (
        "hookSpecificOutput" in output &&
        output.hookSpecificOutput?.hookEventName === "PreToolUse" &&
        output.hookSpecificOutput.permissionDecision === "deny"
      )
        return false;
    }
  return true;
};
