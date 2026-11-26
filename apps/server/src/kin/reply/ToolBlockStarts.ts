import type { MessageId, ProviderTurnId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export interface ToolBlockStart {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly providerTurnId: ProviderTurnId;
  readonly toolUseId: string;
  readonly toolName: string;
}

type Listener = (start: ToolBlockStart) => Effect.Effect<void>;

export class ToolBlockStarts extends Context.Service<
  ToolBlockStarts,
  {
    readonly listen: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>;
    readonly publish: Listener;
  }
>()("t3/kin/reply/ToolBlockStarts") {}

export const layer = Layer.sync(ToolBlockStarts, () => {
  const listeners = new Set<Listener>();
  return {
    listen: Effect.fn("ToolBlockStarts.listen")((listener: Listener) =>
      Effect.acquireRelease(
        Effect.sync(() => listeners.add(listener)),
        () => Effect.sync(() => listeners.delete(listener)),
      ).pipe(Effect.asVoid),
    ),
    publish: Effect.fn("ToolBlockStarts.publish")((start: ToolBlockStart) =>
      Effect.forEach(listeners, (listener) => listener(start), { discard: true }),
    ),
  };
});
