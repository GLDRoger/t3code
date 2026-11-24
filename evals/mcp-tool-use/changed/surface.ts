// @effect-diagnostics nodeBuiltinImport:off
/**
 * What a Kin case can receive from this checkout, hashed by part, so a comparison reruns only cases
 * whose input changed (`select.ts`). The part list was read off the runner at `REVIEWED_RUNNER`;
 * selection refuses another runner until this file is checked again.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as Contracts from "@t3tools/contracts";
import { ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } from "@t3tools/contracts";
import { THEME_GUIDE } from "@t3tools/shared/themeCss";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CHILD_PULL_REQUEST_REPORT_NEXT,
  PullRequestsToolkit,
} from "../../../apps/server/src/mcp/toolkits/pullRequests/tools.ts";
import { PreviewControlsToolkit } from "../../../apps/server/src/mcp/toolkits/previewControls/tools.ts";
import { PreviewToolkit } from "../../../apps/server/src/mcp/toolkits/preview/tools.ts";
import { TURN_EVENT_TOOLS } from "../../../apps/server/src/kin/lead/eventIds.ts";
import { CAPTION_PROMPT, RESCUE_PROMPT } from "../../../apps/server/src/kin/reply/classify.ts";
import { fillKinRules, KIN_CALL_REFUSAL, kinDated, kinSessionOf, kinTurnFiles } from "../kin.ts";
import { filledKinMocks } from "../kin-checks.ts";
import { rubricRequest } from "../rubric.ts";
import {
  type Base,
  buildBase,
  buildMessages,
  makeSample,
  McpToolUseCase,
  normalizeToolName,
  NOT_GRADER,
  type RunConfig,
  t3SubagentContext,
  withBackgroundWait,
  withDevices,
} from "../run.ts";

const RUNNER_DIR = NodePath.join(import.meta.dirname, "..");

const hash = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
const hashJson = (value: unknown) => hash(JSON.stringify(value) ?? "undefined");

/** The runner and graders as run.ts's `grader` hash reads them, without the shell model. */
export const runnerHash = () =>
  hash(
    NodeFS.readdirSync(RUNNER_DIR)
      .filter(
        (name) =>
          (name.endsWith(".ts") && !name.endsWith(".test.ts") && !NOT_GRADER.has(name)) ||
          name.endsWith(".txt"),
      )
      .toSorted()
      .map((name) => NodeFS.readFileSync(NodePath.join(RUNNER_DIR, name), "utf8"))
      .join("\0"),
  );

/** The runner this file's part list was checked against. */
export const REVIEWED_RUNNER = "4a3935eeff4c834e";

export const CaseSurface = Schema.Struct({
  /** The case as run.json hashes it, and its first request as run.json hashes it. */
  case: Schema.String,
  request: Schema.String,
  /** Every tool the case starts with or can load, by name: a hash of its schema. */
  schemas: Schema.Record(Schema.String, Schema.String),
  /** Checkout text that can reach the model after the first request, by label: its hash. */
  later: Schema.Record(Schema.String, Schema.String),
  /** The rubric judge's request without the turn, "" without a rubric. */
  judge: Schema.String,
  /** Why the case can receive checkout output no hash here covers: it is always rerun. */
  pinned: Schema.Array(Schema.String),
});
export type CaseSurface = typeof CaseSurface.Type;

export const Surface = Schema.Struct({
  runner: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  shellModel: Schema.String,
  cases: Schema.Record(Schema.String, CaseSurface),
});
export type Surface = typeof Surface.Type;

// Tools whose answers carry a thread link (run.ts `withProductFields`).
const THREAD_LINK_TOOLS = new Set([
  "delegate_task",
  "task_status",
  "t3_thread_read",
  "t3_thread_launch",
  "t3_thread_send",
  "run_scheduled_task_now",
  "t3_thread_list",
  "create_threads",
  "t3_thread_search",
]);
const PREVIEW_TOOLS = new Set(
  [PreviewToolkit, PreviewControlsToolkit].flatMap((toolkit) => Object.keys(toolkit.tools)),
);
// Their answers read the PRs a shell command created (run.ts `createdPullRequests`).
const PULL_REQUEST_TOOLS = new Set(Object.keys(PullRequestsToolkit.tools));

