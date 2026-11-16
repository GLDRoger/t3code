import { ThreadId } from "@t3tools/contracts";
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
import { AGENT_THREAD_ENV } from "../../preview/PortScanner.ts";
import { sessionVariablePatterns } from "../claudeConfinement.ts";
import { KinServer } from "../KinServer.ts";
import { KinEnabled, layer as kinEnabledLayer } from "../KinEnabled.ts";
import { threadPrefix as dreamThreadPrefix } from "../dreaming/DreamIsolation.ts";
import { instructions } from "./instructions.ts";
import { SESSION_REFUSAL, SHARED_THREAD_PREFIX } from "./Audience.ts";
import { GH_SIGN_FOLDER } from "./LeadIsolation.ts";
import { KinAgentSessionPolicy } from "./sessionPolicy.ts";
import { isWorkThread } from "./workThread.ts";

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

/**
 * An owner-only thread's Codex tools: its shell and patches, each of which Codex asks Kin about
 * first (`fullSessionThreadParams`). What runs without asking stays off: hosted web search, image
 * viewing, and unified exec, whose open sessions would take later stdin unasked.
 */
export const FULL_SESSION_CONFIG: Readonly<Record<string, Json>> = {
  ...CONFINED_CONFIG,
  include_apply_patch_tool: true,
  "features.shell_tool": true,
  // A Codex sub-agent inherits the turn's approval policy and sandbox (codex-cli 0.169), so its
  // commands and patches ask Kin on this same connection.
  "agents.enabled": true,
};

/** GPT agents rarely ask with a card or make the Confirm card (evals, Nov 2026). */
const CODEX_NOTE =
  "When a decision is the owner's, ask with kin_ask and the default you'll take, not in prose. Anything leaving the company (mail, a payment, a post) goes only through the tool that makes its Confirm card: call it, never just draft it in the chat.";
const CONFINED_NOTE =
  "This session has no shell, files or web: act only through your tools, and don't try those.";
const FULL_SESSION_NOTE =
  "Your shell and file edits run as the owner, and Kin checks each one as it runs: in a chat others read, or once the turn has read outside content, it's refused with a line saying why. Web search is off; fetch a page with curl.";
/** Kin's instructions are the whole system prompt, as on Claude, plus what this session has. */
export const codexInstructions = `${instructions}\n\n${CONFINED_NOTE}\n${CODEX_NOTE}`;
export const codexFullSessionInstructions = `${instructions}\n\n${FULL_SESSION_NOTE}\n${CODEX_NOTE}`;

/** T3's MCP servers, calls approved (Kin's gate checks each); the user's own servers off by name. */
const kinServersOnly = (params: Params, userServers: ReadonlyArray<string>) => {
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
  return { ...config, ...Object.fromEntries(disabled) };
};

/**
 * A Kin thread others read, or any with no session policy: no execution environment (shell,
 * patches and images fail), a read-only sandbox with no network behind it, nothing asked, and only
 * T3's MCP servers. There is never a shell, so no turn on it can reach one.
 */
const confinedThreadParams = (params: Params, userServers: ReadonlyArray<string>) => ({
  ...params,
  baseInstructions: codexInstructions,
  developerInstructions: null,
  environments: [],
  approvalPolicy: "never",
  sandbox: "read-only",
  config: { ...kinServersOnly(params, userServers), ...CONFINED_CONFIG },
});

type Shell = { readonly path: string; readonly agentName: string | undefined };

/** The env a Claude agent's session gets (`sessionEnvironment`), the signing `gh` first on PATH. */
const shellEnvironment = (shell: Shell) => ({
  "shell_environment_policy.inherit": "all",
  "shell_environment_policy.include_only": [
    ...sessionVariablePatterns,
    "KIN_AGENT_NAME",
    AGENT_THREAD_ENV,
  ],
  "shell_environment_policy.set.PATH": shell.path,
  ...(shell.agentName === undefined
    ? {}
    : { "shell_environment_policy.set.KIN_AGENT_NAME": shell.agentName }),
});

