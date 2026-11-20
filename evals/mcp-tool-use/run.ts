#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Replays small fake threads on a Claude or Codex model to check T3's MCP tool use. A trimmed
 * harness capture supplies the prompt and native tools; a cheap model plays the shell. See
 * README.md for how to run it and add cases.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as NodeVM from "node:vm";
import * as NodeZlib from "node:zlib";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ComposerContextRecord,
  DeviceOperationError,
  DeviceSummary,
  OrchestratorMcpTaskRole,
  PreviewAutomationError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Tool } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { taskPrompt } from "../../apps/server/src/mcp/delegatedTaskModes.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import * as Contracts from "@t3tools/contracts";
import {
  EnvironmentId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  PullRequestState,
  ThreadId,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { THEME_GUIDE } from "@t3tools/shared/themeCss";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { buildCodexAdditionalContext } from "../../apps/server/src/provider/CodexDeveloperInstructions.ts";
import { makeSideChatContext } from "../../apps/server/src/orchestration-v2/ContextHandoffService.ts";
import { withInlineContext } from "../../apps/server/src/orchestration-v2/ContextHandoffDelivery.ts";
import {
  groupRules as kinGroupRules,
  instructions as kinLeadInstructions,
  teamRules as kinTeamRules,
} from "../../apps/server/src/kin/lead/instructions.ts";
import { kinInstructions } from "../../apps/server/src/kin/lead/turn/session.ts";
import { LEAD_T3_TOOLS } from "../../apps/server/src/kin/lead/t3Tools.ts";
import { KinLeadToolkit } from "../../apps/server/src/kin/lead/mcp/tools.ts";
import { KIN_DEFERRED_TOOLS } from "../../apps/server/src/kin/lead/deferredTools.ts";
import { listedOnSharedThread } from "../../apps/server/src/kin/lead/SharedTools.ts";
import { KinChatToolkit } from "../../apps/server/src/kin/mcp/KinChatToolkit.ts";
import { KinStatementToolkit } from "../../apps/server/src/kin/work/mcp/statementTools.ts";
import { KinWorkToolkit } from "../../apps/server/src/kin/work/mcp/tools.ts";
import { KinDocsToolkit } from "../../apps/server/src/kin/work/mcp/docTools.ts";
import { KinDocumentToolkit } from "../../apps/server/src/kin/gendocs/mcp.ts";
import { KinConnectionsToolkit } from "../../apps/server/src/kin/connections/mcp.ts";
import { socialRules as kinSocialRules } from "../../apps/server/src/kin/social/instructions.ts";
import { KinSocialToolkit } from "../../apps/server/src/kin/social/mcp.ts";
import { KinSalesToolkit } from "../../apps/server/src/kin/sales/mcp.ts";
import { salesRulesFor } from "../../apps/server/src/kin/sales/seat.ts";
import { KinPulseToolkit } from "../../apps/server/src/kin/pulse/mcp.ts";
import {
  MONEY_RULE,
  WITHDRAWN_WORK,
  WORK_RULE,
} from "../../apps/server/src/kin/work/workPrompt.ts";
import {
  githubTriggerEvent,
  HANDED_BACK_WORK,
  REPLY_SHAPE,
  SHARED_TURN_LINE,
} from "../../apps/server/src/kin/lead/LeadPrompt.ts";
import { CHECK_IN_PULSE_RULE, PULSE_RULE } from "../../apps/server/src/kin/pulse/prompt.ts";
import { WEEKLY_RULE } from "../../apps/server/src/kin/pulse/weekly.ts";
import { STARTED_RULE } from "../../apps/server/src/kin/lead/startedSection.ts";
import { DECLINED_RULE } from "../../apps/server/src/kin/lead/declinedSection.ts";
import { UNDO_RULE } from "../../apps/server/src/kin/lead/undoSection.ts";
import { defaultCharacterFor } from "../../apps/server/src/kin/lead/characterDefaults.ts";
import { characterForTurn, colleagueLine } from "../../apps/server/src/kin/lead/characters.ts";
import {
  CaseMargin,
  caseState,
  type Check,
  Limits,
  limitChecks,
  sampleState,
  type State,
} from "./margin.ts";
import { needsTopUp, refusals, RunManifest, tallies, tally } from "./gate.ts";
import { Rubric, rubricChecks, rubricRequest } from "./rubric.ts";
import { type AppServer, type AppServerEvent, openAppServer } from "./appServer.ts";
import {
  CONFINED_CONFIG,
  FULL_SESSION_CONFIG,
} from "../../apps/server/src/kin/lead/turn/providers/codex.ts";
import {
  CAPTION_PROMPT,
  classifySegment,
  repeats,
  RESCUE_PROMPT,
} from "../../apps/server/src/kin/reply/classify.ts";
import { TURN_EVENT_TOOLS } from "../../apps/server/src/kin/lead/eventIds.ts";
import { AttachmentToolkit } from "../../apps/server/src/mcp/toolkits/attachment/tools.ts";
import { DeviceToolkit } from "../../apps/server/src/mcp/toolkits/device/tools.ts";
import { EnvironmentToolkit } from "../../apps/server/src/mcp/toolkits/environment/tools.ts";
import { HtmlToolkit } from "../../apps/server/src/mcp/toolkits/html/tools.ts";
import { IssuesToolkit } from "../../apps/server/src/mcp/toolkits/issues/tools.ts";
import { MessageToolkit } from "../../apps/server/src/mcp/toolkits/message/tools.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../../apps/server/src/mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../../apps/server/src/mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../../apps/server/src/mcp/toolkits/project/tools.ts";
import {
  CHILD_PULL_REQUEST_REPORT_NEXT,
  PullRequestsToolkit,
} from "../../apps/server/src/mcp/toolkits/pullRequests/tools.ts";
import { ThemeToolkit } from "../../apps/server/src/mcp/toolkits/theme/tools.ts";
import { ThreadToolkit } from "../../apps/server/src/mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../../apps/server/src/mcp/toolkits/worktree/tools.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { proxyConfig } from "../shared/proxy.ts";
import { ASSUMED_SHAPE, caseProblems, estimate, estimateTable } from "./estimate.ts";
import { changeRequestsCreatedBy } from "../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts";
import { type BackgroundWait, makeBackgroundWait } from "./backgroundWait.ts";
import { DeviceExpect, gradeDevice } from "./device-grading.ts";
import { FileLinksExpect, gradeFileLinks } from "./file-link-grading.ts";
import {
  AGENT_DEVICE_SHELL,
  deviceFailure,
  type DeviceTools,
  isDeviceTool,
  launcherHelp,
  makeDeviceTools,
} from "./devices.ts";
import {
  argvForm,
  gradeSecret,
  scriptsBefore,
  UNKNOWN_SCRIPT,
  scriptSources,
  SecretExpect,
  secretDiagnostics,
} from "./secret-grading.ts";
/** Agent models by id, with the display name a harness gives them. */
const MODELS = {
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5-5": "Opus 5.5",
  // Kin's cheap model.
  "claude-haiku-5-5": "Haiku 5.5",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6-astra": "GPT-6 Astra",
} as const;
type Model = keyof typeof MODELS;
/** GPT models replay a Codex capture through CLIProxyAPI, the rest a Claude Code capture. */
const isCodex = (model: Model): model is Extract<Model, `gpt-${string}`> =>
  model.startsWith("gpt-");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// USD per million tokens. Cache writes use the 5-minute rate.
const PRICES = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};
type PricedModel = keyof typeof PRICES;
// OpenAI's standard API prices (developers.openai.com/api/docs/pricing, November 2026); output
// includes reasoning. GPT runs bill a ChatGPT sign-in instead: this is what the API would charge.
const AGENT_PRICES = {
  ...PRICES,
  "gpt-6.1-sol": { input: 2, output: 10, cacheWrite: 0, cacheRead: 0.1 },
  "gpt-6-astra": { input: 10, output: 50, cacheWrite: 0, cacheRead: 1 },
};
/** GPT models that can play the shell through CLIProxyAPI, when no Anthropic key is at hand. */
const PROXY_SHELL_MODELS = ["gpt-6-luna", "gpt-6.1-terra"] as const;
type ShellModel = PricedModel | (typeof PROXY_SHELL_MODELS)[number];
const isPricedModel = (model: ShellModel): model is PricedModel => model in PRICES;
const T3_PREFIX = "mcp__t3-code__";
const RUNTIME_MARKER = "<runtime_info>";
const TOOL_LOADED = "Tool loaded.";

