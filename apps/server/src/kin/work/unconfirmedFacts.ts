import {
  KinChatError,
  KinChatId,
  type KinOrgId,
  KinPersonId,
  KinWakeupId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { keySentSql } from "../chat/keySent.ts";
import { effectiveAudience } from "../lead/Audience.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import {
  followsOutsideRead,
  outsideRead,
  outsideStamp,
  renderSource,
} from "../lead/OutsideContent.ts";
import { ownerLevel, ownerLevelSql } from "../people/KinAccess.ts";
import { dayWord } from "../questions/rules.ts";
import { directChatWith } from "../triggers/deferralOrigin.ts";
import { companyMoney } from "./companyProfile.ts";
import { KinRecords } from "./KinRecords.ts";
import type { Lead } from "./leadWork.ts";
import { fieldText, parseFields } from "./lists.ts";
import { ownerZone, type RecordRow } from "./recordRows.ts";
import { regionOf } from "./region.ts";
import { orgOwner } from "./toolNames.ts";

/**
 * A client's printed details (`gendocs/facts.ts`) an agent writes that no person typed in the turn
 * wait for an owner-level tap on one card; documents print the old value until then. Proposals
 * live in `kin_profile_changes` under `uf_`, one row per card, beside the shell's and numbers'.
 */
const UNCONFIRMED_CHANGE = "uf_";

const PRINTED = ["title", "address", "gstin", "placeOfSupply", "terms"] as const;
export type PrintedField = (typeof PRINTED)[number];
export const PRINTED_FIELDS: ReadonlyArray<PrintedField> = PRINTED;

/** Outer whitespace ignored, nothing else: "1.5%" is not "15%". */
const same = (a: string | null, b: string | null) => (a?.trim() ?? null) === (b?.trim() ?? null);
/**
 * How a typed value is matched: case, spaces, hyphens and slashes ignored, so "29 abcde-1234f1z5"
 * is "29ABCDE1234F1Z5"; marks, signs and a point or comma between digits kept.
 */
const gentle = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?<!\p{N})[.,]|[.,](?!\p{N})/gu, "")
    .replace(/[\s\p{Pd}/]/gu, "");
const EDGES =
  /^[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"'.,;:!?…।॥。、¡¿]+|[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"'.,;:!?…।॥。、¡¿]+$/gu;
/** A text's words, folded, without the quotes, brackets and sentence marks around each. */
const words = (text: string) =>
  text
    .split(/\s+/u)
    .map((word) => gentle(word.replace(EDGES, "")))
    .filter((word) => word !== "");
/** Whether a run of whole words of one message folds to the value. */
const typedIn = (said: string, messages: ReadonlyArray<ReadonlyArray<string>>) =>
  messages.some((message) =>
    message.some((_, start) => {
      let run = "";
      for (const word of message.slice(start)) {
        run += word;
        if (run === said) return true;
        if (!said.startsWith(run)) return false;
      }
      return false;
    }),
  );
/** A value as typed values are matched (`gentle`), whole. */
const folded = (value: string) => words(value).join("");
/** What a client's printed field holds now. */
const holding = (record: Pick<RecordRow, "title" | "fieldsJson">, field: PrintedField) =>
  field === "title" ? record.title : fieldText(parseFields(record.fieldsJson), field);

const Item = Schema.Struct({
  field: Schema.Literals(PRINTED),
  /** Null clears it. */
  value: Schema.NullOr(Schema.String),
  before: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Schema.String),
  at: Schema.Number,
});
export type UnconfirmedItem = typeof Item.Type;
const Proposal = Schema.Struct({ recordId: Schema.String, items: Schema.Array(Item) });
const ProposalJson = Schema.fromJsonString(Proposal);
const decodeProposal = Schema.decodeUnknownOption(ProposalJson);
const encodeProposal = Schema.encodeEffect(ProposalJson);

type Turn = Pick<Lead, "orgId" | "agentId" | "wakeupId">;

/**
 * What people of the company wrote themselves in the messages that woke this turn, folded; `owner`
 * when an owner-level person wrote it in their own direct chat.
 */
