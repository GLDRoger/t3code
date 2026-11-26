import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

import type * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";

export class KinAgentSessions extends Context.Service<
  KinAgentSessions,
  {
    readonly resolveAgent: McpSessionRegistry.McpSessionRegistryShape["resolve"];
    readonly recordToolList: (threadId: ThreadId, sessionId: string, sha: string) => void;
    readonly lastToolList: (threadId: ThreadId) => string | null;
  }
>()("t3/kin/mcp/KinAgentSessions") {}
