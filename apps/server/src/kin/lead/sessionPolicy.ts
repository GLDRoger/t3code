import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * What a Kin agent's session needs from Kin to open (`turn/session.ts`), kept apart from Kin's
 * services so the provider layers that load first import nothing of Kin's (`AgentSession` builds it).
 */
export class KinAgentSessionPolicy extends Context.Service<
  KinAgentSessionPolicy,
  {
    /** Why the thread's turn refuses built-in tools now (the model reads it); none admits them. */
    readonly refusal: (threadId: ThreadId) => Effect.Effect<string | undefined>;
    /**
     * Marks the thread's turn as having read outside text, before a provider's web search runs
     * in a confined session; why the search may not run, or none when it was marked.
     */
    readonly webSearch: (threadId: ThreadId) => Effect.Effect<string | undefined>;
    /** Whether the thread is a task delegated, at any depth, from a lead's thread. */
    readonly delegated: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** First on the session's PATH: the pinned `gh` and Typst. */
    readonly toolDirectories: ReadonlyArray<string>;
    /**
     * The Kin agent a thread works for: a lead's own thread, or a task it delegated. What it posts
     * on GitHub is signed with this name; undefined for any other thread.
     */
    readonly agentName: (threadId: ThreadId) => Effect.Effect<string | undefined>;
  }
>()("t3/kin/lead/sessionPolicy/KinAgentSessionPolicy") {}
