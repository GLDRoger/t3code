/**
 * `--harness app-server`: a Kin lead's sample in `codex app-server`, as Kin runs GPT models
 * (`lead/turn/providers/codex.ts`). run.ts calls it from runSample; it runs only after run.ts loaded.
 */
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";

import {
  CONFINED_CONFIG,
  FULL_SESSION_CONFIG,
} from "../../apps/server/src/kin/lead/turn/providers/codex.ts";
import type { AppServer, AppServerEvent } from "./appServer.ts";
import {
  isText,
  KIN_SHARED_PROMPT,
  filledEvent,
  kinInstructions,
  kinSessionOf,
  rescuePrompt,
  shownText,
} from "./kin.ts";
import {
  answerToolCall,
  buildMessages,
  EvalToolCallError,
  makeSample,
  normalizeToolName,
  ranCalls,
  settle,
  type ApiMessage,
  type Base,
  type Call,
  type RunConfig as Config,
  type McpToolUseCase,
  type Sample,
  type Usage,
} from "./run.ts";

const T3_PREFIX = "mcp__t3-code__";
const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

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
export const runAppServerSample = Effect.fn("evaluateMcpToolUse.runAppServerSample")(function* (
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
  const ownerSession = kinSessionOf(testCase) && !KIN_SHARED_PROMPT.test(testCase.prompt);
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
        maxToolCalls:
          config.maxSteps === 0 ? Infinity : Math.max(config.maxSteps, testCase.maxSteps ?? 0) * 3,
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
            answerToolCall(sample, config, filledEvent(testCase, use, normalizeToolName)).pipe(
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
      ? [{ type: "text", text: event.text }]
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
    silent: rescuePrompt(sample, normalizeToolName) !== undefined,
    linked: [...sample.linked],
    usage: spent.usage,
    shellUsage: sample.shellUsage,
    reasoningTokens: result.usage.reasoning,
    transcript: result.items,
  };
});
