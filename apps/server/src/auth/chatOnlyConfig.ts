import {
  AuthKinChatScope,
  DEFAULT_SERVER_SETTINGS,
  type AuthEnvironmentScope,
  type ServerConfig,
} from "@t3tools/contracts";

/** A teammate's session: it holds the chat permission and nothing else. */
export const isChatOnly = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  scopes.length > 0 && scopes.every((scope) => scope === AuthKinChatScope);

/**
 * The config a chat-only session connects with. Clients need a snapshot to count as connected,
 * so this one names the environment, which is public anyway, and carries nothing of the host:
 * no paths, providers, keybindings, settings or policy. Built from constants, never redacted.
 */
export const chatOnlyServerConfig = (
  environment: ServerConfig["environment"],
  auth: ServerConfig["auth"],
): ServerConfig => ({
  environment,
  auth,
  cwd: "/",
  keybindingsConfigPath: "/",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
});
