import * as Layer from "effect/Layer";

import type * as ClaudeAdapterV2 from "../../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type * as CodexAdapterV2 from "../../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as KinDreamIsolation from "../../../dreaming/DreamIsolation.ts";
import { acp } from "./acp.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";

/** Kin's seams around T3's adapter layers; a dream's isolation sits inside Kin's session plan. */
export const kinAdapters = <EC, RC, EX, RX>(
  claudeQueryRunner: Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, EC, RC>,
  codexAppServerClientFactory: Layer.Layer<CodexAdapterV2.CodexAppServerClientFactory, EX, RX>,
) =>
  Layer.mergeAll(
    claude.install(KinDreamIsolation.claudeQueryRunner(claudeQueryRunner)),
    codex.install(codexAppServerClientFactory),
    acp.install(Layer.empty),
  );
