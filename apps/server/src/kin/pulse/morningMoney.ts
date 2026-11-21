import type { KinChatId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevel } from "../people/KinAccess.ts";
import { formatMoneyPlain } from "../work/money.ts";
import { countedEntry, owedInvoices, recordName } from "../work/recordRows.ts";
import { KIN_OWNER_LEVEL, type KinViewer, seenBy, viewerOfPeople } from "../work/teamView.ts";
import { daysText, elapsed } from "./senses/shared.ts";
import { thresholds, toMs } from "./thresholds.ts";

const MONEY_SHOWN = 3;
/** Past its due date "today", else for how many calendar days. */
const overdueText = (days: number) =>
  days === 0 ? "overdue since today" : `${daysText(days)} overdue`;

/**
 * The morning page's own Money lines, every morning until settled: each invoice past its due date
 * and each sent quote with no answer for its follow-up days (5 unless a playbook says otherwise),
 * as `viewer` may see them; at most three of each, then how many more. From the rows alone.
 */
export const morningMoneyLines = Effect.fn("KinMorningMoney.lines")(function* (input: {
  readonly orgId: KinOrgId;
  readonly now: number;
  readonly viewer: KinViewer;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, now } = input;
  const seen = seenBy(sql, input.viewer);
  const shown = (lines: ReadonlyArray<string>) =>
    lines.length <= MONEY_SHOWN
      ? lines
      : [...lines.slice(0, MONEY_SHOWN), `and ${lines.length - MONEY_SHOWN} more`];
  const invoices = (yield* owedInvoices({ orgId, now, seen }))
    .filter((one) => one.overdue)
    .map(
      (one) =>
        `${one.partyTitle === null ? `${recordName(one.key, one.number)} is owed ${formatMoneyPlain(one.balance)}` : `${one.partyTitle} owes ${formatMoneyPlain(one.balance)} on ${recordName(one.key, one.number)}`}, ${overdueText(one.daysOverdue)}.`,
    );
  const limits = yield* thresholds(orgId);
  const quotes = yield* sql<{
    key: string;
    title: string;
    clientId: string | null;
    client: string | null;
    minor: number | null;
    currency: string | null;
    number: unknown;
    lastAt: number;
  }>`SELECT r.key, r.title, r.party_id AS "clientId", c.title AS client, r.amount_minor AS minor,
      r.currency, json_extract(r.fields_json, '$.number') AS number,
      COALESCE((SELECT MAX(ch.at) FROM kin_record_changes ch
        WHERE ch.org_id = r.org_id AND ch.record_id = r.record_id), r.updated_at) AS "lastAt"
    FROM kin_records r
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'quotes' AND r.state = 'waiting'
      AND ${countedEntry(sql)} AND ${seen}
    ORDER BY "lastAt", r.key`;
  const unanswered = quotes
    .filter(
      (one) => one.lastAt <= now - toMs(limits("quote_follow_up_days", one.clientId ?? undefined)),
    )
    .map((one) => {
      const amount =
        one.minor === null || one.currency === null
          ? ""
          : ` for ${formatMoneyPlain({ minor: one.minor, currency: one.currency })}`;
      const quote = `quote ${recordName(one.key, one.number)}${amount}`;
      const days = daysText(elapsed(one.lastAt, now, "days"));
      return one.client === null
        ? `No answer to ${quote} in ${days}.`
        : `${one.client} hasn't answered ${quote} in ${days}.`;
    });
  return [...shown(invoices), ...shown(unanswered)];
});

/** `morningMoneyLines` for whoever reads `chatId`: every person in it, at what all of them see. */
export const morningMoneyFor = Effect.fn("KinMorningMoney.forChat")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const readers = yield* sql<{ personId: KinPersonId }>`SELECT person_id AS "personId"
    FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
      AND principal_kind = 'person' AND left_at IS NULL ORDER BY person_id`;
  if (readers.length === 0) return [];
  let owners = true;
  for (const reader of readers) owners &&= yield* ownerLevel(input.orgId, reader.personId);
  return yield* morningMoneyLines({
    orgId: input.orgId,
    now: input.now,
    viewer: owners ? KIN_OWNER_LEVEL : viewerOfPeople(readers.map((reader) => reader.personId)),
  });
});
