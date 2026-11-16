import type { ThreadId } from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { KinServer } from "../KinServer.ts";
import { KinEnabled, layer as kinEnabledLayer } from "../KinEnabled.ts";
import { threadPrefix as dreamThreadPrefix } from "../dreaming/DreamIsolation.ts";
import { instructions } from "./instructions.ts";
import { GH_SIGN_FOLDER } from "./LeadIsolation.ts";
import { KinAgentSessionPolicy } from "./sessionPolicy.ts";

type Json = Schema.Json;
type Params = Readonly<Record<string, unknown>>;
type Client = CodexClient.CodexAppServerClient["Service"];

/** The MCP servers T3 mounts on a Codex thread; Kin's endpoint arrives as the first. */
const T3_SERVERS = ["t3-code", "t3-code-direct"];

/**
 * Codex's own tools and the user's Codex extensions that a Kin session never gets (codex-cli 0.169).
 * Explicit, because the user's config can switch experimental tools on for every thread.
 */
export const CONFINED_CONFIG: Readonly<Record<string, Json>> = {
  web_search: "disabled",
  "agents.enabled": false,
  include_apply_patch_tool: false,
  "tools.view_image": false,
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.apps": false,
  "features.plugins": false,
  "features.memories": false,
  "features.hooks": false,
  "features.browser_use": false,
  "features.computer_use": false,
  "features.image_generation": false,
  "features.goals": false,
  "features.sleep_tool": false,
  "features.tool_suggest": false,
  "features.skill_mcp_dependency_install": false,
  "features.default_mode_request_user_input": false,
  "features.context_management": false,
  "context_management.experimental_mode": false,
};

/** Kin's instructions are the whole system prompt, as on Claude, plus what this session lacks. */
const CODEX_PROVIDER_NOTE =
  "This session has no shell, files or web: act only through your tools, and don't try those.";
export const codexInstructions = `${instructions}\n\n${CODEX_PROVIDER_NOTE}`;

/**
 * A Kin thread on Codex, in any chat: no execution environment (shell, patches and images fail),
 * a read-only sandbox with no network behind it, nothing asked, and only T3's MCP servers, whose
 * calls Kin's gate checks. There is never a shell, so a turn others read, one that read outside
 * text, or one someone joined can't reach one either; Codex has no per-call hook to take it away.
 */
const confinedThreadParams = (params: Params, userServers: ReadonlyArray<string>) => {
  const config = { ...(params.config as Readonly<Record<string, Json>> | null | undefined) };
  for (const name of T3_SERVERS) {
    const server = config[`mcp_servers.${name}`];
    // Codex asks before an MCP call outside full access; nobody answers on a Kin thread.
    if (typeof server === "object" && server !== null && !Array.isArray(server))
      config[`mcp_servers.${name}`] = { ...server, default_tools_approval_mode: "approve" };
  }
  const disabled = userServers
    .filter((name) => !T3_SERVERS.includes(name))
    .map((name) => [`mcp_servers.${name}.enabled`, false] as const);
  return {
    ...params,
    baseInstructions: codexInstructions,
    developerInstructions: null,
    environments: [],
    approvalPolicy: "never",
    sandbox: "read-only",
    config: { ...config, ...CONFINED_CONFIG, ...Object.fromEntries(disabled) },
  };
};

/**
 * T3 sends full access on every turn; a Kin turn keeps the thread's confinement instead. T3's
 * thread guidance describes tools a lead doesn't have, as on Claude (`LeadIsolation`), so it goes.
 */
const confinedTurnParams = ({ additionalContext: _t3Guidance, ...params }: Params) => ({
  ...params,
  environments: [],
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly", networkAccess: false },
});

/** A task a lead delegated posts on GitHub through Kin's signing `gh` (`ghSign.ts`), as on Claude. */
const signedShellParams = (
  params: Params,
  sign: { readonly path: string; readonly agentName: string | undefined },
) => ({
  ...params,
  config: {
    ...(params.config as Readonly<Record<string, Json>> | null | undefined),
    "shell_environment_policy.set.PATH": sign.path,
    ...(sign.agentName === undefined
      ? {}
      : { "shell_environment_policy.set.KIN_AGENT_NAME": sign.agentName }),
  },
});

const THREAD_METHODS = new Set(["thread/start", "thread/resume"]);
const REWRITTEN = new Set([...THREAD_METHODS, "turn/start", "thread/inject_items"]);

