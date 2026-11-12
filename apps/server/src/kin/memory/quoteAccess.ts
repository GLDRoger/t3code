import type { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { parseDocument } from "yaml";

import { readableBy } from "../chat/sharing.ts";
import { isItemPath } from "./checkoutPaths.ts";
import { FRONT_MATTER_YAML, parseFrontMatter } from "./frontMatter.ts";

// As `LeadMemory.authority` writes the source of an item saved from a chat message.
const CHAT_SOURCE = /^kin:chat:([^:]+):message:(.+)$/;

/**
 * When each cited message `person` can open in chat now was said, by ref: a posted text message,
 * in a chat they are still in, from where they may read (`readableBy`). One deleted, or in a chat
 * they left, is missing. The one rule for every reader that shows an item's quote.
 */
export const readableSources = Effect.fn("KinMemory.readableSources")(function* (
  orgId: KinOrgId,
  person: string,
  sources: Iterable<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const cited = new Map<string, Set<string>>();
  for (const source of sources) {
    const [, chatId, messageId] = CHAT_SOURCE.exec(source) ?? [];
    if (chatId === undefined || messageId === undefined) continue;
    cited.set(chatId, (cited.get(chatId) ?? new Set()).add(messageId));
  }
  const saidAt = new Map<string, string>();
  if (cited.size === 0) return saidAt;
  const members = yield* sql<{ chatId: string; memberId: string }>`SELECT chat_id AS "chatId",
      member_id AS "memberId" FROM kin_chat_members
    WHERE org_id = ${orgId} AND principal_kind = 'person' AND person_id = ${person}
      AND left_at IS NULL AND chat_id IN ${sql.in([...cited.keys()])}
    ORDER BY chat_id, member_id`;
  for (const { chatId, memberId } of members) {
    const rows = yield* sql<{ messageId: string; createdAt: string }>`SELECT
        message_id AS "messageId", created_at AS "createdAt" FROM kin_messages
      WHERE kin_messages.org_id = ${orgId} AND kin_messages.chat_id = ${chatId}
        AND kin_messages.status = 'posted' AND kin_messages.kind = 'text'
        AND kin_messages.message_id IN ${sql.in([...(cited.get(chatId) ?? [])])}
        AND ${readableBy(sql, orgId, memberId)}
      ORDER BY kin_messages.seq`;
    for (const row of rows)
      saidAt.set(`kin:chat:${chatId}:message:${row.messageId}`, row.createdAt);
  }
  return saidAt;
});

/** Who reads a lead's own turns and its checkout: its owner, from stored rows. */
export const leadOwner = Effect.fn("KinMemory.leadOwner")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ person: string }>`SELECT owner_person_id AS person FROM kin_agents
    WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
  return row?.person;
});

/**
 * Each head as `person` may read it: its quote only while they can open the cited message.
 * Without a person, no quote is shown.
 */
export const withReadableQuotes = Effect.fn("KinMemory.withReadableQuotes")(function* <
  H extends { readonly source: string; readonly quote?: string | undefined },
>(orgId: KinOrgId, person: string | undefined, heads: ReadonlyArray<H>) {
  const quoted = heads.filter((head) => head.quote !== undefined);
  const readable =
    person === undefined || quoted.length === 0
      ? new Map<string, string>()
      : yield* readableSources(
          orgId,
          person,
          quoted.map((head) => head.source),
        );
  return heads.map((head): Omit<H, "quote"> & { readonly quote?: string | undefined } => {
    if (head.quote === undefined || readable.has(head.source)) return head;
    const { quote: _quote, ...shown } = head;
    return shown;
  });
});

const FRONT = /^((?:\uFEFF)?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$)[\s\S]*)$/;

/** The item's front matter, parsed as every reader parses it, when it has a `quote` key. */
const quotedFront = (text: string) => {
  const parts = FRONT.exec(text);
  if (parts === null) return undefined;
  const [, open = "", front = "", rest = ""] = parts;
  // Saves a YAML parse per item per read: any style of quote key holds "quote" or an escape's \.
  if (!front.includes("quote") && !front.includes("\\")) return undefined;
  const doc = parseDocument(front, FRONT_MATTER_YAML);
  if (doc.errors.length > 0 || !doc.has("quote")) return undefined;
  return { open, doc, rest };
};

/** The item's text with no `quote` in its front matter, every other field as it was. */
const withoutQuote = (text: string) => {
  const quoted = quotedFront(text);
  if (quoted === undefined) return text;
  quoted.doc.delete("quote");
  return `${quoted.open}${quoted.doc.toString().replace(/\r?\n$/, "")}${quoted.rest}`;
};

/**
 * Memory files as `person` may read them with their own tools: each item keeps its quote only
 * while they can open the cited message (`withReadableQuotes`), and one that isn't text never.
 * Returns the files that changed.
 */
export const readableFiles = Effect.fn("KinMemory.readableFiles")(function* (
  orgId: KinOrgId,
  person: string | undefined,
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
) {
  const quoted = [];
  for (const file of files) {
    if (!isItemPath(file.path) || quotedFront(file.text) === undefined) continue;
    const parsed = yield* parseFrontMatter(orgId, file.path, file.text, false, true).pipe(
      Effect.option,
    );
    // One that is not a valid item has no source anyone could open, so its quote never shows.
    quoted.push({
      ...file,
      source: parsed._tag === "Some" ? parsed.value.frontMatter.source : "",
      quote: parsed._tag === "Some" ? parsed.value.frontMatter.quote : undefined,
    });
  }
  const shown = yield* withReadableQuotes(orgId, person, quoted);
  const changed = new Map<string, string>();
  for (const [index, file] of quoted.entries())
    if (shown[index]?.quote === undefined) {
      const text = withoutQuote(file.text);
      if (text !== file.text) changed.set(file.path, text);
    }
  return changed;
});

/**
 * The files whose item quotes a message that no longer exists, each without its quote. Read
 * from what is stored, so the same sweep strips after a clear and after a crash that cut one short.
 */
export const deletedQuotes = Effect.fn("KinMemory.deletedQuotes")(function* (
  orgId: KinOrgId,
  files: ReadonlyMap<string, string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const quoted = new Map<string, { readonly source: string; readonly quote: string }>();
  for (const [path, text] of files) {
    if (!isItemPath(path) || quotedFront(text) === undefined) continue;
    const parsed = yield* parseFrontMatter(orgId, path, text, false, true).pipe(Effect.option);
    const quote = parsed._tag === "Some" ? parsed.value.frontMatter.quote : undefined;
    if (parsed._tag === "Some" && quote !== undefined)
      quoted.set(path, { source: parsed.value.frontMatter.source, quote });
  }
  const cited = new Set<string>();
  for (const { source } of quoted.values()) {
    const messageId = CHAT_SOURCE.exec(source)?.[2];
    if (messageId !== undefined) cited.add(messageId);
  }
  const present = new Set<string>();
  for (const batch of Array.from({ length: Math.ceil(cited.size / 500) }, (_, index) =>
    [...cited].slice(index * 500, index * 500 + 500),
  ))
    for (const row of yield* sql<{ chatId: string; messageId: string }>`SELECT chat_id AS "chatId",
        message_id AS "messageId" FROM kin_messages
      WHERE org_id = ${orgId} AND status <> 'deleted' AND message_id IN ${sql.in(batch)}
      ORDER BY message_id`)
      present.add(`kin:chat:${row.chatId}:message:${row.messageId}`);
  const gone = new Set(
    [...quoted]
      .filter(([, { source }]) => CHAT_SOURCE.test(source) && !present.has(source))
      .map(([path]) => path),
  );
  const stripped = new Map<string, string>();
  for (const path of gone) {
    const text = files.get(path)!;
    const without = withoutQuote(text);
    if (without !== text) stripped.set(path, without);
  }
  return stripped;
});
