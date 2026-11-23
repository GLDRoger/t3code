import { KinWidgetId, type KinAgentId, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { KinChatService } from "../chat/KinChatService.ts";
import * as Docs from "../work/docs.ts";
import type { Writer } from "../work/KinRecords.ts";
import { type CharacterMoney, defaultCharacterFor, shippedLines } from "./characterDefaults.ts";
import { companyMoney } from "../work/companyProfile.ts";

/**
 * An agent's character is two parts: Kin's, its seat's default as this release ships it, never
 * stored; and the owner's, a sensitive company doc the agent owns, found by its origin (so phones
 * that decode the Docs list keep doing so). An area with no default has the doc alone.
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

/** Kin's part of an agent's character, headed with its name; undefined when its area has none. */
export const kinPartFor = (domain: string, name: string, money: CharacterMoney) =>
  defaultCharacterFor(domain, money)
    ?.replace(/^# .*$/m, `# ${name}`)
    .trim();

/** Both parts as one text, for readers of the single field: Kin's, a blank line, the owner's. */
export const wholeCharacter = (character: Pick<Character, "kin" | "body">) => {
  const own = character.body.trim();
  if (character.kin === undefined) return character.body;
  return own === "" ? character.kin : `${character.kin}\n\n${own}`;
};

/** The fixed line between Kin's part and the owner's, which says his wins. */
export const OWN_WORDS =
  "The company's own words for you follow; where they differ from the above, they win.";

/**
 * The character as a turn carries it: whole, with the doc to change it, in the owner's own turns;
 * the voice alone where others read, since examples may carry figures.
 */
export const characterForTurn = (character: Character, ownerOnly: boolean) => {
  if (character.kin === undefined) {
    const parsed = parseCharacter(character.body);
    return ownerOnly
      ? `Doc ${character.key}. When the owner tells you how to sound, change it with doc_edit and confirm in one line; doc_restore brings the last one back.${parsed.starter ? " It is a starter: offer them a sharper one." : ""}\n${character.body.trim()}`
      : parsed.voice;
  }
  const own = character.body.trim();
  if (ownerOnly)
    return own === ""
      ? `${character.kin.trimEnd()}\n\nDoc ${character.key} holds the owner's part, empty now: when they tell you how to sound, write it there with doc_edit and confirm in one line.`
      : `Doc ${character.key} holds the owner's part, the last below: when they tell you how to sound, change it there with doc_edit and confirm in one line; doc_restore brings the last one back.\n${character.kin}\n\n${OWN_WORDS}\n${own}`;
  const voice = parseCharacter(character.kin).voice;
  const ownVoice = own === "" ? "" : parseCharacter(own).voice;
  return ownVoice === "" ? voice : `${voice}\n\n${OWN_WORDS}\n${ownVoice}`;
};

const LINE_CAP = 160;
/** What every other agent is told about this one: the owner's line, else Kin's. */
export const colleagueLine = (character: Pick<Character, "name" | "kin" | "body">) => {
  const said =
    parseCharacter(character.body).colleagues ??
    (character.kin === undefined ? undefined : parseCharacter(character.kin).colleagues);
  const line = (said ?? "").replace(/\s+/g, " ");
  return `- ${character.name}: ${line.length <= LINE_CAP ? line : `${line.slice(0, LINE_CAP - 1)}…`}`;
};

const HEADING = /^#{1,6}\s/;

/**
 * The owner's part of a character doc written before it had two: its lines that no default Kin
 * shipped for its seat (`shipped`), in order. A heading stays only above a line kept under it, and
 * the agent's name heading goes, as Kin's part carries it. No `shipped` lines: the doc is all his.
 */
export const ownersPart = (body: string, name: string, shipped: ReadonlyArray<string>) => {
  if (shipped.length === 0) return body;
  const known = new Set(shipped.map((line) => line.trim()));
  const lines = body.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  const title = lines[first]?.trim() ?? "";
  if (title === `# ${name}` || (title.startsWith("# ") && known.has(title))) lines.splice(first, 1);
  const kept: Array<string> = [];
  let heading: string | undefined;
  for (const line of lines) {
    const text = line.trim();
    if (HEADING.test(text)) heading = line;
    else if (text === "") {
      if (heading === undefined && kept.length > 0 && kept.at(-1) !== "") kept.push("");
    } else if (!known.has(text)) {
      if (heading !== undefined) {
        if (kept.length > 0 && kept.at(-1) !== "") kept.push("");
        kept.push(heading, "");
        heading = undefined;
      }
      kept.push(line);
    }
  }
  return kept.join("\n").trim();
};

/** A character for an agent no default fits, until the owner and the agent shape a real one. */
const starterCharacter = (name: string, domain: string, charter: string) => {
  const job = charter.trim() === "" ? `You run ${domain} for the company.` : charter.trim();
  return `# ${name}

To colleagues: Runs ${domain}. Talk to it plainly about its own lane.

You are ${name}. ${job}

${STARTER} In your next chat with the owner, offer them a sharper one in two or three lines (an archetype, what you love, what you push back on, how you write) and, once they agree, save it over this paragraph with doc_edit.

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

/** Gives every live agent without one its character doc: the owner's part, empty, else a starter. */
export const seedCharacters = Effect.fn("KinCharacters.seed")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const have = new Set(
    (yield* sql<{ originKey: string }>`SELECT origin_key AS "originKey" FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'docs' AND origin_key LIKE ${`${ORIGIN}%`}
        ORDER BY origin_key`).map((row) => row.originKey),
  );
  let made = 0;
  const money = yield* companyMoney(orgId);
  for (const lead of yield* liveLeads(sql, orgId)) {
    const originKey = characterOrigin(lead.agentId);
    if (have.has(originKey)) continue;
    const fixed = defaultCharacterFor(lead.domain, money);
    yield* Docs.create(
      orgId,
      system,
      {},
      {
        title: `${lead.name}'s character`,
        body: fixed === undefined ? starterCharacter(lead.name, lead.domain, lead.charter) : "",
        owner: { _tag: "agent", agentId: lead.agentId as KinAgentId },
        summary:
          fixed === undefined ? "Kin's starter character" : "Your part, empty until you write it",
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
  /** The doc: the owner's part, or the whole character with no `kin`. */
  readonly body: string;
  /** Kin's part, as this release ships it; undefined when the agent's area has no default. */
  readonly kin: string | undefined;
};

type Stored = {
  readonly agentId: string;
  readonly name: string;
  readonly domain: string;
  readonly key: string;
  readonly body: string;
  readonly version: number;
};
/** Live agents' character docs as they stand, archived ones left out; one agent's with `agentId`. */
const stored = (orgId: KinOrgId, agentId?: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<Stored>`SELECT l.agent_id AS "agentId", l.name, l.domain, r.key, v.body, v.version
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    JOIN kin_records r ON r.org_id = l.org_id AND r.register_id = 'docs'
      AND r.origin_key = ${ORIGIN} || l.agent_id AND r.state <> 'dropped'
    JOIN kin_doc_versions v ON v.org_id = r.org_id AND v.record_id = r.record_id
      AND v.version = (SELECT MAX(w.version) FROM kin_doc_versions w
        WHERE w.org_id = v.org_id AND w.record_id = v.record_id)
    WHERE l.org_id = ${orgId} AND a.role = 'lead' AND a.retired_at IS NULL
      AND (${agentId ?? null} IS NULL OR l.agent_id = ${agentId ?? null})
    ORDER BY a.created_at, l.agent_id`,
  );

/** The live agents' current characters, both parts, archived ones left out; one agent's with `agentId`. */
export const characters = Effect.fn("KinCharacters.read")(function* (
  orgId: KinOrgId,
  agentId?: string,
) {
  const money = yield* companyMoney(orgId);
  return (yield* stored(orgId, agentId)).map((row): Character => ({
    agentId: row.agentId,
    name: row.name,
    key: row.key,
    body: row.body,
    kin: kinPartFor(row.domain, row.name, money),
  }));
});

/**
 * The owner's part of an agent's character, from its page or the host (`kin lead character`):
 * written as a new version over whatever is there, so the doc's history can still bring the old
 * one back. Text that opens with Kin's part, as a page that knows one field sends, keeps the rest.
 */
export const setCharacter = Effect.fn("KinCharacters.set")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  body: string,
  /** Someone editing it on the agent's page; absent for the host's command. */
  by?: KinPersonId,
) {
  yield* seedCharacters(orgId);
  const [row] = yield* characters(orgId, agentId);
  if (row === undefined) return { outcome: "no-agent" as const };
  const now = yield* Clock.currentTimeMillis;
  const own =
    row.kin !== undefined && body.trim().startsWith(row.kin)
      ? body.trim().slice(row.kin.length)
      : body;
  const written = yield* Docs.replaceBody(
    orgId,
    {
      actor: by === undefined ? { _tag: "system" } : { _tag: "person", personId: by },
      via: "owner",
    },
    {},
    { key: row.key },
    {
      body: own.trim(),
      summary: by === undefined ? "Set from the host" : "Edited on its page",
      originKey: `kin-character-set:${agentId}:${now}`,
    },
  );
  return { outcome: written.created ? ("set" as const) : ("unchanged" as const), key: row.key };
});