class EvalToolCallError extends Schema.TaggedError<EvalToolCallError>()("EvalToolCallError", {
  tool: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The ${this.tool} tool call failed.`;
  }
}
const DEFERRED_LIST =
  /(The following deferred tools are now available via ToolSearch\.[^\n]*\n)((?:[^\n]+\n)*)/;
const MODEL_LINE = /You are powered by the model named .+?\. The exact model ID is [\w.-]+\./;
// API keys can be billed differently for requests that open with Claude Code's identity line,
// so every copy of it becomes a neutral line. The rest of the captured prompt is unchanged.
const IDENTITY =
  /You are Claude Code, Anthropic's official CLI for Claude(?:, running within the Claude Agent SDK)?\./g;
const NEUTRAL_IDENTITY = "You are an AI coding agent running in the user's terminal.";

type Block = { readonly type: string; readonly [key: string]: unknown };
type ApiMessage = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> };
type ApiTool = { readonly name: string; readonly [key: string]: unknown };
type Usage = Record<keyof (typeof PRICES)[PricedModel], number>;
type Call = {
  readonly step: number;
  readonly tool: string;
  readonly input: unknown;
  /** The tool_use id, when the call was a tool use of its own. */
  readonly id?: string;
  /** Once answered: whether the agent saw an error, and the result text it saw. */
  failed?: boolean;
  output?: string;
};
export type SampleRun = {
  readonly calls: ReadonlyArray<Call>;
  text: string;
  stopReason: string;
  /** The agent's final answer: its last response's text, if it ended its turn. */
  readonly finalText?: string;
  /** PRs linked to the thread when the sample ends, by the agent or by T3. */
  readonly linked?: ReadonlyArray<string>;
  /** The thread's working directory, which chat resolves relative file pills against. */
  readonly cwd?: string;
  /** The `agent-device` commands T3's device_open returned, prior turns included. */
  readonly launchers?: ReadonlyArray<string>;
};

const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

const PriorToolCall = Schema.Struct({
  tool: Schema.String,
  input: Schema.Unknown,
  /**
   * For a device tool or t3_background_wait, `"default"` runs the call on the world's devices or
   * background tasks for T3's result.
   */
  result: Schema.Unknown,
  /** Repository-relative file whose current contents supply this tool result. */
  resultFile: Schema.optional(Schema.String),
});

/**
 * One expected call. `args` match partially: `~text` is a case-insensitive substring,
 * `"<=N"` / `">=N"` bound a number, `null` matches a missing key, and keys may be dotted paths.
 */
const McpToolUseCall = Schema.Struct({
  tool: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const McpToolUseCallWithAlternatives = Schema.Struct({
  ...McpToolUseCall.fields,
  argsAnyOf: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});
const McpToolUseExpectedCall = Schema.Struct({
  ...McpToolUseCallWithAlternatives.fields,
  success: Schema.optional(Schema.Literal(true)),
});
type McpToolUseCall = typeof McpToolUseExpectedCall.Type;

/** Grading rules. Tool names are bare: `delegate_task`, `Bash`, `Agent`. */
const McpToolUseExpect = Schema.Struct({
  /** Each entry needs one matching call. */
  calls: Schema.optional(Schema.Array(McpToolUseExpectedCall)),
  /** Each entry matches a different call, and no call matches two entries; tool names are exact. */
  distinctCalls: Schema.optional(Schema.Array(McpToolUseCall)),
  /** No call may match any entry. */
  callsMustNot: Schema.optional(Schema.Array(McpToolUseCallWithAlternatives)),
  notCalls: Schema.optional(Schema.Array(Schema.String)),
  /** First calls of these tools happen in this order. */
  order: Schema.optional(Schema.Array(Schema.String)),
  minCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  maxCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  /**
   * One `args`-style value per new top-level thread the agent asks for, by `t3_thread_launch` or a
   * `create_threads` entry. Each matches a different thread's request; no other thread is asked for.
   */
  newThreads: Schema.optional(Schema.Array(Schema.Unknown)),
  /** The last step with tool calls includes this tool, then the turn ends. */
  endsTurnAfter: Schema.optional(Schema.String),
  /**
   * Regexes that no shell command may match. A command also carries the source of the scripts it
   * runs that the agent wrote earlier in the sample.
   */
  shellMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Regexes that some shell command must match, each. */
  shellMust: Schema.optional(Schema.Array(Schema.String)),
  /** Case-sensitive regexes on the agent's visible text. */
  textMust: Schema.optional(Schema.Array(Schema.String)),
  textMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Counts on the agent's visible text, graded pass, within margin or fail. See margin.ts. */
  limits: Schema.optional(Limits),
  /** Case-sensitive regexes on the final answer: the last response's text, once the turn ended. */
  finalTextMust: Schema.optional(Schema.Array(Schema.String)),
  /** Each entry matches a PR URL linked at the end, as `args` values match. */
  linked: Schema.optional(Schema.Array(Schema.String)),
  /** The PR numbers linked at the end, exactly. */
  linkedNumbers: Schema.optional(Schema.Array(Schema.Number)),
  /** Device manager checks: child briefs, simulator UI over the shell, failures, recordings. */
  device: Schema.optional(DeviceExpect),
  /**
   * Secret checks: chat asks in text and question tools, where fixture values went, and how the
   * files request_secret returned were read. See `SecretExpect` in secret-grading.ts.
   */
  secret: Schema.optional(SecretExpect),
  /** Yes/no questions a judge model answers about the visible reply. See rubric.ts. */
  rubric: Schema.optional(Rubric),
  /** File pills in the final answer resolve against the thread cwd to `world.files` entries. */
  fileLinks: Schema.optional(FileLinksExpect),
});

/**
 * The agent's machine, as the shell simulator and the gitStatus reminder see it. Only these keys
 * are typed; others (files, diff, prs, pages) are free-form facts for the simulator.
 */
const McpToolUseWorld = Schema.StructWithRest(
  Schema.Struct({
    /** GitHub `owner/name`. Defaults to `acme/app`. */
    repo: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
    /** `git status --short` lines. */
    status: Schema.optional(Schema.String),
    /** Newest first. On a branch other than main, these are the commits main lacks. */
    commits: Schema.optional(
      Schema.Array(
        Schema.StructWithRest(Schema.Struct({ sha: Schema.String, subject: Schema.String }), Rest),
      ),
    ),
    /** Simulators and emulators. With them, T3's device tools answer from this world. */
    devices: Schema.optional(Schema.Array(DeviceSummary)),
    /** Labels of the SSH device hosts in `devices`, by id. The local host always exists. */
    deviceHosts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    /**
     * agent-device sessions that prior turns started, by device id, with the app `open` put in
     * each. Otherwise a device's session starts at its launcher's first `open` in the sample.
     */
    agentDeviceSessions: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ app: Schema.optional(Schema.String) })),
    ),
    /**
     * Hosts whose hub fails to list devices, by id, with the error, such as F1's
     * `{"_tag": "DeviceOperationError", "operation": "list", "reason": "request_failed", "cause": null}`.
     * T3 marks each one failed on every call and lists none of its devices.
     */
    deviceDiscoveryFailures: Schema.optional(Schema.Record(Schema.String, DeviceOperationError)),
    /** false: agent device access is off. T3 denies every device call and drops its device text. */
    deviceAgentAccess: Schema.optional(Schema.Boolean),
    /** false: agent browser access is off. T3 denies every preview call and drops its browser text. */
    browserAgentAccess: Schema.optional(Schema.Boolean),
    /** Every capture reaches T3 with adb screencap's warning ahead of the PNG: T3 reports 0×0. */
    deviceInvalidCapture: Schema.optional(Schema.Boolean),
    /** Devices another thread's agent-device session holds, by device id: that thread's id. */
    deviceOwners: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    /**
     * Task IDs of the background commands and Monitors still running on the agent's Claude
     * session. With them, T3's own t3_background_wait handler answers from this world.
     */
    backgroundTasks: Schema.optional(Schema.Array(Schema.String)),
    /** The world's `prs`, bottom first, form one native stack with this number. */
    stack: Schema.optional(Schema.Number),
    /** PRs already linked to the thread, with the state T3 last saw. */
    linkedPullRequests: Schema.optional(
      Schema.Array(
        Schema.Struct({ number: Schema.Number, state: PullRequestState, title: Schema.String }),
      ),
    ),
  }),
  Rest,
);

/** One fake thread, one JSON object per line in a case file. */
export const McpToolUseCase = Schema.Struct({
  id: Schema.String,
  area: Schema.String,
  kind: Schema.Literals(["bad", "guard", "control"]),
  pattern: Schema.String,
  experience: Schema.String,
  rule: Schema.optional(Schema.String),
  privacy: Schema.optional(Schema.Literals(["commit-safe", "private"])),
  setup: Schema.Struct({
    role: Schema.Literals(["top", "delegated-child", "native-subagent"]),
    /** Runs only on this harness, for cases whose right answer depends on it. */
    harness: Schema.optional(Schema.Literals(["claude", "codex"])),
    /** The Linked environments beta is on, so T3 lists its link tools. */
    linkedEnvironments: Schema.optional(Schema.Boolean),
    /** false: the project is on no forge T3 reads, so T3 hides its forge tools. */
    forge: Schema.optional(Schema.Boolean),
    /** delegate_task `role` for a delegated child. T3 builds the child's first message from it. */
    delegateRole: Schema.optional(OrchestratorMcpTaskRole),
    context: Schema.optional(Schema.String),
    priorTurns: Schema.optional(
      Schema.Array(
        Schema.Struct({
          role: Schema.Literals(["user", "assistant"]),
          text: Schema.optional(Schema.String),
          toolCalls: Schema.optional(Schema.Array(PriorToolCall)),
        }),
      ),
    ),
    world: Schema.optional(McpToolUseWorld),
    /**
     * Canned tool results by bare name. `"default"` uses the runner's result. A device `DeviceError`
     * or preview `PreviewAutomationError` fails inside T3; `{"$error": value}` fails with value, as a
     * declared tool failure does; `{"$sequence": [...]}` answers call n with entry n, then the last.
     */
    mocks: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    /** Regexes on one part of a shell command. A match wins over the shell simulator. */
    shellMocks: Schema.optional(
      Schema.Array(Schema.Struct({ match: Schema.String, output: Schema.String })),
    ),
    /** The thread is a side chat's first turn: T3 puts the parent's digest ahead of `prompt`. */
    sideChat: Schema.optional(
      Schema.Struct({ parentThreadId: Schema.String, digest: Schema.Array(Schema.String) }),
    ),
  }),
  /** Empty to resume a top-level thread without side-chat context after its last tool result. */
  prompt: Schema.String,
  /** Records for the context chips `prompt` links, projected as T3 sends them. */
  promptContext: Schema.optional(Schema.Struct({ records: Schema.Array(ComposerContextRecord) })),
  expect: McpToolUseExpect,
  /** How many samples must pass for the case to pass. See margin.ts. */
  margin: Schema.optional(CaseMargin),
  /** Model calls this case may need. Overrides `--max-steps`. */
  maxSteps: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  notes: Schema.optional(Schema.String),
});
export type McpToolUseCase = typeof McpToolUseCase.Type;
const AnyBlock = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  Rest,
);
const Content = Schema.Union([Schema.String, Schema.Array(AnyBlock)]);
const MessagesRequest = Schema.Struct({
  system: Schema.optional(Content),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Content })),
  tools: Schema.Array(Schema.StructWithRest(Schema.Struct({ name: Schema.String }), Rest)),
});
// A CLIProxyAPI capture keeps the Anthropic body at request.provider_native.
const Capture = Schema.Struct({ request: Schema.Struct({ provider_native: MessagesRequest }) });
const ResponsesRequest = Schema.StructWithRest(
  Schema.Struct({
    input: Schema.Array(AnyBlock),
    reasoning: Schema.StructWithRest(Schema.Struct({ effort: Schema.String }), Rest),
  }),
  Rest,
);
const CodexCapture = Schema.Struct({
  request: Schema.Struct({ provider_native: ResponsesRequest }),
});
const ToolUse = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
const isToolUse = Schema.is(ToolUse);
const isText = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const Count = Schema.optional(Schema.NullOr(Schema.Number));
const ApiResponse = Schema.Struct({
  content: Schema.Array(AnyBlock),
  stop_reason: Schema.NullOr(Schema.String),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_creation_input_tokens: Count,
    cache_read_input_tokens: Count,
  }),
});

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const addUsage = (total: Usage, usage: typeof ApiResponse.Type.usage) => {
  total.input += usage.input_tokens;
  total.output += usage.output_tokens;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
};

const text = (value: string): Block => ({ type: "text", text: value });
const reminder = (value: string) => text(`<system-reminder>\n${value}\n</system-reminder>`);
const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");
const toolResult = (id: string, content: unknown): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content: valueText(content),
});
const texts = (content: typeof Content.Type) =>
  typeof content === "string" ? [content] : content.flatMap((block) => block.text ?? []);
const isT3Name = (name: string) => name.startsWith(T3_PREFIX) || name.startsWith("mcp__t3_code__");
const hasTool = (tools: ReadonlyArray<ApiTool>, name: string) =>
  tools.some((tool) => tool.name === name);

/** Grading name: T3 tools lose their MCP prefix, native tools keep the part after the last `_`. */
const CODEX_NAMES: Readonly<Record<string, string>> = {
  exec_command: "Bash",
  shell_command: "Bash",
  shell: "Bash",
  spawn_agent: "Agent",
  apply_patch: "Edit",
  request_user_input: "AskUserQuestion",
  request_user_input_async: "AskUserQuestion",
  write_stdin: "write_stdin",
  web__run: "WebFetch",
};
/** What follows a text block, as Kin's bridge reads it (`classifySegment`). */
const nextAfter = (blocks: ReadonlyArray<unknown>, index: number) => {
  const following = blocks.slice(index + 1).find((next) => isText(next) || isToolUse(next));
  return following === undefined ? "end" : isText(following) ? "text" : "tool";
};
/**
 * The text a chat shows from a turn's responses: every text block, status lines included, less
 * one that only repeats the reply so far, which Kin's bridge drops (`repeats`).
 */
export const shownText = (responses: ReadonlyArray<ReadonlyArray<unknown>>) => {
  const blocks = responses.flat();
  const said: Array<string> = [];
  let reply = "";
  blocks.forEach((block, index) => {
    if (!isText(block) || (reply !== "" && repeats(block.text, reply))) return;
    said.push(block.text);
    if (classifySegment(block.text, nextAfter(blocks, index)) === "post")
      reply = reply === "" ? block.text : `${reply}\n\n${block.text}`;
  });
  return said.join("\n\n");
};
/** Whether any text block posts as a message: short text before a tool is a status line. */
const postsText = (responses: ReadonlyArray<ReadonlyArray<unknown>>) => {
  const blocks = responses.flat();
  return blocks.some(
    (block, index) =>
      isText(block) && classifySegment(block.text, nextAfter(blocks, index)) === "post",
  );
};
export const normalizeToolName = (name: string) => {
  const bare = name.slice(name.lastIndexOf(".") + 1);
  return isT3Name(bare)
    ? bare.slice(T3_PREFIX.length)
    : (CODEX_NAMES[bare] ?? bare.slice(bare.lastIndexOf("_") + 1));
};
// Decoding wraps secrets such as a statement password in Redacted; grade the value the agent sent.
const unredact = (value: unknown): unknown =>
  Redacted.isRedacted(value)
    ? Redacted.value(value)
    : Array.isArray(value)
      ? value.map(unredact)
      : isRecord(value)
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unredact(item)]))
        : value;
export const normalizeToolInput = (name: string, input: unknown) => {
  const decode = t3InputDecoders.get(normalizeToolName(name));
  if (decode !== undefined) return unredact(Option.getOrElse(decode(input), () => input));
  return normalizeToolName(name) === "Bash" && isRecord(input)
    ? { ...input, command: input.command ?? input.cmd }
    : typeof input === "string" && normalizeToolName(name) === "Edit"
      ? { patch: input }
      : input;
};

// McpHttpServer advertises each tool's JSON schema, and Claude Code passes the MCP name,
// description, and schema through unchanged.
const t3SourceTools: ReadonlyArray<Tool.Any> = [
  OrchestratorToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  ThemeToolkit,
  PreviewControlsToolkit,
  WorktreeToolkit,
  PullRequestsToolkit,
  PreviewToolkit,
  IssuesToolkit,
  DeviceToolkit,
  HtmlToolkit,
  KinChatToolkit,
  KinLeadToolkit,
  KinWorkToolkit,
  KinStatementToolkit,
  KinDocsToolkit,
  KinDocumentToolkit,
  KinConnectionsToolkit,
  KinPulseToolkit,
  KinSocialToolkit,
  KinSalesToolkit,
  MessageToolkit,
].flatMap((toolkit): ReadonlyArray<Tool.Any> => Object.values(toolkit.tools));
// McpHttpServer decodes arguments with each tool's JSON codec, which drops undeclared keys.
const t3InputDecoders = new Map(
  t3SourceTools.map((tool) => [
    tool.name,
    Schema.decodeUnknownOption(
      Schema.toCodecJson(tool.parametersSchema as Schema.Codec<unknown, unknown>),
    ),
  ]),
);
const t3Tools: ReadonlyArray<ApiTool> = t3SourceTools.map((tool) => ({
  name: `${T3_PREFIX}${tool.name}`,
  description: Tool.getDescription(tool) ?? "",
  input_schema: advertisedJsonSchema(tool),
}));
// T3 gates these on the `preview` capability, which agent browser access decides.
const PREVIEW_TOOLS = new Set(
  [PreviewToolkit, PreviewControlsToolkit].flatMap((toolkit) =>
    Object.values(toolkit.tools).map((tool: Tool.Any) => tool.name),
  ),
);
const decodePreviewError = Schema.decodeUnknownOption(PreviewAutomationError);
const previewFailure = (mock: unknown) => Option.getOrUndefined(decodePreviewError(mock));
const enabledWhen = (predicate: () => boolean) =>
  new Set(
    t3SourceTools
      .filter(
        (tool) => Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen) === predicate,
      )
      .map((tool) => `${T3_PREFIX}${tool.name}`),
  );
// Claude Code loads a tool whose `_meta` sets anthropic/alwaysLoad up front instead of deferring it.
const alwaysLoaded = new Set(
  t3SourceTools
    .filter((tool) => {
      const meta = Context.getOrUndefined(tool.annotations, Tool.Meta);
      return meta !== undefined && meta["anthropic/alwaysLoad"] === true;
    })
    .map((tool) => `${T3_PREFIX}${tool.name}`),
);
// Refs whose request_secret takes `value` save a secret the user already pasted, with no card.
export const savesPastedSecrets = t3Tools.some(
  (tool) =>
    tool.name === `${T3_PREFIX}request_secret` &&
    isRecord(tool.input_schema) &&
    isRecord(tool.input_schema.properties) &&
    "value" in tool.input_schema.properties,
);
/** A request_secret call that hands T3 a pasted secret, on a ref that takes one. */
const pastedSecret = (name: string, input: Readonly<Record<string, unknown>>) =>
  savesPastedSecrets && name === "request_secret" && typeof input.value === "string";
// T3 does not offer these to a delegated child, so its harness never lists them.
const hiddenFromSubagents = enabledWhen(McpInvocationContext.hiddenFromSubagents);
// The Linked environments beta starts off, and T3 lists its tools only while it is on.
const hiddenWhileLinksOff = enabledWhen(McpInvocationContext.hiddenWhileLinksOff);
// T3 lists PR and CI tools only to a thread whose project is on a forge it reads.
const hiddenWithoutForge = enabledWhen(McpInvocationContext.hiddenWithoutForge);
const visibleT3Tools = (options: {
  readonly subagent?: boolean;
  readonly links?: boolean;
  readonly forge?: boolean;
  readonly kinAgent?: boolean;
  readonly kinLead?: boolean;
  readonly kinSession?: boolean;
  readonly kinShared?: boolean;
  /** The lead's remit is social media, so Social's tools join (AgentSession). */
  readonly kinSocial?: boolean;
}) =>
  t3Tools.filter(
    (tool) =>
      // A turn others read runs on a shared thread, which lists only what it may run (AgentSession).
      !(options.kinShared === true && !listedOnSharedThread(tool.name.slice(T3_PREFIX.length))) &&
      (options.kinAgent === true || options.kinLead === true
        ? // An owner-only turn's session: T3's lead tools join (AgentSession).
          (options.kinSession === true
            ? (LEAD_T3_TOOLS as ReadonlyArray<string>).some(
                (name) => tool.name === `${T3_PREFIX}${name}`,
              )
            : false) ||
          Object.keys(KinChatToolkit.tools).some((name) => tool.name === `${T3_PREFIX}${name}`) ||
          (options.kinLead === true &&
            [
              ...Object.keys(KinLeadToolkit.tools),
              ...Object.keys(KinWorkToolkit.tools),
              ...Object.keys(KinStatementToolkit.tools),
              ...Object.keys(KinStatementToolkit.tools),
              ...Object.keys(KinDocsToolkit.tools),
              ...Object.keys(KinDocumentToolkit.tools),
              ...Object.keys(KinPulseToolkit.tools),
              ...Object.keys(KinConnectionsToolkit.tools),
              ...(options.kinSocial === true ? Object.keys(KinSocialToolkit.tools) : []),
              ...Object.keys(KinSalesToolkit.tools),
            ].some((name) => tool.name === `${T3_PREFIX}${name}`))
        : ![
            ...Object.keys(KinChatToolkit.tools),
            ...Object.keys(KinLeadToolkit.tools),
            ...Object.keys(KinWorkToolkit.tools),
            ...Object.keys(KinDocsToolkit.tools),
            ...Object.keys(KinDocumentToolkit.tools),
            ...Object.keys(KinPulseToolkit.tools),
            ...Object.keys(KinConnectionsToolkit.tools),
            ...Object.keys(KinSocialToolkit.tools),
            ...Object.keys(KinSalesToolkit.tools),
          ].some((name) => tool.name === `${T3_PREFIX}${name}`)) &&
      (options.links === true || !hiddenWhileLinksOff.has(tool.name)) &&
      (options.forge !== false || !hiddenWithoutForge.has(tool.name)) &&
      !(options.subagent === true && hiddenFromSubagents.has(tool.name)),
  );

/**
 * T3's Claude Code options for an eval thread: its system prompt append and its hooks. `device` and
 * `browser` say whether the thread holds the `device` and `preview` capabilities, as agent device
 * and browser access decide.
 */
const claudeQueryOptions = (model: Model, device = true, browser = true) => {
  // Refs whose text follows a capability read its flag; older ones ignore it.
  const input: Parameters<typeof makeClaudeQueryOptions>[0] & {
    readonly deviceToolsAvailable?: boolean;
    readonly browserToolsAvailable?: boolean;
  } = {
    modelSelection: { instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER), model },
    nativeThreadId: "mcp-tool-use-eval",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
    deviceToolsAvailable: device,
    browserToolsAvailable: browser,
  };
  return makeClaudeQueryOptions(input);
};

/** Text T3 appends to Claude Code's system prompt. Delegated children get the same text. */
export const t3SystemAppend = (model: Model, device = true, browser = true) => {
  const { systemPrompt } = claudeQueryOptions(model, device, browser);
  if (isRecord(systemPrompt) && systemPrompt.type === "preset" && systemPrompt.append) {
    return systemPrompt.append;
  }
  throw new Error("makeClaudeQueryOptions no longer appends T3 text to a preset prompt.");
};

/**
 * The context T3's SubagentStart hooks give a native subagent, which gets none of the append.
 * Empty when T3 registers no such hook.
 */
export const t3SubagentContext = async (model: Model, device = true, browser = true) => {
  const hooks = (claudeQueryOptions(model, device, browser).hooks?.SubagentStart ?? []).flatMap(
    (m) => m.hooks,
  );
  const input = {
    hook_event_name: "SubagentStart" as const,
    session_id: "mcp-tool-use-eval",
    transcript_path: "",
    cwd: "",
    agent_id: "mcp-tool-use-eval",
    agent_type: "general-purpose",
  };
  const outputs = await Promise.all(
    hooks.map((hook) => hook(input, undefined, { signal: AbortSignal.timeout(10_000) })),
  );
  return outputs
    .flatMap((output) =>
      "hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "SubagentStart"
        ? [output.hookSpecificOutput.additionalContext ?? ""]
        : [],
    )
    .filter(Boolean)
    .join("\n\n");
};

/**
 * Size of the context T3 adds: the system text every Claude thread gets, and the tool
 * descriptions and schemas (loaded on demand here, sent up front by harnesses without
 * deferred tools). Tokens are estimated at 4 characters each.
 */
const t3ContextReport = (model: Model) => {
  const size = (chars: number) => `${chars} chars (~${Math.round(chars / 4)} tokens)`;
  const descriptions = t3Tools.reduce((sum, tool) => sum + valueText(tool.description).length, 0);
  const schemas = JSON.stringify(t3Tools).length;
  return [
    `- T3 context: system text ${size((isCodex(model) ? JSON.stringify(buildCodexAdditionalContext({ model }, { browser: true, device: true })) : t3SystemAppend(model)).length)}`,
    `tool descriptions ${size(descriptions)}`,
    `full tool schemas ${size(schemas)} across ${t3Tools.length} tools.`,
  ].join(", ");
};

const stringProperty = (description: string) => ({ type: "string", description });
const NATIVE_SCHEMAS: Readonly<Record<string, Omit<ApiTool, "name">>> = {
  WebFetch: {
    description: "Fetches content from a URL and answers the prompt about it.",
    input_schema: {
      type: "object",
      properties: {
        url: stringProperty("The URL to fetch"),
        prompt: stringProperty("What to extract"),
      },
      required: ["url", "prompt"],
    },
  },
  WebSearch: {
    description: "Searches the web and returns result titles, links, and snippets.",
    input_schema: {
      type: "object",
      properties: { query: stringProperty("The search query") },
      required: ["query"],
    },
  },
};

/** Rebuilds the parts of a captured request that every case shares. */
export const buildBase = (
  template: typeof MessagesRequest.Type,
  options: {
    readonly model: Model;
    readonly keepUserInstructions: boolean;
    readonly subagent?: boolean;
    readonly links?: boolean;
    readonly forge?: boolean;
    readonly kinAgent?: boolean;
    readonly kinLead?: boolean;
    readonly kinSession?: boolean;
    readonly kinShared?: boolean;
    readonly kinSocial?: boolean;
    /** A native subagent starts from its task: T3 appends nothing to its system prompt. */
    readonly nativeSubagent?: boolean;
    /** false: the thread has no agent device access, so T3's text leaves devices out. */
    readonly deviceAccess?: boolean;
    /** false: the thread has no agent browser access, so T3's text leaves the browser out. */
    readonly browserAccess?: boolean;
  },
) => {
  const t3 = visibleT3Tools(options);
  const firstAssistant = template.messages.findIndex((message) => message.role === "assistant");
  const head = template.messages.slice(0, firstAssistant === -1 ? undefined : firstAssistant);
  const systemTexts = [
    template.system ?? [],
    ...head.flatMap((m) => (m.role === "system" ? [m.content] : [])),
  ]
    .flatMap(texts)
    .filter((value) => !value.startsWith("x-anthropic-billing-header:"));
  const deferredList = DEFERRED_LIST.exec(systemTexts.join("\n"))?.[2];
  if (systemTexts.filter((value) => value.includes(RUNTIME_MARKER)).length !== 1 || !deferredList) {
    throw new Error(`The template needs one ${RUNTIME_MARKER} block and a deferred tool list.`);
  }
  const nativeDeferred = deferredList.split("\n").filter((name) => name && !isT3Name(name));
  const names = [
    ...nativeDeferred,
    ...t3.filter((tool) => !alwaysLoaded.has(tool.name)).map((tool) => tool.name),
  ]
    .toSorted()
    .join("\n");
  const { model } = options;
  const append = options.nativeSubagent
    ? ""
    : t3SystemAppend(model, options.deviceAccess, options.browserAccess);
  const modelLine = `You are powered by the model named ${MODELS[model]}. The exact model ID is ${model}.`;
  const joined = systemTexts.join("\n");
  // The capture's home directory names its user. Cases use `/home/user` paths instead.
  const cwd = /Primary working directory: (\S+)/.exec(joined)?.[1] ?? "/home/user/app";
  const home = /^\/(?:home|Users)\/[^/]+/.exec(cwd)?.[0];
  const anonymize = (value: string) =>
    home === undefined ? value : value.replaceAll(home, home.replace(/[^/]+$/, "user"));
  const system = systemTexts.map((value) => {
    // T3's append is the tail of its block: runtime info, PR linking, then orchestration.
    const at = value.indexOf(RUNTIME_MARKER);
    return anonymize(at === -1 ? value : value.slice(0, at) + append)
      .replace(DEFERRED_LIST, (_, header: string) => `${header}${names}\n`)
      .replace(MODEL_LINE, modelLine)
      .replace(IDENTITY, NEUTRAL_IDENTITY);
  });
  const [first] = template.messages;
  // The last block is the captured prompt.
  const reminders = (first?.role === "user" ? texts(first.content).slice(0, -1) : []).filter(
    (value) =>
      options.keepUserInstructions || !value.includes("Codebase and user instructions are"),
  );
  // gitStatus names a real repo state. Each case gets one built from its fake world instead.
  const gitStatusAt = reminders.findIndex((value) => value.includes("# gitStatus"));
  // Claude Code sends no schema for tools it only names. Web tools get their usual one, the
  // rest load open.
  const open = { type: "object", additionalProperties: true };
  const nativeSchema = (name: string) =>
    NATIVE_SCHEMAS[name] ?? { description: name, input_schema: open };
  const environment = {
    cwd: anonymize(cwd),
    platform: /Platform: (\w+)/.exec(joined)?.[1] ?? "linux",
    date: /Today's date is ([\d-]+)/.exec(reminders.join("\n"))?.[1],
  };
  // As Kin plans a session (`lead/turn/session.ts`): its instructions are the whole system prompt
  // and Kin tools load upfront except the few deferred behind ToolSearch. A turn with the owner's
  // seat (kinSession, not shared) has Claude Code's own tools too; a confined one, only its web search.
  if (options.kinLead === true) {
    const ownerSeat = options.kinSession === true && options.kinShared !== true;
    const deferredKin = t3.filter((tool) =>
      KIN_DEFERRED_TOOLS.has(tool.name.slice(T3_PREFIX.length)),
    );
    const header = DEFERRED_LIST.exec(joined)?.[1];
    const toolSearch = template.tools.filter((tool) => tool.name.endsWith("ToolSearch"));
    return {
      model,
      system: [text(kinInstructions(ownerSeat ? "owner" : "confined", "claudeAgent"))],
      reminders:
        deferredKin.length > 0 && header !== undefined
          ? [text(`${header}${deferredKin.map((tool) => tool.name).join("\n")}\n`)]
          : [],
      gitStatusAt: undefined,
      environment,
      nativeTools: [
        ...(ownerSeat
          ? [
              ...template.tools.filter(
                (tool) => !isT3Name(tool.name) && !tool.name.endsWith("ToolSearch"),
              ),
              ...nativeDeferred.map((name): ApiTool => ({ name, ...nativeSchema(name) })),
            ]
          : // A confined Claude session keeps the provider's own web search (`claude.ts`).
            [{ name: "WebSearch", ...nativeSchema("WebSearch") }]),
        ...(deferredKin.length > 0 ? toolSearch : []),
        ...t3.filter((tool) => !deferredKin.includes(tool)),
      ],
      t3,
      deferred: deferredKin,
    };
  }
  return {
    model,
    system: system.map(text),
    reminders: reminders.filter((_, i) => i !== gitStatusAt).map((value) => text(anonymize(value))),
    gitStatusAt: gitStatusAt === -1 ? reminders.length : gitStatusAt,
    /** The shell simulator's cwd and OS follow the template's environment section. */
    environment,
    nativeTools: [
      ...template.tools.filter((tool) => !isT3Name(tool.name)),
      ...t3.filter((tool) => alwaysLoaded.has(tool.name)),
    ],
    /** Tools ToolSearch loads: T3 tools from source, and native tools the template only names. */
    t3,
    deferred: [...t3, ...nativeDeferred.map((name) => ({ name, ...nativeSchema(name) }))],
  };
};

type Base = ReturnType<typeof buildBase> & {
  readonly codex?: typeof ResponsesRequest.Type;
  /** What T3's SubagentStart hooks give a native subagent. */
  readonly subagentContext?: string;
};

/** Keep the captured harness prompt and tools; replace app-owned context and the real user. */
const buildCodexBase = (
  template: typeof ResponsesRequest.Type,
  options: {
    readonly model: Model;
    readonly keepUserInstructions: boolean;
    readonly effort?: string | undefined;
    readonly subagent?: boolean;
    readonly links?: boolean;
    readonly forge?: boolean;
    readonly kinAgent?: boolean;
    readonly kinLead?: boolean;
    readonly kinSession?: boolean;
    readonly kinShared?: boolean;
    readonly kinSocial?: boolean;
    /** false: the thread has no agent device access, so T3's text leaves devices out. */
    readonly deviceAccess?: boolean;
    /** false: the thread has no agent browser access, so T3's text leaves the browser out. */
    readonly browserAccess?: boolean;
  },
): Base => {
  const t3 = visibleT3Tools(options);
  const contentText = (item: Block) =>
    Array.isArray(item.content)
      ? item.content.map((block: Block) => valueText(block.text)).join("\n")
      : valueText(item.content);
  const joined = template.input.map(contentText).join("\n");
  if (!joined.includes("<t3_code_runtime>"))
    throw new Error("Codex template needs full T3 context.");
  const cwd = /<cwd>(.*?)<\/cwd>/.exec(joined)?.[1] ?? "/home/user/app";
  const home = /^\/(?:home|Users)\/[^/]+/.exec(cwd)?.[0];
  const clean = (s: string) => (home ? s.replaceAll(home, home.replace(/[^/]+$/, "user")) : s);
  const effort = options.effort ?? template.reasoning.effort;
  const message = (value: string, role = "developer") => ({
    type: "message",
    role,
    content: [{ type: "input_text", text: value }],
  });
  // The captured <collaboration_mode> message stays: Codex supplies its own mode text natively.
  const input = template.input.flatMap((item) => {
    const content = contentText(item);
    if (content.includes("<t3_code_")) return [];
    if (item.role === "user") {
      const env = /<environment_context>[\s\S]*?<\/environment_context>/.exec(content)?.[0];
      return env ? [message(clean(options.keepUserInstructions ? content : env), "user")] : [];
    }
    // Only harness messages and tools. A captured turn's answers and tool calls would leak into
    // every case.
    if (item.type !== "message" && item.type !== "additional_tools") return [];
    if (item.role === "assistant") return [];
    return [JSON.parse(clean(JSON.stringify(item))) as Block];
  });
  const context = buildCodexAdditionalContext(
    { model: options.model, reasoningEffort: effort },
    { browser: options.browserAccess ?? true, device: options.deviceAccess ?? true },
  );
  input.push(
    ...Object.entries(context).map(([key, entry]) => message(`<${key}>${entry.value}</${key}>`)),
  );
  const nativeTools = input
    .flatMap((item) =>
      item.type === "additional_tools" && Array.isArray(item.tools)
        ? item.tools.flatMap((ns: unknown) =>
            isRecord(ns) && Array.isArray(ns.tools) ? ns.tools : [],
          )
        : [],
    )
    .filter((tool): tool is ApiTool => isRecord(tool) && typeof tool.name === "string");
  if (!nativeTools.some((tool) => tool.name === "exec"))
    throw new Error("Codex template needs code-mode exec.");
  return {
    model: options.model,
    system: [],
    reminders: [],
    gitStatusAt: 0,
    environment: {
      cwd: clean(cwd),
      platform: cwd.startsWith("/Users/") ? "darwin" : "linux",
      date: /<current_date>(.*?)<\/current_date>/.exec(joined)?.[1],
    },
    nativeTools,
    t3,
    deferred: [...t3],
    codex: { ...template, input, reasoning: { ...template.reasoning, effort } },
  };
};

/** Replay prior calls in Codex's wire format, including Claude-shaped file operations. */
const codexCall = (name: string, input: unknown) => {
  const args = isRecord(input) ? input : {};
  if (name === "Bash")
    return `text(await tools.exec_command(${JSON.stringify({ ...args, cmd: args.command })}));`;
  if (["Read", "Write", "Edit"].includes(name)) {
    const file = valueText(args.file_path);
    const command =
      name === "Read"
        ? `cat ${JSON.stringify(file)}`
        : name === "Write"
          ? `cat > ${JSON.stringify(file)} <<'EVAL_EOF'\n${valueText(args.content)}\nEVAL_EOF`
          : `python3 -c ${JSON.stringify(`from pathlib import Path; p=Path(${JSON.stringify(file)}); p.write_text(p.read_text().replace(${JSON.stringify(args.old_string)}, ${JSON.stringify(args.new_string)}))`)}`;
    return `text(await tools.exec_command(${JSON.stringify({ cmd: command })}));`;
  }
  return `text(await tools.${name.replace("mcp__t3-code__", "mcp__t3_code__")}(${JSON.stringify(input)}));`;
};
const codexMessages = (messages: ReadonlyArray<ApiMessage>): Array<Block> =>
  messages.flatMap((message) =>
    message.content.map((block): Block =>
      block.type === "tool_use"
        ? {
            type: "custom_tool_call",
            call_id: block.id,
            name: "exec",
            input: codexCall(valueText(block.name), block.input),
          }
        : block.type === "tool_result"
          ? {
              type: "custom_tool_call_output",
              call_id: block.tool_use_id,
              output: valueText(block.content),
            }
          : {
              type: "message",
              role: message.role,
              content: [
                {
                  type: message.role === "user" ? "input_text" : "output_text",
                  text: valueText(block.text),
                },
              ],
            },
    ),
  );
/** One tool call the shell simulator has answered, or one from the case's prior turns. */
type ShellEntry = { readonly tool: string; readonly input: unknown; readonly output: string };
/** PRs T3 links by itself because a shell command created them, as `gh pr create` does. */
const createdPullRequests = ({ tool, input, output }: ShellEntry) =>
  tool === "Bash" && isRecord(input) && typeof input.command === "string"
    ? changeRequestsCreatedBy(input.command, output).map(({ url }) => url)
    : [];

/** The PR number a shell command opened for `branch`; `--head` naming another branch is not it. */
const branchPullRequestCreatedBy = (entry: ShellEntry, branch: string | undefined) => {
  const command = isRecord(entry.input) ? valueText(entry.input.command) : "";
  const head = /--head[=\s]+["']?([^\s"']+)/.exec(command)?.[1];
  if (head !== undefined && branch !== undefined && head.split(":").at(-1) !== branch) {
    return undefined;
  }
  return createdPullRequests(entry)
    .map((url) => Number(/\/pull\/(\d+)/.exec(url)?.[1]))
    .find((number) => number > 0);
};
/** The branch the agent last checked out or switched to in the shell, else the world's. */
const checkedOutBranch = (sample: Sample) => {
  let branch = sample.testCase.setup.world?.branch ?? "";
  for (const entry of sample.shell) {
    const command = isRecord(entry.input) ? valueText(entry.input.command) : "";
    for (const part of command.replace(/\s\d?>&\d/g, "").split(/[;&|\n]+/)) {
      // `git checkout <ref> -- <paths>` restores files and stays on the branch.
      if (/\s--(\s|$)/.test(part)) continue;
      const match = /\bgit (?:checkout|switch)\s+(?:-[bcBC]\s+)?([A-Za-z0-9][\w./-]*)\s*$/.exec(
        part.trim(),
      );
      if (match !== null) branch = match[1]!;
    }
  }
  return branch;
};

/**
 * One sample's state. ToolSearch adds loaded schemas to `tools`, like Claude Code. `shell` is the
 * history the simulator keeps consistent with; `linked`, `nextTask` and `threads` do the same for
 * T3 results.
 */
type Sample = {
  readonly testCase: McpToolUseCase;
  readonly base: Base;
  readonly tools: Array<ApiTool>;
  readonly repo: string;
  readonly shell: Array<ShellEntry>;
  readonly shellUsage: Usage;
  readonly linked: Set<string>;
  /** The branch PR the agent opened in this sample, which links alone do not prove. */
  openedPullRequest: number | undefined;
  /** PRs pull_request_create opened from branches other than the world's, by branch. */
  readonly openedByBranch: Map<string, number>;
  /** PR changes the agent made through T3's tools, which gh and the host show from then on. */
  readonly forgeChanges: Array<string>;
  /** PRs pull_request_merge merged, as `repo#number`, which reads show as merged from then on. */
  readonly merged: Set<string>;
  readonly codeStore: Record<string, unknown>;
  nextTask: number;
  /** Threads the agent launched in this sample, by id, so reading one shows its own brief. */
  readonly threads: Map<string, { readonly title: string; readonly brief: string }>;
  /** Files T3's request_secret saved in this sample, in call order. */
  readonly secretFiles: Array<string>;
  secretRequests: number;
  /** T3's device tools, once `withDevices` builds them for a world with devices. */
  devices?: DeviceTools;
  /** T3's results for prior device calls whose case result is "default". */
  readonly priorResults: Map<unknown, string>;
  /** The model's responses so far, as `shownText` reads them. */
  readonly responses: Array<ReadonlyArray<unknown>>;
  /** Prior calls whose T3 result is an error, so the agent sees it as one. */
  readonly priorErrors: Set<unknown>;
  /** T3's t3_background_wait, once `withBackgroundWait` builds it for `world.backgroundTasks`. */
  backgroundWait?: BackgroundWait;
  /** Calls so far per mocked tool, for mocks that answer in sequence. */
  readonly mockCalls: Map<string, number>;
};

const SHELL_TOOLS = new Set(["Bash", "Read", "Edit", "Write", "WebFetch"]);

export const makeSample = (testCase: McpToolUseCase, base: Base): Sample => {
  const prior = testCase.setup.priorTurns ?? [];
  const priorCalls = prior.flatMap((turn) => turn.toolCalls ?? []);
  const repo = testCase.setup.world?.repo ?? "acme/app";
  const urls = [
    ...(testCase.setup.world?.linkedPullRequests ?? []).map(
      ({ number }) => pullRequest(repo, { number }).url,
    ),
    ...priorCalls.flatMap((call) =>
      ["link_pull_request", "watch_pull_request"].includes(call.tool) && isRecord(call.input)
        ? [pullRequest(repo, call.input).url]
        : call.tool === "link_pull_requests" &&
            isRecord(call.input) &&
            Array.isArray(call.input.urls)
          ? call.input.urls
              .filter((url) => PULL_REQUEST_URL.test(valueText(url)))
              .map((url) => pullRequest(repo, { url }).url)
          : [],
    ),
  ];
  const taskNumbers = [...valueText(prior).matchAll(/task-(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  const shell = priorCalls
    .filter((call) => SHELL_TOOLS.has(call.tool))
    .map(({ tool, input, result }) => ({ tool, input, output: valueText(result) }));
  return {
    testCase,
    base,
    // A Kin tool an earlier turn of the thread loaded through ToolSearch is still loaded.
    tools: [
      ...base.nativeTools,
      ...base.deferred.filter((tool) => {
        const bare = tool.name.replace(T3_PREFIX, "");
        return KIN_DEFERRED_TOOLS.has(bare) && priorCalls.some((call) => call.tool === bare);
      }),
    ],
    repo: testCase.setup.world?.repo ?? "acme/app",
    shell,
    shellUsage: emptyUsage(),
    linked: new Set([...urls, ...shell.flatMap(createdPullRequests)]),
    openedByBranch: new Map(),
    forgeChanges: [],
    merged: new Set(),
    openedPullRequest:
      shell
        .map((entry) => branchPullRequestCreatedBy(entry, testCase.setup.world?.branch))
        .find((number) => number !== undefined) ??
      priorCalls
        .filter((call) => call.tool === "pull_request_create")
        .map((call) => Number(/\/pull\/(\d+)/.exec(valueText(call.result))?.[1]))
        .find((number) => number > 0),
    codeStore: {},
    nextTask: Math.max(0, ...taskNumbers) + 1,
    threads: new Map(),
    secretFiles: [],
    secretRequests: 0,
    priorResults: new Map(),
    responses: [],
    priorErrors: new Set(),
    mockCalls: new Map(),
  };
};

/** A `{"$sequence": [...]}` mock answers its nth call with the nth result, then repeats the last. */
const nextMock = (sample: Sample, name: string, mock: unknown) => {
  if (!isRecord(mock) || !Array.isArray(mock.$sequence) || mock.$sequence.length === 0) return mock;
  const n = sample.mockCalls.get(name) ?? 0;
  sample.mockCalls.set(name, n + 1);
  return mock.$sequence[Math.min(n, mock.$sequence.length - 1)];
};

/**
 * Builds T3's device tools for a world with devices. Prior device calls whose result is "default"
 * run first, in order and without the case's mocks, so their results and sessions are T3's. As in
 * the real flow, device_open starts no agent-device session: one starts at a launcher `open` in the
 * sample's shell history, prior turns included, or where `world.agentDeviceSessions` declares it.
 */
export const withDevices = Effect.fn("evaluateMcpToolUse.withDevices")(function* (sample: Sample) {
  const world = sample.testCase.setup.world;
  if (world?.devices === undefined) return;
  sample.devices = yield* makeDeviceTools(
    { ...world, devices: world.devices },
    sample.base.environment,
  );
  for (const call of (sample.testCase.setup.priorTurns ?? []).flatMap((t) => t.toolCalls ?? [])) {
    if (call.result !== "default" || !isDeviceTool(call.tool)) continue;
    sample.priorResults.set(call, (yield* sample.devices.call(call.tool, call.input)).text);
  }
});

/**
 * Builds T3's t3_background_wait for a world with background tasks, and answers prior waits whose
 * result is "default" with T3's result.
 */
export const withBackgroundWait = Effect.fn("evaluateMcpToolUse.withBackgroundWait")(function* (
  sample: Sample,
) {
  const running = sample.testCase.setup.world?.backgroundTasks;
  if (running === undefined) return;
  const backgroundWait = yield* makeBackgroundWait(running);
  sample.backgroundWait = backgroundWait;
  for (const call of (sample.testCase.setup.priorTurns ?? []).flatMap((t) => t.toolCalls ?? [])) {
    if (call.result !== "default" || call.tool !== "t3_background_wait") continue;
    const result = yield* backgroundWait(call.input);
    sample.priorResults.set(call, result.text);
    if (result.isError) sample.priorErrors.add(call);
  }
});

// Main's history under every case's world.
const MAIN_COMMITS = [
  { sha: "9f2c1ab", subject: "feat(web): show the model name in the thread header" },
  { sha: "4e7d2c0", subject: "fix(server): retry provider start once on ENOENT" },
  { sha: "b81f3d9", subject: "chore: update dependencies" },
];

/**
 * The gitStatus Claude Code shows when a session starts, built from the case's world. Commits and
 * a branch that the prior turns made (their tool results show it) came later, so they are left out.
 */
const gitStatus = ({ setup }: McpToolUseCase) => {
  const prior = valueText(setup.priorTurns ?? []);
  const branch = setup.world?.branch ?? "main";
  const commits = [...(setup.world?.commits ?? []), ...MAIN_COMMITS].filter(
    (commit) => !prior.includes(` ${commit.sha}] `),
  );
  return [
    "As you answer the user's questions, you can use the following context:",
    "# gitStatus",
    "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
    "",
    `Current branch: ${prior.includes(`Switched to a new branch '${branch}'`) ? "main" : branch}`,
    "",
    "Main branch (you will usually use this for PRs): main",
    "",
    "Status:",
    setup.world?.status || "(clean)",
    "",
    "Recent commits:",
    ...commits.slice(0, 5).map((commit) => `${commit.sha} ${commit.subject}`),
    "",
    "Claude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
  ].join("\n");
};

const findTool = (base: Base, bare: string) =>
  [...base.nativeTools, ...base.deferred].find((tool) => normalizeToolName(tool.name) === bare) ??
  (base.codex ? { name: bare } : undefined);

/** Adds deferred schemas to `tools` and returns the ToolSearch result Claude Code sends. */
const loadTools = (tools: Array<ApiTool>, id: string, found: ReadonlyArray<ApiTool>): Block => {
  for (const tool of found) {
    if (!hasTool(tools, tool.name)) tools.push({ ...tool, defer_loading: true });
  }
  const content = found.map((tool) => ({ type: "tool_reference", tool_name: tool.name }));
  return { type: "tool_result", tool_use_id: id, content };
};

/** Messages for a case: reminders, context, prior turns with real tool blocks, then the prompt. */
/**
 * A lead case writes `{{WORK_RULE}}`, `{{SHARED_TURN}}` and Kin's other rule lines where Kin puts
 * them, in its prompt or a prior turn, so it tests the current text.
 */
const STANDARD_SEATS = ["chief-of-staff", "finance", "engineering", "growth", "social"];
const seatCharacter = (domain: string) => {
  // The eval company keeps rupees in India, so Finance's text is the one Kin's tests know.
  const body = defaultCharacterFor(domain, { homeCurrency: "INR", country: "IN", tax: null });
  if (body === undefined) throw new Error(`No default character for ${domain}.`);
  return { body, name: /^# (.+)$/m.exec(body)?.[1] ?? domain };
};
/**
 * `{{CHARACTER:<domain>}}` is that default character as its agent's own owner-only turn carries
 * it; `{{COLLEAGUES:<domain>}}` the other standard agents' lines, as Kin gives them.
 */
const fillCharacters = (prompt: string) =>
  prompt
    .replace(/\{\{CHARACTER:([a-z-]+)\}\}/g, (_, domain: string) =>
      characterForTurn({ key: "D-12", body: seatCharacter(domain).body }, true),
    )
    .replace(/\{\{COLLEAGUES:([a-z-]+)\}\}/g, (_, domain: string) =>
      STANDARD_SEATS.filter((seat) => seat !== domain)
        .map((seat) => colleagueLine(seatCharacter(seat).name, seatCharacter(seat).body))
        .join("\n"),
    );

/** `{{GITHUB_TRIGGER}}` is the event Kin builds for the case's `world.githubTrigger`. */
const fillGitHubTrigger = (prompt: string, world: McpToolUseCase["setup"]["world"]) => {
  if (!prompt.includes("{{GITHUB_TRIGGER}}")) return prompt;
  const given = world?.githubTrigger as
    | {
        readonly event: string;
        readonly repo: string;
        readonly trigger: Contracts.KinGithubTrigger;
      }
    | undefined;
  if (given === undefined) throw new Error("{{GITHUB_TRIGGER}} needs setup.world.githubTrigger.");
  return prompt.replaceAll(
    "{{GITHUB_TRIGGER}}",
    githubTriggerEvent(given.event, given.repo, given.trigger),
  );
};

const fillKinRules = (prompt: string, world?: McpToolUseCase["setup"]["world"]) =>
  fillCharacters(fillGitHubTrigger(prompt, world))
    .replaceAll("{{UNDO_RULE}}", UNDO_RULE)
    .replaceAll("{{WORK_RULE}}", WORK_RULE)
    .replaceAll("{{MONEY_RULE}}", MONEY_RULE)
    .replaceAll("{{PULSE_RULE}}", PULSE_RULE)
    .replaceAll("{{CHECK_IN_PULSE_RULE}}", CHECK_IN_PULSE_RULE)
    .replaceAll("{{WEEKLY_RULE}}", WEEKLY_RULE)
    .replaceAll("{{GROUP_RULES}}", kinGroupRules)
    .replaceAll("{{TEAM_RULES}}", kinTeamRules)
    .replaceAll("{{SOCIAL_RULES}}", kinSocialRules)
    // The seat's rules as the prompt builder picks them, by the agent's domain.
    .replace(/\{\{SALES_RULES:([a-z-]+)\}\}/g, (_, domain: string) =>
      salesRulesFor(domain).join("\n\n"),
    )
    .replaceAll("{{REPLY_SHAPE}}", REPLY_SHAPE)
    .replaceAll("{{HANDED_BACK_WORK}}", HANDED_BACK_WORK)
    .replaceAll("{{STARTED_RULE}}", STARTED_RULE)
    .replaceAll("{{DECLINED_RULE}}", DECLINED_RULE)
    .replaceAll("{{SHARED_TURN}}", SHARED_TURN_LINE)
    .replaceAll("{{WITHDRAWN_WORK}}", WITHDRAWN_WORK);

export const buildMessages = (sample: Sample) => {
  const { testCase, base, tools } = sample;
  const messages: Array<ApiMessage> = [];
  const push = (role: ApiMessage["role"], ...blocks: ReadonlyArray<Block>) => {
    const last = messages.at(-1);
    if (last?.role !== role) messages.push({ role, content: blocks });
    else messages[messages.length - 1] = { role, content: [...last.content, ...blocks] };
  };
  const { role, context, delegateRole, priorTurns = [] } = testCase.setup;
  const sideChat = testCase.setup.sideChat;
  if (testCase.prompt === "" && (role !== "top" || sideChat !== undefined)) {
    throw new Error(
      `${testCase.id}: Empty-prompt replay requires a top-level thread without side-chat context.`,
    );
  }
  const sideChatContext =
    sideChat === undefined
      ? undefined
      : makeSideChatContext({
          parentThreadId: ThreadId.make(sideChat.parentThreadId),
          digest: sideChat.digest,
        });
  const native = role === "native-subagent";
  const notes = [
    native
      ? "You are a subagent started by the parent agent's Agent tool. Your final message goes to the parent agent, not to the user."
      : undefined,
    context,
  ];
  // A lead's cwd is its memory checkout, so its turn carries no git status.
  const reminders =
    base.gitStatusAt === undefined
      ? base.reminders
      : base.reminders.toSpliced(base.gitStatusAt, 0, reminder(gitStatus(testCase)));
  push("user", ...reminders, ...notes.flatMap((note) => (note ? [reminder(note)] : [])));
  const toolSearch = findTool(base, "ToolSearch")?.name ?? "ToolSearch";
  let nextId = 0;
  for (const turn of priorTurns) {
    const calls = (turn.toolCalls ?? []).map((call) => {
      const tool = findTool(base, call.tool);
      if (tool === undefined) throw new Error(`${testCase.id}: unknown prior tool ${call.tool}.`);
      const builder = isDeviceTool(call.tool)
        ? "withDevices"
        : call.tool === "t3_background_wait"
          ? "withBackgroundWait"
          : undefined;
      if (call.result === "default" && builder && !sample.priorResults.has(call)) {
        throw new Error(`${testCase.id}: prior ${call.tool} needs T3's result; run ${builder}.`);
      }
      return { ...call, id: `toolu_prior_${nextId++}`, name: tool.name, tool, prior: call };
    });
    // Prior T3 calls load their schemas first, as in a real deferred session.
    const unloaded = [...new Set(calls.map((call) => call.tool))].filter(
      (tool) => !hasTool(tools, tool.name),
    );
    if (unloaded.length > 0 && !base.codex) {
      const id = `toolu_prior_${nextId++}`;
      const query = `select:${unloaded.map((tool) => tool.name).join(",")}`;
      const input = { query, max_results: unloaded.length };
      push("assistant", { type: "tool_use", id, name: toolSearch, input });
      push("user", loadTools(tools, id, unloaded), text(TOOL_LOADED));
    }
    // One call per step, as most real turns run them.
    for (const { id, name, input, result, tool, prior } of calls) {
      push("assistant", { type: "tool_use", id, name, input });
      const replayed =
        normalizeToolName(tool.name) === "orchestrator_capabilities"
          ? capabilities(sample, result)
          : (sample.priorResults.get(prior) ?? result);
      const answer = toolResult(id, replayed);
      push("user", sample.priorErrors.has(prior) ? { ...answer, is_error: true } : answer);
    }
    if (turn.text) push(turn.role, text(fillKinRules(turn.text)));
  }
  const casePrompt = fillKinRules(testCase.prompt, testCase.setup.world);
  const userText =
    testCase.promptContext === undefined
      ? casePrompt
      : projectComposerContextForProvider({ text: casePrompt, ...testCase.promptContext });
  const inline =
    sideChatContext === undefined ? userText : withInlineContext(sideChatContext, userText);
  // Codex has no lead session to carry the instructions, so its prompt opens with them.
  const prompt =
    testCase.setup.world?.kinLead === true && base.codex !== undefined
      ? `${kinLeadInstructions}\n\n${inline}`
      : inline;
  const childPrompt = () => taskPrompt({ task: prompt, role: delegateRole });
  if (testCase.prompt !== "")
    push("user", text(role === "delegated-child" ? childPrompt() : prompt));
  // Claude Code gives a subagent its SubagentStart hooks' context as a reminder after the task.
  if (native && base.subagentContext) {
    push("user", reminder(`SubagentStart hook additional context: ${base.subagentContext}`));
  }
  return messages;
};

// Results for T3 tools a case does not mock. The model ids are public in this repo's catalog.
const claudeModel = (id: string) => ({ id, options: [{ id: "effort", values: EFFORTS }] });
const codexModel = (id: string) => ({ id, options: [{ id: "reasoningEffort", values: EFFORTS }] });
// Mirrors the real catalog's main models, so a case's named model is not missing by accident.
const PROVIDERS = [
  {
    providerInstanceId: "claudeAgent",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-haiku-5-5"].map(
      claudeModel,
    ),
  },
  {
    providerInstanceId: "codex",
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].map(codexModel),
  },
  { providerInstanceId: "muse", models: ["muse-wonder-full", "muse-wonder"].map(codexModel) },
  { providerInstanceId: "grok", models: ["grok-4.7"].map(codexModel) },
];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEFAULT_THREAD = {
  title: "Fix the flaky reconnect test",
  status: "idle",
  items: [
    {
      position: 1,
      createdBy: "user",
      text: "The reconnect test in src/session.test.ts fails about 1 in 10 runs. Fix it.",
    },
    {
      position: 2,
      createdBy: "assistant",
      text: "Fixed. The test now waits for the socket close event before it reconnects. 20 runs in a row pass.",
    },
  ],
};
const HTML_RENDERED =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

const PULL_REQUEST_URL = /\/pull\/\d+\/?$/;

/** Pull request identity from a `url` or `repository` plus `number` input, like T3's results. */
const pullRequest = (repo: string, input: Readonly<Record<string, unknown>>) => {
  const url = typeof input.url === "string" ? input.url : "";
  const repository =
    /github\.com\/([^/]+\/[^/]+)\/pull/.exec(url)?.[1] ?? valueText(input.repository ?? repo);
  const number = Number(/(\d+)\/?$/.exec(url)?.[1] ?? input.number);
  return {
    host: "github.com",
    repository,
    number,
    url: url || `https://github.com/${repository}/pull/${number}`,
  };
};

/** A linked PR as `list_thread_pull_requests` shows it. Links made in the sample are open. */
const linkedEntry = (sample: Sample, url: string) => {
  const pr = pullRequest(sample.repo, { url });
  const seeded = sample.testCase.setup.world?.linkedPullRequests?.find(
    ({ number }) => number === pr.number && pr.repository === sample.repo,
  );
  const state = mergedIn(sample, pr.repository, pr.number) ? "merged" : (seeded?.state ?? "open");
  return { ...pr, state, title: seeded?.title ?? null };
};

const mergedIn = (sample: Sample, repository: string, number: unknown) =>
  sample.merged.has(`${repository.toLowerCase()}#${Number(number)}`);

/** The world's PRs. `prs` is free-form world data: number, title, headRefName, checks. */
const worldPullRequests = (sample: Sample) => {
  const prs = sample.testCase.setup.world?.prs;
  return Array.isArray(prs) ? prs.filter(isRecord) : [];
};

/** World fixtures spell states as GitHub does (`MERGED`) or as T3 does (`merged`). */
const worldState = (pr: Readonly<Record<string, unknown>> | undefined) => {
  const state = valueText(pr?.state ?? "open").toLowerCase();
  return state === "merged" || state === "closed" ? state : "open";
};

/**
 * The PR for the sample's branch: the world's, else the one a create would open. A case that
 * mocks `gh pr create` names that URL, so the T3 tool opens the same number.
 */
const worldBranchPullRequest = (sample: Sample) => {
  const branch = sample.testCase.setup.world?.branch;
  const prs = worldPullRequests(sample);
  const own = prs.find((pr) => pr.headRefName === branch);
  if (own !== undefined) return { number: Number(own.number), created: false, pr: own };
  if (sample.openedPullRequest !== undefined) {
    return { number: sample.openedPullRequest, created: false, pr: undefined };
  }
  const mocked = (sample.testCase.setup.shellMocks ?? []).find((mock) =>
    /\b(pr|mr) create\b/.test(mock.match),
  );
  const fromMock = Number(/\/pull\/(\d+)/.exec(mocked?.output ?? "")?.[1]);
  const number =
    fromMock > 0 ? fromMock : Math.max(123, ...prs.map((pr) => Number(pr.number) || 0)) + 1;
  return { number, created: true, pr: undefined };
};

/** The PR for the checked-out branch: a stack layer's own, or the world branch's. */
const branchPullRequest = (sample: Sample) => {
  const checkedOut = checkedOutBranch(sample);
  if (checkedOut === sample.testCase.setup.world?.branch) return worldBranchPullRequest(sample);
  const known = worldPullRequests(sample).find((pr) => pr.headRefName === checkedOut);
  if (known !== undefined) return { number: Number(known.number), created: false, pr: known };
  const opened = sample.openedByBranch.get(checkedOut);
  if (opened !== undefined) return { number: opened, created: false, pr: undefined };
  const number =
    Math.max(
      worldBranchPullRequest(sample).number,
      ...sample.openedByBranch.values(),
      ...worldPullRequests(sample).map((pr) => Number(pr.number) || 0),
      ...[...sample.linked].map((url) => Number(/\/pull\/(\d+)/.exec(url)?.[1]) || 0),
    ) + 1;
  return { number, created: true, pr: undefined };
};

/** PullRequestService reads this many logs when no check is named. */
const DEFAULT_CHECK_LOGS = 5;

/** The checks `ci_logs` and `ci_rerun` act on, selected as PullRequestService does. */
const selectedWorldChecks = (sample: Sample, input: Readonly<Record<string, unknown>>) => {
  const number = typeof input.number === "number" ? input.number : branchPullRequest(sample).number;
  const world = worldPullRequests(sample).find((pr) => Number(pr.number) === number);
  const all = Array.isArray(world?.checks) ? world.checks.filter(isRecord) : [];
  const named = typeof input.check === "string" ? input.check.trim().toLowerCase() : null;
  const checks = all.filter((check) =>
    named === null
      ? check.state === "fail" || check.state === "cancelled"
      : valueText(check.name).toLowerCase() === named,
  );
  return { number, all, checks, named };
};

/** A believable T3 result for a tool the case does not mock. */
export const t3Default = (
  sample: Sample,
  name: string,
  input: Readonly<Record<string, unknown>>,
) => {
  const pr = () => pullRequest(sample.repo, input);
  const newThread = (request: unknown, brief: unknown) => {
    const n = sample.nextTask++;
    const title =
      isRecord(request) && typeof request.title === "string" ? request.title : "New thread";
    const text = typeof brief === "string" ? brief.trim() : "";
    sample.threads.set(uuid(n), { title, brief: text });
    return {
      threadId: uuid(n),
      title,
      ...(text ? { runId: `run-${n}`, status: "starting" } : { status: "idle" }),
    };
  };
  switch (name) {
    case "t3_thread_launch":
      return newThread(input, input.message);
    case "create_threads":
      return {
        threads: (Array.isArray(input.threads) ? input.threads : []).map((request) => {
          const target = isRecord(request) && isRecord(request.target) ? request.target : {};
          return {
            ...newThread(request, isRecord(request) ? request.prompt : undefined),
            createdBy: "agent",
            creationSource: "mcp",
            providerInstanceId:
              target.providerInstanceId ?? (sample.base.codex ? "codex" : "claudeAgent"),
            model: target.model ?? sample.base.model,
          };
        }),
      };
    case "orchestrator_capabilities":
      return {
        inheritedProviderInstanceId: "claudeAgent",
        inheritedModel: sample.base.model,
        providers: PROVIDERS,
      };
    case "delegate_task": {
      const n = sample.nextTask++;
      const target = isRecord(input.target) ? input.target : {};
      return {
        taskId: `task-${n}`,
        childThreadId: uuid(n),
        childRunId: `run-${n}`,
        status: "running",
        workState: "working",
        hasPendingChildRuns: false,
        providerInstanceId:
          target.providerInstanceId ?? (sample.base.codex ? "codex" : "claudeAgent"),
        model: target.model ?? sample.base.model,
        summary: null,
        hasPendingQuestion: false,
        pendingApproval: null,
      };
    }
    case "task_status":
      return {
        taskId: input.taskId,
        status: "running",
        workState: "working",
        hasPendingChildRuns: false,
        summary: null,
      };
    case "task_cancel":
      return { taskId: input.taskId, status: "cancel_requested" };
    case "link_pull_request": {
      const alreadyLinked = sample.linked.has(pr().url);
      sample.linked.add(pr().url);
      return { ...pr(), alreadyLinked };
    }
    case "link_pull_requests": {
      const urls = Array.isArray(input.urls) ? input.urls.map(valueText) : [];
      const invalidUrls = urls.filter((url) => !PULL_REQUEST_URL.test(url));
      const targets = [...new Set(urls.filter((url) => PULL_REQUEST_URL.test(url)))].map((url) =>
        pullRequest(sample.repo, { url }),
      );
      const fresh = targets.filter(({ url }) => !sample.linked.has(url));
      for (const { url } of targets) sample.linked.add(url);
      const byRepository = (prs: ReadonlyArray<ReturnType<typeof pullRequest>>) =>
        [...Map.groupBy(prs, (pr) => pr.repository).values()].map((group) => ({
          host: "github.com",
          repository: group[0]!.repository,
          numbers: group.map((pr) => pr.number),
        }));
      return {
        linked: byRepository(fresh),
        alreadyLinked: byRepository(targets.filter((pr) => !fresh.includes(pr))),
        linkedCount: targets.length,
        ...(invalidUrls.length > 0 ? { invalidUrls } : {}),
      };
    }
    case "pull_request_create": {
      const checkedOut = checkedOutBranch(sample);
      const { number, created } = branchPullRequest(sample);
      const target = pullRequest(sample.repo, { number });
      sample.linked.add(target.url);
      // Another layer of a stack gets its own PR, opened once per branch like the real tool.
      if (checkedOut !== sample.testCase.setup.world?.branch) {
        sample.openedByBranch.set(checkedOut, number);
      } else if (created) sample.openedPullRequest = number;
      return { ...target, created };
    }
    case "pull_request_read": {
      const own = branchPullRequest(sample);
      const number = typeof input.number === "number" ? input.number : own.number;
      const world = worldPullRequests(sample).find((pr) => Number(pr.number) === number);
      const sections = Array.isArray(input.sections) ? input.sections : ["summary", "checks"];
      const checks = Array.isArray(world?.checks) ? world.checks.filter(isRecord) : [];
      return {
        ...pullRequest(sample.repo, { number }),
        ...(sections.includes("summary")
          ? {
              summary: {
                title: valueText(
                  world?.title ?? sample.testCase.setup.world?.commits?.[0]?.subject,
                ),
                body: valueText(world?.body ?? ""),
                state: mergedIn(sample, sample.repo, number) ? "merged" : worldState(world),
                isDraft: false,
                author: "user",
                headBranch: valueText(world?.headRefName ?? sample.testCase.setup.world?.branch),
                baseBranch: valueText(world?.baseRefName ?? "main"),
                // Only the branch's own PR is at the checkout's latest commit.
                headSha:
                  typeof world?.headRefOid === "string"
                    ? world.headRefOid
                    : number === own.number
                      ? (sample.testCase.setup.world?.commits?.[0]?.sha ?? null)
                      : null,
                mergeability: "mergeable",
                behindBy: 0,
                autoMergeEnabled: false,
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                labels: [],
                reviewers: [],
              },
            }
          : {}),
        ...(sections.includes("checks")
          ? {
              checks: checks.map((check) => ({
                name: valueText(check.name),
                status:
                  check.state === "fail"
                    ? "failure"
                    : check.state === "pending"
                      ? "pending"
                      : "success",
                description: null,
                url: null,
              })),
            }
          : {}),
        ...(sections.includes("diff")
          ? { diff: { patch: valueText(world?.diff ?? ""), truncated: false, nextCursor: null } }
          : {}),
        ...(sections.includes("conversation")
          ? {
              conversation: {
                comments: (Array.isArray(world?.comments) ? world.comments : [])
                  .filter(isRecord)
                  .map((comment, index) => ({
                    id: `comment-${index + 1}`,
                    kind: "issue-comment",
                    author: valueText(comment.author),
                    body: valueText(comment.body),
                    createdAt: "2026-10-27T10:00:00Z",
                    path: null,
                    reviewState: null,
                  })),
                reviewThreads: [],
                hiddenResolvedThreads: 0,
                truncated: false,
                nextCursor: null,
              },
            }
          : {}),
      };
    }
    case "pull_request_list": {
      const state = valueText(input.state ?? "open");
      const stateOf = (pr: Readonly<Record<string, unknown>>) =>
        mergedIn(sample, sample.repo, pr.number) ? "merged" : worldState(pr);
      return {
        pullRequests: worldPullRequests(sample)
          .filter((pr) => state === "all" || stateOf(pr) === state)
          .map((pr) => ({
            number: Number(pr.number),
            title: valueText(pr.title),
            url: pullRequest(sample.repo, { number: pr.number }).url,
            author: "user",
            headBranch: valueText(pr.headRefName),
            baseBranch: "main",
            state: stateOf(pr),
            isDraft: false,
            reviewDecision: null,
            checksState: null,
            updatedAt: "2026-10-27T10:00:00Z",
          })),
        truncated: false,
        nextCursor: null,
      };
    }
    case "pull_request_update":
    case "pull_request_review":
      return pullRequest(sample.repo, { number: input.number ?? branchPullRequest(sample).number });
    case "pull_request_respond":
      return {
        ...pullRequest(sample.repo, { number: input.number ?? branchPullRequest(sample).number }),
        replied: input.body !== undefined,
        resolved: typeof input.resolved === "boolean" ? input.resolved : null,
      };
    case "pull_request_merge": {
      const number = input.number ?? branchPullRequest(sample).number;
      if (input.auto !== true) {
        const layers = worldPullRequests(sample).map((pr) => Number(pr.number));
        const below =
          input.stack === true && sample.testCase.setup.world?.stack !== undefined
            ? layers.slice(0, layers.indexOf(Number(number)) + 1)
            : [];
        for (const merged of [Number(number), ...below])
          sample.merged.add(`${sample.repo.toLowerCase()}#${merged}`);
      }
      return {
        ...pullRequest(sample.repo, { number }),
        state: input.auto === true ? "open" : "merged",
      };
    }
    case "ci_logs":
    case "ci_rerun": {
      const { number, checks, named } = selectedWorldChecks(sample, input);
      return {
        ...pullRequest(sample.repo, { number }),
        checks: checks.map((check, index) =>
          name === "ci_rerun"
            ? { name: valueText(check.name), rerun: true, detail: null }
            : named === null && index >= DEFAULT_CHECK_LOGS
              ? {
                  name: valueText(check.name),
                  url: null,
                  log: null,
                  truncated: false,
                  detail: "Not read, to keep the reply short. Ask for this check by name.",
                }
              : {
                  name: valueText(check.name),
                  url: null,
                  log: valueText(check.log ?? `Error: ${valueText(check.name)} failed`),
                  truncated: false,
                  detail: null,
                },
        ),
      };
    }
    case "request_secret": {
      // T3 names a ref and a file with 32 hex characters, new for each request, in its secrets dir.
      const id = NodeCrypto.createHash("sha256")
        .update(`${sample.testCase.id}:${sample.secretRequests++}`)
        .digest("hex")
        .slice(0, 32);
      const home =
        /^\/(?:home|Users)\/[^/]+/.exec(sample.base.environment.cwd)?.[0] ?? "/home/user";
      return input.delivery === "file" || pastedSecret(name, input)
        ? { status: "saved", file: `${home}/.t3/userdata/secrets/files/${id}` }
        : { status: "saved", secretRef: `secret-ref:${id}` };
    }
    case "unlink_pull_request":
      return { ...pr(), wasLinked: sample.linked.delete(pr().url) };
    case "unlink_pull_requests": {
      const states = Array.isArray(input.states) ? input.states : [];
      const unlinked = [...sample.linked]
        .map((url) => linkedEntry(sample, url))
        .filter((entry) => states.includes(entry.state));
      for (const { url } of unlinked) sample.linked.delete(url);
      const groups = Map.groupBy(unlinked, (entry) => `${entry.repository}/${entry.state}`);
      return {
        unlinked: [...groups.values()].map((entries) => ({
          host: "github.com",
          repository: entries[0]!.repository,
          state: entries[0]!.state,
          numbers: entries.map((entry) => entry.number),
        })),
        unlinkedCount: unlinked.length,
        remaining: sample.linked.size,
      };
    }
    case "watch_pull_request":
      sample.linked.add(pr().url);
      return { ...pr(), watching: true, wasWatching: false };
    case "unwatch_pull_request":
      return { ...pr(), watching: false, wasWatching: true };
    case "list_thread_pull_requests": {
      const states = Array.isArray(input.states) ? input.states : undefined;
      const layers =
        sample.testCase.setup.world?.stack === undefined
          ? []
          : worldPullRequests(sample).map((pr) => Number(pr.number));
      const matching = [...sample.linked]
        .map((url) => linkedEntry(sample, url))
        .map((entry) => {
          const position =
            entry.repository.toLowerCase() === sample.repo.toLowerCase()
              ? layers.indexOf(entry.number) + 1
              : 0;
          return {
            ...entry,
            source: "agent",
            watching: false,
            stack: position === 0 ? null : { kind: "native", position, size: layers.length },
          };
        })
        .filter((entry) => states === undefined || states.includes(entry.state));
      const start = Number(valueText(input.cursor)) || 0;
      const end = start + 50;
      const linkedLayers = layers.filter((number) =>
        matching.some((entry) => entry.stack !== null && entry.number === number),
      );
      return {
        pullRequests: matching.slice(start, end),
        chains: linkedLayers.length < 2 ? [] : [{ kind: "native", numbers: linkedLayers }],
        nextCursor: end < matching.length ? String(end) : null,
      };
    }
    case "t3_thread_read": {
      const threadId = valueText(input.threadId);
      const launched = sample.threads.get(threadId);
      if (launched !== undefined) {
        const items = launched.brief
          ? [{ position: 1, createdBy: "agent", creationSource: "mcp", text: launched.brief }]
          : [];
        const thread = {
          threadId,
          title: launched.title,
          createdBy: "agent",
          creationSource: "mcp",
          status: launched.brief ? "running" : "idle",
        };
        return { thread, items, nextPosition: items.length + 1, hasMore: false };
      }
      const { title, status, items } = DEFAULT_THREAD;
      return { thread: { threadId, title, status }, items, nextPosition: 3, hasMore: false };
    }
    case "html_preview":
      return { width: 728, contentHeight: 560, capturedHeight: 560, consoleMessages: [] };
    case "html_render":
      return {
        htmlRender: { attachmentId: "att-1", title: input.title ?? "Visual", height: 560 },
        message: HTML_RENDERED,
      };
    case "preview_status":
      return {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      };
    default:
      return { ok: true };
  }
};

/** The machine the fake threads live on. */
const EVAL_ENVIRONMENT_ID = EnvironmentId.make("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

// The note T3 adds when a secret card ends unsaved, on refs that have one (looked up by name so
// the runner still builds on refs without it).
const unsavedSecretNote = (Contracts as Record<string, unknown>).SECRET_REQUEST_UNSAVED_NOTE as
  | Readonly<Record<string, string>>
  | undefined;

/** Fields T3 adds to real thread and task results, applied to mocks and defaults alike. */
const withProductFields = (name: string, value: unknown, child: boolean): unknown => {
  if (!isRecord(value)) return value;
  // The guide is the checkout's text, so a case's mock cannot go stale.
  if (name === "t3_theme_read") return { ...value, guide: THEME_GUIDE };
  const linked = (thread: unknown, idKey = "threadId") => {
    if (!isRecord(thread) || thread.link !== undefined) return thread;
    const id = thread[idKey] ?? thread.id;
    return typeof id === "string"
      ? {
          ...thread,
          link: formatThreadLink(
            { environmentId: EVAL_ENVIRONMENT_ID, threadId: ThreadId.make(id) },
            typeof thread.title === "string" ? thread.title : undefined,
          ),
        }
      : thread;
  };
  const listed = (key: string) =>
    Array.isArray(value[key]) ? { ...value, [key]: value[key].map((item) => linked(item)) } : value;
  switch (name) {
    case "request_secret": {
      const note = typeof value.status === "string" ? unsavedSecretNote?.[value.status] : undefined;
      return note === undefined || value.note !== undefined ? value : { ...value, note };
    }
    case "delegate_task":
    case "task_status": {
      const task = linked(value, "childThreadId") as Record<string, unknown>;
      const running = task.status === "running" && task.next === undefined;
      return running ? { ...task, next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } : task;
    }
    case "t3_thread_read":
      return { ...value, thread: linked(value.thread) };
    case "t3_thread_launch":
    case "t3_thread_send":
    case "run_scheduled_task_now":
      return linked(value);
    case "t3_thread_list":
    case "create_threads":
      return listed("threads");
    case "t3_thread_search":
      return listed("matches");
    case "link_pull_request":
    case "link_pull_requests":
    case "pull_request_create":
      return child ? { ...value, next: CHILD_PULL_REQUEST_REPORT_NEXT } : value;
    default:
      return value;
  }
};

/** Cases mock a Claude caller, so the inherited fields follow the model under test. */
const capabilities = ({ base }: Sample, value: unknown) =>
  isRecord(value)
    ? {
        ...value,
        inheritedModel: base.model,
        ...(base.codex
          ? {
              inheritedProviderInstanceId: "codex",
              inheritedOptions: [{ id: "reasoningEffort", value: base.codex.reasoning.effort }],
            }
          : {}),
      }
    : value;

/** ToolSearch: `select:a,b` loads those tools. Other queries load tools whose name has a word. */
const searchTools = (base: Base, query: string, max: number) => {
  if (query.startsWith("select:")) {
    const wanted = query.slice("select:".length).split(",");
    return base.deferred.filter((tool) =>
      wanted.some((name) => [tool.name, normalizeToolName(tool.name)].includes(name.trim())),
    );
  }
  const words = query
    .toLowerCase()
    .split(/[\s+]+/)
    .filter(Boolean);
  const hits = (tool: ApiTool) => words.filter((word) => tool.name.toLowerCase().includes(word));
  const found = base.deferred.filter((tool) => hits(tool).length > 0);
  return found.toSorted((a, b) => hits(b).length - hits(a).length).slice(0, max);
};

/** Tools that act on the branch's PR when no number is passed. */
const BRANCH_PULL_REQUEST_TOOLS = new Set([
  "pull_request_read",
  "pull_request_update",
  "pull_request_respond",
  "pull_request_review",
  "pull_request_merge",
  "ci_logs",
  "ci_rerun",
]);
const BRANCH_HAS_NO_PR_ERROR =
  "This thread's branch has no known PR. Pass number, or open one with pull_request_create.";

const SUBAGENT_WATCH_ERROR =
  "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";

/** Result for a native tool the case does not mock, other than shell, file, and web tools. */
const nativeResult = (name: string, input: Readonly<Record<string, unknown>>) => {
  const skill = valueText(input.skill);
  const results: Readonly<Record<string, string>> = {
    Agent: "The agent finished. Summary: the task is done and nothing else needs attention.",
    Skill: `Launching skill: ${skill}\n\nBase directory for this skill: ~/.claude/skills/${skill}\n\nThis skill adds no steps for this task. Do it with your usual tools.`,
    WebSearch: "No results found.",
  };
  return results[name] ?? "OK";
};

const SHELL_PROMPT = `You play the computer a coding agent works on. You get a description of the machine, the agent's tool calls so far with their outputs, and one new call. Reply in JSON. In "facts", note briefly what the output must agree with. In "output", put only the call's output, exactly as the tool prints it: no notes, headings, code fences, or corrections. The agent sees "output" unchanged.

- Bash: what the command prints in a real terminal (git, gh, ls, cat, grep, package managers). If it fails, start with "Exit code N", then the error. If it prints nothing, reply "(Bash completed with no output)".
- Read: the file with numbered lines, like \`cat -n\`. Write: "File created successfully at: <path>". Edit: "The file <path> has been updated successfully." Edit may instead supply a Codex apply_patch patch; apply its additions, deletions and hunks. A missing file, or an Edit whose old_string is not in the file: "<tool_use_error>reason</tool_use_error>".
- WebFetch: the page's text.

Stay consistent with the machine and with earlier outputs: edits, commits, pushes, and new PRs show in later output. Where the description is silent, invent plausible small details that fit it (file contents, SHAs, test names) rather than printing nothing. Commands succeed unless the description says otherwise, including git push, gh pr create, installs, builds, and tests. A new PR gets the next number after the highest one in the description or the history, or 124 if there is none.`;

const ShellReply = Schema.Struct({ facts: Schema.String, output: Schema.String });
const SHELL_REPLY_SCHEMA = {
  ...Schema.toJsonSchemaDocument(ShellReply).schema,
  additionalProperties: false,
};
const decodeShellReply = Schema.decodeUnknownOption(Schema.fromJsonString(ShellReply));

const callText = ({ tool, input }: Omit<ShellEntry, "output">) =>
  `<call>${tool} ${valueText(input)}</call>`;

/**
 * Absolute paths the case's context or files name exist, wherever the template's working
 * directory is. Without this the simulator denies a checkout the agent was told to work in.
 */
export const namedPathsLine = ({ setup }: McpToolUseCase) => {
  const absolute = /(?:^|[\s(`'"])((?:\/home|\/Users|\/tmp)\/[^\s`'",;:)]+)/g;
  const fromContext = [...(setup.context ?? "").matchAll(absolute)].flatMap(([, path]) =>
    path ? [path] : [],
  );
  const fromFiles = Object.keys(isRecord(setup.world?.files) ? setup.world.files : {}).filter(
    (path) => path.startsWith("/"),
  );
  const paths = [
    ...new Set([...fromContext, ...fromFiles].map((path) => path.replace(/[.]+$/, ""))),
  ];
  return paths.length > 0
    ? [
        `These paths exist on this machine, with the contents the world gives: ${paths.join(", ")}. The working directory above is only where the shell starts; the agent may cd into them.`,
      ]
    : [];
};

/** The simulator's request: the machine, this sample's earlier calls, then the new call. */
export const shellRequest = (sample: Sample, call: Omit<ShellEntry, "output">, model: string) => {
  const { testCase, base, repo, shell, devices } = sample;
  const { world, context, shellMocks = [] } = testCase.setup;
  const { cwd, platform, date } = base.environment;
  const command = call.tool === "Bash" && isRecord(call.input) ? call.input.command : undefined;
  const machine = [
    `Working directory: ${cwd} on ${platform}, a git checkout of github.com/${repo}.${date ? ` Today is ${date}.` : ""}`,
    gitStatus(testCase),
    `World: ${valueText(world ?? {})}`,
    ...(shellMocks.length > 0
      ? [`Commands that match these regexes print exactly this output: ${valueText(shellMocks)}`]
      : []),
    // Which device each launcher and session drives, and which of this call's opens are refused.
    ...(devices?.describe(shell, typeof command === "string" ? command : undefined) ?? []),
    ...(world?.deviceInvalidCapture
      ? [
          "T3's device_screenshot gets each capture as a PNG whose header says 0×0, so it reports 0×0. agent-device's own screenshot is unaffected.",
        ]
      : []),
    ...(sample.secretFiles.length > 0
      ? [
          `T3's request_secret saved these files in this sample: ${sample.secretFiles.join(", ")}. Each exists, is readable only by the user, and holds exactly the value the user gave, typed into T3's private card or pasted in chat and saved by the agent, the right one for the task, with no trailing newline. A program that reads it, as in "$(cat <file>)", < <file> or a --*-file flag, gets that value. What appears in the output is whatever that program prints: one that prints or logs its input shows the value. No other file in that directory exists.`,
        ]
      : []),
    ...(sample.forgeChanges.length > 0
      ? [
          `The agent made these changes through T3's tools; gh, git fetch and the host show them: ${sample.forgeChanges.join("; ")}`,
        ]
      : []),
    ...(context ? [`The agent was told: ${context}`] : []),
    `The agent's task: ${testCase.prompt}`,
    ...namedPathsLine(testCase),
  ];
  const history = shell.map((entry) => `${callText(entry)}\n<output>\n${entry.output}\n</output>`);
  return {
    model,
    max_tokens: 8_000,
    // The "facts" field keeps the simulator's reasoning out of the output the agent sees.
    output_config: { effort: "low", format: { type: "json_schema", schema: SHELL_REPLY_SCHEMA } },
    // A case with devices also gets agent-device's own CLI, so T3's launchers answer as it does.
    system: devices ? `${SHELL_PROMPT}\n\n${AGENT_DEVICE_SHELL}` : SHELL_PROMPT,
    messages: [
      {
        role: "user",
        content: [machine, [...history, `New call:\n${callText(call)}`]].map((part) =>
          text(part.join("\n\n")),
        ),
      },
    ],
  };
};

/** The same simulator request in Responses form, for a GPT shell model through the proxy. */
export const shellResponsesRequest = (body: ReturnType<typeof shellRequest>) => ({
  model: body.model,
  stream: true,
  store: false,
  reasoning: { effort: "low" },
  instructions: body.system,
  text: {
    format: { type: "json_schema", name: "shell_reply", schema: SHELL_REPLY_SCHEMA, strict: true },
  },
  input: body.messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => ({ type: "input_text", text: block.text })),
  })),
});

/** The tool output in the simulator's JSON reply, or its raw text if that is not JSON. */
export const shellOutput = (content: ReadonlyArray<Block>) => {
  const reply = content.flatMap((block) => (isText(block) ? [block.text] : [])).join("");
  return Option.match(decodeShellReply(reply), {
    onNone: () => reply.trim(),
    onSome: ({ output }) => output.trim(),
  });
};

/** A shell mock's output, when the command is one simple command that the mock matches. */
export const mockOutput = (sample: Sample, command: string) =>
  /&&|\|\||[;|\n]/.test(command.trim())
    ? undefined
    : sample.testCase.setup.shellMocks?.find((mock) => new RegExp(mock.match).test(command))
        ?.output;

type Config = {
  readonly apiKey: string;
  readonly model: Model;
  readonly proxy?: { readonly url: string; readonly headers: Readonly<Record<string, string>> };
  /** An Anthropic-compatible gateway from `ANTHROPIC_BASE_URL`, used when there is no API key. */
  readonly anthropic?: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly effort: string;
  readonly maxSteps: number;
  readonly shellModel: ShellModel;
  /** `--harness app-server`: GPT models run in `codex app-server` as Kin runs them (`providers/codex.ts`). */
  readonly appServer?: AppServer;
};

/**
 * Output for a command that needs no simulator: a matching shell mock, else, for a plain command
 * on a launcher T3 returned, agent-device's help or its error for a session not yet started.
 */
export const cannedOutput = (sample: Sample, command: string) =>
  mockOutput(sample, command) ??
  launcherHelp(sample.devices?.launchers ?? [], command) ??
  sample.devices?.sessionError(sample.shell, command);

/** Output for a shell, file, or web tool: canned output, else the shell simulator. */
const simulate = Effect.fn("evaluateMcpToolUse.simulate")(function* (
  sample: Sample,
  config: Config,
  call: Omit<ShellEntry, "output">,
) {
  const command = call.tool === "Bash" && isRecord(call.input) ? call.input.command : undefined;
  let output = typeof command === "string" ? cannedOutput(sample, command) : undefined;
  if (output === undefined) {
    const body = shellRequest(sample, call, config.shellModel);
    const response = isPricedModel(config.shellModel)
      ? yield* callModel(
          config.apiKey,
          body,
          config.apiKey ? undefined : (config.anthropic ?? config.proxy),
        )
      : yield* callCodex(config, shellResponsesRequest(body));
    addUsage(sample.shellUsage, response.usage);
    output = shellOutput(response.content);
  }
  if (call.tool === "Bash" && output === "") output = "(Bash completed with no output)";
  const entry = { ...call, output };
  sample.shell.push(entry);
  for (const url of createdPullRequests(entry)) sample.linked.add(url);
  sample.openedPullRequest ??= branchPullRequestCreatedBy(
    entry,
    sample.testCase.setup.world?.branch,
  );
  return output;
});

/** Tells the shell simulator about a file request_secret saved, so it exists for later commands. */
const savedSecretFile = (sample: Sample, result: unknown) => {
  if (isRecord(result) && typeof result.file === "string") sample.secretFiles.push(result.file);
};

// Tools whose card or reaction answers the person in the chat, as Kin's own message would.
const ANSWERS_IN_CHAT = new Set([
  "kin_ask",
  "kin_chart",
  "kin_visual",
  "kin_react",
  "kin_connection_call",
  "kin_connection_offer",
  "kin_document",
  "kin_issue",
  "kin_receipt",
  "list_define",
  "company_profile",
  "statement_read",
  "doc_create",
  "doc_edit",
  "doc_rewrite",
]);
// Cards that show a chart, visual or file: Kin asks once for a line saying what it is. A doc
// tool shows its doc as a card only when asked to (`card`); otherwise it posts nothing.
const SHOWS_ONLY = new Set(["kin_chart", "kin_visual", "kin_document", "kin_issue", "kin_receipt"]);
const DOC_TOOLS = new Set(["doc_create", "doc_edit", "doc_rewrite"]);
/**
 * Every teammate message of the turn passed on by kin_hand_off (its mocked results, in call
 * order): Kin's own line in the chat answers each, so the turn owes no words (`answered`).
 */
const passedOnEach = (
  testCase: Sample["testCase"],
  used: ReadonlyArray<{ readonly tool: string }>,
) => {
  if (!testCase.prompt.includes("your direct chat with a teammate")) return false;
  const asked = testCase.prompt.match(/BEGIN QUOTE: member human message/g)?.length ?? 0;
  const mock = testCase.setup.mocks?.kin_hand_off;
  const results = isRecord(mock) && Array.isArray(mock.$sequence) ? mock.$sequence : [mock];
  const passed = used
    .filter((one) => one.tool === "kin_hand_off")
    .filter((_, n) => {
      const result: unknown = results[Math.min(n, results.length - 1)];
      return isRecord(result) && result.passed === true;
    });
  return asked > 0 && passed.length >= asked;
};
/**
 * What Kin asks a lead whose finished turn left a person's message without words
 * (KinReplyBridge `complete`): the rescue prompt, the caption prompt when its only answer was a
 * chart, visual or file, or undefined when the turn answered.
 */
export const rescuePrompt = (sample: Pick<Sample, "testCase" | "responses">) => {
  if (sample.testCase.setup.world?.kinLead !== true) return undefined;
  if (
    !/BEGIN QUOTE: (?:owner|co-owner|member human|guest human) message/.test(sample.testCase.prompt)
  )
    return undefined;
  if (postsText(sample.responses)) return undefined;
  const used = sample.responses
    .flat()
    .filter(isToolUse)
    .map((block) => ({
      tool: normalizeToolName(block.name),
      card: isRecord(block.input) && block.input.card === true,
    }));
  if (passedOnEach(sample.testCase, used)) return undefined;
  const shows = ({ tool, card }: (typeof used)[number]) =>
    SHOWS_ONLY.has(tool) || (DOC_TOOLS.has(tool) && card);
  if (used.some((one) => ANSWERS_IN_CHAT.has(one.tool) && !DOC_TOOLS.has(one.tool) && !shows(one)))
    return undefined;
  return used.some(shows) ? CAPTION_PROMPT : RESCUE_PROMPT;
};

/** The result for one tool call. */
const FORGE_WRITE_TOOLS = new Set([
  "pull_request_create",
  "pull_request_update",
  "pull_request_respond",
  "pull_request_review",
  "pull_request_merge",
  "ci_rerun",
]);

const recordForgeChange = (
  sample: Sample,
  name: string,
  input: Readonly<Record<string, unknown>>,
  result: unknown,
) => {
  if (FORGE_WRITE_TOOLS.has(name)) {
    sample.forgeChanges.push(`${name} ${valueText(input)} returned ${valueText(result)}`);
  }
};

export const answerToolCall = Effect.fn("evaluateMcpToolUse.answerToolCall")(function* (
  sample: Sample,
  config: Config,
  call: typeof ToolUse.Type,
) {
  const { testCase, base, tools } = sample;
  let name = normalizeToolName(call.name);
  let input = isRecord(call.input) ? call.input : {};
  if (call.name === "web__run") {
    const open = Array.isArray(input.open) ? input.open[0] : undefined;
    const search = Array.isArray(input.search_query) ? input.search_query[0] : undefined;
    name = open ? "WebFetch" : "WebSearch";
    input = isRecord(open)
      ? { url: open.ref_id, prompt: "Return the page content." }
      : isRecord(search)
        ? { query: search.q }
        : input;
  }
  const failed = (error: string): Block => ({ ...toolResult(call.id, error), is_error: true });
  if (!base.codex && !hasTool(tools, call.name)) {
    const error = `InputValidationError: ${call.name} is deferred. Load it with ToolSearch first.`;
    return failed(`<tool_use_error>${error}</tool_use_error>`);
  }
  if (name === "ToolSearch") {
    const max = typeof input.max_results === "number" ? input.max_results : 5;
    const found = searchTools(base, valueText(input.query), max);
    if (found.length === 0) return toolResult(call.id, "No matching deferred tools found");
    return loadTools(tools, call.id, found);
  }
  // T3 refuses a page call without exactly one source before any mocked result.
  const sources = [input.html, input.path].filter(
    (source) => source !== undefined && source !== null,
  );
  if (isPageTool(name) && (sources.length !== 1 || typeof sources[0] !== "string")) {
    return failed("Pass exactly one of html or path.");
  }
  if (isPageTool(name) && typeof input.path === "string" && !input.path.startsWith("/")) {
    return failed(`${input.path} is not a readable HTML document. Pass an absolute path.`);
  }
  const mock = nextMock(sample, name, testCase.setup.mocks?.[name]);
  if (isRecord(mock) && mock.$error !== undefined) return failed(valueText(mock.$error));
  if (isT3Name(call.name) && PREVIEW_TOOLS.has(name)) {
    if (testCase.setup.world?.browserAgentAccess === false)
      return failed(
        new PreviewAutomationUnavailableError({
          capability: "preview",
          environmentId: EVAL_ENVIRONMENT_ID,
        }).message,
      );
    const previewError = previewFailure(mock);
    if (previewError !== undefined) return failed(previewError.message);
  }
  // T3 answers device calls from the world. A mock that is a T3 device error fails inside T3.
  const failure = deviceFailure(mock);
  const fromWorld = mock === undefined || mock === "default" || failure !== undefined;
  if (sample.devices && isT3Name(call.name) && isDeviceTool(name) && fromWorld) {
    const result = yield* sample.devices.call(name, input, failure);
    return result.isError ? failed(result.text) : toolResult(call.id, result.text);
  }
  if (sample.backgroundWait && isT3Name(call.name) && name === "t3_background_wait" && fromWorld) {
    const result = yield* sample.backgroundWait(input);
    return result.isError ? failed(result.text) : toolResult(call.id, result.text);
  }
  // A pasted secret is saved without a card, so a mocked card outcome does not apply.
  if (mock !== undefined && mock !== "default" && !pastedSecret(name, input)) {
    if (name === "request_secret") savedSecretFile(sample, mock);
    if (name === "pull_request_create" && isRecord(mock) && typeof mock.url === "string") {
      sample.linked.add(mock.url);
      const number = Number(mock.number);
      if (number > 0) sample.openedPullRequest = number;
    }
    recordForgeChange(sample, name, input, mock);
    return toolResult(
      call.id,
      name === "orchestrator_capabilities"
        ? capabilities(sample, mock)
        : withProductFields(name, mock, testCase.setup.role === "delegated-child"),
    );
  }
  if (isT3Name(call.name)) {
    // T3 refuses a watch from a delegated child.
    if (name === "watch_pull_request" && testCase.setup.role === "delegated-child") {
      return failed(SUBAGENT_WATCH_ERROR);
    }
    if (BRANCH_PULL_REQUEST_TOOLS.has(name) && input.number === undefined) {
      // Until the agent opens it, the PR a create would open does not exist.
      if (branchPullRequest(sample).created) return failed(BRANCH_HAS_NO_PR_ERROR);
    }
    if (name === "ci_logs" || name === "ci_rerun") {
      const { all, checks, named } = selectedWorldChecks(sample, input);
      if (named !== null && checks.length === 0) {
        const names = all.map((check) => valueText(check.name)).join(", ") || "none";
        return failed(`No check is named ${valueText(input.check)}. Checks: ${names}.`);
      }
    }
    const value = t3Default(sample, name, input);
    if (name === "request_secret") savedSecretFile(sample, value);
    recordForgeChange(sample, name, input, value);
    return toolResult(
      call.id,
      name === "orchestrator_capabilities"
        ? capabilities(sample, value)
        : withProductFields(name, value, testCase.setup.role === "delegated-child"),
    );
  }
  if (call.name === "clock__curr_time")
    return toolResult(call.id, {
      current_time: `${base.environment.date ?? "2026-01-01"} 12:00:00 UTC`,
    });
  if (!SHELL_TOOLS.has(name)) return toolResult(call.id, nativeResult(name, input));
  const output = yield* simulate(sample, config, { tool: name, input });
  // Claude Code marks a failed command or file call as an error.
  return /^(Exit code [1-9]|<tool_use_error>)/.test(output)
    ? failed(output)
    : toolResult(call.id, output);
});

/** GPT models write ’ ‘ “ ” where cases write ' and ": text is matched with them made plain. */
const plainQuotes = (text: string) => text.replaceAll(/[‘’]/g, "'").replaceAll(/[“”]/g, '"');
const matchesPattern = (pattern: string, value: string) =>
  new RegExp(plainQuotes(pattern)).test(plainQuotes(value));

const BOUND = /^([<>]=)(-?\d+(?:\.\d+)?)$/;
/**
 * Partial match: `~text` is a case-insensitive substring, `<=N` / `>=N` bound a number, and `null`
 * matches a missing or null value.
 */
const matches = (expected: unknown, actual: unknown): boolean => {
  if (expected === null) return actual === undefined || actual === null;
  const bound = typeof expected === "string" ? BOUND.exec(expected) : null;
  if (bound !== null) {
    const limit = Number(bound[2]);
    return typeof actual === "number" && (bound[1] === "<=" ? actual <= limit : actual >= limit);
  }
  // A bare "~" asks only that the field is there.
  if (expected === "~") return actual !== undefined && actual !== null && actual !== "";
  if (typeof expected === "string" && expected.startsWith("~")) {
    return plainQuotes(valueText(actual))
      .toLowerCase()
      .includes(plainQuotes(expected.slice(1)).toLowerCase());
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && expected.every((item) => actual.some((at) => matches(item, at)))
    );
  }
  if (!isRecord(expected)) return expected === actual;
  const at = (path: string) =>
    path
      .split(".")
      .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), actual);
  return Object.entries(expected).every(([path, value]) => matches(value, at(path)));
};

