import {
  KIN_MESSAGE_LINKS_CAP,
  type KinChatMember,
  type KinMessage,
  type KinMessageLink,
  type KinMessageLinkTarget,
  type KinOrgId,
  type KinPersonId,
  type KinTurnChanges,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { turnChanges } from "../lead/turnChanges.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { KIN_OWNER_LEVEL, seenBy, viewerOfPeople, type KinViewer } from "../work/teamView.ts";

/** A name Kin knows and where it goes. */
export interface LinkName {
  readonly name: string;
  readonly to: KinMessageLinkTarget;
  readonly note: string | null;
  /** An agent's name also links as "finance chat", in any case. */
  readonly chat?: boolean;
}

const KEY = /(?<![\p{L}\p{N}-])([A-Z][A-Z0-9]{0,7}-[1-9]\d{0,8})(?![\p{L}\p{N}-])/gu;
const FENCED = /^\s{0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:^\s{0,3}\1[^\n]*$|(?![\s\S]))/gm;
const INLINE_CODE = /`[^`\n]*`/g;
const MARKDOWN_LINK = /!?\[[^\]\n]*\]\([^)\n]*\)/g;
const BARE_URL = /<?https?:\/\/[^\s<>()]+>?/g;
const SETTINGS = /(?<![\p{L}\p{N}])Settings(?![\p{L}\p{N}])/gu;
// Shorter names are ordinary words too often ("HR", "Ops" stay plain).
const MIN_NAME = 3;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blank = (match: string) => " ".repeat(match.length);

/** The text a link may sit in: no code, no link someone already wrote, no web address. */
const linkableText = (body: string) =>
  body
    .replace(FENCED, blank)
    .replace(INLINE_CODE, blank)
    .replace(MARKDOWN_LINK, blank)
    .replace(BARE_URL, blank);

/** The document numbers a message writes, such as INV-12 or W-3, in order. */
export const keysIn = (body: string): ReadonlyArray<string> => [
  ...new Set([...linkableText(body).matchAll(KEY)].map((match) => match[1]!)),
];

// A printed document number has a digit and a separator: INV/26-27/004, PO-2026-17.
const NUMBER = /(?<![\p{L}\p{N}/-])([\p{L}\p{N}]+(?:[/-][\p{L}\p{N}]+)+)(?![\p{L}\p{N}/-])/gu;

/** What in a message could be a printed number, for looking those up and no others. */
const numbersIn = (body: string): ReadonlyArray<string> =>
  [...linkableText(body).matchAll(NUMBER)]
    .map((match) => match[1]!)
    .filter((token) => /\d/.test(token));

const around = (pattern: string, flags: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, flags);

/**
 * What a message names among `names` and `keys`, by exact spelling: keys (INV-1) and printed
 * numbers (INV/26-27/004) of entries, and whole names of agents, people, clients, projects and deals,
 * case and all ("Finance", not "finance"), longest first, each once. An agent also matches as
 * "<name> chat" in any case. Built once for a batch; its patterns run only where a name appears.
 */
export function linkMatcher(
  names: ReadonlyArray<LinkName>,
  keys: ReadonlyMap<string, Omit<KinMessageLink, "text">>,
  settings: boolean,
) {
  const usable = names
    .filter((one) => one.name.trim().length >= MIN_NAME)
    .sort((a, b) => b.name.length - a.name.length)
    .map((one) => ({
      name: one.name,
      lower: one.name.toLowerCase(),
      link: { to: one.to, note: one.note },
      exact: around(escape(one.name), "gu"),
      chat: one.chat === true ? around(`${escape(one.name)}\\s+chat`, "giu") : null,
    }));
  return (body: string): ReadonlyArray<KinMessageLink> => {
    const text = linkableText(body);
    const lower = text.toLowerCase();
    const found: Array<KinMessageLink & { readonly at: number }> = [];
    const taken: Array<readonly [number, number]> = [];
    const free = (at: number, end: number) => taken.every(([from, to]) => end <= from || at >= to);
    const add = (at: number, written: string, link: Omit<KinMessageLink, "text">) => {
      const end = at + written.length;
      if (!free(at, end) || found.some((one) => one.text === written)) return false;
      taken.push([at, end]);
      found.push({ ...link, text: written, at });
      return true;
    };
    // The first place it is written that a longer name hasn't taken.
    const addFirst = (pattern: RegExp, link: Omit<KinMessageLink, "text">) => {
      for (const match of text.matchAll(pattern))
        if (add(match.index, body.slice(match.index, match.index + match[0].length), link)) return;
    };
    for (const one of usable) {
      if (!lower.includes(one.lower)) continue;
      if (one.chat !== null) addFirst(one.chat, one.link);
      if (text.includes(one.name)) addFirst(one.exact, one.link);
    }
    for (const match of text.matchAll(KEY)) {
      const link = keys.get(match[1]!);
      if (link !== undefined) add(match.index, match[1]!, link);
    }
    if (settings) addFirst(SETTINGS, { to: { _tag: "settings" }, note: null });
    return found
      .sort((a, b) => a.at - b.at)
      .slice(0, KIN_MESSAGE_LINKS_CAP)
      .map(({ at: _at, ...link }) => link);
  };
}

const STATE_WORDS: Record<string, string> = {
  open: "Open",
  doing: "In progress",
  waiting: "Waiting",
  done: "Done",
  dropped: "Dropped",
};
export const kindOf = (
  register: string,
): Extract<KinMessageLinkTarget, { _tag: "record" }>["kind"] =>
  register === "work" || register === "milestones"
    ? "task"
    : register === "clients"
      ? "client"
      : register === "projects"
        ? "project"
        : register === "docs"
          ? "doc"
          : "entry";
const noteOf = (row: {
  readonly title: string;
  readonly register: string;
  readonly state: string;
}) =>
  kindOf(row.register) === "task"
    ? `${row.title} · ${STATE_WORDS[row.state] ?? row.state}`
    : row.title;

/** What this viewer may open, read once for a batch of messages. */
const linkSources = Effect.fn("KinMessageLinks.sources")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  viewer: KinViewer,
  keys: ReadonlyArray<string>,
  numbers: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  // Their own direct chats with agents: the chat a name like "Finance" opens.
  const agents = yield* sql<{ name: string; chatId: string }>`SELECT a.display_name AS name,
      c.chat_id AS "chatId"
    FROM kin_chats c
    JOIN kin_chat_members me ON me.org_id = c.org_id AND me.chat_id = c.chat_id
      AND me.principal_kind = 'person' AND me.person_id = ${personId} AND me.left_at IS NULL
    JOIN kin_chat_members am ON am.org_id = c.org_id AND am.chat_id = c.chat_id
      AND am.principal_kind = 'agent' AND am.left_at IS NULL
    JOIN kin_agents a ON a.org_id = c.org_id AND a.agent_id = am.agent_id AND a.retired_at IS NULL
    WHERE c.org_id = ${orgId} AND c.kind = 'direct' AND c.archived_at IS NULL
    ORDER BY c.created_at`;
  const people = yield* sql<{ name: string; personId: string }>`SELECT display_name AS name,
      person_id AS "personId" FROM kin_people
    WHERE org_id = ${orgId} AND removed_at IS NULL AND person_id <> ${personId}`;
  const named = yield* sql<{ key: string; title: string; register: string; state: string }>`SELECT
      r.key, r.title, r.register_id AS register, r.state FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id IN ('clients', 'projects', 'deals')
      AND r.state <> 'dropped' AND ${seenBy(sql, viewer)}`;
  // A document's own number, such as INV/26-27/004, as it is printed and mailed.
  const numbered =
    numbers.length === 0
      ? []
      : yield* sql<{
          key: string;
          title: string;
          register: string;
          state: string;
          number: string;
        }>`SELECT
            r.key, r.title, r.register_id AS register, r.state,
            json_extract(r.fields_json, '$.number') AS number FROM kin_records r
          WHERE r.org_id = ${orgId} AND json_extract(r.fields_json, '$.number') IS NOT NULL
            AND json_extract(r.fields_json, '$.number') IN ${sql.in(numbers)}
            AND ${seenBy(sql, viewer)}`;
  const keyed =
    keys.length === 0
      ? []
      : yield* sql<{ key: string; title: string; register: string; state: string }>`SELECT
          r.key, r.title, r.register_id AS register, r.state FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.key IN ${sql.in(keys)} AND ${seenBy(sql, viewer)}`;
  const record = (row: { key: string; title: string; register: string; state: string }) => ({
    to: { _tag: "record" as const, key: row.key, kind: kindOf(row.register) },
    note: noteOf(row),
  });
  const seenAgents = new Set<string>();
  const names: Array<LinkName> = [
    ...agents.flatMap((row) => {
      if (seenAgents.has(row.name)) return [];
      seenAgents.add(row.name);
      return [
        {
          name: row.name,
          to: { _tag: "chat" as const, chatId: row.chatId },
          note: null,
          chat: true,
        },
      ];
    }),
    ...people.map((row) => ({
      name: row.name,
      to: { _tag: "person" as const, personId: row.personId },
      note: null,
    })),
    ...named
      .filter((row) => row.register !== "deals")
      .map((row) => ({ name: row.title, ...record(row) })),
    ...numbered.map((row) => ({ name: row.number, ...record(row) })),
  ];
  // A deal named like its client, or anything else, leaves that name to it.
  const others = new Set(names.map((one) => one.name));
  for (const row of named)
    if (row.register === "deals" && !others.has(row.title))
      names.push({ name: row.title, ...record(row) });
  // Two things by one name would be a guess, so neither links.
  const counts = new Map<string, number>();
  for (const one of names) counts.set(one.name, (counts.get(one.name) ?? 0) + 1);
  return {
    names: names.filter((one) => counts.get(one.name) === 1),
    keys: new Map(keyed.map((row) => [row.key, record(row)])),
  };
});

/** A name written in place of an entry's key, kept so the name still links to it. */
const NamedKeys = Schema.Array(Schema.Struct({ text: Schema.String, key: Schema.String }));
export type NamedKey = (typeof NamedKeys.Type)[number];
const decodeNames = Schema.decodeUnknownOption(Schema.fromJsonString(NamedKeys));
export const encodeNames = Schema.encodeSync(Schema.fromJsonString(NamedKeys));

/** What every person in the chat may see: owner level only when all of them are. */
export const chatReaders = Effect.fn("KinMessageLinks.chatReaders")(function* (
  orgId: KinOrgId,
  chatId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const members = yield* sql<{ personId: KinPersonId }>`SELECT person_id AS "personId"
    FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${chatId}
      AND principal_kind = 'person' AND left_at IS NULL ORDER BY person_id`;
  const restricted: Array<KinPersonId> = [];
  for (const { personId } of members)
    if (!(yield* ownerLevel(orgId, personId))) restricted.push(personId);
  return restricted.length === 0 ? KIN_OWNER_LEVEL : viewerOfPeople(restricted);
});

/**
 * An agent's message for people with each bare entry key (W-3, EXP-12) written as people name
 * it: the entry's printed number, else its title. Only keys every person in the chat may see
 * change; code, links and printed numbers (INV/26-27/004, a number that looks like a key) don't.
 */
export const nameKeys = Effect.fn("KinMessageLinks.nameKeys")(function* (
  orgId: KinOrgId,
  chatId: string,
  body: string,
) {
  const keys = keysIn(body);
  if (keys.length === 0) return { body, names: [] as ReadonlyArray<NamedKey> };
  const sql = yield* SqlClient.SqlClient;
  const viewer = yield* chatReaders(orgId, chatId);
  const rows = yield* sql<{ key: string; title: string; number: string | null }>`SELECT r.key,
      r.title, json_extract(r.fields_json, '$.number') AS number FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.key IN ${sql.in(keys)} AND ${seenBy(sql, viewer)}`;
  const printed = new Set(
    (yield* sql<{ number: string }>`SELECT json_extract(fields_json, '$.number') AS number
      FROM kin_records WHERE org_id = ${orgId}
        AND json_extract(fields_json, '$.number') IN ${sql.in(keys)}`).map((row) => row.number),
  );
  const byKey = new Map(
    rows
      .filter((row) => !printed.has(row.key) && row.title.trim() !== "")
      .map((row) => [row.key, row]),
  );
  if (byKey.size === 0) return { body, names: [] as ReadonlyArray<NamedKey> };
  const names: Array<NamedKey> = [];
  const matches = [...linkableText(body).matchAll(KEY)].filter((m) => byKey.has(m[1]!));
  let out = body;
  // From the end, so earlier indexes stay put.
  for (const match of matches.toReversed()) {
    const row = byKey.get(match[1]!)!;
    const name = row.number ?? row.title.replace(/\s+/g, " ").trim();
    const from = match.index;
    const to = from + match[1]!.length;
    const before = out.slice(0, from);
    const after = out.slice(to);
    const lower = name.toLowerCase();
    if (row.number === null) names.push({ text: name, key: row.key });
    // "Logo files (W-3)", "W-3 (Logo files)" or "W-3: Logo files" already names it: the key goes.
    if (before.toLowerCase().endsWith(`${lower} (`) && after.startsWith(")")) {
      out = `${before.slice(0, -2)}${after.slice(1)}`;
      continue;
    }
    const lead = /^(?: \(|:? | [–-] )/.exec(after)?.[0];
    if (lead !== undefined && after.slice(lead.length).toLowerCase().startsWith(lower)) {
      const rest = after.slice(lead.length + name.length);
      out = `${before}${after.slice(lead.length, lead.length + name.length)}${
        lead === " (" && rest.startsWith(")") ? rest.slice(1) : rest
      }`;
      continue;
    }
    out = `${before}${name}${after}`;
  }
  return { body: out, names: names.reverse() };
});

/**
 * Each message with the names in it this reader may open (`links`), worked out for this reader:
 * an entry they can't see, by name or number, yields nothing, the same as one that doesn't
 * exist. Agents read the text as written, so their messages come back unchanged.
 */
export const withLinks = Effect.fn("KinMessageLinks.withLinks")(function* (
  orgId: KinOrgId,
  reader: KinChatMember["principal"] | undefined,
  messages: ReadonlyArray<KinMessage>,
  // A chat list's preview has no use for what a turn changed.
  options: { readonly receipts: boolean } = { receipts: true },
) {
  if (reader?._tag !== "person") return messages;
  const texts = messages.filter(
    (message) => message.kind === "text" && message.status !== "deleted",
  );
  if (texts.length === 0) return messages;
  const owner = yield* ownerLevel(orgId, reader.personId);
  const viewer = owner ? KIN_OWNER_LEVEL : viewerOfPeople([reader.personId]);
  const sql = yield* SqlClient.SqlClient;
  const agentTexts = texts.filter((message) => message.author._tag === "agent");
  const named =
    agentTexts.length === 0
      ? []
      : (yield* sql<{ names: string }>`SELECT names_json AS names FROM kin_message_names
          WHERE org_id = ${orgId}
            AND message_id IN ${sql.in(agentTexts.map((message) => message.messageId))}`).flatMap(
          (row) => Option.getOrElse(decodeNames(row.names), (): ReadonlyArray<NamedKey> => []),
        );
  const keys = [
    ...new Set([
      ...texts.flatMap((message) => keysIn(message.body)),
      ...named.map((one) => one.key),
    ]),
  ];
  const numbers = [...new Set(texts.flatMap((message) => numbersIn(message.body)))].slice(0, 500);
  const sources = yield* linkSources(orgId, reader.personId, viewer, keys, numbers);
  // A name Kin wrote for a key links where the key did, for a reader who may open it.
  const taken = new Set(sources.names.map((one) => one.name));
  const written = new Map<string, LinkName>();
  for (const one of named) {
    const link = sources.keys.get(one.key);
    if (link !== undefined && !taken.has(one.text) && !written.has(one.text))
      written.set(one.text, { name: one.text, ...link });
  }
  const match = linkMatcher([...sources.names, ...written.values()], sources.keys, owner);
  const receipts = options.receipts
    ? yield* turnChanges(
        viewer,
        orgId,
        agentTexts.map((message) => message.messageId),
      )
    : new Map<string, KinTurnChanges>();
  return messages.map((message) => {
    if (message.kind !== "text" || message.status === "deleted") return message;
    const links = match(message.body);
    const turn = receipts.get(message.messageId);
    return {
      ...message,
      ...(links.length === 0 ? {} : { links }),
      ...(turn === undefined ? {} : { turnChanges: turn }),
    };
  });
});
