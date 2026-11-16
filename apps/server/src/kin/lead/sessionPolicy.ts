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
    /** The switch: the owner's GitHub is connected, so owner-only turns get the full session. */
    readonly connected: () => Effect.Effect<boolean>;
    /** Whether the thread's running turn admits built-in tools now. */
    readonly admitted: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** First on the session's PATH: the pinned `gh`. */
    readonly ghDirectory: string;
  }
>()("t3/kin/lead/sessionPolicy/KinAgentSessionPolicy") {}
