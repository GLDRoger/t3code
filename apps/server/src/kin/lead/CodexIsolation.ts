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
 * raw and their answers decode as the typed client would. A rewrite of `null` leaves the call as
 * the adapter made it.
 */
const rewriting = (
  client: Client,
  rewrite: (
    method: string,
    params: Params,
  ) => Effect.Effect<Params | null, CodexErrors.CodexAppServerError>,
  answered: (method: string, params: Params, answer: unknown) => void,
): Client => {
  const sent = (method: string, params: Params) =>
    client.raw
      .request(method, params)
      .pipe(Effect.tap((answer) => Effect.sync(() => answered(method, params, answer))));
  const raw = (method: string, params: unknown) =>
    rewrite(method, (params ?? {}) as Params).pipe(
      Effect.flatMap((rewritten) => sent(method, rewritten ?? ((params ?? {}) as Params))),
    );
  return {
    ...client,
    raw: { ...client.raw, request: raw as typeof client.raw.request },
    request: ((method: CodexRpc.ClientRequestMethod, payload: unknown) => {
      if (!REWRITTEN.has(method)) return client.request(method, payload as never);
      const schema = CodexRpc.CLIENT_REQUEST_RESPONSES[method] as Schema.Codec<unknown, unknown>;
      return rewrite(method, payload as Params).pipe(
        Effect.flatMap((rewritten) =>
          rewritten === null
            ? client.request(method, payload as never)
            : sent(method, rewritten).pipe(
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

/** The native thread an ask comes from: v2 asks name it, legacy ones name the conversation. */
const askingThread = (payload: unknown) => {
  const asked = payload as { readonly threadId?: unknown; readonly conversationId?: unknown };
  return String(asked.threadId ?? asked.conversationId ?? "");
};

/** Kin answers the asks of its own threads; any other thread's go to T3's handler as before. */
const answering = (
  client: Client,
  answers: Answers,
  ours: (native: string) => boolean,
): Client => ({
  ...client,
  handleServerRequest: ((
    method: CodexRpc.ServerRequestMethod,
    handler: (payload: unknown) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>,
  ) => {
    const answer = answers[method] as typeof handler | undefined;
    return client.handleServerRequest(
      method,
      (answer === undefined
        ? handler
        : (payload: unknown) =>
            ours(askingThread(payload)) ? answer(payload) : handler(payload)) as never,
    );
  }) as Client["handleServerRequest"],
});

type Seat = { readonly thread: ThreadId; readonly full: boolean };

/**
 * Kin's seam on T3's Codex adapter, as `LeadIsolation.claudeQueryRunner` is on Claude's: an agent's
 * owner-only thread gets a full session Kin checks per call, a shared one runs confined, a task a
 * lead delegated gets the signing `gh`. One app-server serves a whole Codex instance, so each thread
 * is placed when it starts, never by the thread that opened the process.
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
      const isKinFolder = Effect.fn("KinCodexIsolation.isKinFolder")(function* (cwd: string) {
        return (
          within(kinDirectory, path.resolve(cwd)) ||
          within(yield* real(kinDirectory), yield* real(cwd))
        );
      });
      const kin = yield* Effect.serviceOption(KinServer);
      const policy = Option.flatMap(kin, (server) =>
        Option.flatMap(server.services, (services) =>
          Context.getOption(services, KinAgentSessionPolicy),
        ),
      );
      return CodexAdapterV2.CodexAppServerClientFactory.of({
        open: Effect.fn("KinCodexIsolation.open")(function* (input) {
          const client = yield* factory.open(input);
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
          const userServers = new Map<string, ReadonlyArray<string>>();
          const servers = Effect.fn("KinCodexIsolation.servers")(function* (cwd: string) {
            const known = userServers.get(cwd);
            if (known !== undefined) return known;
            const answer = yield* client.raw.request("config/read", { cwd });
            const read = yield* decodeConfigRead(answer).pipe(Effect.orDie);
            const names = Object.keys(read.config.mcp_servers ?? {});
            userServers.set(cwd, names);
            return names;
          });
          // Each native thread of an agent, and each Codex sub-agent under one, answers to the T3
          // thread that started it.
          const seats = new Map<string, Seat>();
          const starting = new Map<ThreadId, Seat>();
          yield* client.handleServerNotification("thread/started", ({ thread }) =>
            Effect.sync(() => {
              const parent = thread.parentThreadId ? seats.get(thread.parentThreadId) : undefined;
              if (parent !== undefined) seats.set(thread.id, parent);
            }),
          );
          const t3Thread = (params: Params) => {
            const settings = params.config as Readonly<Record<string, unknown>> | null | undefined;
            const id = settings?.[`shell_environment_policy.set.${AGENT_THREAD_ENV}`];
            return typeof id === "string" ? ThreadId.make(id) : input.threadId;
          };
          const threadParams = Effect.fn("KinCodexIsolation.threadParams")(function* (
            params: Params,
          ) {
            const thread = t3Thread(params);
            if (thread.startsWith(dreamThreadPrefix) || isWorkThread(thread)) return null;
            const cwd = typeof params.cwd === "string" ? params.cwd : input.runtimePolicy.cwd;
            if (cwd != null && (yield* isKinFolder(cwd))) {
              const seat: Seat = {
                thread,
                full: Option.isSome(policy) && !thread.startsWith(SHARED_THREAD_PREFIX),
              };
              starting.set(thread, seat);
              if (typeof params.threadId === "string") seats.set(params.threadId, seat);
              const names = yield* servers(cwd);
              return seat.full && Option.isSome(policy)
                ? fullSessionThreadParams(params, names, yield* signing(policy.value, thread))
                : confinedThreadParams(params, names);
            }
            if (Option.isNone(policy) || !(yield* policy.value.delegated(thread))) return null;
            return signedShellParams(params, yield* signing(policy.value, thread));
          });
          const asked = Option.isNone(policy)
            ? client
            : answering(
                client,
                kinApprovals(client, (native) => {
                  const seat = seats.get(native);
                  return seat === undefined
                    ? Effect.succeed(SESSION_REFUSAL.none)
                    : policy.value.refusal(seat.thread);
                }),
                (native) => seats.has(native),
              );
          return rewriting(
            asked,
            (method, params) => {
              const seat =
                typeof params.threadId === "string" ? seats.get(params.threadId) : undefined;
              if (method === "turn/start")
                return Effect.succeed(
                  seat === undefined
                    ? null
                    : seat.full
                      ? fullSessionTurnParams(params)
                      : confinedTurnParams(params),
                );
              if (method === "thread/inject_items")
                return Effect.succeed(seat === undefined ? null : withoutT3Guidance(params));
              return THREAD_METHODS.has(method) ? threadParams(params) : Effect.succeed(null);
            },
            (method, params, answer) => {
              const native = (answer as { thread?: { id?: unknown } } | null)?.thread?.id;
              const seat = starting.get(t3Thread(params));
              if (THREAD_METHODS.has(method) && typeof native === "string" && seat !== undefined)
                seats.set(native, seat);
            },
          );
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(base, kinEnabledLayer)));
