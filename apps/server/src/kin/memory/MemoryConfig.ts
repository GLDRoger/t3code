import type { KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";

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