const REPO = NodePath.join(RUNNER_DIR, "../..");
const sources = (files: ReadonlyArray<string>) =>
  hash(
    files.map((file) => `${file}\0${NodeFS.readFileSync(NodePath.join(REPO, file))}`).join("\0"),
  );
const tree = (dir: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(NodePath.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tree(file);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [file] : [];
  });
/**
 * formatThreadLink's output is threadLinks.ts's code and the literal DEFAULT_HOSTED_APP_URL in
 * connectAuth.ts; it reads no contracts value. A change elsewhere cannot move a link.
 */
const THREAD_LINK_SOURCES = sources([
  "packages/shared/src/threadLinks.ts",
  "packages/shared/src/connectAuth.ts",
]);
/**
 * changeRequestsCreatedBy: its own module, the definitions list, and every forge's URL parser.
 * Contracts are left out: the parsers read forge URLs with their own patterns.
 */
const CREATED_PR_SOURCES = sources([
  "apps/server/src/orchestration-v2/PullRequestSyncReactor.ts",
  "apps/server/src/sourceControl/sourceControlDefinitions.ts",
  ...NodeFS.readdirSync(NodePath.join(REPO, "packages"))
    .filter((name) => name.startsWith("source-control-"))
    .flatMap((name) => tree(`packages/${name}/src`)),
]);
const unsavedSecretNote = (Contracts as Record<string, unknown>).SECRET_REQUEST_UNSAVED_NOTE;
const previewUnavailable = new Contracts.PreviewAutomationUnavailableError({
  capability: "preview",
  environmentId: Contracts.EnvironmentId.make("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
}).message;
const decodePreviewError = Schema.decodeUnknownOption(Contracts.PreviewAutomationError);
const CLASSIFY_SOURCE = sources(["apps/server/src/kin/reply/classify.ts"]);
const CALL_ARGUMENTS_SOURCE = sources(["apps/server/src/kin/connections/callArguments.ts"]);
const QUOTED_MESSAGE = /BEGIN QUOTE: (?:owner|co-owner|member human|guest human) message/;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Every result a mock can give (run.ts `nextMock`): each `$when` result, `$else`, each step. */
const mockResults = (given: unknown): ReadonlyArray<unknown> => {
  const picked =
    isRecord(given) && Array.isArray(given.$when)
      ? [...given.$when.map((rule) => (isRecord(rule) ? rule.result : undefined)), given.$else]
      : [given];
  return picked.flatMap((mock) =>
    isRecord(mock) && Array.isArray(mock.$sequence) ? mock.$sequence : [mock],
  );
};

/**
 * Checkout text a case can receive after its first request, and why it can receive checkout output
 * no hash here covers. `tools` are the names of every tool it starts with or can load, as graded.
 */
export const laterParts = (testCase: McpToolUseCase, tools: ReadonlySet<string>) => {
  const has = (set: ReadonlySet<string>) => [...tools].some((tool) => set.has(tool));
  const { setup, expect } = testCase;
  const later: Record<string, string> = {
    // The rescue decision and shownText read Kin's reply classifier; the judge reads shownText.
    "kin/reply/classify.ts": CLASSIFY_SOURCE,
    TURN_EVENT_TOOLS: hashJson([...TURN_EVENT_TOOLS].toSorted()),
  };
  const pinned: Array<string> = [];
  // A Kin mock's answer is filled in by Kin's own builders, so it moves when they do.
  const kinMocks = filledKinMocks(setup);
  if (kinMocks.length > 0) later.kinMocks = hashJson(kinMocks);
  if (setup.world?.kinLead === true && QUOTED_MESSAGE.test(testCase.prompt)) {
    later.RESCUE_PROMPT = hash(RESCUE_PROMPT);
    later.CAPTION_PROMPT = hash(CAPTION_PROMPT);
  }
  // A connection call's text arguments are read as Kin reads them; text with no object is refused.
  if (tools.has("kin_connection_call"))
    later["kin/connections/callArguments.ts"] = hash(CALL_ARGUMENTS_SOURCE + KIN_CALL_REFUSAL);
  if (tools.has("t3_theme_read")) later.THEME_GUIDE = hash(THEME_GUIDE);
  if (tools.has("request_secret")) later.SECRET_REQUEST_UNSAVED_NOTE = hashJson(unsavedSecretNote);
  if (tools.has("delegate_task") || tools.has("task_status"))
    later.ORCHESTRATOR_MCP_RUNNING_TASK_NEXT = hash(ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);
  if (setup.role === "delegated-child" && has(PULL_REQUEST_TOOLS))
    later.CHILD_PULL_REQUEST_REPORT_NEXT = hash(CHILD_PULL_REQUEST_REPORT_NEXT);
  if (has(THREAD_LINK_TOOLS)) later.formatThreadLink = THREAD_LINK_SOURCES;
  if (has(PREVIEW_TOOLS)) {
    later.previewUnavailable = hash(previewUnavailable);
    // A preview mock that is a T3 preview error answers with that error's message.
    later.previewErrors = hashJson(
      [...PREVIEW_TOOLS].toSorted().map((name) =>
        mockResults(setup.mocks?.[name]).map((mock) =>
          Option.match(decodePreviewError(mock), {
            onNone: () => null,
            onSome: (error) => error.message,
          }),
        ),
      ),
    );
  }
  if (
    tools.has("Bash") &&
    (has(PULL_REQUEST_TOOLS) || expect.linked !== undefined || expect.linkedNumbers !== undefined)
  )
    later.changeRequestsCreatedBy = CREATED_PR_SOURCES;
  // The file-link grader reads shared link parsers that import far into the checkout.
  if (expect.fileLinks !== undefined) pinned.push("file links: graded by shared link parsers");
  if (setup.world?.devices !== undefined) pinned.push("devices: T3's device service answers");
  if (setup.world?.backgroundTasks !== undefined)
    pinned.push("background tasks: T3's orchestrator answers t3_background_wait");
  return { later, pinned };
};

/** The Kin case files `pnpm kin:*` run, as a candidate run passes them. */
export const readCases = (files: ReadonlyArray<string>) => {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(McpToolUseCase));
  return files.flatMap((file) =>
    NodeFS.readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const testCase = decode(line);
        // As run.ts: a prior call's resultFile is read into its result before anything is hashed.
        const priorTurns = (testCase.setup.priorTurns ?? []).map((turn) => ({
          ...turn,
          toolCalls: (turn.toolCalls ?? []).map((call) =>
            call.resultFile === undefined
              ? call
              : {
                  ...call,
                  result: NodeFS.readFileSync(
                    NodePath.resolve(RUNNER_DIR, "../..", call.resultFile),
                    "utf8",
                  ),
                },
          ),
        }));
        return { ...testCase, setup: { ...testCase.setup, priorTurns } };
      }),
  );
};