const ownWords = Effect.fn("KinUnconfirmed.ownWords")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ body: string; owner: number }>`SELECT m.body,
      (c.kind = 'direct' AND ${sql.literal(ownerLevelSql("m.org_id", "m.author_person_id"))})
        AS owner
    FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
      AND m.chat_id = json_extract(e.json, '$.chatId')
    JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId}
      AND e.wakeup_id = ${turn.wakeupId} AND e.tag = 'chat.message'
      AND json_extract(e.json, '$.origin') IS NULL
      AND m.author_kind = 'human' AND m.author_person_id IS NOT NULL AND m.origin_json IS NULL
      AND COALESCE(m.client_message_id, '') NOT LIKE 'send:private:%'
      AND NOT ${sql.literal(keySentSql("m.client_message_id"))}
    ORDER BY e.event_id`;
  return rows.map((row) => ({ words: words(row.body), owner: row.owner === 1 }));
});

/**
 * Of an agent's changes to printed fields, the ones that wait for a person: every value no person
 * of the company typed in a message that woke this turn, and one a person said no to that no
 * owner-level person typed in their own chat. A clear goes in when a person started the turn and
 * nothing from outside came into it. A value equal to the one kept is no change.
 */
export const heldBack = Effect.fn("KinUnconfirmed.heldBack")(function* (
  turn: Turn,
  asked: ReadonlyArray<{
    readonly field: PrintedField;
    readonly value: string | null;
    readonly before: string | null;
  }>,
  recordId?: string,
) {
  const changing = asked.filter((one) => !same(one.value, one.before));
  if (changing.length === 0) return [];
  const messages = yield* ownWords(turn);
  const said = messages.map((one) => one.words);
  const ownerSaid = messages.flatMap((one) => (one.owner ? [one.words] : []));
  const declined = recordId === undefined ? [] : yield* declinedFor(turn.orgId, [recordId]);
  const clears =
    said.length > 0 &&
    !(yield* outsideRead(turn)) &&
    !(yield* followsOutsideRead(turn.orgId, turn.wakeupId));
  return changing.filter((one) => {
    if (one.value === null) return !clears;
    const value = folded(one.value);
    const no = declined.some((item) => item.field === one.field && folded(item.value) === value);
    return value === "" || !typedIn(value, no ? ownerSaid : said);
  });
});

/**
 * Values a person said no to on Kin's card (Not this) for these clients, newest first, for every
 * agent while the field doesn't hold them: who said no is kept on the row (`answerUnconfirmed`).
 * Only a card that proposed one value: a no to several may have been to any one of them.
 */
const declinedFor = Effect.fn("KinUnconfirmed.declined")(function* (
  orgId: KinOrgId,
  recordIds: ReadonlyArray<string>,
) {
  if (recordIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    patch: string;
    at: number;
    name: string | null;
    title: string;
    fieldsJson: string;
  }>`SELECT c.patch_json AS patch, c.declined_at AS at, p.display_name AS name, r.title,
      r.fields_json AS "fieldsJson"
    FROM kin_profile_changes c
    JOIN kin_records r ON r.org_id = c.org_id
      AND r.record_id = json_extract(c.patch_json, '$.recordId') AND r.register_id = 'clients'
    LEFT JOIN kin_people p ON p.org_id = c.org_id
      AND p.person_id = json_extract(c.patch_json, '$.declinedBy')
    WHERE c.org_id = ${orgId} AND substr(c.change_id, 1, 3) = ${UNCONFIRMED_CHANGE}
      AND c.declined_at IS NOT NULL AND json_extract(c.patch_json, '$.declinedBy') IS NOT NULL
      AND r.record_id IN ${sql.in([...new Set(recordIds)])}
    ORDER BY c.declined_at DESC, c.rowid DESC`;
  return rows.flatMap((row) =>
    Option.toArray(decodeProposal(row.patch)).flatMap((proposal) =>
      proposal.items.length !== 1
        ? []
        : proposal.items.flatMap((item) =>
            item.value === null || folded(holding(row, item.field) ?? "") === folded(item.value)
              ? []
              : [
                  {
                    client: row.title,
                    field: item.field,
                    value: item.value,
                    name: row.name ?? "the owner",
                    at: row.at,
                  },
                ],
          ),
    ),
  );
});