/** After a compaction T3 puts its thread guidance back (`restoreAdditionalContext`); not on Kin's. */
const isT3Guidance = (item: unknown) => {
  const content = (item as { content?: ReadonlyArray<{ text?: unknown }> }).content;
  const text = Array.isArray(content) ? content[0]?.text : undefined;
  return typeof text === "string" && text.startsWith("<t3_code_");
};
const withoutT3Guidance = (params: Params) => ({
  ...params,
  items: (Array.isArray(params.items) ? params.items : []).filter((item) => !isT3Guidance(item)),
});

/** The user's Codex MCP servers as Codex resolves them for this cwd (user and project layers). */
const ConfigRead = Schema.Struct({
  config: Schema.Struct({
    mcp_servers: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  }),
});
const decodeConfigRead = Schema.decodeUnknownEffect(ConfigRead);

/**
 * `request` encodes through the stable schema, which drops `environments`; the rewritten calls go
 * raw and their answers decode as the typed client would.
 */
const rewriting = (
  client: Client,
  rewrite: (
    method: string,
    params: Params,
  ) => Effect.Effect<Params, CodexErrors.CodexAppServerError>,
): Client => {
  const raw = (method: string, params: unknown) =>
    rewrite(method, (params ?? {}) as Params).pipe(
      Effect.flatMap((rewritten) => client.raw.request(method, rewritten)),
    );
  return {
    ...client,
    raw: { ...client.raw, request: raw as typeof client.raw.request },
    request: ((method: CodexRpc.ClientRequestMethod, payload: unknown) => {
      if (!REWRITTEN.has(method)) return client.request(method, payload as never);
      const schema = CodexRpc.CLIENT_REQUEST_RESPONSES[method] as Schema.Codec<unknown, unknown>;
      return raw(method, payload).pipe(
        Effect.flatMap((answer) =>
          Schema.decodeUnknownEffect(schema)(answer).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
                "decode-response-payload",
                error,
                { method },
              ),
            ),
          ),
        ),
      );
    }) as typeof client.request,
  };
};

/**
 * Kin's seam on T3's Codex adapter, as `LeadIsolation.claudeQueryRunner` is on Claude's: an agent's
 * thread runs confined (`confinedThreadParams`); a task delegated from a lead's thread gets the
 * signing `gh`. Every other Codex session passes through untouched.
 */
export const codexClientFactory = <E, R>(
  base: Layer.Layer<CodexAdapterV2.CodexAppServerClientFactory, E, R>,
) =>
  Layer.effect(
    CodexAdapterV2.CodexAppServerClientFactory,
    Effect.gen(function* () {
      const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
      if (!(yield* KinEnabled).enabled) return factory;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const kinDirectory = path.join(config.stateDir, "kin");
      const real = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
      const within = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
      };
      const kin = yield* Effect.serviceOption(KinServer);
      const policy = Option.flatMap(kin, (server) =>
        Option.flatMap(server.services, (services) =>
          Context.getOption(services, KinAgentSessionPolicy),
        ),
      );
      return CodexAdapterV2.CodexAppServerClientFactory.of({
        open: Effect.fn("KinCodexIsolation.open")(function* (input) {
          const client = yield* factory.open(input);
          const threadId: ThreadId = input.threadId;
          if (threadId.startsWith(dreamThreadPrefix)) return client;
          const cwd = input.runtimePolicy.cwd ?? undefined;
          const isKin =
            cwd !== undefined &&
            (within(kinDirectory, path.resolve(cwd)) ||
              within(yield* real(kinDirectory), yield* real(cwd)));
          if (isKin) {
            let userServers: ReadonlyArray<string> | undefined;
            const servers = Effect.gen(function* () {
              if (userServers !== undefined) return userServers;
              const answer = yield* client.raw.request("config/read", { cwd });
              const read = yield* decodeConfigRead(answer).pipe(Effect.orDie);
              userServers = Object.keys(read.config.mcp_servers ?? {});
              return userServers;
            });
            return rewriting(client, (method, params) =>
              method === "turn/start"
                ? Effect.succeed(confinedTurnParams(params))
                : method === "thread/inject_items"
                  ? Effect.succeed(withoutT3Guidance(params))
                  : THREAD_METHODS.has(method)
                    ? servers.pipe(Effect.map((names) => confinedThreadParams(params, names)))
                    : Effect.succeed(params),
            );
          }
          if (Option.isNone(policy) || !(yield* policy.value.delegated(threadId))) return client;
          const sign = {
            path: [
              path.join(kinDirectory, GH_SIGN_FOLDER),
              ...policy.value.toolDirectories,
              input.environment.PATH,
            ]
              .filter(Boolean)
              .join(":"),
            agentName: yield* policy.value.agentName(threadId),
          };
          return rewriting(client, (method, params) =>
            Effect.succeed(THREAD_METHODS.has(method) ? signedShellParams(params, sign) : params),
          );
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(base, kinEnabledLayer)));