/** Each new top-level thread request in a run; a failed call created nothing. */
const newThreadRequests = (calls: ReadonlyArray<Call>) =>
  calls.flatMap((call): ReadonlyArray<{ request: unknown; brief: unknown }> => {
    if (call.failed === true || !isRecord(call.input)) return [];
    if (call.tool === "t3_thread_launch")
      return [{ request: call.input, brief: call.input.message }];
    if (call.tool !== "create_threads" || !Array.isArray(call.input.threads)) return [];
    return call.input.threads.map((request: unknown) => ({
      request,
      brief: isRecord(request) ? request.prompt : undefined,
    }));
  });

/** Whether every expected value can take a different request it matches. */
const matchesDistinct = (
  expected: ReadonlyArray<unknown>,
  requests: ReturnType<typeof newThreadRequests>,
  taken: ReadonlySet<number> = new Set(),
): boolean => {
  const [first, ...rest] = expected;
  if (expected.length === 0) return true;
  return requests.some(
    ({ request, brief }, i) =>
      !taken.has(i) &&
      matches(first, typeof first === "string" ? brief : request) &&
      matchesDistinct(rest, requests, new Set([...taken, i])),
  );
};

/** delegate_task takes `target.options` as an object or `[{id, value}]`. Grade both as an object. */
const withOptionsObject = (input: unknown) => {
  if (!isRecord(input) || !isRecord(input.target) || !Array.isArray(input.target.options)) {
    return input;
  }
  const options = Object.fromEntries(
    input.target.options.flatMap((option) =>
      isRecord(option) ? [[valueText(option.id), option.value]] : [],
    ),
  );
  return { ...input, target: { ...input.target, options } };
};

