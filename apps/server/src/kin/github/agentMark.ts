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

/** The visible line, e.g. "— Tech lead, via Kin". */
export const signatureLine = (agentName: string) => `— ${agentName.trim() || "Agent"}, via Kin`;

export const markerOf = (agentName: string) => `<!-- kin-agent: ${slug(agentName)} -->`;

/** Whether text carries an agent's marker: Kin's own words, never a trigger. */
export const isAgentText = (text: string | null | undefined) =>
  text !== null && text !== undefined && MARKER.test(text);

/** `body` with the agent's signature and marker at its end, once. */
export const signed = (body: string, agentName: string) =>
  isAgentText(body)
    ? body
    : `${body.trimEnd()}${body.trim() === "" ? "" : "\n\n"}${signatureLine(agentName)}\n${markerOf(agentName)}`;