/** When a no was said, as Kin's other agent-read lines say a day, in the company's zone. */
const saidOn = Effect.fn("KinUnconfirmed.saidOn")(function* (orgId: KinOrgId) {
  const zone = yield* ownerZone(orgId);
  const now = yield* Clock.currentTimeMillis;
  return (at: number) => dayWord(at, now, zone);
});

const LABELS: Readonly<Record<Exclude<PrintedField, "gstin">, string>> = {
  title: "Name",
  address: "Billing address",
  placeOfSupply: "Place of supply",
  terms: "Terms",
};
/** What the company's country calls a tax number; any other field by its plain name. */
const labeller = Effect.fn("KinUnconfirmed.labels")(function* (orgId: KinOrgId) {
  const { country } = yield* companyMoney(orgId);
  const tax = regionOf(country)?.taxIdLabel ?? "Tax number";
  return (field: PrintedField) => (field === "gstin" ? tax : LABELS[field]);
});

const SHOWN_MAX = 600;
const shown = (value: string | null) =>
  value === null
    ? "none"
    : value.length <= SHOWN_MAX
      ? value
      : `${value.slice(0, SHOWN_MAX)}… (${value.length - SHOWN_MAX} more characters)`;

/** Who confirms: the client's holder when they are owner-level, else the company's owner. */
const confirmer = Effect.fn("KinUnconfirmed.confirmer")(function* (
  orgId: KinOrgId,
  record: Pick<RecordRow, "ownerKind" | "ownerId">,
) {
  const holder =
    record.ownerKind === "person" &&
    (yield* ownerLevel(orgId, KinPersonId.make(record.ownerId)).pipe(Effect.orDie))
      ? record.ownerId
      : yield* orgOwner(orgId);
  if (holder === null) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${holder}`;
  return { personId: KinPersonId.make(holder), name: person?.name ?? "the owner" };
});

const pendingRows = Effect.fn("KinUnconfirmed.pending")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ changeId: string; widgetId: string | null; patch: string }>`
    SELECT change_id AS "changeId", widget_id AS "widgetId", patch_json AS patch
    FROM kin_profile_changes
    WHERE org_id = ${orgId} AND substr(change_id, 1, 3) = ${UNCONFIRMED_CHANGE}
      AND applied_at IS NULL AND declined_at IS NULL
      AND json_extract(patch_json, '$.recordId') = ${recordId}
    ORDER BY rowid`;
  return rows.flatMap((row) =>
    Option.toArray(decodeProposal(row.patch)).map((proposal) => ({ ...row, proposal })),
  );
});

const sameItem = (a: UnconfirmedItem, b: Pick<UnconfirmedItem, "field" | "value">) =>
  a.field === b.field && same(a.value, b.value);
const itemsKey = (items: ReadonlyArray<UnconfirmedItem>) =>
  stableStringify(items.map(({ at: _at, ...one }) => one));
const hashed = (text: string) =>
  `${UNCONFIRMED_CHANGE}${NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 32)}`;

/** Whether a card is still open and waits on the person who confirms now. */
const awaits = Effect.fn("KinUnconfirmed.awaits")(function* (
  orgId: KinOrgId,
  widgetId: string | null,
  personId: KinPersonId | undefined,
) {
  if (widgetId === null || personId === undefined) return false;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_widgets w
    WHERE w.org_id = ${orgId} AND w.widget_id = ${widgetId} AND w.closed_at IS NULL
      AND EXISTS (SELECT 1 FROM json_each(w.awaiting_json) WHERE value = ${personId})`;
  return rows.length > 0;
});

const fits = (item: Pick<UnconfirmedItem, "value">) =>
  item.value === null || item.value.length <= SHOWN_MAX;

/** A new row's id: a retry's own card-less row, else one this client's rows haven't used. */
const rowId = Effect.fn("KinUnconfirmed.rowId")(function* (
  orgId: KinOrgId,
  recordId: string,
  base: string,
  retry: string | undefined,
) {
  if (retry !== undefined) return retry;
  const sql = yield* SqlClient.SqlClient;
  const [made] = yield* sql<{ taken: number; count: number }>`
    SELECT COALESCE(SUM(change_id = ${base}), 0) AS taken, COUNT(*) AS count
    FROM kin_profile_changes
    WHERE org_id = ${orgId} AND substr(change_id, 1, 3) = ${UNCONFIRMED_CHANGE}
      AND json_extract(patch_json, '$.recordId') = ${recordId}`;
  return !made?.taken ? base : hashed(`${base}|${made.count}`);
});

