import {
  KIN_CAMPAIGN_SOURCE,
  KIN_CONTACT_EXPORT_MAX,
  KIN_CONTACT_LIST_SHOWN,
  KinChatError,
  type KinCameFrom,
  type KinContactExport,
  type KinContactList,
  type KinContactListInput,
  type KinContactListRow,
  type KinMarketing,
  type KinMarketingInput,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as Crm from "./crm.ts";
import { fieldText, parseFields } from "./lists.ts";
import { inList } from "./ownerWork.ts";
import { read, reader, switchedOn } from "./ownerClients.ts";
import { notFound, selectRecords, type RecordRow } from "./recordRows.ts";
import { companyTags, spellingsOf } from "./tags.ts";
import { crmSeenBy, crmVisible, type KinViewer } from "./teamView.ts";

/**
 * Marketing's reads: the tags and places "Came from" offers, and lists. A list is a saved filter
 * read again each time, never a stored copy, and shows each reader only what they see in Clients.
 * Someone who reads names only gets no emails, phones or tags, on screen or in a file.
 */

const LISTS_NEED_CLIENTS = new KinChatError({
  reason: "not_allowed",
  message: "Lists by tag and campaign are for the owner, co-owners and teammates with Clients on.",
});

/** Every tag and every place a client came from that this reader sees in Clients. */
export const marketing = Effect.fn("KinWork.marketing")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinMarketingInput,
) {
  const viewer = yield* reader(people, input.orgId);
  if (!(yield* switchedOn(input.orgId, viewer)))
    return { tags: [], cameFrom: [] } satisfies KinMarketing;
  const sql = yield* SqlClient.SqlClient;
  const tags = [...(yield* read(companyTags(input.orgId, viewer))).values()].sort((a, b) =>
    a.localeCompare(b),
  );
  const campaigns = yield* read(sql<{ key: string; title: string }>`
    SELECT r.key, r.title FROM kin_records r
    WHERE r.org_id = ${input.orgId} AND r.register_id = 'projects' AND r.category = 'campaign'
      AND ${crmSeenBy(sql, viewer)}
    ORDER BY r.state != 'open', r.created_at DESC, r.key`);
  const words = yield* read(sql<{ source: string }>`
    SELECT DISTINCT json_extract(r.fields_json, '$.source') AS source FROM kin_records r
    WHERE r.org_id = ${input.orgId} AND r.register_id = 'clients'
      AND json_extract(r.fields_json, '$.source') IS NOT NULL
      AND json_extract(r.fields_json, '$.source') NOT LIKE ${`${KIN_CAMPAIGN_SOURCE}%`}
      AND ${crmSeenBy(sql, viewer)}
    ORDER BY lower(source), source`);
  const cameFrom = [
    ...campaigns.map((one) => ({
      source: `${KIN_CAMPAIGN_SOURCE}${one.key}`,
      label: one.title,
      campaign: true,
    })),
    ...words.map((one) => ({ source: one.source, label: one.source, campaign: false })),
  ];
  return { tags, cameFrom: cameFrom as ReadonlyArray<KinCameFrom> } satisfies KinMarketing;
});

/**
 * Which contacts a list is, as SQL over `r`, and its name: refused or unknown as the reader's
 * own reads would answer. A campaign they can't see answers as one never there.
 */