/** What the user wrote in the case's thread: its context, prior user turns and the prompt. */
/** `world.files` keys: paths relative to the thread cwd, or absolute. */
export const worldFilePaths = ({ setup }: Pick<McpToolUseCase, "setup">) =>
  Object.keys(isRecord(setup.world?.files) ? setup.world.files : {});

export const pastedText = ({ prompt, setup }: Pick<McpToolUseCase, "prompt" | "setup">) =>
  [
    setup.context ?? "",
    ...(setup.priorTurns ?? []).flatMap((turn) => (turn.role === "user" ? [turn.text ?? ""] : [])),
    prompt,
  ].join("\n");

const isPageTool = (tool: string) => tool === "html_preview" || tool === "html_render";

/** `page` is the HTML a page tool shows: its inline `html`, or the file the agent wrote at `path`. */
const withPage = (tool: string, input: unknown, files: ReadonlyMap<string, string>) => {
  if (!isPageTool(tool) || !isRecord(input)) return input;
  const path = valueText(input.path);
  // A patch may name the file relative to the agent's working directory. When written files that
  // could be this one differ, the page is unknown, so page checks fail rather than grade a stale copy.
  const written = [...files].filter(
    ([file]) =>
      file === path ||
      (!file.startsWith("/") && path.endsWith(`/${file.replace(/^(?:\.\/)+/, "")}`)),
  );
  const pages = new Set(written.map(([, page]) => page));
  const page =
    typeof input.html === "string"
      ? input.html
      : pages.size === 1 && !pages.has(UNKNOWN_SCRIPT)
        ? written[0]![1]
        : undefined;
  // The grader derives `page`; a call cannot supply its own.
  return { ...input, page };
};

