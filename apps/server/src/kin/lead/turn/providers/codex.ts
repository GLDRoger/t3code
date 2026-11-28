import { ThreadId } from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CodexAdapterV2 from "../../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { AGENT_THREAD_ENV } from "../../../../preview/PortScanner.ts";
import { type KinSessionPlan, KinSessions } from "../session.ts";
import type { KinProvider } from "./provider.ts";

const DRIVER = "codex";

type Json = Schema.Json;
type Params = Readonly<Record<string, unknown>>;
type Client = CodexClient.CodexAppServerClient["Service"];

/** Kin's tools beyond its core, mounted apart so Codex defers them as Claude Code's ToolSearch does. */
export const KIN_RARE_SERVER = "t3-code-rare";
/** The MCP servers T3 mounts on a Codex thread; Kin's endpoint arrives as the first. */
const T3_SERVERS = ["t3-code", "t3-code-direct", KIN_RARE_SERVER];

/**
 * Codex's own tools and the user's Codex extensions that a Kin session never gets (codex-cli 0.169).
 * Explicit, because the user's config can switch experimental tools on for every thread. Skills
 * stay out as on Claude, whose Kin sessions load no setting sources: no catalog, no bundled ones.
 */
export const CONFINED_CONFIG: Readonly<Record<string, Json>> = {
  web_search: "disabled",
  "skills.include_instructions": false,
  "skills.bundled.enabled": false,
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

// Cached web search needs no local execution environment.
export const FULL_SESSION_CONFIG: Readonly<Record<string, Json>> = {
  ...CONFINED_CONFIG,
  web_search: "cached",
};

type Server = Readonly<Record<string, Json>>;
const isServer = (value: Json | undefined): value is Server =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Codex's up-front partition for models with search is independent of Claude's MCP markers. */
export const CODEX_ALWAYS_LOADED = [
  "kin_ask",
  "kin_defer",
  "kin_cancel",
  "kin_react",
  "kin_hand_off",
  "kin_relay",
  "kin_ask_person",
  "memory_search",
  "memory_read",
  "memory_write",
  "records_query",
  "record_get",
  "record_create",
  "record_update",
  "client_read",
  "pulse_handle",
  "docs_search",
  "doc_read",
  "doc_edit",
  "doc_create",
  "pulse_read",
  "people_read",
  "kin_leads",
  "dates_query",
  "touch_log",
  "kin_recipes",
  "kin_connection_tools",
  "kin_connection_call",
  "web_page",
  "record_assign",
  "deal_stages",
  "money_summary",
  "money_query",
  "pipeline_read",
  "kin_document",
  "kin_issue",
] as const;

/**
 * A model with tool search (gpt-6.1) defers every MCP tool
 * unless its server says otherwise: Kin's endpoint shows only its core up front, and a second mount
 * of it, left deferred, serves everything else. Without search there is one mount, all up front.
 */
const kinToolLoading = (config: Record<string, Json>, toolSearch: boolean) => {
  const kin = config["mcp_servers.t3-code"];
  if (!isServer(kin)) return;
  if (!toolSearch) {
    config["mcp_servers.t3-code"] = { ...kin, omit_tools_from: ["deferred"] };
    return;
  }
  const core = [...CODEX_ALWAYS_LOADED];
  const disabled = Array.isArray(kin.disabled_tools) ? kin.disabled_tools : [];
  config["mcp_servers.t3-code"] = { ...kin, enabled_tools: core, omit_tools_from: ["deferred"] };
  config[`mcp_servers.${KIN_RARE_SERVER}`] = { ...kin, disabled_tools: [...disabled, ...core] };
};

/** T3's MCP servers, calls approved (Kin's gate checks each); the user's own servers off by name. */
const kinServersOnly = (
  params: Params,
  userServers: ReadonlyArray<string>,
  toolSearch: boolean,
  partition: boolean,
) => {
  const config = { ...(params.config as Readonly<Record<string, Json>> | null | undefined) };
  if (partition) kinToolLoading(config, toolSearch);
  for (const name of T3_SERVERS) {
    const server = config[`mcp_servers.${name}`];
    // Codex asks before an MCP call outside full access; nobody answers on a Kin thread.
    if (isServer(server))
      config[`mcp_servers.${name}`] = { ...server, default_tools_approval_mode: "approve" };
  }
  const disabled = userServers
    .filter((name) => !T3_SERVERS.includes(name))
    .map((name) => [`mcp_servers.${name}.enabled`, false] as const);
  return { ...config, ...Object.fromEntries(disabled) };
};

type UserConfig = {
  readonly servers: ReadonlyArray<string>;
  readonly provider: string | undefined;
};

/**
 * gpt-6.1 searches through Codex's own `/alpha/search` call, which Codex makes only on OpenAI's
 * provider unless a custom one says it serves it; the host's gateway does.
 */
const searchThrough = (provider: string | undefined): Readonly<Record<string, Json>> =>
  provider === undefined || provider === "openai"
    ? {}
    : { [`model_providers.${provider}.supports_standalone_web_search`]: true };

/**
 * A model Codex's catalog lacks gets Codex's fallback metadata, which has no tool search
 * (codex-cli 0.169), so a deferred tool would be out of its reach.
 */
const listCatalog = Effect.fn("KinCodex.catalog")(function* (client: Client) {
  const models = new Set<string>();
  let cursor: string | null | undefined;
  do {
    const page: CodexSchema.V2ModelListResponse = yield* client.request("model/list", {
      includeHidden: true,
      ...(cursor ? { cursor } : {}),
    });
    for (const model of page.data) models.add(model.model);
    cursor = page.nextCursor;
  } while (cursor);
  return models;
});

const NO_EXECUTION = {
  environments: [],
  approvalPolicy: "never",
} as const;
const NO_EXECUTION_REASON = "This session has no shell or file patches.";

const threadParams = (params: Params, plan: KinSessionPlan, user: UserConfig) => {
  if (plan.seat === "dream") return params;
  const delegated = plan.seat === "delegated";
  const owner = plan.seat === "owner";
  return {
    ...params,
    ...(delegated ? {} : { baseInstructions: plan.instructions, developerInstructions: null }),
    ...NO_EXECUTION,
    sandbox: "read-only",
    config: {
      ...kinServersOnly(params, user.servers, !delegated && plan.toolSearch, !delegated),
      ...(owner ? FULL_SESSION_CONFIG : CONFINED_CONFIG),
      ...(owner ? searchThrough(user.provider) : {}),
    },
  };
};

const turnParams = ({ additionalContext, ...params }: Params, plan: KinSessionPlan) => ({
  ...params,
  ...(plan.seat !== "delegated" || additionalContext === undefined ? {} : { additionalContext }),
  ...NO_EXECUTION,
  sandboxPolicy: { type: "readOnly", networkAccess: false },
});

const THREAD_METHODS = new Set(["thread/start", "thread/resume"]);
const TURN_INPUT = new Set(["turn/start", "turn/steer"]);
const REWRITTEN = new Set([...THREAD_METHODS, ...TURN_INPUT, "thread/inject_items"]);

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

/** The user's Codex MCP servers and model provider as Codex resolves them for this cwd. */
const ConfigRead = Schema.Struct({
  config: Schema.Struct({
    mcp_servers: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    model_provider: Schema.optional(Schema.NullOr(Schema.String)),
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
    // Never grant a sandbox escalation on a Kin thread.
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

/**
 * One app-server serves a whole Codex instance, so each thread is placed when it starts, from the
 * T3 thread T3 names in its shell env, never by the thread that opened the process; a Codex
 * sub-agent answers to its parent's plan.
 */
const install = <E, R>(base: Layer.Layer<CodexAdapterV2.CodexAppServerClientFactory, E, R>) =>
  Layer.effect(
    CodexAdapterV2.CodexAppServerClientFactory,
    Effect.gen(function* () {
      const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
      const sessions = yield* KinSessions;
      if (!sessions.enabled) return factory;
      return CodexAdapterV2.CodexAppServerClientFactory.of({
        open: Effect.fn("KinCodex.open")(function* (input) {
          const client = yield* factory.open(input);
          const userConfigs = new Map<string, UserConfig>();
          const userConfig = Effect.fn("KinCodex.userConfig")(function* (cwd: string) {
            const known = userConfigs.get(cwd);
            if (known !== undefined) return known;
            const answer = yield* client.raw.request("config/read", { cwd });
            const read = yield* decodeConfigRead(answer).pipe(Effect.orDie);
            const found: UserConfig = {
              servers: Object.keys(read.config.mcp_servers ?? {}),
              provider: read.config.model_provider ?? undefined,
            };
            userConfigs.set(cwd, found);
            return found;
          });
          // A catalog that can't be read knows no model: every tool goes up front.
          const catalog = yield* Effect.cached(
            listCatalog(client).pipe(Effect.orElseSucceed(() => new Set<string>())),
          );
          const seats = new Map<string, KinSessionPlan>();
          const starting = new Map<ThreadId, KinSessionPlan>();
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
          const placed = Effect.fn("KinCodex.place")(function* (params: Params) {
            const thread = t3Thread(params);
            const cwd = typeof params.cwd === "string" ? params.cwd : input.runtimePolicy.cwd;
            const plan = yield* sessions.plan({
              threadId: thread,
              cwd: cwd ?? undefined,
              driver: DRIVER,
              path: input.environment.PATH,
              toolLookup: typeof params.model === "string" && (yield* catalog).has(params.model),
            });
            if (plan === undefined || plan.seat === "dream") return null;
            starting.set(thread, plan);
            if (typeof params.threadId === "string") seats.set(params.threadId, plan);
            const user =
              cwd == null ? { servers: [], provider: undefined } : yield* userConfig(cwd);
            return threadParams(params, plan, user);
          });
          yield* client.handleServerNotification("item/completed", ({ threadId, item }) => {
            const seat = seats.get(threadId);
            return item.type === "webSearch" && seat?.seat === "owner"
              ? seat.webRead(undefined).pipe(Effect.asVoid)
              : Effect.void;
          });
          const asked = answering(
            client,
            kinApprovals(client, (native) =>
              (seats.get(native)?.refusal ?? Effect.undefined).pipe(
                Effect.map((why) => why ?? NO_EXECUTION_REASON),
              ),
            ),
            (native) => seats.has(native),
          );
          return rewriting(
            asked,
            (method, params) => {
              const plan =
                typeof params.threadId === "string" ? seats.get(params.threadId) : undefined;
              if (TURN_INPUT.has(method))
                return Effect.succeed(
                  plan === undefined || method === "turn/steer" ? null : turnParams(params, plan),
                );
              if (method === "thread/inject_items")
                return Effect.succeed(
                  plan === undefined || plan.seat === "delegated"
                    ? null
                    : withoutT3Guidance(params),
                );
              return THREAD_METHODS.has(method) ? placed(params) : Effect.succeed(null);
            },
            (method, params, answer) => {
              const native = (answer as { thread?: { id?: unknown } } | null)?.thread?.id;
              const plan = starting.get(t3Thread(params));
              if (THREAD_METHODS.has(method) && typeof native === "string" && plan !== undefined)
                seats.set(native, plan);
            },
          );
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(base, KinSessions.layer)));

/** Codex's built-ins by what they do (codex-cli 0.169); it has no page fetch or open sessions. */
export const codex = {
  driver: DRIVER,
  lookup: "provider",
  turnContextBeside: false,
  capabilities: {
    webSearch: ["web_search"],
  },
  install,
} satisfies KinProvider<CodexAdapterV2.CodexAppServerClientFactory>;
