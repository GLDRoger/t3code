import type { KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";

export class MemoryConfig extends Context.Service<
  MemoryConfig,
  {
    readonly baseDirectory: string;
    readonly repositories: ReadonlyArray<{
      readonly orgId: KinOrgId;
      readonly repoUrl: string;
      readonly path: string;
    }>;
  }
>()("t3/kin/memory/MemoryConfig") {}

export const layer = (
  repositories: ReadonlyArray<{ readonly orgId: KinOrgId; readonly repoUrl: string }>,
) =>
  Layer.effect(
    MemoryConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      return MemoryConfig.of({
        baseDirectory: path.join(config.stateDir, "kin"),
        repositories: repositories.map((repo) => ({
          ...repo,
          path: encodeURIComponent(repo.orgId),
        })),
      });
    }),
  );