/**
 * Keeps held-back values on the record and asks who confirms on one card in their chat with the
 * agent; a newer card takes in the older one's other fields and replaces it once shown. A value
 * too long for the card waits with no card. Returns the line the agent's tool answer carries.
 */
export const propose = Effect.fn("KinUnconfirmed.propose")(function* (
  lead: Lead,
  record: Pick<RecordRow, "recordId" | "title" | "fieldsJson" | "ownerKind" | "ownerId">,
  given: ReadonlyArray<{
    readonly field: PrintedField;
    readonly value: string | null;
    readonly before: string | null;
  }>,
  heardFrom: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = lead.orgId;
  const now = yield* Clock.currentTimeMillis;
  const label = yield* labeller(orgId);
  const who = yield* confirmer(orgId, record);
  const name = who?.name ?? "the owner";
  // A value a person said no to is told, with who and when, and never asked again (`heldBack`).
  const declined = yield* declinedFor(orgId, [record.recordId]);
  const noTo = ({ field, value }: (typeof given)[number]) =>
    value === null
      ? undefined
      : declined.find((item) => item.field === field && folded(item.value) === folded(value));
  const held = given.filter((one) => noTo(one) === undefined);
  const older = yield* pendingRows(orgId, record.recordId);
  // An item whose field changed since it was proposed is no longer asked.
  const live = (item: UnconfirmedItem) => same(holding(record, item.field), item.before);
  const stamp = yield* outsideStamp(lead);
  const from =
    heardFrom?.trim() ||
    (stamp === undefined ? null : renderSource(stamp, false, who?.personId)) ||
    null;
  const store = Effect.fn("KinUnconfirmed.store")(function* (
    changeId: string,
    items: ReadonlyArray<UnconfirmedItem>,
  ) {
    const patch = yield* encodeProposal({ recordId: record.recordId, items }).pipe(Effect.orDie);
    yield* sql`INSERT INTO kin_profile_changes (org_id, change_id, agent_id, wakeup_id,
        patch_json, base_rev, proposed_at)
      VALUES (${orgId}, ${changeId}, ${lead.agentId}, ${lead.wakeupId}, ${patch}, 0, ${now})
      ON CONFLICT (org_id, change_id) DO NOTHING`;
  });
  const decline = (rows: ReadonlyArray<{ readonly changeId: string }>) =>
    rows.length === 0
      ? Effect.void
      : sql`UPDATE kin_profile_changes SET declined_at = ${now}
          WHERE org_id = ${orgId} AND change_id IN ${sql.in(rows.map((row) => row.changeId))}`.pipe(
          Effect.asVoid,
        );
  const wake = `${orgId}|${lead.agentId}|${lead.wakeupId}|${record.recordId}`;
  const describe = (some: typeof held) =>
    some
      .map((one) =>
        one.value === null
          ? `removing its ${label(one.field)}`
          : `${label(one.field)} "${one.value}"`,
      )
      .join(" and ");
  const heldField = (item: UnconfirmedItem) => held.some((one) => one.field === item.field);

  // A value the card can't show whole waits on the record alone, one row each: no tap writes it.
  const long = held.filter((one) => !fits(one));
  const stored: Array<string> = [];
  for (const one of long) {
    const items = [{ ...one, from, at: now }];
    const key = itemsKey(items);
    const retry = older.find((row) => itemsKey(row.proposal.items) === key)?.changeId;
    const changeId = yield* rowId(orgId, record.recordId, hashed(`${wake}|long|${key}`), retry);
    yield* store(changeId, items);
    stored.push(changeId);
  }
  yield* decline(
    older.filter(
      (row) =>
        !row.proposal.items.every(fits) &&
        !stored.includes(row.changeId) &&
        row.proposal.items.some(heldField),
    ),
  );
  const short = held.filter(fits);
  const tooLong =
    long.length === 0
      ? []
      : [
          tooLongLine(
            record.title,
            long.map((one) => label(one.field)),
            name,
          ),
        ];
  const day = yield* saidOn(orgId);
  const saidNo = given.flatMap((one) => {
    const no = noTo(one);
    return no === undefined ? [] : [saidNoLine(record.title, describe([one]), no.name, day(no.at))];
  });
  const say = (line: string | undefined) =>
    [...(line === undefined ? [] : [line]), ...tooLong, ...saidNo].join(" ");
  const waiting = (carded: boolean) =>
    say(short.length === 0 ? undefined : waitingLine(record.title, describe(short), name, carded));

  const carded = older.filter((row) => row.proposal.items.every(fits));
  const latest = carded.at(-1);
  const asked = (latest?.proposal.items ?? []).filter(live);
  const items: ReadonlyArray<UnconfirmedItem> = [
    ...asked.filter((item) => !heldField(item)),
    ...short.map((one) => ({ ...one, from, at: now })),
  ];
  const unchanged =
    asked.length === items.length &&
    short.every((one) => asked.some((item) => sameItem(item, one)));
  if (
    unchanged &&
    (short.length === 0 ||
      (latest !== undefined && (yield* awaits(orgId, latest.widgetId, who?.personId))))
  )
    return waiting(true);
  // Only values too long for a card: no card replaces the older one, so the person keeps it.
  if (items.length === 0) return waiting(true);
  const gate = Option.getOrUndefined(yield* Effect.serviceOption(KinLevelGate));
  const key = itemsKey(items);
  const changeId = yield* rowId(
    orgId,
    record.recordId,
    hashed(`${wake}|${key}`),
    carded.find((row) => row.widgetId === null && itemsKey(row.proposal.items) === key)?.changeId,
  );
  yield* store(changeId, items);
  const chatId =
    who === undefined ? undefined : yield* directChatWith(sql, orgId, who.personId, lead.agentId);
  // Tools without Kin's chat (an import, a test of the write alone) keep the value and ask in words.
  const posted =
    who === undefined || chatId === undefined || gate === undefined
      ? undefined
      : yield* gate
          .askTo(
            { ...lead, wakeupId: KinWakeupId.make(lead.wakeupId) },
            who.personId,
            {
              chatId: KinChatId.make(chatId),
              clientMessageId: `kin-unconfirmed:${changeId}`,
              untilAnswered: true,
              question: `${items.length === 1 ? "Use this" : "Use these"} for ${record.title}?`,
              detail: cardDetail(items, label),
              options: [
                { label: "Use it", kind: "yes" },
                { label: "Not this", kind: "no" },
              ],
            },
            (widget) =>
              widget === null
                ? Effect.void
                : sql`UPDATE kin_profile_changes SET widget_id = ${widget.widgetId}
                    WHERE org_id = ${orgId} AND change_id = ${changeId} AND widget_id IS NULL`.pipe(
                    Effect.asVoid,
                  ),
          )
          // The value is kept either way; a card that can't be shown now is asked for in words.
          .pipe(Effect.catchTags({ KinChatError: () => Effect.undefined }));
  if (posted === undefined || "_tag" in posted || gate === undefined) return waiting(false);
  // Only a card now shown replaces the older ones; until then the person keeps theirs.
  const replaced = carded.filter((row) => row.changeId !== changeId);
  yield* decline(replaced);
  const widgets = replaced.flatMap((row) => (row.widgetId === null ? [] : [row.widgetId]));
  if (widgets.length > 0)
    yield* gate
      .closeReplaced(lead, widgets, posted.widgetId)
      .pipe(Effect.catchTags({ KinChatError: () => Effect.void }));
  return waiting(true);
});

