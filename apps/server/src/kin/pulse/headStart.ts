import type { KinOrgId, KinPulseFact } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { liveConnections } from "../connections/ConnectionRows.ts";
import { mailProviderOf } from "../connections/mailProviders.ts";
import { clientRecipients } from "../work/billingContact.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";

/** Facts whose head start is a word to the client: who to write to comes with them. */
const TO_CLIENT = new Set<KinPulseFact["sense"]>([
  "invoice_overdue",
  "quote_unanswered",
  "retainer_due",
  "renewal_due",
  "client_quiet",
  "client_cold",
  "client_waiting_on_us",
  "theirs_late",
]);
/** Facts about money a client owes: they go to its billing contact when it has one. */
const BILLED = new Set<KinPulseFact["sense"]>(["invoice_overdue", "retainer_due"]);
/** Facts about an entry Kin makes a file for: the latest one comes with them, to attach. */
const WITH_FILE = new Set<KinPulseFact["sense"]>([
  "invoice_overdue",
  "quote_unanswered",
  "retainer_due",
]);
/** Client facts carry their history instead (`clientHistory`). */
const ABOUT_CLIENT = new Set<KinPulseFact["sense"]>([
  "client_quiet",
  "client_cold",
  "client_waiting_on_us",
]);
const SAID_CAP = 200;

export interface HeadStart {
  readonly writeTo?:
    | { readonly name: string; readonly email: string; readonly billing?: true }
    | string;
  readonly document?:
    | { readonly key: string; readonly file: string; readonly draft: boolean }
    | string;
  readonly lastSaid?: { readonly on: string; readonly by: string; readonly text: string };
}

/**
 * What a colleague needs to start on each fact, from the org's own rows: the client's contact
 * with an address (or that there is none), the file Kin made for the entry, the last comment on
 * it; and, once per section, the mail accounts a draft can go from. Owner-only, like the pulse.
 */
