import { acp, antigravity } from "./providers/acp.ts";
import { claude } from "./providers/claude.ts";
import { codex } from "./providers/codex.ts";

/** Every provider a Kin agent runs on; each passes `conformance.test.ts`. */
export const KIN_PROVIDERS = [claude, codex, acp, antigravity] as const;