/** `pasted` is the thread's user text (`pastedText`), for request_secret's `value`. */
export const gradeSample = (
  expect: McpToolUseCase["expect"],
  run: SampleRun,
  pasted = "",
  worldFiles: ReadonlyArray<string> = [],
) => {
  const checks: Array<Check> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const written = scriptsBefore(run.calls, true);
  // A refused page call showed nothing, so it neither previews nor renders, and no file stands in
  // for its page. Inline HTML it sent still counts against callsMustNot.
  const attempted = run.calls.map((call, index) => ({
    ...call,
    input: withPage(
      call.tool,
      withOptionsObject(call.input),
      call.failed ? new Map() : written[index]!,
    ),
  }));
  const calls = attempted.filter((call) => !(call.failed && isPageTool(call.tool)));
  // `tool` may list alternatives, as in "link_pull_request|watch_pull_request"; counts add up.
  const count = (tool: string) =>
    calls.filter((call) => tool.split("|").includes(call.tool)).length;
  const found = ({ tool, args = {}, argsAnyOf, success }: McpToolUseCall, among = calls) =>
    among.some(
      (call) =>
        tool.split("|").includes(call.tool) &&
        (success === undefined || call.failed === false) &&
        matches(args, call.input) &&
        (argsAnyOf === undefined ||
          argsAnyOf.some((alternative) => matches(alternative, call.input))),
    );
  const label = ({ tool, args }: McpToolUseCall) => (args ? `${tool} ${valueText(args)}` : tool);
  for (const call of expect.calls ?? []) add(`calls ${label(call)}`, found(call));
  if (expect.distinctCalls !== undefined) {
    const expected = expect.distinctCalls.map(({ tool, args }) => ({ tool, input: args ?? {} }));
    add(
      "distinctCalls",
      calls.every((call) => expected.filter((entry) => matches(entry, call)).length <= 1) &&
        matchesDistinct(
          expected,
          calls.map((request) => ({ request, brief: "" })),
        ),
    );
  }
  for (const call of expect.callsMustNot ?? [])
    add(`callsMustNot ${label(call)}`, !found(call, attempted));
  // A page check must not pass because the grader never saw the file a path call shows.
  const pageTools = [...(expect.calls ?? []), ...(expect.callsMustNot ?? [])].flatMap((call) =>
    call.args?.page === undefined ? [] : call.tool.split("|"),
  );
  for (const call of calls)
    if (
      pageTools.includes(call.tool) &&
      isRecord(call.input) &&
      call.input.path !== undefined &&
      call.input.page === undefined
    )
      add(`page known ${call.tool} ${valueText(call.input.path)}`, false);
  for (const tool of expect.notCalls ?? [])
    add(`notCalls ${tool}`, !attempted.some((call) => call.tool === tool));
  if (expect.order !== undefined) {
    const firsts = expect.order.map((tool) => calls.findIndex((call) => call.tool === tool));
    const inOrder = firsts.every((at, i) => at > (firsts[i - 1] ?? -1));
    add(`order ${expect.order.join(" > ")}`, inOrder);
  }
  for (const [t, n] of Object.entries(expect.minCalls ?? {}))
    add(`minCalls ${t} >= ${n}`, count(t) >= n);
  for (const [t, n] of Object.entries(expect.maxCalls ?? {}))
    add(`maxCalls ${t} <= ${n}`, count(t) <= n);
  if (expect.newThreads !== undefined) {
    const requests = newThreadRequests(calls);
    add(
      `newThreads ${valueText(expect.newThreads)}`,
      requests.length === expect.newThreads.length && matchesDistinct(expect.newThreads, requests),
    );
  }
  if (expect.endsTurnAfter !== undefined) {
    const lastStep = Math.max(-1, ...calls.map((call) => call.step));
    const last = calls.filter((call) => call.step === lastStep).map((call) => call.tool);
    const ended = run.stopReason === "end_turn" && last.includes(expect.endsTurnAfter);
    add(`endsTurnAfter ${expect.endsTurnAfter}`, ended);
  }
  // Bash and Monitor both take a shell `command`. Shell checks also read, one by one, the scripts
  // the agent wrote and a command ran: `node run.mjs signup.mjs` after a Write of signup.mjs.
  const sources = scriptSources(calls);
  const shell = calls.flatMap((call, i) =>
    isRecord(call.input) && typeof call.input.command === "string"
      ? [call.input.command, ...(sources[i] ?? [])]
      : [],
  );
  const test = matchesPattern;
  for (const p of expect.shellMustNot ?? [])
    add(`shellMustNot /${p}/`, !shell.some((c) => test(p, c)));
  // A positive check also reads argv lists as command lines: spawnSync('pnpm', ['exec', …]).
  for (const p of expect.shellMust ?? [])
    add(
      `shellMust /${p}/`,
      shell.some((c) => test(p, c) || test(p, argvForm(c))),
    );
  // A Kin card's question is posted to the chat and stands for the turn's message, so it counts.
  const shown = [
    run.text,
    ...calls.flatMap((call) =>
      call.tool === "kin_ask" && isRecord(call.input) && typeof call.input.question === "string"
        ? [call.input.question]
        : [],
    ),
  ].join("\n\n");
  for (const p of expect.textMust ?? []) add(`textMust /${p}/`, test(p, shown));
  for (const p of expect.textMustNot ?? []) add(`textMustNot /${p}/`, !test(p, run.text));
  checks.push(...limitChecks(expect.limits, run.text));
  for (const p of expect.finalTextMust ?? [])
    add(`finalTextMust /${p}/`, run.stopReason === "end_turn" && test(p, run.finalText ?? ""));
  const isLinked = (url: string) => (run.linked ?? []).some((at) => matches(url, at));
  for (const url of expect.linked ?? []) add(`linked ${url}`, isLinked(url));
  if (expect.linkedNumbers !== undefined) {
    const numbers = (run.linked ?? []).map((url) => Number(/(\d+)\/?$/.exec(url)?.[1]));
    const exact = valueText(numbers.toSorted((a, b) => a - b));
    add("linkedNumbers", exact === valueText(expect.linkedNumbers.toSorted((a, b) => a - b)));
  }
  checks.push(...gradeDevice(expect.device, run));
  checks.push(
    ...gradeFileLinks(
      expect.fileLinks,
      run.stopReason === "end_turn" ? run.finalText : undefined,
      run.cwd,
      worldFiles,
    ),
  );
  checks.push(...gradeSecret(expect.secret, run, pasted));
  return checks;
};