export const headStarts = Effect.fn("KinPulse.headStarts")(function* (
  orgId: KinOrgId,
  facts: ReadonlyArray<KinPulseFact>,
) {
  const sql = yield* SqlClient.SqlClient;
  const recordIds = [
    ...new Set(
      facts.flatMap((fact) => (fact.subject.recordId === undefined ? [] : [fact.subject.recordId])),
    ),
  ];
  const byFact = new Map<string, HeadStart>();
  if (recordIds.length === 0) return { byFact, mail: undefined };
  const clients = new Map(
    (yield* sql<{ recordId: string; partyId: string | null; partyTitle: string | null }>`
      SELECT r.record_id AS "recordId", c.record_id AS "partyId", c.title AS "partyTitle"
      FROM kin_records r
      LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id
      LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.register_id = 'clients'
        AND c.record_id = CASE WHEN r.register_id = 'clients' THEN r.record_id
          ELSE COALESCE(r.party_id, p.party_id) END
      WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in(recordIds)}
      ORDER BY r.record_id`).map((row) => [row.recordId, row]),
  );
  const partyIds = [
    ...new Set(
      facts.flatMap((fact) => {
        const partyId = TO_CLIENT.has(fact.sense)
          ? clients.get(fact.subject.recordId ?? "")?.partyId
          : undefined;
        return partyId === undefined || partyId === null ? [] : [partyId];
      }),
    ),
  ];
  // The contact a draft goes to: for money owed, the client's billing contact first.
  const contacts = yield* clientRecipients(orgId, partyIds, false);
  const billed = yield* clientRecipients(
    orgId,
    [
      ...new Set(
        facts.flatMap((fact) => (BILLED.has(fact.sense) ? [fact.subject.recordId ?? ""] : [])),
      ),
    ].flatMap((id) => clients.get(id)?.partyId ?? []),
    true,
  );
  const fileIds = facts.flatMap((fact) =>
    WITH_FILE.has(fact.sense) && fact.subject.recordId !== undefined ? [fact.subject.recordId] : [],
  );
  const files = new Map<string, { key: string; file: string; draft: boolean }>();
  if (fileIds.length > 0)
    for (const row of yield* sql<{ entryId: string; key: string; file: string; draft: number }>`
      SELECT j.entry_record_id AS "entryId", d.key, json_extract(v.file_json, '$.name') AS file,
        COALESCE(json_extract(v.file_json, '$.draft'), 0) AS draft
      FROM kin_doc_jobs j
      JOIN kin_doc_versions v ON v.org_id = j.org_id AND v.worker_id = j.worker_id
      JOIN kin_records d ON d.org_id = v.org_id AND d.record_id = v.record_id
      WHERE j.org_id = ${orgId} AND j.entry_record_id IN ${sql.in(fileIds)}
        AND v.file_json IS NOT NULL AND d.state <> 'dropped'
      ORDER BY j.entry_record_id, v.created_at DESC, v.version DESC`)
      if (!files.has(row.entryId))
        files.set(row.entryId, { key: row.key, file: row.file, draft: row.draft === 1 });
  const saidIds = facts.flatMap((fact) =>
    !ABOUT_CLIENT.has(fact.sense) && fact.subject.recordId !== undefined
      ? [fact.subject.recordId]
      : [],
  );
  const said = new Map<string, { at: number; by: string; text: string }>();
  if (saidIds.length > 0)
    for (const row of yield* sql<{ recordId: string; at: number; by: string | null; text: string }>`
      SELECT m.record_id AS "recordId", m.created_at AS at, m.body AS text,
        COALESCE(p.display_name, a.display_name) AS by
      FROM kin_record_comments m
      LEFT JOIN kin_people p ON m.author_kind = 'person' AND p.org_id = m.org_id
        AND p.person_id = m.author_id
      LEFT JOIN kin_agents a ON m.author_kind = 'agent' AND a.org_id = m.org_id
        AND a.agent_id = m.author_id
      WHERE m.org_id = ${orgId} AND m.record_id IN ${sql.in(saidIds)} AND m.removed_at IS NULL
      ORDER BY m.record_id, m.seq DESC`)
      if (!said.has(row.recordId))
        said.set(row.recordId, { at: row.at, by: row.by ?? "someone", text: row.text });
  const zone = said.size === 0 ? "UTC" : yield* ownerZone(orgId);
  for (const fact of facts) {
    // A renewal before its draft day is only mentioned: nothing to start on yet.
    if (fact.stage === "heads_up") continue;
    const recordId = fact.subject.recordId;
    if (recordId === undefined) continue;
    const client = clients.get(recordId);
    const picked =
      client?.partyId == null
        ? undefined
        : (BILLED.has(fact.sense) ? billed : contacts).get(client.partyId);
    const contact =
      picked === undefined
        ? undefined
        : {
            name: picked.name,
            email: picked.email,
            ...(picked.billing ? { billing: true as const } : {}),
          };
    const writeTo = !TO_CLIENT.has(fact.sense)
      ? undefined
      : contact !== undefined
        ? contact
        : client?.partyId == null
          ? "no client on it, so nobody to write to"
          : `${client.partyTitle ?? "this client"} has no contact with an email`;
    const document = !WITH_FILE.has(fact.sense)
      ? undefined
      : (files.get(recordId) ?? "no document made for it yet");
    const last = said.get(recordId);
    const start: HeadStart = {
      ...(writeTo === undefined ? {} : { writeTo }),
      ...(document === undefined ? {} : { document }),
      ...(last === undefined
        ? {}
        : {
            lastSaid: {
              on: dayIn(last.at, zone),
              by: last.by,
              text: Array.from(last.text.trim()).slice(0, SAID_CAP).join(""),
            },
          }),
    };
    if (Object.keys(start).length > 0) byFact.set(fact.key, start);
  }
  const wantsMail = [...byFact.values()].some((start) => typeof start.writeTo === "object");
  return { byFact, mail: wantsMail ? yield* mailAccounts(orgId) : undefined };
});

/** The mail accounts a draft can go from now, or that there is none. */
const mailAccounts = Effect.fn("KinPulse.mailAccounts")(function* (orgId: KinOrgId) {
  const ready = (yield* liveConnections(orgId)).filter(
    (row) => mailProviderOf(row) !== undefined && row.pausedAt === null && row.state === "active",
  );
  return ready.length === 0
    ? "no mail account is connected"
    : ready.map((row) => ({
        connection: row.connectionId,
        account: row.accountLabel ?? row.label,
      }));
});
