import type { KinWakeupId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type PreparedContext = {
  readonly standing?: string;
  readonly delta?: string;
};

export interface SessionSnapshot {
  readonly wakeupId: KinWakeupId;
  readonly sections: Readonly<Record<string, string>>;
  readonly index: string;
  readonly chatSeq: number;
  readonly chatChangeSeq: number;
  readonly heldChatChanges: ReadonlyArray<number>;
}

export class KinSessionContext extends Context.Service<
  KinSessionContext,
  {
    readonly forThread: (thread: ThreadId) => PreparedContext | undefined;
    readonly previous: (thread: ThreadId) => SessionSnapshot | undefined;
    readonly take: (thread: ThreadId) => string | undefined;
    readonly remember: (thread: ThreadId, previous: SessionSnapshot) => Effect.Effect<void>;
    readonly forget: (thread: ThreadId) => Effect.Effect<void>;
    readonly set: (thread: ThreadId, context: PreparedContext | undefined) => Effect.Effect<void>;
  }
>()("t3/kin/lead/turn/sessionContext/KinSessionContext") {
  static readonly layer = Layer.sync(KinSessionContext, () => {
    const contexts = new Map<ThreadId, PreparedContext>();
    const snapshots = new Map<ThreadId, SessionSnapshot>();
    return KinSessionContext.of({
      forThread: (thread) => contexts.get(thread),
      previous: (thread) => snapshots.get(thread),
      take: (thread) => {
        const context = contexts.get(thread);
        if (context?.delta === undefined) return undefined;
        if (context.standing === undefined) contexts.delete(thread);
        else contexts.set(thread, { standing: context.standing });
        return context.delta;
      },
      remember: Effect.fn("KinSessionContext.remember")(function (thread, previous) {
        return Effect.sync(() => void snapshots.set(thread, previous));
      }),
      forget: Effect.fn("KinSessionContext.forget")(function (thread) {
        return Effect.sync(() => {
          contexts.delete(thread);
          snapshots.delete(thread);
        });
      }),
      set: Effect.fn("KinSessionContext.set")(function (thread, context) {
        return Effect.sync(() => {
          if (context === undefined) contexts.delete(thread);
          else contexts.set(thread, context);
        });
      }),
    });
  });
}