/** Claimed once per company in the told ledger, which a chat clear never touches. */
const SPLIT = { party: "kin:company", fact: "kin-character-two-parts", event: "split" };
/** The card an earlier release posted to choose between Growth's old and new character. */
const OLD_CARD = "kin-character-default:growth:2:";

/**
 * Once per company, at start: each live agent's character doc, written when it held the whole
 * character, keeps only the owner's own lines (`ownersPart`) as a new version by Kin, so the whole
 * text before is one step back in its history. A doc changed since it was read is left alone.
 * The card that asked him to choose closes, if still open. Returns how many docs it rewrote.
 */
export const splitCharacters = Effect.fn("KinCharacters.split")(function* (
  orgId: KinOrgId,
  chat: Pick<KinChatService["Service"], "closeReplaced">,
) {
  const sql = yield* SqlClient.SqlClient;
  const money = yield* companyMoney(orgId);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const claim = yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id,
          sig, told_at)
        VALUES (${orgId}, ${SPLIT.party}, ${SPLIT.fact}, ${SPLIT.event}, 'told', ${now})
        ON CONFLICT DO NOTHING RETURNING fact_key`;
      if (claim.length === 0) return 0;
      let split = 0;
      for (const doc of yield* stored(orgId)) {
        const own = ownersPart(doc.body, doc.name, shippedLines(doc.domain, money));
        if (own === doc.body.trim()) continue;
        const written = yield* Docs.replaceBody(
          orgId,
          system,
          {},
          { key: doc.key },
          {
            body: own,
            summary: "Kept your own lines; Kin's part is now separate",
            originKey: `kin-character-split:${doc.agentId}`,
            atVersion: doc.version,
          },
        );
        if (written.created) split += 1;
      }
      const widgetId = KinWidgetId.make(`${OLD_CARD}${orgId}`);
      const [card] = yield* sql<{ messageId: string }>`SELECT message_id AS "messageId"
        FROM kin_widgets WHERE org_id = ${orgId} AND widget_id = ${widgetId} ORDER BY message_id`;
      if (card !== undefined) {
        // Its message id is `<card>:<kind>:<agent>:<doc>:<version>`.
        const agentId = card.messageId
          .slice(widgetId.length + 1)
          .split(":")
          .slice(1, -2)
          .join(":");
        const [lead] = yield* sql<{ name: string }>`SELECT name FROM kin_leads
          WHERE org_id = ${orgId} AND agent_id = ${agentId} ORDER BY agent_id`;
        yield* chat.closeReplaced({
          orgId,
          widgetId,
          outcome: {
            title: "Closed",
            text: `${lead?.name ?? "This agent"} now has Kin's part and yours; nothing to choose.`,
          },
        });
      }
      return split;
    }),
  );
});