type Model = RunConfig["model"];

// run.ts's capture schema: decoding puts each block's declared keys first, and the request hash
// sees that key order.
const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;
const AnyBlock = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  Rest,
);
const Content = Schema.Union([Schema.String, Schema.Array(AnyBlock)]);
const Capture = Schema.Struct({
  request: Schema.Struct({
    provider_native: Schema.Struct({
      system: Schema.optional(Content),
      messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Content })),
      tools: Schema.Array(Schema.StructWithRest(Schema.Struct({ name: Schema.String }), Rest)),
    }),
  }),
});
const decodeCapture = Schema.decodeSync(Schema.fromJsonString(Capture));
const readTemplate = (bytes: Uint8Array) =>
  decodeCapture(new TextDecoder().decode(NodeZlib.gunzipSync(bytes))).request.provider_native;

/**
 * Builds each case's base and first request as run.ts's `main` does for a Claude model, and
 * hashes its parts. run.json's own `case` and `request` hashes check that this build is the run's.
 */
export const surfaceOf = Effect.fn("changedCases.surfaceOf")(function* (input: {
  readonly cases: ReadonlyArray<McpToolUseCase>;
  readonly model: Model;
  readonly effort: string;
  readonly shellModel: string;
}) {
  const { model, effort } = input;
  if (model.startsWith("gpt-"))
    return yield* Effect.die(new Error("Changed cases only runs Claude models."));
  const templateBytes = NodeFS.readFileSync(NodePath.join(RUNNER_DIR, "templates/claude.json.gz"));
  const native = readTemplate(templateBytes);
  // run.ts `baseKey` for a Claude model.
  const options = (testCase: McpToolUseCase) => {
    const { setup, prompt } = testCase;
    return {
      role: setup.role,
      deviceAccess: setup.world?.deviceAgentAccess !== false,
      browserAccess: setup.world?.browserAgentAccess !== false,
      links: setup.linkedEnvironments === true,
      forge: setup.forge !== false,
      kinAgent: setup.world?.kinAgent === true,
      kinLead: setup.world?.kinLead === true,
      kinSession: kinSessionOf(testCase),
      kinShared: prompt.includes("{{SHARED_TURN}}"),
      kinSocial: setup.world?.kinSocial === true,
    };
  };
  const bases = new Map<string, Base>();
  const baseFor = Effect.fnUntraced(function* (testCase: McpToolUseCase) {
    const { role, ...seat } = options(testCase);
    const key = hashJson(options(testCase));
    let base = bases.get(key);
    if (base === undefined) {
      const built = buildBase(native, {
        model,
        keepUserInstructions: false,
        subagent: role === "delegated-child",
        nativeSubagent: role === "native-subagent",
        ...seat,
      });
      base =
        role === "native-subagent"
          ? {
              ...built,
              subagentContext: yield* Effect.promise(() =>
                t3SubagentContext(model, seat.deviceAccess, seat.browserAccess),
              ),
            }
          : built;
      bases.set(key, base);
    }
    return kinDated(testCase, base);
  });
  const cases: Record<string, CaseSurface> = {};
  for (const testCase of input.cases) {
    const sample = makeSample(testCase, yield* baseFor(testCase));
    yield* Effect.scoped(Effect.andThen(withDevices(sample), withBackgroundWait(sample)));
    sample.kinFiles = yield* kinTurnFiles(testCase);
    const messages = buildMessages(sample);
    const { base, tools } = sample;
    // run.ts `requestBody` off the gateway, as `firstRequest` hashes it.
    const body = {
      model: base.model,
      max_tokens: 16_000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
      cache_control: { type: "ephemeral" },
      system: base.system.map((block, i) =>
        i === base.system.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block,
      ),
      tools,
      messages,
    };
    const schemas: Record<string, string> = {};
    for (const tool of [...tools, ...base.deferred]) schemas[tool.name] = hashJson(tool);
    const names = new Set(Object.keys(schemas).map(normalizeToolName));
    const { rubric } = testCase.expect;
    const judge =
      rubric === undefined
        ? ""
        : hashJson(
            rubricRequest(
              input.shellModel,
              rubric.context === undefined
                ? rubric
                : { ...rubric, context: fillKinRules(rubric.context) },
              { text: "", calls: [] },
            ),
          );
    cases[testCase.id] = {
      case: hashJson(testCase),
      request: hashJson(body),
      schemas,
      ...laterParts(testCase, names),
      judge,
    };
  }
  return {
    runner: runnerHash(),
    model,
    effort,
    shellModel: input.shellModel,
    cases,
  } satisfies Surface;
});
