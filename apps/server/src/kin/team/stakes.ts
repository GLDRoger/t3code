/**
 * Which agents a Team-room message touches, from their domains and Kin's records: a client with an
 * open invoice is Finance's whatever the words, and a few words per lane do the rest. An entity
 * match outranks a word match. The Chief of staff chairs and takes no pitch-ins.
 */

type Lane = "finance" | "growth" | "tech" | "social";

const LANE_OF: ReadonlyArray<readonly [RegExp, Lane]> = [
  [/^(finance|money|accounts?|books?)/, "finance"],
  [/^(growth|sales|business|clients?)/, "growth"],
  [/^(engineering|tech|dev|product|build)/, "tech"],
  [/^(social|marketing|content|brand|design)/, "social"],
];

const WORDS: Record<Lane, RegExp> = {
  finance:
    /\b(amounts?|prices?|priced|pricing|discounts?|advances?|spend\w*|print\w*|invoices?|costs?|budget\w*|paid|pays?|owe[sd]?|deposits?|rupees?|gst|tds)\b|₹|\$/i,
  growth:
    /\b(clients?|customers?|pitch\w*|offers?|sectors?|case stud(?:y|ies)|referrals?|seasons?|leads?|prospects?|retainers?)\b/i,
  tech: /\b(repos?|prs?|pull requests?|sites?|website|builds?|built|dates?|launch\w*|features?|integrations?|automat\w*|deploy\w*|displays?|screens?)\b/i,
  social:
    /\b(posts?|looks?|colou?rs?|brochures?|launch\w*|announce\w*|instagram|reels?|designs?|carousels?|linkedin|feeds?|logos?)\b/i,
};

const laneOf = (domain: string): Lane | null =>
  LANE_OF.find(([pattern]) => pattern.test(domain))?.[1] ?? null;

const mentions = (text: string, name: string) =>
  new RegExp(
    `(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(text);

/**
 * Agents whose stake `text` touches, strongest first: 2 for an entity it owns (Finance: a client
 * with an open invoice), 1 for a word of its lane. Ties keep the agents' order.
 */
export const stakeholders = (
  text: string,
  agents: ReadonlyArray<{ readonly agentId: string; readonly domain: string }>,
  owedClients: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  agents
    .flatMap((agent, index) => {
      const lane = laneOf(agent.domain);
      if (lane === null) return [];
      const entity = lane === "finance" && owedClients.some((name) => mentions(text, name));
      const score = entity ? 2 : WORDS[lane].test(text) ? 1 : 0;
      return score === 0 ? [] : [{ agentId: agent.agentId, score, index }];
    })
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.agentId);
