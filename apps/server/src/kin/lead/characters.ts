import type { KinAgentId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Docs from "../work/docs.ts";
import type { Writer } from "../work/KinRecords.ts";
import { defaultCharacterFor } from "./characterDefaults.ts";

/**
 * An agent's character is a doc it owns, filed as the company's and labelled sensitive, so only
 * owner-level people and the owner's own turns read or edit it. It is found by its origin, not a
 * doc kind, so phones that already decode the Docs list keep doing so.
 */
const ORIGIN = "kin-character:";
const characterOrigin = (agentId: string) => `${ORIGIN}${agentId}`;

const COLLEAGUES = /^to colleagues:\s*(.+)$/im;
const EXAMPLES = /^#{1,3}\s*examples\b.*$/im;
const STARTER = "This is a starter character.";

/** The doc split as a turn uses it: the line colleagues see, the voice, and the examples. */
export const parseCharacter = (body: string) => {
  const colleagues = COLLEAGUES.exec(body)?.[1]?.trim();
  const at = EXAMPLES.exec(body);
  const main = at === null ? body : body.slice(0, at.index);
  const voice = main
    .replace(COLLEAGUES, "")
    .replace(/^#\s+.*$/m, "")
    .trim();
  return {
    ...(colleagues === undefined || colleagues === "" ? {} : { colleagues }),
    voice,
    ...(at === null ? {} : { examples: body.slice(at.index).trim() }),
    starter: body.includes(STARTER),
  };
};

/**
 * The character as a turn carries it: whole, with the doc to change it, in the owner's own turns;
 * the voice alone where others read, since examples may carry figures.
 */
export const characterForTurn = (
  doc: { readonly key: string; readonly body: string },
  ownerOnly: boolean,
) => {
  const parsed = parseCharacter(doc.body);
  return ownerOnly
    ? `Doc ${doc.key}. When the owner tells you how to sound, change it with doc_edit and confirm in one line; doc_restore brings the last one back.${parsed.starter ? " It is a starter: offer him a sharper one." : ""}\n${doc.body.trim()}`
    : parsed.voice;
};

const LINE_CAP = 160;
/** What every other agent is told about this one. */
export const colleagueLine = (name: string, body: string) => {
  const line = (parseCharacter(body).colleagues ?? "").replace(/\s+/g, " ");
  return `- ${name}: ${line.length <= LINE_CAP ? line : `${line.slice(0, LINE_CAP - 1)}…`}`;
};

/** A character for an agent no default fits, until the owner and the agent shape a real one. */
const starterCharacter = (name: string, domain: string, charter: string) => {
  const job = charter.trim() === "" ? `You run ${domain} for the company.` : charter.trim();
  return `# ${name}

To colleagues: Runs ${domain}. Talk to it plainly about its own lane.

You are ${name}. ${job}

${STARTER} In your next chat with the owner, offer him a sharper one in two or three lines (an archetype, what you love, what you push back on, how you write) and, on his word, save it over this paragraph with doc_edit.

Until then: plain, direct and short. Have a view, say it once, and disagree with the owner when the facts support it.
`;
};

type LeadRow = { agentId: string; name: string; domain: string; charter: string };

const liveLeads = (sql: SqlClient.SqlClient, orgId: KinOrgId) =>
  sql<LeadRow>`SELECT l.agent_id AS "agentId", l.name, l.domain, l.charter
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${orgId} AND a.role = 'lead' AND a.retired_at IS NULL
    ORDER BY a.created_at, l.agent_id`;

const system: Writer = { actor: { _tag: "system" }, via: "import" };

/** Gives every live agent without one its character: the default for its domain, else a starter. */
export const seedCharacters = Effect.fn("KinCharacters.seed")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const have = new Set(
    (yield* sql<{ originKey: string }>`SELECT origin_key AS "originKey" FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'docs' AND origin_key LIKE ${`${ORIGIN}%`}
        ORDER BY origin_key`).map((row) => row.originKey),
  );
  let made = 0;
  for (const lead of yield* liveLeads(sql, orgId)) {
    const originKey = characterOrigin(lead.agentId);
    if (have.has(originKey)) continue;
    const fixed = defaultCharacterFor(lead.domain);
    yield* Docs.create(
      orgId,
      system,
      {},
      {
        title: `${lead.name}'s character`,
        body:
          fixed === undefined
            ? starterCharacter(lead.name, lead.domain, lead.charter)
            : fixed.replace(/^# .*$/m, `# ${lead.name}`),
        owner: { _tag: "agent", agentId: lead.agentId as KinAgentId },
        summary: fixed === undefined ? "Kin's starter character" : "Kin's default character",
        kind: "other",
        company: true,
        sensitive: true,
        originKey,
      },
    );
    made += 1;
  }
  return made;
});

export type Character = {
  readonly agentId: string;
  readonly name: string;
  readonly key: string;
  readonly body: string;
};

/** The live agents' current characters, archived ones left out, read straight from storage. */
export const characters = Effect.fn("KinCharacters.read")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Character>`SELECT l.agent_id AS "agentId", l.name, r.key, v.body
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    JOIN kin_records r ON r.org_id = l.org_id AND r.register_id = 'docs'
      AND r.origin_key = ${ORIGIN} || l.agent_id AND r.state <> 'dropped'
    JOIN kin_doc_versions v ON v.org_id = r.org_id AND v.record_id = r.record_id
      AND v.version = (SELECT MAX(w.version) FROM kin_doc_versions w
        WHERE w.org_id = v.org_id AND w.record_id = v.record_id)
    WHERE l.org_id = ${orgId} AND a.role = 'lead' AND a.retired_at IS NULL
    ORDER BY a.created_at, l.agent_id`;
});

/**
 * The owner's own text as an agent's character, from the host (`kin lead character`): written as
 * a new version over whatever is there, so the doc's history can still bring the old one back.
 */
export const setCharacter = Effect.fn("KinCharacters.set")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  body: string,
  /** Someone editing it on the agent's page; absent for the host's command. */
  by?: KinPersonId,
) {
  yield* seedCharacters(orgId);
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ key: string }>`SELECT key FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'docs' AND origin_key = ${characterOrigin(agentId)}`;
  if (row === undefined) return { outcome: "no-agent" as const };
  const now = yield* Clock.currentTimeMillis;
  const written = yield* Docs.replaceBody(
    orgId,
    { actor: by === undefined ? { _tag: "system" } : { _tag: "person", personId: by }, via: "owner" },
    {},
    { key: row.key },
    {
      body,
      summary: by === undefined ? "Set from the host" : "Edited on its page",
      originKey: `kin-character-set:${agentId}:${now}`,
    },
  );
  return { outcome: written.created ? ("set" as const) : ("unchanged" as const), key: row.key };
});