/**
 * An owner-only thread: Codex's shell and patches with full access, as a Claude lead's Bash has,
 * and `untrusted` approval, under which Codex asks before every command and patch (no read-only
 * shortcut in codex-cli 0.169). Kin answers each ask from the turn as it is then
 * (`kinApprovals`); the guardian reviewer never does.
 */
const fullSessionThreadParams = (
  params: Params,
  userServers: ReadonlyArray<string>,
  shell: Shell,
) => ({
  ...params,
  baseInstructions: codexFullSessionInstructions,
  developerInstructions: null,
  approvalPolicy: "untrusted",
  approvalsReviewer: "user",
  sandbox: "danger-full-access",
  config: {
    ...kinServersOnly(params, userServers),
    ...FULL_SESSION_CONFIG,
    ...shellEnvironment(shell),
  },
});

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

/** The owner-only turn keeps its thread's asking; T3's thread guidance goes, as on Claude. */
const fullSessionTurnParams = ({ additionalContext: _t3Guidance, ...params }: Params) => ({
  ...params,
  approvalPolicy: "untrusted",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "dangerFullAccess" },
});

/** A task a lead delegated posts on GitHub through Kin's signing `gh` (`ghSign.ts`), as on Claude. */
const signedShellParams = (params: Params, sign: Shell) => ({
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
  answered: (method: string, params: Params, answer: unknown) => void = () => {},
): Client => {
  const raw = (method: string, params: unknown) =>
    rewrite(method, (params ?? {}) as Params).pipe(
      Effect.flatMap((rewritten) =>
        client.raw
          .request(method, rewritten)
          .pipe(Effect.tap((answer) => Effect.sync(() => answered(method, rewritten, answer)))),
      ),
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

type Answers = {
  readonly [M in CodexRpc.ServerRequestMethod]?: (
    payload: CodexRpc.ServerRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ServerRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
};

/**
 * Kin answers Codex's asks on a Kin thread itself, never showing them to anyone: the Claude hook's
 * decision (`fullSessionRefusal`) for the asking thread's turn as it is at that call, never "for
 * the session". Codex's decline carries no reason, so the refusal's words reach the model as a
 * steer into the turn that asked.
 */
const kinApprovals = (
  client: Client,
  refusal: (nativeThreadId: string) => Effect.Effect<string | undefined>,
): Answers => {
  const decided = (asked: { readonly threadId: string; readonly turnId: string }) =>
    refusal(asked.threadId).pipe(
      Effect.tap((why) =>
        why === undefined
          ? Effect.void
          : client
              .request("turn/steer", {
                threadId: asked.threadId,
                expectedTurnId: asked.turnId,
                input: [{ type: "text", text: why }],
              })
              .pipe(Effect.ignore),
      ),
    );
  const legacy = (asked: { readonly conversationId: string }) =>
    refusal(asked.conversationId).pipe(
      Effect.map((why) => ({
        decision: why === undefined ? ("approved" as const) : { denied: { rejection: why } },
      })),
    );
  return {
    "item/commandExecution/requestApproval": (asked) =>
      decided(asked).pipe(
        Effect.map((why) => ({ decision: why === undefined ? "accept" : "decline" })),
      ),
    "item/fileChange/requestApproval": (asked) =>
      decided(asked).pipe(
        Effect.map((why) => ({ decision: why === undefined ? "accept" : "decline" })),
      ),
    // Full access already holds what an admitted call needs; nothing more is ever granted.
    "item/permissions/requestApproval": () => Effect.succeed({ permissions: {} }),
    execCommandApproval: legacy,
    applyPatchApproval: legacy,
  };
};

const answering = (client: Client, answers: Answers): Client => ({
  ...client,
  handleServerRequest: ((method: CodexRpc.ServerRequestMethod, handler: unknown) =>
    client.handleServerRequest(
      method,
      (answers[method] ?? handler) as never,
    )) as Client["handleServerRequest"],
});

/**
 * Kin's seam on T3's Codex adapter, as `LeadIsolation.claudeQueryRunner` is on Claude's: an agent's
 * owner-only thread gets a full session whose every command and patch Kin decides; a thread others
 * read runs confined; a task delegated from a lead's thread gets the signing `gh`. Every other
 * Codex session passes through untouched.
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
          if (threadId.startsWith(dreamThreadPrefix) || isWorkThread(threadId)) return client;
          const cwd = input.runtimePolicy.cwd ?? undefined;
          const isKin =
            cwd !== undefined &&
            (within(kinDirectory, path.resolve(cwd)) ||
              within(yield* real(kinDirectory), yield* real(cwd)));
          const signing = Effect.fn("KinCodexIsolation.signing")(function* (
            sessions: KinAgentSessionPolicy["Service"],
            thread: ThreadId,
          ) {
            const signed: Shell = {
              path: [
                path.join(kinDirectory, GH_SIGN_FOLDER),
                ...sessions.toolDirectories,
                input.environment.PATH,
              ]
                .filter(Boolean)
                .join(":"),
              agentName: yield* sessions.agentName(thread),
            };
            return signed;
          });
          if (isKin) {
            let userServers: ReadonlyArray<string> | undefined;
            const servers = Effect.gen(function* () {
              if (userServers !== undefined) return userServers;
              const answer = yield* client.raw.request("config/read", { cwd });
              const read = yield* decodeConfigRead(answer).pipe(Effect.orDie);
              userServers = Object.keys(read.config.mcp_servers ?? {});
              return userServers;
            });
            // One app-server serves several of the lead's threads, an owner's and a shared one
            // among them, so each native thread answers to the T3 thread that started it.
            const governing = new Map<string, ThreadId>();
            yield* client.handleServerNotification("thread/started", ({ thread }) =>
              Effect.sync(() => {
                const parent = thread.parentThreadId
                  ? governing.get(thread.parentThreadId)
                  : undefined;
                if (parent !== undefined) governing.set(thread.id, parent);
              }),
            );
            const t3Thread = (params: Params) => {
              const config = params.config as Readonly<Record<string, unknown>> | null | undefined;
              const id = config?.[`shell_environment_policy.set.${AGENT_THREAD_ENV}`];
              return typeof id === "string" ? ThreadId.make(id) : threadId;
            };
            const full = (thread: ThreadId | undefined): thread is ThreadId =>
              thread !== undefined &&
              Option.isSome(policy) &&
              !thread.startsWith(SHARED_THREAD_PREFIX);
            const rewritten = rewriting(
              Option.isNone(policy)
                ? client
                : answering(
                    client,
                    kinApprovals(client, (native) => {
                      const thread = governing.get(native);
                      return thread === undefined
                        ? Effect.succeed(SESSION_REFUSAL.none)
                        : policy.value.refusal(thread);
                    }),
                  ),
              (method, params) => {
                if (method === "turn/start")
                  return Effect.succeed(
                    full(governing.get(String(params.threadId)))
                      ? fullSessionTurnParams(params)
                      : confinedTurnParams(params),
                  );
                if (method === "thread/inject_items")
                  return Effect.succeed(withoutT3Guidance(params));
                if (!THREAD_METHODS.has(method)) return Effect.succeed(params);
                const thread = t3Thread(params);
                if (typeof params.threadId === "string") governing.set(params.threadId, thread);
                return Effect.gen(function* () {
                  const names = yield* servers;
                  if (!full(thread) || Option.isNone(policy))
                    return confinedThreadParams(params, names);
                  return fullSessionThreadParams(
                    params,
                    names,
                    yield* signing(policy.value, thread),
                  );
                });
              },
              (method, params, answer) => {
                const native = (answer as { thread?: { id?: unknown } } | null)?.thread?.id;
                if (THREAD_METHODS.has(method) && typeof native === "string")
                  governing.set(native, t3Thread(params));
              },
            );
            return rewritten;
          }
          if (Option.isNone(policy) || !(yield* policy.value.delegated(threadId))) return client;
          const sign = yield* signing(policy.value, threadId);
          return rewriting(client, (method, params) =>
            Effect.succeed(THREAD_METHODS.has(method) ? signedShellParams(params, sign) : params),
          );
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(base, kinEnabledLayer)));