// Checks that can only go from pass to fail as a sample goes on.
const SETTLED =
  /^(?:(?:notCalls|callsMustNot|shellMustNot|maxCalls|textMustNot|limits) |secret\.(?:chatAsk|askTools|values|fileUse|noCardDemand|afterDecline) )/;
/** True once the sample has failed for good, so the rest of it cannot change the result. */
export const failedEarly = (expect: McpToolUseCase["expect"], run: SampleRun, pasted = "") =>
  gradeSample(
    expect,
    // A page call T3 has not answered yet may still be refused, so it is graded once it settles.
    {
      ...run,
      calls: run.calls.filter((call) => !isPageTool(call.tool) || call.failed !== undefined),
    },
    pasted,
  ).some((check) => !check.pass && SETTLED.test(check.check));

const requestBody = (
  { base, tools }: Sample,
  effort: string,
  messages: unknown,
  gateway = false,
) => ({
  model: base.model,
  max_tokens: 16_000,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort },
  // The Anthropic gateway marks the last message for a 1h cache itself and rejects a second mark.
  ...(gateway ? {} : { cache_control: { type: "ephemeral" } }),
  // Like Claude Code, cache the shared system prompt so every sample reuses it.
  system: base.system.map((block, i) =>
    i === base.system.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block,
  ),
  tools,
  messages,
});

const codexRequest = (base: Base, input: ReadonlyArray<Block>) => ({
  model: base.model,
  stream: true,
  store: false,
  parallel_tool_calls: true,
  reasoning: base.codex?.reasoning,
  instructions: base.codex?.instructions,
  text: base.codex?.text,
  tool_choice: base.codex?.tool_choice,
  include: ["reasoning.encrypted_content"],
  input: [...(base.codex?.input ?? []), ...input],
});

/** The bridge only accepts serialized data. Model code never receives host objects/functions. */
export const executeCodex = async (
  code: string,
  catalog: ReadonlyArray<{ name: string; description: string }>,
  answer: (name: string, input: unknown) => Promise<unknown>,
  saved: Record<string, unknown> = {},
) => {
  const pending: Array<{ name: string; input: string; resolve: (value: string) => void }> = [];
  const bridge = Object.setPrototypeOf(
    (name: string, input: string, resolve: (value: string) => void) =>
      pending.push({ name, input, resolve }),
    null,
  );
  const context = NodeVM.createContext(
    { __bridge: bridge, __catalog: JSON.stringify(catalog), __storeJson: JSON.stringify(saved) },
    { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" },
  );
  const run = (source: string) => NodeVM.runInContext(source, context, { timeout: 250 });
  run(`((bridge, catalog) => {
    delete globalThis.__bridge; delete globalThis.__catalog;
    globalThis.ALL_TOOLS = catalog;
    globalThis.tools = Object.fromEntries(catalog.map(({name}) => [name, (input) => new Promise(resolve => bridge(name, JSON.stringify(input ?? {}), value => resolve(JSON.parse(value))))]));
    globalThis.__output = []; globalThis.__done = false;
    globalThis.text = globalThis.notify = value => __output.push(typeof value === 'string' ? value : JSON.stringify(value));
    globalThis.__stored = JSON.parse(__storeJson); delete globalThis.__storeJson;
    globalThis.store = (k,v) => __stored[k] = v; globalThis.load = k => __stored[k];
  })(__bridge, JSON.parse(__catalog));
  (async () => { ${code}\n })().then(() => { __done = true; }, e => { text(String(e)); __done = true; });`);
  // Unawaited calls still run, as they do in Codex, so they are answered and graded too.
  for (let count = 0; !context.__done || pending.length > 0; count++) {
    if (count === 128) throw new Error("Code cell exceeded 128 tool calls.");
    const job = pending.shift();
    if (!job) throw new Error("Code cell stalled without a tool call.");
    const result = await answer(job.name, JSON.parse(job.input));
    context.__resolve = job.resolve;
    context.__result = JSON.stringify(result ?? null);
    run("__resolve(__result); delete globalThis.__resolve; delete globalThis.__result;");
  }
  Object.assign(saved, JSON.parse(run("JSON.stringify(__stored)")));
  return valueText(context.__output.join("\n"));
};

const codexCatalog = (base: Base) => [
  ...base.t3.map((tool) => ({
    name: tool.name.replace("mcp__t3-code__", "mcp__t3_code__"),
    description: `${valueText(tool.description)}\nInput JSON schema: ${JSON.stringify(tool.input_schema)}`,
  })),
  ...[
    ...valueText(base.nativeTools.find((tool) => tool.name === "exec")?.description).matchAll(
      /### `([^`]+)`/g,
    ),
  ].map((match) => ({ name: match[1]!, description: match[1]! })),
];

const CodexResponse = Schema.Struct({
  output: Schema.Array(AnyBlock),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    input_tokens_details: Schema.Struct({ cached_tokens: Schema.Number }),
  }),
});

const decodeCodexResponse = Schema.decodeUnknownEffect(CodexResponse);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const callCodex = Effect.fn("evaluateMcpToolUse.callCodex")(function* (
  config: Config,
  body: unknown,
) {
  const raw = yield* postModel("", body, config.proxy, true);
  const completed = raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .find((event) => event.type === "response.completed");
  if (!completed)
    return yield* Effect.die(new Error("Responses stream ended without response.completed."));
  const response = yield* decodeCodexResponse(completed.response);
  return {
    raw: response.output,
    content: response.output.flatMap((item): Array<Block> => {
      if (item.type === "message" && Array.isArray(item.content))
        return item.content.map((part: Block) => text(valueText(part.text)));
      if (item.type === "function_call" || item.type === "custom_tool_call")
        return [
          {
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input:
              item.type === "custom_tool_call" ? item.input : JSON.parse(valueText(item.arguments)),
          },
        ];
      return [];
    }),
    stop_reason: response.output.some(
      (item) => item.type.endsWith("tool_call") || item.type === "function_call",
    )
      ? "tool_use"
      : "end_turn",
    usage: {
      ...response.usage,
      input_tokens: response.usage.input_tokens - response.usage.input_tokens_details.cached_tokens,
      cache_read_input_tokens: response.usage.input_tokens_details.cached_tokens,
    },
  };
});

// Concurrent runs share an organization's rate limits. Backing off for up to about 4 minutes
// lets a sample wait out a busy spell, with jitter so samples do not retry in step.
const RETRY = Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("1 minute")]).pipe(
  Schedule.jittered,
);

const postModel = Effect.fn("evaluateMcpToolUse.postModel")(function* (
  apiKey: string,
  body: unknown,
  proxy?: Config["proxy"],
  responses = false,
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    // Anthropic answers 529 when it is overloaded; retryTransient already retries 429 and 5xx.
    HttpClient.filterStatus((status) => status !== 529),
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      while: (error) =>
        error.reason._tag === "StatusCodeError" && error.reason.response.status === 529,
      schedule: RETRY,
      times: 8,
    }),
  );
  const response = yield* HttpClientRequest.post(
    `${proxy?.url ?? "https://api.anthropic.com/v1"}/${responses ? "responses" : "messages"}`,
  ).pipe(
    HttpClientRequest.setHeaders({
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      "anthropic-version": "2023-06-01",
      // Claude Code sends this beta for `defer_loading` tools and `tool_reference` results.
      "anthropic-beta": "advanced-tool-use-2025-11-20",
      ...proxy?.headers,
    }),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  if (response.status !== 200) {
    const body = yield* response.text;
    return yield* Effect.die(new Error(`Model API ${response.status}: ${body}`));
  }
  return yield* response.text;
});
const callModel = (apiKey: string, body: unknown, proxy?: Config["proxy"]) =>
  postModel(apiKey, body, proxy).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ApiResponse))),
  );

/** The rubric's checks, answered by the shell model about the turn's visible reply and calls. */
const judged = Effect.fn("evaluateMcpToolUse.rubric")(function* (
  testCase: McpToolUseCase,
  sample: SampleRun,
  config: Config,
  usage: Usage,
) {
  const { rubric } = testCase.expect;
  if (rubric === undefined) return [];
  if (!isPricedModel(config.shellModel))
    return yield* Effect.die(new Error("A rubric needs a Claude shell model."));
  const turn = {
    text: sample.text,
    calls: sample.calls.map((call) => `${call.tool} ${valueText(call.input).slice(0, 600)}`),
  };
  const response = yield* callModel(
    config.apiKey,
    rubricRequest(
      config.shellModel,
      rubric.context === undefined ? rubric : { ...rubric, context: fillKinRules(rubric.context) },
      turn,
    ),
    config.apiKey ? undefined : (config.anthropic ?? config.proxy),
  );
  addUsage(usage, response.usage);
  return rubricChecks(rubric, response.content);
});

/** A tool call as graded. Claude Code runs an `Agent` in the background unless told otherwise. */
const recordedCall = (step: number, use: typeof ToolUse.Type): Call => {
  const tool = normalizeToolName(use.name);
  const input = normalizeToolInput(use.name, use.input);
  const claudeAgent = tool === "Agent" && !use.name.endsWith("spawn_agent") && isRecord(input);
  return {
    step,
    tool,
    input: claudeAgent ? { run_in_background: true, ...input } : input,
    id: use.id,
  };
};

/** Records on a call what the agent saw, so graders can count failed attempts. */
const settle = (call: Call | undefined, result: Block) => {
  if (call !== undefined) {
    call.failed = result.is_error === true;
    call.output = valueText(result.content);
  }
  return result;
};

/** Calls that ran. Claude Code rejects a deferred tool that was not loaded, so it never runs. */
/**
 * A Kin tool's event as Kin's tool gate fills it (`KinToolGate.turnEvents`): left out, the turn's
 * latest message, else its first event; a message id, that message's event.
 */
export const filledEvent = (testCase: McpToolUseCase, use: typeof ToolUse.Type) => {
  const name = normalizeToolName(use.name);
  if (testCase.setup.world?.kinLead !== true || !TURN_EVENT_TOOLS.has(name) || !isRecord(use.input))
    return use;
  const events = [
    ...testCase.prompt.matchAll(/"event":\s*"([^"]+)"(?:,\s*"message":\s*"([^"]+)")?/g),
  ].map((match) => ({ eventId: match[1]!, messageId: match[2] }));
  const given = use.input.sourceEventId;
  if (events.some((event) => event.eventId === given)) return use;
  const chosen =
    events.find((event) => event.messageId !== undefined && event.messageId === given) ??
    (given === undefined
      ? (events.findLast((event) => event.messageId !== undefined) ?? events[0])
      : undefined);
  return chosen === undefined
    ? use
    : { ...use, input: { ...use.input, sourceEventId: chosen.eventId } };
};

