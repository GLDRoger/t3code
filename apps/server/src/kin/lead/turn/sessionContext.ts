import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type PreparedContext = {
  readonly standing?: string;
  readonly delta?: string;
};

export class KinSessionContext extends Context.Service<
  KinSessionContext,
  {
    readonly forThread: (thread: ThreadId) => PreparedContext | undefined;
    readonly set: (thread: ThreadId, context: PreparedContext | undefined) => Effect.Effect<void>;
  }
>()("t3/kin/lead/turn/sessionContext/KinSessionContext") {
  static readonly layer = Layer.sync(KinSessionContext, () => {
    const contexts = new Map<ThreadId, PreparedContext>();
    return KinSessionContext.of({
      forThread: (thread) => contexts.get(thread),
      set: Effect.fn("KinSessionContext.set")(function (thread, context) {
        return Effect.sync(() => {
          if (context === undefined) contexts.delete(thread);
          else contexts.set(thread, context);
        });
      }),
    });
  });
}
