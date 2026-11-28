import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const WorkspaceHostAccess = Context.Reference<{
  readonly fenced: (cwd: string, threadId?: ThreadId) => Effect.Effect<boolean>;
  readonly register: (cwd: string, threadId: ThreadId) => Effect.Effect<boolean>;
  readonly guard: <A, E, R>(
    paths: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
    refused: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}>("t3/workspace/WorkspaceHostAccess", {
  defaultValue: () => ({
    fenced: () => Effect.succeed(false),
    register: () => Effect.succeed(true),
    guard: (_paths, effect) => effect,
  }),
});
