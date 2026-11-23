import type { KinChatId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevel } from "../people/KinAccess.ts";
import { formatMoneyPlain } from "../work/money.ts";
import { billedParty } from "../work/billTo.ts";
import { fold } from "../work/nameMatch.ts";
import { countedEntry, owedInvoices, ownerZone } from "../work/recordRows.ts";
import { KIN_OWNER_LEVEL, type KinViewer, seenBy, viewerOfPeople } from "../work/teamView.ts";
import { invoiceAsides } from "./invoiceAsides.ts";
import { UNREADABLE_BANK_ALERTS_KEY, unreadableBankAlerts } from "./senses/bank.ts";
import { daysText, elapsed } from "./senses/shared.ts";
import { thresholds, toMs } from "./thresholds.ts";

/** Lines of each kind before the rest are counted: a list a person reads at a glance. */
import * as KinShell from "../shell/KinShell.ts";

const MONEY_SHOWN = 8;
/** Past its due date "today", else for how many calendar days. */
const overdueText = (days: number) =>
  days === 0 ? "overdue since today" : `${daysText(days)} overdue`;
/** An entry as a person reads it: its own number, else its title; never Kin's record key. */
const entryName = (number: unknown, title: string) =>
  typeof number === "string" && number.trim() !== "" ? number.trim() : `"${title}"`;
/** Words that end a company's name on its record and are often left off when people write it. */
const FORM_WORDS = new Set([
  "ltd",
  "limited",
  "llp",
  "llc",
  "inc",
  "pvt",
  "private",
  "plc",
  "gmbh",
  "co",
  "corp",
  "company",
  "pty",
  "sa",
  "ag",
  "bv",
  "srl",
  "oy",
  "ab",
]);
/** Whether folded `text` holds `name` as whole words, with or without its trailing form words. */
const names = (text: string, name: string | null) => {
  if (name === null) return false;
  const words = fold(name)
    .split(" ")
    .filter((word) => word !== "");
  while (words.length > 1 && FORM_WORDS.has(words[words.length - 1]!)) words.pop();
  return words.length > 0 && text.includes(` ${words.join(" ")} `);
};
const total = (amounts: ReadonlyArray<{ readonly minor: number; readonly currency: string }>) => {
  const sums = new Map<string, number>();
  for (const one of amounts) sums.set(one.currency, (sums.get(one.currency) ?? 0) + one.minor);
  return [...sums].map(([currency, minor]) => formatMoneyPlain({ minor, currency })).join(" + ");
};

/**
 * The morning page's own Money lines, every morning until settled: each invoice past its due date
 * and each sent quote with no answer for its follow-up days (5 unless a playbook says otherwise),
 * as `viewer` may see them. An invoice set aside (`invoiceAsides`) is left out until its day; one
 * `said` (the agent's own Money section) names by number (else title) or client is not said again.
 */