export const ranCalls = (
  { base, tools, testCase }: Sample,
  step: number,
  uses: ReadonlyArray<typeof ToolUse.Type>,
) =>
  uses
    .filter((use) => base.codex !== undefined || hasTool(tools, use.name))
    .map((use) => recordedCall(step, filledEvent(testCase, use)));

/**
 * Runs one sample until the model ends its turn, uses up its steps, or fails a check that no
 * later step can undo. Tokens add up in `spent`, so a sample that errors still reports them.
 */
const runSample = Effect.fn("evaluateMcpToolUse.runSample")(function* (
  testCase: McpToolUseCase,
  config: Config,
  base: Base,
  spent: { readonly usage: Usage; readonly shellUsage: Usage },
) {
  if (config.appServer !== undefined)
    return yield* runAppServerSample(testCase, config, config.appServer, base, spent);
  const sample = { ...makeSample(testCase, base), shellUsage: spent.shellUsage };
  yield* withDevices(sample);
  yield* withBackgroundWait(sample);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<HttpClient.HttpClient>());
  const messages = buildMessages(sample);
  const input = base.codex ? codexMessages(messages) : undefined;
  const transcript: Array<unknown> = [];
  const start = messages.length;
  const calls: Array<Call> = [];
  const responses = sample.responses;
  let shown = "";
  const { usage } = spent;
  let stopReason = "max_steps";
  let finalText = "";
  // Codex's code-mode cells take more model calls, so a case's own budget grows for it too.
  const extra = isCodex(config.model) ? 4 : 0;
  let maxSteps = testCase.maxSteps === undefined ? config.maxSteps : testCase.maxSteps + extra;
  // Kin's rescue: a finished lead turn that owed words and said none is asked once, as a new turn.
  let rescue: string | undefined;
  for (let step = 0; step < maxSteps; step++) {
    const response = input
      ? yield* callCodex(config, codexRequest(base, input))
      : yield* callModel(
          config.apiKey,
          requestBody(sample, config.effort, messages, config.anthropic !== undefined),
          config.anthropic,
        );
    addUsage(usage, response.usage);
    if ("raw" in response) {
      input?.push(...response.raw);
      transcript.push(...response.raw);
    }
    messages.push({ role: "assistant", content: response.content });
    responses.push(response.content);
    shown = shownText(responses);
    const texts = response.content.filter(isText).map((block) => block.text);
    const uses = response.content.filter(isToolUse);
    calls.push(...ranCalls(sample, step, uses));
    if (response.stop_reason !== "tool_use") {
      stopReason = response.stop_reason ?? "unknown";
      finalText = texts.join("\n\n");
      const asked = input || rescue !== undefined ? undefined : rescuePrompt(sample);
      if (asked === undefined) break;
      rescue = asked;
      messages.push({ role: "user", content: [text(asked)] });
      maxSteps = Math.max(maxSteps, step + 3);
      continue;
    }
    if (failedEarly(testCase.expect, { calls, text: shown, stopReason }, pastedText(testCase))) {
      stopReason = "failed_early";
      break;
    }
    const results = yield* Effect.forEach(uses, (use) =>
      Effect.gen(function* () {
        const own = calls.find((call) => call.id === use.id);
        if (!input) {
          return settle(own, yield* answerToolCall(sample, config, use));
        }
        const answer = (name: string, args: unknown, record = true) => {
          const tool = normalizeToolName(name);
          const normalized = normalizeToolInput(name, args);
          // A code cell's calls are recorded here; a direct function call already was.
          let recorded = own;
          if (record) {
            recorded = { step, tool, input: normalized };
            calls.push(recorded);
          }
          const call = { ...use, name, input: normalized };
          return answerToolCall(sample, config, call).pipe(
            Effect.map((result) => settle(recorded, result)),
            Effect.map((result) => {
              const output = valueText(result.content);
              if (isT3Name(name))
                return {
                  content: [text(output)],
                  ...(!result.is_error
                    ? { structuredContent: Option.getOrElse(decodeJson(output), () => output) }
                    : { isError: true }),
                };
              return tool === "Bash"
                ? {
                    output,
                    exit_code: /^Exit code [1-9]/.test(output) ? 1 : 0,
                    wall_time_seconds: 0,
                  }
                : output;
            }),
            runPromise,
          );
        };
        return yield* Effect.tryPromise({
          try: async () => {
            const output =
              use.name === "exec"
                ? await executeCodex(
                    valueText(use.input),
                    codexCatalog(base),
                    answer,
                    sample.codeStore,
                  )
                : await answer(use.name, use.input, false);
            const item = {
              type: use.name === "exec" ? "custom_tool_call_output" : "function_call_output",
              call_id: use.id,
              output: valueText(output),
            };
            input.push(item);
            transcript.push(item);
            return toolResult(use.id, output);
          },
          catch: (cause) => new EvalToolCallError({ tool: use.name, cause }),
        });
      }),
    );
    // Claude Code adds this text after a ToolSearch that loaded tools.
    const loaded = results.some((result) => Array.isArray(result.content));
    messages.push({ role: "user", content: [...results, ...(loaded ? [text(TOOL_LOADED)] : [])] });
    if (failedEarly(testCase.expect, { calls, text: shown, stopReason }, pastedText(testCase))) {
      stopReason = "failed_early";
      break;
    }
  }
  // The transcript (model turns and tool results) shows what the agent saw when a case fails.
  return {
    calls,
    text: shown,
    stopReason,
    finalText,
    ...(rescue === undefined ? {} : { rescue }),
    silent: rescuePrompt(sample) !== undefined,
    cwd: base.environment.cwd,
    linked: [...sample.linked],
    ...(sample.devices ? { launchers: [...sample.devices.launchers] } : {}),
    usage,
    shellUsage: sample.shellUsage,
    transcript: input ? transcript : messages.slice(start),
  };
}, Effect.scoped);

/** Earlier turns as Responses items; a tool call carries its namespace, as Codex records one. */
const responsesHistory = (messages: ReadonlyArray<ApiMessage>, namespace: string): Array<unknown> =>
  messages.flatMap((message) =>
    message.content.flatMap((block): Array<unknown> => {
      if (block.type === "tool_use")
        return [
          {
            type: "function_call",
            call_id: block.id,
            name: valueText(block.name).replace(T3_PREFIX, ""),
            namespace,
            arguments: JSON.stringify(block.input ?? {}),
          },
        ];
      if (block.type === "tool_result")
        return [
          {
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: valueText(block.content),
          },
        ];
      if (!isText(block)) return [];
      return [
        {
          type: "message",
          role: message.role,
          content: [
            { type: message.role === "user" ? "input_text" : "output_text", text: block.text },
          ],
        },
      ];
    }),
  );

const APP_SERVER_NAMESPACE = "t3_code";

/**
 * One sample in `codex app-server`, confined as Kin's Codex descriptor confines a Kin thread: Kin's
 * instructions as the base instructions, no environment, and the turn's T3 and Kin tools as dynamic
 * tools that the case's mocks answer. A Claude lead's ToolSearch list becomes Codex's deferred loading.
 */
const runAppServerSample = Effect.fn("evaluateMcpToolUse.runAppServerSample")(function* (
  testCase: McpToolUseCase,
  config: Config,
  server: AppServer,
  base: Base,
  spent: { readonly usage: Usage; readonly shellUsage: Usage },
) {
  const t3 = [...new Map(base.t3.map((tool) => [tool.name, tool])).values()];
  const sample: Sample = {
    ...makeSample(testCase, base),
    tools: t3,
    shellUsage: spent.shellUsage,
  };
  const messages = buildMessages(sample).map((message) => ({
    ...message,
    // Claude Code's reminders (its ToolSearch list) are its harness, not the case.
    content: message.content.filter((block) => !base.reminders.includes(block)),
  }));
  const last = messages.at(-1);
  if (testCase.prompt === "" || last?.role !== "user")
    return yield* Effect.die(new Error(`${testCase.id}: the app-server harness needs a prompt.`));
  const prompt = last.content
    .filter(isText)
    .map((block) => block.text)
    .join("\n\n");
  // As Kin's sessions decide (`kinDeferredTools`): a tool waits only where the model can look it up.
  const lookup = yield* Effect.promise(() => server.knowsModel(config.model));
  const deferred = new Set(lookup ? base.deferred.map((tool) => tool.name) : []);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<HttpClient.HttpClient>());
  const calls: Array<Call> = [];
  let step = 0;
  const ownerSession =
    testCase.setup.world?.kinSession === true &&
    !/\{\{(SHARED_TURN|GROUP_RULES)\}\}/.test(testCase.prompt);
  const result = yield* Effect.tryPromise({
    try: () =>
      server.runTurn({
        model: config.model,
        effort: config.effort,
        // An owner-only session's note says it has a shell, as Kin's does; the eval runs none, so
        // it keeps the session's web search and no sub-agents nobody here would answer.
        baseInstructions: kinInstructions(ownerSession ? "owner" : "confined", "codex"),
        config: ownerSession
          ? { ...FULL_SESSION_CONFIG, "agents.enabled": false }
          : CONFINED_CONFIG,
        namespace: APP_SERVER_NAMESPACE,
        tools: t3.map((tool) => ({
          name: tool.name.replace(T3_PREFIX, ""),
          description: valueText(tool.description),
          inputSchema: tool.input_schema,
          deferLoading: deferred.has(tool.name),
        })),
        history: responsesHistory(messages.slice(0, -1), APP_SERVER_NAMESPACE),
        prompt,
        maxToolCalls: Math.max(config.maxSteps, testCase.maxSteps ?? 0) * 3,
        onToolCall: (tool, args) => {
          const use = {
            type: "tool_use" as const,
            id: `call_${step}`,
            name: `${T3_PREFIX}${tool}`,
            input: args,
          };
          const [recorded] = ranCalls(sample, step++, [use]);
          if (recorded !== undefined) calls.push(recorded);
          return runPromise(
            answerToolCall(sample, config, filledEvent(testCase, use)).pipe(
              Effect.map((answer) => {
                settle(recorded, answer);
                return { text: valueText(answer.content), failed: answer.is_error === true };
              }),
            ),
          );
        },
      }),
    catch: (cause) => new EvalToolCallError({ tool: "app-server", cause }),
  });
  spent.usage.input += result.usage.input - result.usage.cached;
  spent.usage.cacheRead += result.usage.cached;
  spent.usage.output += result.usage.output;
  // The turn as the runner's other harnesses record it, so the graders read it the same way.
  const responses = result.events.map((event: AppServerEvent) =>
    event.type === "text"
      ? [text(event.text)]
      : [{ type: "tool_use", id: event.id, name: `${T3_PREFIX}${event.tool}`, input: event.args }],
  );
  sample.responses.push(...responses);
  const finals = result.events.flatMap((event) =>
    event.type === "text" && event.phase !== "commentary" ? [event.text] : [],
  );
  return {
    calls,
    text: shownText(responses),
    stopReason: result.stopReason,
    finalText: finals.at(-1) ?? "",
    silent: rescuePrompt(sample) !== undefined,
    linked: [...sample.linked],
    usage: spent.usage,
    shellUsage: sample.shellUsage,
    reasoningTokens: result.usage.reasoning,
    transcript: result.items,
  };
});

type ResultRow = Pick<McpToolUseCase, "id" | "kind" | "pattern"> & {
  readonly role: string;
  readonly pass: boolean;
  /** Passed, but some check only within margin. */
  readonly withinMargin?: boolean;
  /** `max_steps` when the step limit ended the turn. */
  readonly stopReason?: string;
  /** Set when the sample could not run to the end, even after retries. It is not graded. */
  readonly error?: string;
  readonly usage: Usage;
  readonly shellUsage: Usage;
  readonly latencyMs?: number;
};

/** The share of samples that passed. Samples that errored are left out: NaN if all did. */
const passRate = (
  rows: ReadonlyArray<{ readonly pass: boolean; readonly error?: string | undefined }>,
) => {
  const finished = rows.filter((row) => row.error === undefined);
  return finished.filter((row) => row.pass).length / finished.length;
};
const rowState = (row: { readonly pass: boolean; readonly withinMargin?: boolean | undefined }) =>
  row.withinMargin === true ? "margin" : row.pass ? "pass" : "fail";
/** A case's state from its finished samples. */
const rowsState = (
  rows: ReadonlyArray<{
    readonly pass: boolean;
    readonly withinMargin?: boolean | undefined;
    readonly error?: string | undefined;
  }>,
  margin: CaseMargin | undefined,
) => caseState(rows.filter((row) => row.error === undefined).map(rowState), margin);
const STATE_LABEL: Record<State, string> = {
  pass: "pass",
  margin: "pass within margin",
  fail: "FAIL",
};
const percent = (rate: number) => (Number.isNaN(rate) ? "-" : `${Math.round(rate * 100)}%`);
const groups = <A>(rows: ReadonlyArray<A>, key: (row: A) => string) =>
  [...Map.groupBy(rows, key)].toSorted(([left], [right]) => left.localeCompare(right));

const USAGE_KEYS = ["input", "output", "cacheWrite", "cacheRead"] as const;
/** Token totals and their cost in USD at one model's prices. Proxy shell models have no price. */
const spend = (usages: ReadonlyArray<Usage>, model: ShellModel | Model) => {
  const total = (key: keyof Usage) => usages.reduce((sum, usage) => sum + usage[key], 0);
  const prices = model in AGENT_PRICES ? AGENT_PRICES[model as keyof typeof AGENT_PRICES] : null;
  const price = (key: keyof Usage) => prices?.[key] ?? 0;
  const cost = USAGE_KEYS.reduce((sum, key) => sum + total(key) * price(key), 0) / 1e6;
  return { cost, tokens: USAGE_KEYS.map((key) => `${key} ${total(key)}`).join(", ") };
};

const caseKey = (row: ResultRow) => row.id;
const cutOff = (rows: ReadonlyArray<ResultRow>) =>
  rows.filter((row) => row.error === undefined && row.stopReason === "max_steps");
/** Each sample's wall time: the model's calls and the runner's tool answers, as one turn. */
const latencyLine = (rows: ReadonlyArray<ResultRow>) => {
  const times = rows.flatMap((row) => (row.latencyMs === undefined ? [] : [row.latencyMs]));
  if (times.length === 0) return [];
  const sorted = times.toSorted((a, b) => a - b);
  const at = (q: number) =>
    (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! / 1000).toFixed(1);
  return [`- Turn latency: median ${at(0.5)} s, p90 ${at(0.9)} s, over ${times.length} turns.`];
};
/** Markdown report. With a baseline, each case shows its earlier pass rate and the change. */
export const summarize = (
  rows: Array<ResultRow>,
  options: {
    readonly header: string;
    readonly shellModel: ShellModel;
    readonly model: Model;
    /** Cases' `margin` settings, by id. */
    readonly margins?: ReadonlyMap<string, CaseMargin>;
  },
  before?: Map<string, number>,
) => {
  const codex = isCodex(options.model);
  const agent = spend(
    rows.map((row) => row.usage),
    options.model,
  );
  const shell = spend(
    rows.map((row) => row.shellUsage),
    options.shellModel,
  );
  const cost = agent.cost + shell.cost;
  const byCase = groups(rows, (row) => row.id).map(
    ([id, members]) => [id, rowsState(members, options.margins?.get(id))] as const,
  );
  const states = new Map(byCase);
  const caseCount = (state: State) => byCase.filter(([, at]) => at === state).length;
  const sampleCount = (state: State) =>
    rows.filter((row) => row.error === undefined && rowState(row) === state).length;
  const table = (title: string, key: (row: ResultRow) => string, compare = false) => [
    `## ${title}\n`,
    compare ? "| Group | Pass | Baseline | Delta |" : "| Group | Pass |",
    compare ? "| --- | --- | --- | --- |" : "| --- | --- |",
    ...groups(rows, key).map(([group, members]) => {
      const now = passRate(members);
      const was = before?.get(group);
      const errored = members.filter((row) => row.error !== undefined).length;
      const delta =
        was === undefined
          ? "new | |"
          : `${percent(was)} | ${Number.isNaN(now) ? "" : `${Math.round((now - was) * 100)} pts`} |`;
      const margin = members.filter((row) => row.withinMargin === true).length;
      const state = key === caseKey ? states.get(group) : undefined;
      const cut = cutOff(members).length;
      const pass = `${percent(now)} of ${members.length - errored}${margin > 0 ? `, ${margin} within margin` : ""}${cut > 0 ? `, ${cut} cut off by the step limit` : ""}${errored > 0 ? `, ${errored} errored` : ""}${state === undefined ? "" : `: ${STATE_LABEL[state]}`}`;
      return `| ${group} | ${pass} |${compare ? ` ${delta}` : ""}`;
    }),
    "",
  ];
  const errors = groups(
    rows.filter((row) => row.error !== undefined),
    (row) => row.id,
  );
  const errorNote = `- Errored: ${errors.map(([id, failed]) => `${id} ×${failed.length}`).join(", ")}. These samples did not finish, even after retries, so pass rates leave them out; tokens they spent are counted.`;
  const nativeNote =
    "- native-subagent cases are approximate: the harness gives subagents their own system prompt, which this runner does not rebuild. T3's append is left out and its SubagentStart hook context added after the task.";
  const identityNote = `- The captured Claude Code identity line is replaced with "${NEUTRAL_IDENTITY}"`;
  const finished = rows.filter((row) => row.error === undefined).length;
  return [
    "# MCP tool-use eval\n",
    `- ${options.header}`,
    `- Pass: ${percent(passRate(rows))} of ${finished} samples (${sampleCount("pass")} pass, ${sampleCount("margin")} within margin, ${sampleCount("fail")} fail).`,
    `- Cases: ${caseCount("pass")} pass, ${caseCount("margin")} pass within margin, ${caseCount("fail")} fail.`,
    ...(errors.length > 0 ? [errorNote] : []),
    ...(cutOff(rows).length > 0
      ? [
          `- Cut off by the step limit: ${cutOff(rows).length} samples, ${cutOff(rows).filter((row) => !row.pass).length} graded fail. Each ended on max_steps before replying; read its calls to tell a turn that needed more steps from one that looped.`,
        ]
      : []),
    `- Estimated cost $${cost.toFixed(2)}, $${(cost / rows.length).toFixed(3)} per sample${codex ? ", at OpenAI's API prices; the run itself bills whatever provider the Codex config (`CODEX_HOME`) selects" : ""}.`,
    `- Agent tokens: ${agent.tokens} ($${agent.cost.toFixed(2)}).`,
    ...latencyLine(rows),
    `- Shell simulator (${options.shellModel}) tokens: ${shell.tokens} (API-price estimate $${shell.cost.toFixed(2)}).`,
    ...(codex
      ? [
          "- Code-mode tools use case mocks and a simulated machine. Native subagent prompts and asynchronous notifications are approximate.",
        ]
      : [identityNote]),
    ...(rows.some((row) => row.role === "native-subagent") ? [nativeNote] : []),
    "",
    ...table("Cases", caseKey, before !== undefined),
    ...table("By kind", (row) => row.kind),
    ...table("By pattern", (row) => row.pattern),
  ].join("\n");
};

const PositiveInt = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
const PositiveIntOrZero = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const Flags = Schema.Struct({
  model: Schema.Literals(Object.keys(MODELS) as Array<Model>),
  template: Schema.String,
  cases: Schema.optional(Schema.Array(Schema.String)),
  out: Schema.optional(Schema.String),
  baseline: Schema.optional(Schema.String),
  case: Schema.optional(Schema.Array(Schema.String)),
  samples: Schema.optional(PositiveInt),
  "top-up": Schema.optional(PositiveInt),
  concurrency: PositiveInt,
  "max-steps": Schema.optional(PositiveInt),
  effort: Schema.optional(Schema.Literals(EFFORTS)),
  "shell-model": Schema.Literals([
    ...(Object.keys(PRICES) as Array<PricedModel>),
    ...PROXY_SHELL_MODELS,
  ]),
  "user-instructions": Schema.Literals(["keep", "drop"]),
  "dry-run": Schema.Boolean,
  estimate: Schema.Boolean,
  "first-per-area": Schema.Boolean,
  "stop-on-regression": Schema.Boolean,
  "regression-budget": Schema.optional(PositiveIntOrZero),
  context: Schema.Boolean,
  harness: Schema.Literals(["capture", "app-server"]),
});
const decodeFlags = Schema.decodeUnknownEffect(Flags);
const decodeCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(Capture));
const decodeCodexCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexCapture));
const decodeCase = Schema.decodeUnknownEffect(Schema.fromJsonString(McpToolUseCase));
const decodeBaselineRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      pass: Schema.Boolean,
      error: Schema.optional(Schema.String),
    }),
  ),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(RunManifest));
/** Files beside the runner that neither run samples nor grade them. */
const NOT_GRADER = new Set([
  "gate.ts",
  "compare.ts",
  "regrade.ts",
  "trim-capture.ts",
  "estimate.ts",
]);
const string = { type: "string" } as const;

