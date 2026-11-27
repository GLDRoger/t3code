import {
  KinChatError,
  KinChatId,
  KinMessageId,
  KinPersonId,
  type KinOrgId,
  type KinPromiseFrom,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { fieldText, parseFields } from "./lists.ts";
import { iso } from "./recordRows.ts";
import { crmSees } from "./teamView.ts";

/**
 * Promises both ways: an obligation's source (`fields.from`), the deal it sits on, and who holds
 * one the client owes us. Every rule here is plain code over stored rows.
 */

const FROM_MAX = 280;
const SOURCE = /^(meeting|mail|chat):(\S{1,200})$/;

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const missing = (message: string) => new KinChatError({ reason: "not_found", message });

/** Where a promise was made, as stored: `meeting:<touch>`, `mail:<touch>`, `chat:<message>`, or words. */
const fromParts = (text: string) => {
  const found = SOURCE.exec(text.trim());
  if (found === null) return { kind: "note" as const, note: text.trim() };
  return { kind: found[1] as "meeting" | "mail" | "chat", id: found[2]! };
};

/**
 * The stored form of `from`, checked against this org's rows: a meeting or mail is a contact
 * logged on this client, a chat is a message here. Anything else is the person's own words.
 */
export const checkedFrom = Effect.fn("KinPromises.checkedFrom")(function* (
  orgId: KinOrgId,
  partyId: string | null | undefined,
  text: string,
) {
  const parts = fromParts(text);
  const sql = yield* SqlClient.SqlClient;
  switch (parts.kind) {
    case "note": {
      if (parts.note === "") return yield* invalid("Say where it was promised.");
      if (parts.note.length > FROM_MAX)
        return yield* invalid(`Say where it was promised in under ${FROM_MAX} characters.`);
      return parts.note;
    }
    case "meeting":
    case "mail": {
      const [touch] =
        partyId === null || partyId === undefined
          ? []
          : yield* sql<{ id: string }>`SELECT touch_id AS id FROM kin_client_touches
              WHERE org_id = ${orgId} AND touch_id = ${parts.id} AND party_id = ${partyId}
                AND removed_at IS NULL`;
      if (touch === undefined)
        return yield* missing(
          `No contact ${parts.id.slice(0, 60)} logged on its client: a ${parts.kind} it came from is one logged there.`,
        );
      return `${parts.kind}:${touch.id}`;
    }
    case "chat": {
      const [message] = yield* sql<{ id: string }>`SELECT message_id AS id FROM kin_messages
        WHERE org_id = ${orgId} AND message_id = ${parts.id}`;
      if (message === undefined) return yield* missing(`No message ${parts.id.slice(0, 60)}.`);
      return `chat:${message.id}`;
    }
  }
});

/**
 * The deal a new entry sits on: a deal here, open or not, that `seenBy` reaches in Clients (all,
 * for the owner level), on the entry's client when it has one. Returns the deal and its client.
 */
export const dealFor = Effect.fn("KinPromises.dealFor")(function* (
  orgId: KinOrgId,
  key: string,
  partyId: string | null | undefined,
  seenBy: ReadonlyArray<KinPersonId>,
) {
  const sql = yield* SqlClient.SqlClient;
  const [deal] = yield* sql<{
    recordId: string;
    key: string;
    partyId: string | null;
    sensitive: number;
  }>`SELECT r.record_id AS "recordId", r.key, r.party_id AS "partyId", r.sensitive
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.key = ${key.toUpperCase()} AND r.register_id = 'deals'
      AND ${seenBy.length === 0 ? sql`1 = 1` : sql.and(seenBy.map((person) => crmSees(sql, person)))}`;
  if (deal === undefined) return yield* missing(`No deal ${key.slice(0, 40)}.`);
  if (partyId !== undefined && partyId !== null && deal.partyId !== partyId)
    return yield* invalid(`${deal.key} is another client's deal.`);
  return deal;
});

/** The link a promise has to its deal (design 3.3: `record`, `relates`). */
export const dealLink = (deal: { readonly recordId: string; readonly key: string }) => ({
  kind: "record" as const,
  target: deal.recordId,
  relation: "relates" as const,
  label: deal.key,
});

/**
 * Who holds what a client owes us: whoever looks after the client while they are still here;
 * for an agent's client, nobody's or a removed person's, or on a deal kept private, the owner.
 */
export const theirsHolder = Effect.fn("KinPromises.theirsHolder")(function* (
  orgId: KinOrgId,
  partyId: string,
  deal?: { readonly sensitive: number },
) {
  if (deal?.sensitive === 1) return yield* holderFor(orgId, "", "");
  const sql = yield* SqlClient.SqlClient;
  const [client] = yield* sql<{ ownerKind: string; ownerId: string }>`SELECT
      owner_kind AS "ownerKind", owner_id AS "ownerId" FROM kin_records
    WHERE org_id = ${orgId} AND record_id = ${partyId} AND register_id = 'clients'`;
  return yield* holderFor(orgId, client?.ownerKind ?? "", client?.ownerId ?? "");
});

/** `theirsHolder` for a client looked after by this principal. */
export const holderFor = Effect.fn("KinPromises.holderFor")(function* (
  orgId: KinOrgId,
  ownerKind: string,
  ownerId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [looks] =
    ownerKind === "person"
      ? yield* sql<{ personId: string }>`SELECT person_id AS "personId" FROM kin_people
          WHERE org_id = ${orgId} AND person_id = ${ownerId} AND removed_at IS NULL`
      : [];
  if (looks !== undefined)
    return { _tag: "person", personId: KinPersonId.make(looks.personId) } as KinWorkPrincipal;
  const [owner] = yield* sql<{ personId: string }>`SELECT person_id AS "personId" FROM kin_people
    WHERE org_id = ${orgId} AND access = 'owner' AND removed_at IS NULL
    ORDER BY person_id LIMIT 1`;
  return owner === undefined
    ? undefined
    : ({ _tag: "person", personId: KinPersonId.make(owner.personId) } as KinWorkPrincipal);
});

/**
 * Each promise's source as these people may follow it: the day it happened, and a chat message
 * only where every one of them is still in that chat. With no people (an agent) it is words only.
 */
export const fromsOf = Effect.fn("KinPromises.fromsOf")(function* (
  orgId: KinOrgId,
  recordIds: ReadonlyArray<string>,
  readers: ReadonlyArray<string>,
) {
  const out = new Map<string, KinPromiseFrom>();
  if (recordIds.length === 0) return out;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string; fieldsJson: string }>`SELECT record_id AS
      "recordId", fields_json AS "fieldsJson" FROM kin_records
    WHERE org_id = ${orgId} AND record_id IN ${sql.in([...new Set(recordIds)])}
      AND json_extract(fields_json, '$.from') IS NOT NULL
    ORDER BY record_id`;
  for (const row of rows) {
    const text = fieldText(parseFields(row.fieldsJson), "from");
    if (text === null) continue;
    const parts = fromParts(text);
    if (parts.kind === "note") {
      out.set(row.recordId, {
        kind: "note",
        note: parts.note as NonNullable<KinPromiseFrom["note"]>,
      });
      continue;
    }
    if (parts.kind !== "chat") {
      const [touch] = yield* sql<{ at: number }>`SELECT at FROM kin_client_touches
        WHERE org_id = ${orgId} AND touch_id = ${parts.id}`;
      out.set(row.recordId, {
        kind: parts.kind,
        ...(touch === undefined ? {} : { at: iso(touch.at) }),
      });
      continue;
    }
    const [message] = yield* sql<{ chatId: string; at: string }>`SELECT chat_id AS "chatId",
        created_at AS at FROM kin_messages WHERE org_id = ${orgId} AND message_id = ${parts.id}`;
    if (message === undefined) {
      out.set(row.recordId, { kind: "chat" });
      continue;
    }
    const members =
      readers.length === 0
        ? []
        : yield* sql<{ personId: string }>`SELECT DISTINCT person_id AS "personId"
            FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${message.chatId}
              AND principal_kind = 'person' AND left_at IS NULL
              AND person_id IN ${sql.in([...readers])}
            ORDER BY person_id`;
    const opens = readers.length > 0 && members.length === new Set(readers).size;
    out.set(row.recordId, {
      kind: "chat",
      at: iso(Date.parse(message.at)),
      ...(opens
        ? { chatId: KinChatId.make(message.chatId), messageId: KinMessageId.make(parts.id) }
        : {}),
    });
  }
  return out;
});

/** A client's open promises it owes us, held by `holder`: what moves when the client is handed over. */
export const theirsHeldBy = Effect.fn("KinPromises.theirsHeldBy")(function* (
  orgId: KinOrgId,
  partyId: string,
  holder: KinWorkPrincipal,
) {
  const sql = yield* SqlClient.SqlClient;
  const id = holder._tag === "person" ? holder.personId : holder.agentId;
  const rows = yield* sql<{ key: string }>`SELECT key FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'work' AND party_id = ${partyId}
      AND category = 'obligation' AND side = 'theirs' AND state IN ('open', 'doing', 'waiting')
      AND owner_kind = ${holder._tag} AND owner_id = ${id}
    ORDER BY key`;
  return rows.map((row) => row.key);
});