/** A value's own line breaks, shown on one line so they can't draw lines that look like Kin's. */
const oneLine = (text: string) => text.replace(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/g, " ⏎ ");

const cardDetail = (
  items: ReadonlyArray<UnconfirmedItem>,
  label: (field: PrintedField) => string,
) =>
  [
    ...items.map((item) =>
      [
        `${label(item.field)}: ${item.value === null ? "remove it" : oneLine(item.value)}`,
        `Now: ${oneLine(shown(item.before))}`,
        item.from === null
          ? "The agent did not say where it came from."
          : `The agent says it came from: ${oneLine(item.from)}`,
      ].join("\n"),
    ),
    "Invoices and quotes print it only after you tap Use it.",
  ].join("\n\n");

/** Each answer line opens with what is true of the record and ends with what to say. */
const DONT = "never say it is added or on the record, or give it as";

/** How a value a person said no to may come back. */
const UNLESS_TYPED = "unless the owner or a co-owner types it to you in their own chat";

const saidNoLine = (client: string, what: string, name: string, day: string) =>
  `Not saved, and nothing on ${client} changed: ${name} said no to ${what} on Kin's card ${day}, so Kin doesn't ask again ${UNLESS_TYPED}. Invoices and quotes print what they had. Say in one line that ${name} said no to it; ${DONT} ${client}'s.`;

