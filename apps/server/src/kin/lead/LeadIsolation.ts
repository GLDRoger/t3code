import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { KinEnabled, layer as kinEnabledLayer } from "../KinEnabled.ts";

/**
 * A lead runs full-access with Kin's memory checkout as its cwd, so its Claude session loads user
 * settings only: never a project `CLAUDE.md`, `.claude/` or `.mcp.json` that memory might carry.
 * The cwd is the lead project's root, which Kin sets; a match only ever narrows what loads.
 */
export const claudeQueryRunner = <E, R>(
  base: Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, E, R>,
) =>
  Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      if (!(yield* KinEnabled).enabled) return runner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const kinDirectory = path.join((yield* ServerConfig).stateDir, "kin");
      const real = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
      const within = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
      };
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...runner,
        open: Effect.fn("KinLeadIsolation.open")(function* (input) {
          const cwd = input.options.cwd;
          const isKin =
            cwd !== undefined &&
            (within(kinDirectory, path.resolve(cwd)) ||
              within(yield* real(kinDirectory), yield* real(cwd)));
          return yield* runner.open(
            isKin
              ? {
                  ...input,
                  options: {
                    ...input.options,
                    // Narrow, never widen: a dream's `[]` stays `[]` whichever wrapper runs first.
                    settingSources: (
                      input.options.settingSources ?? ["user", "project", "local"]
                    ).filter((source) => source === "user"),
                  },
                }
              : input,
          );
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(base, kinEnabledLayer)));