const main = Effect.gen(function* () {
  const { values } = NodeUtil.parseArgs({
    options: {
      model: { ...string, default: "claude-sonnet-5-5" },
      template: string,
      cases: { ...string, multiple: true },
      out: string,
      baseline: string,
      case: { ...string, multiple: true },
      // Unset: 2 samples per case, and a 3rd when those 2 disagree.
      samples: string,
      // A case whose samples split, or disagree with --baseline, gets more samples up to this count.
      "top-up": string,
      // Samples in flight at once, across all cases.
      concurrency: { ...string, default: "8" },
      // Unset: 6 for Claude, 10 for Codex, whose code-mode cells take more steps.
      "max-steps": string,
      effort: string,
      "shell-model": { ...string, default: "claude-haiku-5-5" },
      // T3's text must work for every user, so the captured CLAUDE.md is dropped by default.
      "user-instructions": { ...string, default: "drop" },
      "dry-run": { type: "boolean", default: false },
      // Prices the selected cases from the requests a dry run builds, then exits. No model call.
      estimate: { type: "boolean", default: false },
      // Keeps the first case of each area: the smallest run that touches every group.
      "first-per-area": { type: "boolean", default: false },
      "stop-on-regression": { type: "boolean", default: false },
      "regression-budget": string,
      // Prints the size of T3's text and tool schemas, then exits. Needs no template or key.
      context: { type: "boolean", default: false },
      // GPT models only: replay the Codex capture through a proxy, or run in `codex app-server`.
      harness: { ...string, default: "capture" },
    },
  });
  const flags = yield* decodeFlags({ template: "", ...values });
  if (flags.context) {
    process.stdout.write(`${t3ContextReport(flags.model)}\n`);
    return;
  }
  const topUp = flags["top-up"];
  if (topUp !== undefined && topUp < (flags.samples ?? 3)) {
    return yield* Effect.die(new Error("--top-up must be at least --samples."));
  }
  if (flags["stop-on-regression"] && flags.baseline === undefined) {
    return yield* Effect.die(new Error("--stop-on-regression needs --baseline."));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readNdjson = <A, E>(file: string, decode: (line: string) => Effect.Effect<A, E>) =>
    fs.readFileString(file).pipe(
      Effect.map((content) => content.split("\n").filter((line) => line.trim() !== "")),
      Effect.flatMap((lines) => Effect.forEach(lines, (line) => decode(line))),
    );
  const casesDir = path.join(import.meta.dirname, "cases");
  const caseFiles =
    flags.cases ??
    (yield* fs.readDirectory(casesDir))
      .filter((name) => name.endsWith(".ndjson"))
      .toSorted()
      .map((name) => path.join(casesDir, name));
  const cases = (yield* Effect.forEach(caseFiles, (file) => readNdjson(file, decodeCase))).flat();
  const wanted = flags.case?.flatMap((ids) => ids.split(","));
  const codex = isCodex(flags.model);
  const harness = codex ? "codex" : "claude";
  // The app-server harness builds Kin's request as a Claude lead's, then runs it in Codex.
  const appServer = codex && flags.harness === "app-server";
  const replay = codex && !appServer;
  const duplicates = cases.filter((one, i) => cases.findIndex(({ id }) => id === one.id) !== i);
  if (duplicates.length > 0)
    return yield* Effect.die(
      new Error(`Duplicate case ids: ${duplicates.map(({ id }) => id).join(", ")}`),
    );
  const matching = cases.filter(
    ({ id, setup }) =>
      (wanted === undefined || wanted.includes(id)) &&
      (setup.harness === undefined || setup.harness === harness),
  );
  // Only a Kin lead runs in the app-server harness: other cases need the captured Codex harness.
  const runnable = appServer
    ? matching.filter(({ setup }) => setup.world?.kinLead === true)
    : matching;
  if (runnable.length < matching.length)
    yield* Effect.log(`Skipped ${matching.length - runnable.length} cases that are not Kin leads.`);
  const selectedCases = flags["first-per-area"]
    ? runnable.filter((one, i) => runnable.findIndex(({ area }) => area === one.area) === i)
    : runnable;
  if (selectedCases.length === 0) return yield* Effect.die(new Error("No case matches --case."));
  const selected = yield* Effect.forEach(selectedCases, (testCase) =>
    Effect.gen(function* () {
      const priorTurns = yield* Effect.forEach(testCase.setup.priorTurns ?? [], (turn) =>
        Effect.gen(function* () {
          const toolCalls = yield* Effect.forEach(turn.toolCalls ?? [], (call) =>
            call.resultFile === undefined
              ? Effect.succeed(call)
              : fs
                  .readFileString(path.resolve(import.meta.dirname, "../..", call.resultFile))
                  .pipe(Effect.map((result) => ({ ...call, result }))),
          );
          return { ...turn, toolCalls };
        }),
      );
      return {
        ...testCase,
        setup: {
          ...testCase.setup,
          priorTurns,
        },
      };
    }),
  );
  // Trimmed captures without user data ship beside the cases. `--template` also takes a raw
  // CLIProxyAPI capture.
  const templatePath =
    flags.template ||
    path.join(import.meta.dirname, "templates", replay ? "codex.json.gz" : "claude.json.gz");
  const templateBytes = yield* fs.readFile(templatePath);
  const template = new TextDecoder().decode(
    templatePath.endsWith(".gz") ? NodeZlib.gunzipSync(templateBytes) : templateBytes,
  );
  const keepUserInstructions = flags["user-instructions"] === "keep";
  const buildFor = (
    role: McpToolUseCase["setup"]["role"],
    deviceAccess: boolean,
    browserAccess: boolean,
    links: boolean,
    forge: boolean,
    kinAgent = false,
    kinLead = false,
    kinSession = false,
    kinShared = false,
    kinSocial = false,
  ): Effect.Effect<Base, Schema.SchemaError> =>
    replay
      ? decodeCodexCapture(template).pipe(
          Effect.map((capture) =>
            buildCodexBase(capture.request.provider_native, {
              model: flags.model,
              keepUserInstructions,
              effort: flags.effort,
              subagent: role === "delegated-child",
              links,
              forge,
              kinAgent,
              kinLead,
              kinSession,
              kinShared,
              kinSocial,
              deviceAccess,
              browserAccess,
            }),
          ),
        )
      : decodeCapture(template).pipe(
          Effect.flatMap((capture) => {
            const built = buildBase(capture.request.provider_native, {
              model: flags.model,
              keepUserInstructions,
              subagent: role === "delegated-child",
              nativeSubagent: role === "native-subagent",
              links,
              forge,
              kinAgent,
              kinLead,
              kinSession,
              kinShared,
              kinSocial,
              deviceAccess,
              browserAccess,
            });
            return role === "native-subagent"
              ? Effect.promise(() =>
                  t3SubagentContext(flags.model, deviceAccess, browserAccess),
                ).pipe(Effect.map((subagentContext): Base => ({ ...built, subagentContext })))
              : Effect.succeed(built);
          }),
        );
  // Codex has no native subagents; its cases with that role run as top-level threads.
  // A Kin turn others read carries Kin's shared-turn line, as the server's prompt does.
  const baseKey = ({ setup, prompt }: McpToolUseCase) =>
    `${replay && setup.role === "native-subagent" ? "top" : setup.role}:${setup.world?.deviceAgentAccess !== false}:${setup.world?.browserAgentAccess !== false}:${setup.linkedEnvironments === true}:${setup.forge !== false}:${setup.world?.kinAgent === true}:${setup.world?.kinLead === true}:${setup.world?.kinSession === true}:${prompt.includes("{{SHARED_TURN}}")}:${setup.world?.kinSocial === true}`;
  const base = yield* buildFor("top", true, true, false, true);
  const bases = new Map<string, Base>([
    ["top:true:true:false:true:false:false:false:false:false", base],
  ]);
  for (const testCase of selected) {
    const key = baseKey(testCase);
    if (bases.has(key)) continue;
    const [
      role = "top",
      device,
      browser,
      links,
      forge,
      kinAgent,
      kinLead,
      kinSession,
      kinShared,
      kinSocial,
    ] = key.split(":") as [
      McpToolUseCase["setup"]["role"],
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    bases.set(
      key,
      yield* buildFor(
        role,
        device === "true",
        browser === "true",
        links === "true",
        forge === "true",
        kinAgent === "true",
        kinLead === "true",
        kinSession === "true",
        kinShared === "true",
        kinSocial === "true",
      ),
    );
  }
  const baseFor = (testCase: McpToolUseCase) => bases.get(baseKey(testCase)) ?? base;
  const effort = flags.effort ?? base.codex?.reasoning.effort ?? "high";
  // The first request of a sample, as the dry run prints it.
  const firstRequest = Effect.fnUntraced(function* (testCase: McpToolUseCase) {
    const sample = makeSample(testCase, baseFor(testCase));
    yield* Effect.scoped(Effect.andThen(withDevices(sample), withBackgroundWait(sample)));
    const messages = buildMessages(sample);
    const body = sample.base.codex
      ? codexRequest(sample.base, codexMessages(messages))
      : requestBody(sample, effort, messages);
    return { sample, messages, encoded: yield* encodeJson(body) };
  });
  if (flags["dry-run"] || flags.estimate) {
    // One JSON line per case. Without --case this also checks that every case builds, and fails on
    // a regex that doesn't compile, a tool the agent lacks or a placeholder left unfilled.
    const problems: Array<string> = [];
    const sizes: Array<{ prefixChars: number; messageChars: number }> = [];
    for (const testCase of selected) {
      const { sample, messages, encoded } = yield* firstRequest(testCase);
      const tools = new Set(
        [...sample.tools, ...sample.base.deferred].map((tool) => normalizeToolName(tool.name)),
      );
      const unfilled = [...new Set(encoded.match(/\{\{[A-Z_]+\}\}/g) ?? [])].map(
        (placeholder) => `placeholder left unfilled: ${placeholder}`,
      );
      // Codex lists its tools differently; only Claude requests are checked for tool names.
      const found = [...(sample.base.codex ? [] : caseProblems(testCase, tools)), ...unfilled];
      problems.push(...found.map((problem) => `${testCase.id}: ${problem}`));
      sizes.push({
        prefixChars: (yield* encodeJson([sample.base.system, sample.tools])).length,
        messageChars: (yield* encodeJson(messages)).length,
      });
      if (!flags.estimate) process.stdout.write(`${encoded}\n`);
    }
    if (problems.length > 0)
      return yield* Effect.die(new Error(`Malformed cases:\n${problems.join("\n")}`));
    if (flags.estimate) {
      const options = {
        samples: flags.samples ?? 3,
        concurrency: flags.concurrency,
        shape: ASSUMED_SHAPE,
      };
      const rows = (["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const).map(
        (model) => estimate(model, PRICES[model], sizes, options),
      );
      process.stdout.write(`${estimateTable(rows, ASSUMED_SHAPE)}\n`);
    }
    return;
  }
  const apiKey = yield* Config.String("ANTHROPIC_API_KEY").pipe(Config.withDefault(""));
  const authToken = yield* Config.String("ANTHROPIC_AUTH_TOKEN").pipe(Config.withDefault(""));
  const baseUrl = yield* Config.String("ANTHROPIC_BASE_URL").pipe(Config.withDefault(""));
  const anthropic =
    !apiKey && authToken && baseUrl
      ? {
          url: `${baseUrl.replace(/\/+$/, "")}/v1`,
          headers: { Authorization: `Bearer ${authToken}` },
        }
      : undefined;
  const out = flags.out;
  if ((!apiKey && !anthropic && (!codex || appServer)) || out === undefined) {
    const message =
      "Set ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL with ANTHROPIC_AUTH_TOKEN, and pass --out <directory>.";
    return yield* Effect.die(new Error(message));
  }
  const config: Config = {
    apiKey,
    ...(anthropic ? { anthropic } : {}),
    model: flags.model,
    ...(replay || !isPricedModel(flags["shell-model"]) ? { proxy: proxyConfig() } : {}),
    effort,
    maxSteps: flags["max-steps"] ?? (codex ? 10 : 6),
    shellModel: flags["shell-model"],
    ...(appServer
      ? {
          appServer: yield* Effect.acquireRelease(Effect.sync(openAppServer), (server) =>
            Effect.sync(server.close),
          ),
        }
      : {}),
  };
  const baselineDir =
    flags.baseline !== undefined && (yield* fs.stat(flags.baseline)).type === "Directory"
      ? flags.baseline
      : undefined;
  const baselineResults =
    baselineDir === undefined ? flags.baseline : path.join(baselineDir, "results.jsonl");
  const previous =
    baselineResults === undefined ? [] : yield* readNdjson(baselineResults, decodeBaselineRow);
  const baselineTallies = tallies(previous);
  const baseline = new Map(
    groups(previous, (row) => row.id)
      .map(([id, r]) => [id, passRate(r)] as const)
      .filter(([, rate]) => !Number.isNaN(rate)),
  );
  // Only a case that passed every baseline sample can stop a run; flaky ones are just reported.
  const passedBefore = (id: string) => baseline.get(id) === 1;
  // Before the paid runs, so a missing git cannot lose their results.
  const commit = yield* Effect.sync(() =>
    Option.getOrElse(
      Option.liftThrowable(() =>
        NodeChildProcess.execFileSync("git", ["describe", "--always", "--dirty"], {
          encoding: "utf8",
        }).trim(),
      )(),
      () => "unknown",
    ),
  );
  const hash = (text: string | Uint8Array) =>
    NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  // The runner and its graders: a change to any of them makes earlier runs incomparable.
  const graderFiles = (yield* fs.readDirectory(import.meta.dirname))
    .filter(
      (name) =>
        (name.endsWith(".ts") && !name.endsWith(".test.ts") && !NOT_GRADER.has(name)) ||
        name.endsWith(".txt"),
    )
    .toSorted();
  const graderSources = yield* Effect.forEach(graderFiles, (name) =>
    fs.readFileString(path.join(import.meta.dirname, name)),
  );
  const requests = yield* Effect.forEach(selected, (testCase) =>
    Effect.all([encodeJson(testCase), firstRequest(testCase)]).pipe(
      Effect.map(([encodedCase, { encoded }]) => ({
        id: testCase.id,
        case: hash(encodedCase),
        request: hash(encoded),
      })),
    ),
  );
  const manifest: RunManifest = {
    commit,
    model: flags.model,
    effort,
    harness: appServer ? "app-server" : harness,
    shellModel: config.shellModel,
    maxSteps: config.maxSteps,
    userInstructions: flags["user-instructions"],
    template: hash(templateBytes),
    grader: hash([config.shellModel, ...graderSources].join("\0")),
    samples: flags.samples ?? (topUp === undefined ? 2 : 3),
    topUp: topUp ?? flags.samples ?? 3,
    text: hash(requests.map(({ request }) => request).join("\n")),
    cases: Object.fromEntries(requests.map(({ id, ...hashes }) => [id, hashes] as const)),
  };
  // A stale baseline would waste the paid runs: refuse it before any.
  if (baselineDir !== undefined && topUp !== undefined) {
    const before = yield* fs
      .readFileString(path.join(baselineDir, "run.json"))
      .pipe(Effect.flatMap(decodeManifest));
    const refused = refusals(before, manifest);
    if (refused.length > 0)
      return yield* Effect.die(
        new Error(`The baseline cannot be compared with this run:\n${refused.join("\n")}`),
      );
  }
  const inFlight = yield* Semaphore.make(flags.concurrency);
  const runOne = (testCase: McpToolUseCase) => {
    const { id, kind, pattern } = testCase;
    const identity = { id, kind, pattern, role: testCase.setup.role };
    const usage = { usage: emptyUsage(), shellUsage: emptyUsage() };
    const privateValues = [
      config.apiKey,
      ...Object.values(config.proxy?.headers ?? {}),
      ...Object.values(config.anthropic?.headers ?? {}),
    ]
      .flatMap((value) => [value, value.replace(/^Bearer /i, "")])
      .filter(Boolean);
    return runSample(testCase, config, baseFor(testCase), usage).pipe(
      Effect.timed,
      // Every harness times its turn, model and tool answers together, for latency side by side.
      Effect.map(([elapsed, sample]) => ({
        latencyMs: Duration.toMillis(elapsed),
        ...sample,
      })),
      inFlight.withPermits(1),
      Effect.flatMap((sample) =>
        judged(testCase, sample, config, usage.shellUsage).pipe(
          Effect.map((rubric) => ({ sample, rubric })),
        ),
      ),
      Effect.matchCause({
        // Not graded: a sample that errors is left out of pass rates, with its tokens so far.
        onFailure: (cause) => ({
          ...identity,
          ...usage,
          pass: false,
          error: privateValues.reduce(
            (message, value) => message.replaceAll(value, "[redacted]"),
            Cause.pretty(cause),
          ),
        }),
        onSuccess: ({ sample, rubric }) => {
          const checks = [
            ...gradeSample(testCase.expect, sample, pastedText(testCase), worldFilePaths(testCase)),
            ...rubric,
          ];
          const { secret } = testCase.expect;
          const state = sampleState(checks);
          return {
            ...identity,
            pass: state !== "fail",
            ...(state === "margin" ? { withinMargin: true } : {}),
            checks,
            // Not graded: how the agent handled a secret it needed, for a person reading the run.
            ...(secret ? { secret: secretDiagnostics(sample, secret) } : {}),
            ...sample,
          };
        },
      }),
      Effect.tap((row) =>
        Effect.log(`${row.id}: ${"error" in row ? "ERROR" : STATE_LABEL[rowState(row)]}`),
      ),
    );
  };
  // Without --samples or --top-up, a case whose 2 samples disagree gets a 3rd to settle it.
  const runCase = Effect.fn("evaluateMcpToolUse.runCase")(function* (testCase: McpToolUseCase) {
    const runMany = (count: number) =>
      Effect.forEach(
        Array.from({ length: count }, () => testCase),
        runOne,
        { concurrency: "unbounded" },
      );
    if (topUp !== undefined) {
      const first = yield* runMany(manifest.samples);
      return needsTopUp(tally(first), baselineTallies.get(testCase.id))
        ? [...first, ...(yield* runMany(topUp - first.length))]
        : first;
    }
    const first = yield* runMany(flags.samples ?? 2);
    const split = flags.samples === undefined && new Set(first.map((row) => row.pass)).size > 1;
    return split ? [...first, yield* runOne(testCase)] : first;
  });
  // --stop-on-regression runs cases that passed in the baseline first and stops once more than
  // --regression-budget of them fail, so a copy change that breaks passing cases fails fast.
  // A budget lets a quirky model miss a case or two without ending the run.
  const stopEarly = flags["stop-on-regression"];
  const budget = flags["regression-budget"] ?? 0;
  const ordered = stopEarly
    ? selected.toSorted((a, b) => Number(passedBefore(b.id)) - Number(passedBefore(a.id)))
    : selected;
  const rows: Array<Effect.Success<ReturnType<typeof runOne>>> = [];
  const regressions: Array<string> = [];
  yield* Effect.forEach(
    ordered,
    (testCase) =>
      runCase(testCase).pipe(
        Effect.flatMap((caseRows) => {
          rows.push(...caseRows);
          // A case whose samples all errored has no rate, so it is no regression either.
          // Moving from pass to pass within margin is no regression; failing is.
          if (
            !stopEarly ||
            !passedBefore(testCase.id) ||
            rowsState(caseRows, testCase.margin) !== "fail"
          ) {
            return Effect.void;
          }
          regressions.push(testCase.id);
          return regressions.length > budget ? Effect.fail(testCase.id) : Effect.void;
        }),
      ),
    { concurrency: flags.concurrency, discard: true },
  ).pipe(Effect.ignore);
  const samples =
    topUp !== undefined && topUp > manifest.samples
      ? `${manifest.samples} (topped up to ${topUp} when split)`
      : flags.samples === undefined
        ? "2-3 (adaptive)"
        : flags.samples;
  const header = `Commit \`${commit}\`, ${flags.model}${appServer ? " (codex app-server)" : ""} at ${effort} effort, user instructions ${flags["user-instructions"]}, ${samples} samples per case, template \`${path.basename(templatePath)}\``;
  const finished = new Set(rows.map((row) => row.id)).size;
  const stopped =
    regressions.length === 0
      ? []
      : [
          `- Regressions (passed every baseline sample, now fail): ${regressions.map((id) => `\`${id}\``).join(", ")}.${regressions.length > budget ? ` Stopped with ${finished} of ${selected.length} cases finished.` : ""}`,
        ];
  const summary = summarize(
    rows,
    {
      header: [header, t3ContextReport(flags.model), ...stopped].join("\n"),
      shellModel: config.shellModel,
      model: config.model,
      margins: new Map(
        selected.flatMap((testCase) =>
          testCase.margin === undefined ? [] : [[testCase.id, testCase.margin] as const],
        ),
      ),
    },
    flags.baseline === undefined ? undefined : baseline,
  );
  yield* fs.makeDirectory(out, { recursive: true });
  const lines = yield* Effect.forEach(rows, (row) => encodeJson(row));
  yield* fs.writeFileString(path.join(out, "results.jsonl"), `${lines.join("\n")}\n`);
  yield* fs.writeFileString(path.join(out, "summary.md"), summary);
  yield* fs.writeFileString(path.join(out, "run.json"), `${yield* encodeJson(manifest)}\n`);
  yield* Effect.log(`Wrote ${rows.length} samples to ${out}.\n\n${summary}`);
});

if (import.meta.main) {
  main.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer, FetchHttpClient.layer),
    ),
    NodeRuntime.runMain,
  );
}
