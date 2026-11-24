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
import { KinLevelGate } from "../lead/LevelGate.ts";
import {
  followsOutsideRead,
  outsideRead,
  outsideStamp,
  renderSource,
} from "../lead/OutsideContent.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { directChatWith } from "../triggers/deferralOrigin.ts";
import { companyMoney } from "./companyProfile.ts";
import { KinRecords } from "./KinRecords.ts";
import type { Lead } from "./leadWork.ts";
import { fieldText, parseFields } from "./lists.ts";
import type { RecordRow } from "./recordRows.ts";
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

/** What people of the company wrote themselves in the messages that woke this turn, folded. */
const ownWords = Effect.fn("KinUnconfirmed.ownWords")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ body: string }>`SELECT m.body FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
      AND m.chat_id = json_extract(e.json, '$.chatId')
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId}
      AND e.wakeup_id = ${turn.wakeupId} AND e.tag = 'chat.message'
      AND json_extract(e.json, '$.origin') IS NULL
      AND m.author_kind = 'human' AND m.author_person_id IS NOT NULL AND m.origin_json IS NULL
      AND COALESCE(m.client_message_id, '') NOT LIKE 'send:private:%'
      AND NOT ${sql.literal(keySentSql("m.client_message_id"))}
    ORDER BY e.event_id`;
  return rows.map((row) => words(row.body));
});

/**
 * Of an agent's changes to printed fields, the ones that wait for a person: every value no person
 * of the company typed in a message that woke this turn. A clear goes in when a person started the
 * turn and nothing from outside came into it. A value equal to the one kept is no change.
 */
