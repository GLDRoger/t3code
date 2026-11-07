import { KinAgentId, KinLevel, KinOrgId, KinWakeupId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

const Caller = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  wakeupId: KinWakeupId,
  level: KinLevel,
});
export class KinLeadRegistryConflict extends Schema.TaggedError<KinLeadRegistryConflict>()(
  "KinLeadRegistryConflict",
  { threadId: ThreadId },
) {}

export class KinLeadRegistry extends Context.Service<
  KinLeadRegistry,
  {
    readonly register: (
      threadId: ThreadId,
      caller: typeof Caller.Type,
    ) => Effect.Effect<void, KinLeadRegistryConflict, Scope.Scope>;
    readonly resolve: (threadId: ThreadId) => Option.Option<typeof Caller.Type>;
    readonly isLeadCaller: (threadId: ThreadId) => boolean;
  }
>()("t3/kin/lead/KinLeadRegistry") {}

export const layer = Layer.sync(KinLeadRegistry, () => {
  const callers = new Map<ThreadId, typeof Caller.Type>();
  return KinLeadRegistry.of({
    register: Effect.fn("KinLeadRegistry.register")((threadId, caller) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          if (callers.has(threadId)) return Effect.fail(new KinLeadRegistryConflict({ threadId }));
          callers.set(threadId, caller);
          return Effect.void;
        }),
        () =>
          Effect.sync(() => {
            callers.delete(threadId);
          }),
      ),
    ),
    resolve: (threadId) => Option.fromUndefinedOr(callers.get(threadId)),
    isLeadCaller: (threadId) => callers.has(threadId),
  });
});
