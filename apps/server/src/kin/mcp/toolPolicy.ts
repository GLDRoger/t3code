import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

/** A tool call a gate refused before its handler ran; the message is what the caller reads. */
export class ToolCallRefused extends Schema.Error<ToolCallRefused>("t3/mcp/ToolCallRefused")({
  ...McpSchema.McpErrorBase.fields,
  _tag: Schema.tag("ToolCallRefused"),
  code: Schema.tag(-32003),
}) {}

const toolCallGateFn =
  <R>(
    refusal: (name: string, args: unknown) => Effect.Effect<string | undefined, never, R>,
  ): McpServer.middleware.Fn<never, McpSchema.McpErrorBase | ToolCallRefused, R> =>
  (effect, { method, target, payload }) =>
    method !== "tools/call"
      ? effect
      : refusal(
          target,
          Predicate.hasProperty(payload, "arguments") ? payload.arguments : undefined,
        ).pipe(
          Effect.flatMap((message) =>
            message === undefined ? effect : Effect.fail(new ToolCallRefused({ message })),
          ),
        );

/**
 * Every tool call on the server this joins passes `admit` before its handler, whichever toolkit
 * registered the tool, including ones added later. `admit` sees the tool name and its raw
 * arguments; `false` answers with `refusal` and the handler never runs.
 */
export const toolCallGate = <R>(
  admit: (name: string, args: unknown) => Effect.Effect<boolean, never, R>,
  refusal: string,
) =>
  McpServer.middleware()(
    toolCallGateFn((name, args) =>
      Effect.map(admit(name, args), (admitted) => (admitted ? undefined : refusal)),
    ),
    { global: true },
  );

/**
 * Which tools the server this joins lists and lets a request call; a hidden one answers as if it
 * weren't registered. `visible` sees the tool name and the request's services.
 */
export const toolVisibility = <R>(
  visible: (
    name: string,
    method: McpServer.MiddlewareOptions["method"],
  ) => Effect.Effect<boolean, never, R>,
) => McpServer.visibility(({ target, method }) => visible(target, method), { global: true });

/**
 * Runs `prepare` on every tool call's raw arguments before they are decoded, whichever toolkit
 * registered the tool; it may fill in a field the server knows better than the caller.
 */
export const toolCallPrepare = <R>(
  prepare: (name: string, args: Record<string, unknown>) => Effect.Effect<void, never, R>,
) =>
  McpServer.middleware()(
    (effect, { method, target, payload }) => {
      const args = Predicate.hasProperty(payload, "arguments") ? payload.arguments : undefined;
      return method !== "tools/call" || !Predicate.isObject(args)
        ? effect
        : // The call's arguments are decoded only when `effect` runs, after this.
          prepare(target, args as Record<string, unknown>).pipe(Effect.andThen(effect));
    },
    { global: true },
  );

/**
 * What a host narrows on `layer`: the tools a request lists, finds and may call, and a call's
 * refusal, if any. The default narrows nothing; a host provides its own to `layer`.
 */
export const McpToolPolicy = Context.Reference<{
  readonly visible: (name: string) => Effect.Effect<boolean>;
  readonly refusal: (name: string, args: unknown) => Effect.Effect<string | undefined>;
}>("t3/mcp/McpToolPolicy", {
  defaultValue: () => ({
    visible: () => Effect.succeed(true),
    refusal: () => Effect.undefined,
  }),
});

export const layerToolPolicy = Layer.mergeAll(
  McpServer.visibility(
    Effect.map(
      Effect.service(McpToolPolicy),
      (policy) => (options: McpServer.MiddlewareOptions) => policy.visible(options.target),
    ),
    { global: true },
  ),
  McpServer.middleware()(
    Effect.map(Effect.service(McpToolPolicy), (policy) => toolCallGateFn(policy.refusal)),
    { global: true },
  ),
);