export const heldBack = Effect.fn("KinUnconfirmed.heldBack")(function* (
  turn: Turn,
  asked: ReadonlyArray<{
    readonly field: PrintedField;
    readonly value: string | null;
    readonly before: string | null;
  }>,
) {
  const changing = asked.filter((one) => !same(one.value, one.before));
  if (changing.length === 0) return [];
  const said = yield* ownWords(turn);
  const clears =
    said.length > 0 &&
    !(yield* outsideRead(turn)) &&
    !(yield* followsOutsideRead(turn.orgId, turn.wakeupId));
  return changing.filter((one) => {
    if (one.value === null) return !clears;
    const value = words(one.value).join("");
    return value === "" || !typedIn(value, said);
  });
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

/**
 * Keeps an agent's held-back values on the record as one unconfirmed proposal, and asks the person
 * who confirms on one card in their own chat with the agent. A newer proposal for the client takes
 * in the older one's other fields and replaces its card; the same values again ask nothing.
 * Returns the line the agent's tool answer carries.
 */
export const propose = Effect.fn("KinUnconfirmed.propose")(function* (
  lead: Lead,
  record: Pick<RecordRow, "recordId" | "title" | "fieldsJson" | "ownerKind" | "ownerId">,
  held: ReadonlyArray<{
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
  const what = held
    .map((one) =>
      one.value === null
        ? `removing its ${label(one.field)}`
        : `${label(one.field)} "${shown(one.value)}"`,
    )
    .join(" and ");
  const older = yield* pendingRows(orgId, record.recordId);
  const latest = older.at(-1);
  // An item whose field changed since it was proposed is no longer asked.
  const live = (item: UnconfirmedItem) => same(holding(record, item.field), item.before);
  if (
    latest?.widgetId != null &&
    held.every((one) => latest.proposal.items.some((item) => live(item) && sameItem(item, one)))
  )
    return waitingLine(record.title, what, name, true);
  const stamp = yield* outsideStamp(lead);
  const from =
    heardFrom?.trim() ||
    (stamp === undefined ? null : renderSource(stamp, false, who?.personId)) ||
    null;
  const items: ReadonlyArray<UnconfirmedItem> = [
    ...(latest?.proposal.items ?? []).filter(
      (item) => live(item) && !held.some((one) => one.field === item.field),
    ),
    ...held.map((one) => ({ ...one, from, at: now })),
  ];
  const patch = yield* encodeProposal({ recordId: record.recordId, items }).pipe(Effect.orDie);
  const changeId = `${UNCONFIRMED_CHANGE}${NodeCrypto.createHash("sha256")
    .update(
      `${orgId}|${lead.agentId}|${lead.wakeupId}|${stableStringify(items.map(({ at: _at, ...one }) => one))}`,
    )
    .digest("hex")
    .slice(0, 32)}`;
  yield* sql`INSERT INTO kin_profile_changes (org_id, change_id, agent_id, wakeup_id, patch_json,
      base_rev, proposed_at)
    VALUES (${orgId}, ${changeId}, ${lead.agentId}, ${lead.wakeupId}, ${patch}, 0, ${now})
    ON CONFLICT (org_id, change_id) DO NOTHING`;
  const replaced = older.filter((row) => row.changeId !== changeId);
  if (replaced.length > 0)
    yield* sql`UPDATE kin_profile_changes SET declined_at = ${now}
      WHERE org_id = ${orgId} AND change_id IN ${sql.in(replaced.map((row) => row.changeId))}`;
  const chatId =
    who === undefined ? undefined : yield* directChatWith(sql, orgId, who.personId, lead.agentId);
  // Tools without Kin's chat (an import, a test of the write alone) keep the value and ask in words.
  const gate = Option.getOrUndefined(yield* Effect.serviceOption(KinLevelGate));
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
  const widgets = replaced.flatMap((row) => (row.widgetId === null ? [] : [row.widgetId]));
  if (widgets.length > 0 && gate !== undefined)
    yield* gate
      .closeReplaced(
        lead,
        widgets,
        ...(posted === undefined || "_tag" in posted ? [] : [posted.widgetId]),
      )
      .pipe(Effect.catchTags({ KinChatError: () => Effect.void }));
  return waitingLine(record.title, what, name, posted !== undefined && !("_tag" in posted));
});

const cardDetail = (
  items: ReadonlyArray<UnconfirmedItem>,
  label: (field: PrintedField) => string,
) =>
  [
    ...items.map((item) =>
      [
        `${label(item.field)}: ${item.value === null ? "remove it" : shown(item.value)}`,
        `Now: ${shown(item.before)}`,
        `From: ${item.from ?? "not said"}`,
      ].join("\n"),
    ),
    "Invoices and quotes print it only after you tap Use it.",
  ].join("\n\n");

export const waitingLine = (client: string, what: string, name: string, carded: boolean) =>
  carded
    ? `Kept unconfirmed, not saved: no one here typed ${what}, so ${name} confirms it on a card Kin showed them. Until they tap Use it, ${client}'s invoices and quotes print what they had. Say in one line it needs ${name}'s confirmation, and never give it as ${client}'s.`
    : `Kept unconfirmed, not saved: no one here typed ${what}, so it waits for ${name} to confirm it, and Kin couldn't show them a card now. Until then ${client}'s invoices and quotes print what they had. Ask ${name} to confirm it when you next speak, and never give it as ${client}'s.`;

/**
 * What waits unconfirmed on a client, as its read answer says it: never as the client's own. A
 * field changed since it was proposed no longer waits on it.
 */
export const unconfirmedLines = Effect.fn("KinUnconfirmed.lines")(function* (
  orgId: KinOrgId,
  record: Pick<RecordRow, "recordId" | "ownerKind" | "ownerId" | "title" | "fieldsJson">,
) {
  const latest = (yield* pendingRows(orgId, record.recordId)).at(-1);
  const waiting = (latest?.proposal.items ?? []).filter((item) =>
    same(holding(record, item.field), item.before),
  );
  if (waiting.length === 0) return [];
  const label = yield* labeller(orgId);
  const name = (yield* confirmer(orgId, record))?.name ?? "the owner";
  return waiting.map(
    (item) =>
      `Unconfirmed ${label(item.field)}: ${item.value === null ? "remove it" : `"${shown(item.value)}"`}, from ${item.from ?? "a source not said"}. It waits for ${name}'s tap and is not on invoices or quotes; never state it as fact.`,
  );
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
    yield* sql`UPDATE kin_profile_changes SET declined_at = ${input.now}
      WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
    return { title: "Not used", text: "You said no, so the client's details stay as they were." };
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
  return { title: "Saved", text: "Saved. Invoices and quotes made from now on print it." };
});