export const morningMoneyLines = Effect.fn("KinMorningMoney.lines")(function* (input: {
  readonly orgId: KinOrgId;
  readonly now: number;
  readonly viewer: KinViewer;
  readonly said?: string | undefined;
  readonly offeredFacts?: ReadonlySet<string> | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, now } = input;
  const shell = yield* KinShell.get(orgId);
  const seen = seenBy(sql, input.viewer);
  const said = ` ${fold(input.said ?? "")} `;
  const saysName = (number: unknown, title: string) => {
    const name = fold(typeof number === "string" && number.trim() !== "" ? number : title);
    return name !== "" && said.includes(` ${name} `);
  };
  const bankLines: Array<string> = [];
  if (
    input.viewer._tag === "ownerLevel" &&
    input.offeredFacts?.has(UNREADABLE_BANK_ALERTS_KEY) &&
    KinShell.sectionOn(shell, "money")
  ) {
    const alert = yield* unreadableBankAlerts({ orgId, at: now, zone: yield* ownerZone(orgId) });
    if (alert !== undefined && !saysName(null, alert.subject.title))
      bankLines.push(`${alert.subject.title}. ${alert.consequence}`);
  }
  if (!KinShell.sectionOn(shell, "invoices")) return bankLines;
  const shown = <T>(
    entries: ReadonlyArray<T>,
    line: (entry: T) => string,
    rest: (count: number, cut: ReadonlyArray<T>) => string,
  ) =>
    entries.length <= MONEY_SHOWN
      ? entries.map(line)
      : [
          ...entries.slice(0, MONEY_SHOWN).map(line),
          rest(entries.length - MONEY_SHOWN, entries.slice(MONEY_SHOWN)),
        ];
  const overdue = (yield* owedInvoices({ orgId, now, seen })).filter((one) => one.overdue);
  const asides = yield* invoiceAsides({ orgId, at: now, viewer: input.viewer, invoices: overdue });
  // Longest overdue first: what the pulse chases soonest is never the part cut.
  const invoices = shown(
    overdue
      .filter(
        (one) =>
          !asides.has(one.recordId) &&
          !saysName(one.number, one.title) &&
          !names(said, one.partyTitle ?? one.billTo ?? null),
      )
      .toSorted((a, b) => b.daysOverdue - a.daysOverdue),
    (one) => {
      const name = one.partyTitle ?? one.billTo;
      const amount = formatMoneyPlain(one.balance);
      const entry = entryName(one.number, one.title);
      const owed =
        name === undefined ? `${entry} is owed ${amount}` : `${name} owes ${amount} on ${entry}`;
      return `${owed}, ${overdueText(one.daysOverdue)}.`;
    },
    (count, cut) =>
      `and ${count} more overdue invoice${count === 1 ? "" : "s"}, ${total(cut.map((one) => one.balance))} in all.`,
  );
  const limits = yield* thresholds(orgId);
  const quotes = yield* sql<{
    key: string;
    title: string;
    clientId: string | null;
    client: string | null;
    fieldsJson: string;
    minor: number | null;
    currency: string | null;
    number: unknown;
    lastAt: number;
  }>`SELECT r.key, r.title, r.party_id AS "clientId", c.title AS client, r.amount_minor AS minor, r.fields_json AS "fieldsJson",
      r.currency, json_extract(r.fields_json, '$.number') AS number,
      COALESCE((SELECT MAX(ch.at) FROM kin_record_changes ch
        WHERE ch.org_id = r.org_id AND ch.record_id = r.record_id), r.updated_at) AS "lastAt"
    FROM kin_records r
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'quotes' AND r.state = 'waiting'
      AND ${countedEntry(sql)} AND ${seen}
    ORDER BY "lastAt", r.key`;
  const unanswered = shown(
    quotes.filter(
      (one) =>
        one.lastAt <= now - toMs(limits("quote_follow_up_days", one.clientId ?? undefined)) &&
        !saysName(one.number, one.title),
    ),
    (one) => {
      const amount =
        one.minor === null || one.currency === null
          ? ""
          : ` for ${formatMoneyPlain({ minor: one.minor, currency: one.currency })}`;
      const quote = `quote ${entryName(one.number, one.title)}${amount}`;
      const days = daysText(elapsed(one.lastAt, now, "days"));
      const name =
        one.client ??
        billedParty({ registerId: "quotes", fieldsJson: one.fieldsJson }, undefined)?.name;
      return name === undefined
        ? `No answer to ${quote} in ${days}.`
        : `${name} hasn't answered ${quote} in ${days}.`;
    },
    (count, cut) => {
      const sum = total(
        cut.flatMap((one) =>
          one.minor === null || one.currency === null
            ? []
            : [{ minor: one.minor, currency: one.currency }],
        ),
      );
      return `and ${count} more unanswered quote${count === 1 ? "" : "s"}${sum === "" ? "" : `, ${sum} in all`}.`;
    },
  );
  return [...bankLines, ...invoices, ...unanswered];
});

/** `morningMoneyLines` for whoever reads `chatId`: every person in it, at what all of them see. */
export const morningMoneyFor = Effect.fn("KinMorningMoney.forChat")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly now: number;
  readonly said?: string | undefined;
  readonly offeredFacts?: ReadonlySet<string> | undefined;
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
    said: input.said,
    offeredFacts: input.offeredFacts,
    viewer: owners ? KIN_OWNER_LEVEL : viewerOfPeople(readers.map((reader) => reader.personId)),
  });
});
