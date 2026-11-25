// @effect-diagnostics nodeBuiltinImport:off - a plain synchronous hash, as the agent's gh computes it.
import * as NodeCrypto from "node:crypto";

/**
 * Everything a Kin agent posts on GitHub ends with one visible line naming the agent and a hidden
 * marker, so a reader knows it was the agent and Kin's GitHub watch never reacts to its own words.
 */
const MARKER = /<!--\s*kin-agent:/i;

/** Whether text carries an agent's marker: Kin's own words, never a trigger. */
export const isAgentText = (text: string | null | undefined) =>
  text !== null && text !== undefined && MARKER.test(text);

/**
 * `body` with "_Tech lead, via Kin_" (italic on GitHub) and the marker at its end, once; a blank
 * name signs as Agent, never not at all. The one definition: an agent's gh runs this function's
 * own source (`ghPolicy.ts`), so it must reference nothing outside itself.
 */
export function signed(body: string, agentName: string): string {
  if (/<!--\s*kin-agent:/i.test(body)) return body;
  const name = agentName.trim() || "Agent";
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agent";
  const gap = body.trim() === "" ? "" : "\n\n";
  return body.trimEnd() + gap + "_" + name + ", via Kin_\n<!-- kin-agent: " + slug + " -->";
}

/**
 * The key an agent's gh records for each text it sends (`ghPolicy.ts`), signed or not, so the watch
 * knows the agent's own words even when GitHub shows them without the marker.
 */
export const postKey = (text: string) =>
  NodeCrypto.createHash("sha256").update(text.replace(/\r\n?/g, "\n").trim()).digest("hex");

/** Each `[at, key]` line of an `agent-posts.log`, `at` in unix seconds. */
export const agentPostLines = (log: string): ReadonlyArray<readonly [number, string]> =>
  log.split("\n").flatMap((line) => {
    const [at, key] = line.split("\t");
    return key !== undefined && /^[0-9a-f]{64}$/.test(key) ? [[Number(at), key] as const] : [];
  });

/** The keys in an `agent-posts.log`, from lines written at or after `since` (unix seconds). */
export const agentPostKeys = (log: string, since: number): ReadonlySet<string> =>
  new Set(agentPostLines(log).flatMap(([at, key]) => (at >= since ? [key] : [])));