/**
 * Why a question to an owner-level person, in a turn only the owner level reads, about these
 * clients or their deals is not asked: it names a value a person said no to for one of them
 * (`declinedFor`) that no owner-level person typed in their own chat. A client's name, or words of
 * it, never count: every question about them may name them.
 */
export const declinedAsked = Effect.fn("KinUnconfirmed.declinedAsked")(function* (
  turn: Turn,
  to: KinPersonId,
  about: ReadonlyArray<string>,
  texts: ReadonlyArray<string | undefined>,
) {
  if (about.length === 0) return undefined;
  if (!(yield* ownerLevel(turn.orgId, to).pipe(Effect.orDie))) return undefined;
  if ((yield* effectiveAudience(turn)) !== "owner_only") return undefined;
  const sql = yield* SqlClient.SqlClient;
  const parties = yield* sql<{ id: string | null }>`SELECT CASE WHEN register_id = 'clients'
      THEN record_id ELSE party_id END AS id
    FROM kin_records WHERE org_id = ${turn.orgId} AND key IN ${sql.in([...new Set(about)])}
      AND register_id IN ('clients', 'deals')
    ORDER BY key`;
  const declined = (yield* declinedFor(
    turn.orgId,
    parties.flatMap((one) => (one.id === null ? [] : [one.id])),
  )).filter((one) => one.field !== "title" && !typedIn(folded(one.value), [words(one.client)]));
  if (declined.length === 0) return undefined;
  const asked = texts.flatMap((text) => (text === undefined ? [] : [words(text)]));
  const ownerSaid = (yield* ownWords(turn)).flatMap((one) => (one.owner ? [one.words] : []));
  const named = declined.find(
    (one) => typedIn(folded(one.value), asked) && !typedIn(folded(one.value), ownerSaid),
  );
  if (named === undefined) return undefined;
  const label = yield* labeller(turn.orgId);
  const day = yield* saidOn(turn.orgId);
  return `${named.name} said no to ${label(named.field)} "${named.value}" for ${named.client} on Kin's card ${day(named.at)}, so Kin doesn't put it on a card again. If ${named.client} asked for it again, tell ${named.name} so in plain words, with no card: it goes on the record only when the owner or a co-owner types it to you in their own chat. A question that doesn't name "${named.value}" is fine to ask.`;
});

const tooLongLine = (client: string, labels: ReadonlyArray<string>, name: string) =>
  `Not saved, and nothing on ${client} changed: the ${labels.join(" and ")} you gave ${labels.length === 1 ? "is" : "are"} too long to confirm on a card, so ${name} sets it on ${client}'s page. Until they do, invoices and quotes print what they had. Say in one line that ${name} sets it there; ${DONT} ${client}'s.`;

export const waitingLine = (client: string, what: string, name: string, carded: boolean) =>
  carded
    ? `Not saved, and nothing on ${client} changed: no one here typed ${what}, so ${name} confirms it on a card Kin showed them. Until they tap Use it, invoices and quotes print what they had. Say in one line that it needs ${name}'s confirmation; ${DONT} ${client}'s.`
    : `Not saved, and nothing on ${client} changed: no one here typed ${what}, so ${name} confirms it, and Kin couldn't show them a card now. Until they do, invoices and quotes print what they had. Ask ${name} in one line to confirm it; ${DONT} ${client}'s.`;

/**
 * What waits unconfirmed on a client, as its read answer says it: never as the client's own. A
 * field changed since it was proposed no longer waits on it.
 */
