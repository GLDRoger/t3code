import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * What a lead's Claude session needs from Kin to open (`LeadIsolation`), kept apart from Kin's
 * services so the provider layers that load first import nothing of Kin's (`AgentSession` builds it).
 */
export class KinAgentSessionPolicy extends Context.Service<
  KinAgentSessionPolicy,
  {
    /** Why the thread's turn refuses built-in tools now (the model reads it); none admits them. */
    readonly refusal: (threadId: ThreadId) => Effect.Effect<string | undefined>;
    /** Whether the thread is a task delegated, at any depth, from a lead's thread. */
    readonly delegated: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** First on the session's PATH: the pinned `gh` and Typst. */
    readonly toolDirectories: ReadonlyArray<string>;
  }
>()("t3/kin/lead/sessionPolicy/KinAgentSessionPolicy") {}
