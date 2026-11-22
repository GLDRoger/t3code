import {
  AssetCreateUrlInput,
  AuthKinChatScope,
  DEFAULT_SERVER_SETTINGS,
  type AuthEnvironmentScope,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A teammate's session: it holds the chat permission and nothing else. */
export const isChatOnly = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  scopes.length > 0 && scopes.every((scope) => scope === AuthKinChatScope);

const decodeAssetCreateUrl = Schema.decodeUnknownOption(AssetCreateUrlInput);

/**
 * The thread attachment calls a chat-only session may make, for the files on Kin messages.
 * Uploads land in the pending pool under an unguessable id and belong to no chat until a send
 * the chat service authorizes claims them; a read is checked against chat membership by the
 * handler (`authorizeAttachmentRead`), which gives such a session no file outside its chats.
 */
export const chatOnlyMayCall = (method: string, payload: unknown) =>
  // Connecting needs a config snapshot; the handler sends such a session an empty one.
  method === WS_METHODS.subscribeServerConfig ||
  // A phone probes and reports activity on every foreground; a refusal blocks the connection.
  method === WS_METHODS.serverProbe ||
  method === WS_METHODS.serverReportClientActivity ||
  method === WS_METHODS.attachmentsCreateUploadUrl ||
  method === WS_METHODS.attachmentsDelete ||
  (method === WS_METHODS.assetsCreateUrl &&
    Option.exists(decodeAssetCreateUrl(payload), ({ resource }) => resource._tag === "attachment"));

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