export const unconfirmedLines = Effect.fn("KinUnconfirmed.lines")(function* (
  orgId: KinOrgId,
  record: Pick<RecordRow, "recordId" | "ownerKind" | "ownerId" | "title" | "fieldsJson">,
) {
  const newest = new Map<PrintedField, UnconfirmedItem>();
  for (const row of yield* pendingRows(orgId, record.recordId))
    for (const item of row.proposal.items) newest.set(item.field, item);
  const waiting = [...newest.values()].filter((item) =>
    same(holding(record, item.field), item.before),
  );
  const day = yield* saidOn(orgId);
  const declined = (yield* declinedFor(orgId, [record.recordId])).filter(
    (one, at, all) =>
      all.findIndex(
        (other) => other.field === one.field && folded(other.value) === folded(one.value),
      ) === at,
  );
  if (waiting.length === 0 && declined.length === 0) return [];
  const label = yield* labeller(orgId);
  const name = (yield* confirmer(orgId, record))?.name ?? "the owner";
  return [
    ...waiting.map(
      (item) =>
        `Unconfirmed ${label(item.field)}: ${item.value === null ? "remove it" : `"${shown(item.value)}"`}, from ${item.from ?? "a source not said"}. It waits for ${name}'s tap and is not on invoices or quotes; never state it as fact.`,
    ),
    ...declined.map(
      (one) =>
        `Declined ${label(one.field)}: "${shown(one.value)}": ${one.name} said no to it on Kin's card ${day(one.at)}. Don't propose it or ask about it again ${UNLESS_TYPED}.`,
    ),
  ];
});

/**
 * The answer on an unconfirmed-details card: an owner-level Use it writes exactly its values,
 * once, while each field still holds what the card showed (one that already holds its value is
 * left as it is); Not this drops them. Undefined for any other card.
 */
export const answerUnconfirmed = Effect.fn("KinUnconfirmed.answer")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: KinPersonId;
  readonly confirmed: boolean;
  readonly via: "tap" | "reaction";
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ changeId: string; patch: string; done: number }>`
    SELECT change_id AS "changeId", patch_json AS patch,
      (applied_at IS NOT NULL OR declined_at IS NOT NULL) AS done
    FROM kin_profile_changes
    WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}
      AND substr(change_id, 1, 3) = ${UNCONFIRMED_CHANGE}`;
  if (row === undefined) return undefined;
  if (!(yield* ownerLevel(input.orgId, input.personId).pipe(Effect.orDie)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner or a co-owner confirms a client's invoice details.",
    });
  if (input.via === "reaction")
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Tap Use it or Not this on the card to answer.",
    });
  if (row.done === 1)
    return yield* new KinChatError({
      reason: "widget_changed",
      message: "This card was already answered or replaced by a newer one.",
    });
  if (!input.confirmed) {
    yield* sql`UPDATE kin_profile_changes SET declined_at = ${input.now},
        patch_json = json_set(patch_json, '$.declinedBy', ${input.personId})
      WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
    return {
      title: "Not used",
      text: "You said no, so the client's details stay as they were.",
      alone: true,
    } as const;
  }
  const proposal = yield* Effect.fromOption(decodeProposal(row.patch)).pipe(Effect.orDie);
  const records = yield* KinRecords;
  const record = yield* records.getById(input.orgId, proposal.recordId);
  const left =
    record === undefined
      ? []
      : proposal.items.filter((item) => !same(holding(record, item.field), item.value));
  if (
    record === undefined ||
    record.state === "dropped" ||
    left.some((item) => !same(holding(record, item.field), item.before))
  )
    return yield* new KinChatError({
      reason: "conflict",
      message:
        "This client's details changed since this card was made, so nothing was changed. Ask for it again.",
    });
  const title = left.find((item) => item.field === "title")?.value;
  const changed = Object.fromEntries(
    left.flatMap((item) => (item.field === "title" ? [] : [[item.field, item.value]])),
  );
  if (left.length > 0)
    yield* records.update(
      input.orgId,
      {
        actor: { _tag: "person", personId: input.personId },
        via: "owner",
        askedBy: input.personId,
      },
      record.key,
      {
        ...(typeof title === "string" ? { title } : {}),
        ...(Object.keys(changed).length === 0 ? {} : { fields: changed }),
      },
    );
  yield* sql`UPDATE kin_profile_changes SET applied_at = ${input.now}
    WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
  return {
    title: "Saved",
    text: "Saved. Invoices and quotes made from now on print it.",
    alone: true,
  } as const;
});
