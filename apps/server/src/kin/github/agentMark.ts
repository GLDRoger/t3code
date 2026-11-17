// @effect-diagnostics nodeBuiltinImport:off - a plain synchronous hash, as the agent's gh computes it.
import * as NodeCrypto from "node:crypto";

/**
 * Everything a Kin agent posts on GitHub ends with one visible line naming the agent and a hidden
 * marker, so a reader knows it was the agent and Kin's GitHub watch never reacts to its own words.
 */
const MARKER = /<!--\s*kin-agent:/i;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "agent";

/** The visible line, "_Tech lead, via Kin_": italic on GitHub. */
const signatureLine = (agentName: string) => `_${agentName.trim() || "Agent"}, via Kin_`;

const markerOf = (agentName: string) => `<!-- kin-agent: ${slug(agentName)} -->`;

/** Whether text carries an agent's marker: Kin's own words, never a trigger. */
export const isAgentText = (text: string | null | undefined) =>
  text !== null && text !== undefined && MARKER.test(text);

/** `body` with the agent's signature and marker at its end, once. */
export const signed = (body: string, agentName: string) =>
  isAgentText(body)
    ? body
    : `${body.trimEnd()}${body.trim() === "" ? "" : "\n\n"}${signatureLine(agentName)}\n${markerOf(agentName)}`;

/**
 * The key an agent's gh records for each text it sends (`ghPolicy.ts`), signed or not, so the watch
 * knows the agent's own words even when GitHub shows them without the marker.
 */
export const postKey = (text: string) =>
  NodeCrypto.createHash("sha256").update(text.replace(/\r\n?/g, "\n").trim()).digest("hex");

/** The keys in an `agent-posts.log`, from lines written at or after `since` (unix seconds). */
export const agentPostKeys = (log: string, since: number): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const line of log.split("\n")) {
    const [at, key] = line.split("\t");
    if (key !== undefined && /^[0-9a-f]{64}$/.test(key) && Number(at) >= since) keys.add(key);
  }
  return keys;
};
