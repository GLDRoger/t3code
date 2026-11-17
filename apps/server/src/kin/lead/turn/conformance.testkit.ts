import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type { ServerConfig } from "../../../config.ts";

/** `person`: the provider's own ask, shown to whoever watches the thread, as on any T3 thread. */
export type Answer = "allowed" | "person" | { readonly refused: string | undefined };

/** What a provider's session ends up with, in Kin's words, whatever the provider's protocol. */
export interface Observed {
  /** Kin changed the session T3 would have opened. */
  readonly changed: boolean;
  /** The system prompt the model gets; undefined leaves the provider's own. */
  readonly instructions: string | undefined;
  /** Kin's tools are listed up front, not each looked up before use. */
  readonly kinToolsUpFront: boolean;
  /** Kin's rare tools are held back, and the model can still find and call them. */
  readonly deferredFindable: boolean;
  /** Any of the user's own skills, settings, plugins or MCP servers can reach the session. */
  readonly personalConfig: boolean;
  /** The provider's own shell, file and web tools exist in the session at all. */
  readonly builtins: boolean;
  readonly shell:
    | {
        readonly path: string | undefined;
        readonly agentName: string | undefined;
        /** The host's variables that reach the shell's environment. */
        readonly variables: ReadonlyArray<string>;
      }
    | undefined;
  /** What Kin answers when the session asks to run a shell command now. */
  readonly askShell: Effect.Effect<Answer>;
  /** What Kin answers when it asks to read a file in the agent's own memory checkout now. */
  readonly askRead: Effect.Effect<Answer>;
}

/**
 * A provider's test double for the conformance suite: it drives the provider's T3 seam, through
 * its descriptor's `install`, with a recording stand-in for the provider process.
 */
export interface ProviderFake {
  readonly driver: string;
  readonly open: (input: {
    readonly thread: string;
    readonly cwd: string;
    /** The host's environment, Kin's secrets included, as the provider would inherit it. */
    readonly environment: Readonly<Record<string, string>>;
  }) => Effect.Effect<Observed, never, ServerConfig | FileSystem.FileSystem | Path.Path>;
}