const listOf = Effect.fn("KinWork.list.of")(function* (
  input: KinContactListInput,
  viewer: KinViewer,
  details: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  const tagged = (spellings: ReadonlyArray<string>) =>
    spellings.length === 0
      ? sql`0 = 1`
      : sql`EXISTS (SELECT 1 FROM json_each(r.fields_json, '$.tags') t
          WHERE t.value IN ${sql.in(spellings)})`;
  if ("parties" in input) {
    // As the Clients list itself does, a name-only reader's filter keeps only what isn't Clients'.
    const filter = details
      ? input.parties
      : { active: input.parties.active, text: input.parties.text };
    const where = yield* Crm.partiesWhere(input.orgId, filter, viewer);
    return {
      title: undefined,
      where: sql`r.party_id IN (SELECT c.record_id FROM kin_records c
        WHERE ${sql.and([sql`c.org_id = ${input.orgId}`, sql`c.register_id = 'clients'`, ...where])})`,
    };
  }
  if (!details) return yield* LISTS_NEED_CLIENTS;
  if ("tag" in input)
    return {
      title: input.tag.trim(),
      where: tagged(yield* read(spellingsOf(input.orgId, input.tag, viewer))),
    };
  const campaign = yield* inList(input.orgId, input.campaign, "projects").pipe(
    Effect.mapError(() => notFound(input.campaign)),
  );
  if (viewer._tag === "people")
    for (const person of viewer.people)
      if (
        !(yield* read(crmVisible(input.orgId, person, [campaign.recordId]))).has(campaign.recordId)
      )
        return yield* notFound(input.campaign);
  if (campaign.category !== "campaign")
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${campaign.key} is not a campaign, so it has no audience.`,
    });
  const audience = fieldText(parseFields(campaign.fieldsJson), "audience");
  return {
    title: campaign.title,
    where: tagged(audience === null ? [] : yield* read(spellingsOf(input.orgId, audience, viewer))),
  };
});

/** Who looks after each client, by name: a person's or an agent's. */
const lookersAfter = Effect.fn("KinWork.list.lookersAfter")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ kind: string; id: string; name: string }>`
    SELECT 'person' AS kind, person_id AS id, display_name AS name FROM kin_people
      WHERE org_id = ${orgId}
    UNION ALL SELECT 'agent', agent_id, display_name FROM kin_agents WHERE org_id = ${orgId}
    ORDER BY kind, id`;
  return new Map(rows.map((row) => [`${row.kind}:${row.id}`, row.name]));
});

/** The list's contacts as this reader may see them, by client then name, up to `limit`. */
const contactsOf = Effect.fn("KinWork.list.contacts")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinContactListInput,
  limit: number,
) {
  const viewer = yield* reader(people, input.orgId);
  const details = yield* switchedOn(input.orgId, viewer);
  const { title, where } = yield* read(listOf(input, viewer, details));
  const sql = yield* SqlClient.SqlClient;
  const filter = sql.and([
    sql`r.org_id = ${input.orgId}`,
    sql`r.register_id = 'contacts'`,
    sql`r.state = 'open'`,
    where,
    crmSeenBy(sql, viewer),
  ]);
  const [count] = yield* read(sql<{ total: number }>`SELECT COUNT(*) AS total FROM kin_records r
    WHERE ${filter}`);
  const rows = yield* read(sql<RecordRow & { partyOwnerKind: string; partyOwnerId: string }>`
    ${selectRecords(sql)} WHERE ${filter}
    ORDER BY lower(pa.title), pa.key, lower(r.title), r.key LIMIT ${limit}`);
  const owners = yield* read(
    sql<{ recordId: string; kind: string; id: string }>`SELECT c.record_id AS "recordId",
        c.owner_kind AS kind, c.owner_id AS id FROM kin_records c
      WHERE c.org_id = ${input.orgId} AND c.record_id IN ${sql.in([
        ...new Set(rows.flatMap((row) => (row.partyId === null ? [] : [row.partyId]))),
        "",
      ])}
      ORDER BY c.record_id`,
  );
  const ownerOf = new Map(owners.map((one) => [one.recordId, `${one.kind}:${one.id}`]));
  const names = yield* read(lookersAfter(input.orgId));
  const contacts = rows.map((row): KinContactListRow => {
    const contact = Crm.toContact(row);
    const lookedAfterBy = (names.get(ownerOf.get(row.partyId ?? "") ?? "") ??
      "") as KinContactListRow["lookedAfterBy"];
    if (details) return { ...contact, lookedAfterBy };
    const { tags: _tags, ...named } = contact;
    return { ...named, email: null, phone: null, emails: [], phones: [], lookedAfterBy };
  });
  return {
    contacts,
    total: count?.total ?? 0,
    ...(title === undefined ? {} : { title: title as KinContactListRow["name"] }),
    details,
  } satisfies KinContactList;
});

export const contactList = Effect.fn("KinWork.contactList")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinContactListInput,
) {
  return yield* contactsOf(people, input, KIN_CONTACT_LIST_SHOWN);
});

const KIN_CONTACT_EXPORT_COLUMNS = [
  "Name",
  "Client",
  "Role",
  "Main email",
  "Other emails",
  "Main phone",
  "Other phones",
  "Tags",
  "Looked after by",
] as const;

/**
 * One CSV cell. Text a spreadsheet would run as a formula (starting `=`, `+`, `-` or `@`) is
 * written with a leading apostrophe, so it opens as the text it is.
 */
const csvCell = (text: string) => {
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const fileName = (title: string | undefined) => {
  const slug = (title ?? "clients")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug === "" ? "list" : slug}-contacts.csv`;
};

/** A list as a CSV file, one row per contact the reader sees, carrying only what they may read. */
export const exportContacts = Effect.fn("KinWork.exportContacts")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinContactListInput,
) {
  const list = yield* contactsOf(people, input, KIN_CONTACT_EXPORT_MAX);
  const lines = [
    KIN_CONTACT_EXPORT_COLUMNS.join(","),
    ...list.contacts.map((one) =>
      [
        one.name,
        one.party.title,
        one.role ?? "",
        one.emails[0] ?? one.email ?? "",
        one.emails.slice(1).join("; "),
        one.phones[0] ?? one.phone ?? "",
        one.phones.slice(1).join("; "),
        (one.tags ?? []).join("; "),
        one.lookedAfterBy,
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  return {
    filename: fileName(list.title),
    // A byte-order mark so a spreadsheet reads every language's letters as written.
    csv: `\uFEFF${lines.join("\r\n")}\r\n`,
    rows: list.contacts.length,
  } satisfies KinContactExport;
});
