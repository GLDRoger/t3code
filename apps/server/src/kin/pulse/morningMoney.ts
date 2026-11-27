import {
  formatKinWhen,
  KIN_TEXT_LOCALE,
  type KinChatId,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { MAIL_TOOL } from "../connections/MailProvider.ts";
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
/** A rest line that would stand for one or two entries saves nothing: they are listed instead. */
const MONEY_SLACK = 2;
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

const decodeAddresses = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
/** Names joined as a person says them: "Sam", "Sam and Lee", "Sam, Lee and Ana". */
const listed = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * Where each entry's reminder stands, from company mailboxes only (a person's own mail stays
 * theirs): its newest card waiting on a Confirm, else the day its last one went. Only mail after
 * `since` counts, so an invoice's own mail before its due day is no reminder. Kin knows only mail
 * sent through it, so "none" says so.
 */
const reminderClauses = Effect.fn("KinMorningMoney.reminders")(function* (input: {
  readonly orgId: KinOrgId;
  readonly entries: ReadonlyArray<{ readonly recordId: string; readonly since: number }>;
  readonly cards: boolean;
  readonly noun: "reminder" | "follow-up";
}) {
  const sql = yield* SqlClient.SqlClient;
  const since = new Map(input.entries.map((one) => [one.recordId, one.since]));
  if (since.size === 0) return new Map<string, string>();
  const rows = (yield* sql<{
    recordId: string;
    state: string;
    at: number;
    agent: string | null;
    to: string | null;
  }>`SELECT k.entry_record_id AS "recordId", k.state, COALESCE(k.done_at, k.proposed_at) AS at,
      a.display_name AS agent, json_extract(k.payload_json, '$.to') AS "to"
    FROM kin_connection_asks k
    JOIN kin_connections c ON c.org_id = k.org_id AND c.connection_id = k.connection_id
    LEFT JOIN kin_agents a ON a.org_id = k.org_id AND a.agent_id = k.agent_id
    WHERE k.org_id = ${input.orgId} AND k.entry_record_id IN ${sql.in([...since.keys()])}
      AND c.person_id IS NULL AND k.tool_name IN ${sql.in([MAIL_TOOL.send, MAIL_TOOL.reply])}
      AND (k.state = 'sent' AND k.done_at IS NOT NULL ${input.cards ? sql`OR k.state = 'open'` : sql``})
    ORDER BY at DESC, k.rowid DESC`).filter((row) => row.at > since.get(row.recordId)!);
  const card = new Map<string, (typeof rows)[number]>();
  const sent = new Map<string, number>();
  for (const row of rows)
    if (row.state === "open") {
      if (!card.has(row.recordId)) card.set(row.recordId, row);
    } else if (!sent.has(row.recordId)) sent.set(row.recordId, row.at);
  const addressesOf = (to: string | null) =>
    Option.getOrElse(decodeAddresses(to ?? "[]"), () => []).map((one) => one.trim());
  const addresses = [
    ...new Set(
      [...card.values()].flatMap((row) => addressesOf(row.to).map((one) => one.toLowerCase())),
    ),
  ];
  const contacts = new Map<string, string>();
  if (addresses.length > 0)
    for (const row of yield* sql<{ email: string; name: string }>`
      SELECT lower(trim(json_extract(fields_json, '$.email'))) AS email, title AS name
      FROM kin_records
      WHERE org_id = ${input.orgId} AND register_id = 'contacts' AND state = 'open'
        AND lower(trim(json_extract(fields_json, '$.email'))) IN ${sql.in(addresses)}
      ORDER BY lower(title), key`)
      if (!contacts.has(row.email)) contacts.set(row.email, row.name);
  const zone = sent.size === 0 ? "UTC" : yield* ownerZone(input.orgId);
  const clauses = new Map<string, string>();
  for (const recordId of since.keys()) {
    const open = card.get(recordId);
    const went = sent.get(recordId);
    const to = listed(
      addressesOf(open?.to ?? null).map((one) => contacts.get(one.toLowerCase()) ?? one),
    );
    clauses.set(
      recordId,
      open !== undefined
        ? `a ${input.noun}${to === "" ? "" : ` to ${to}`} waits on your Confirm${open.agent === null ? "" : ` in ${open.agent}'s chat`}`
        : went !== undefined
          ? `${input.noun} sent ${formatKinWhen(went, "day", { zone, locale: KIN_TEXT_LOCALE }).replace(/,/g, "")}`
          : `no ${input.noun} sent through Kin yet`,
    );
  }
  return clauses;
});

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
    entries.length <= MONEY_SHOWN + MONEY_SLACK
      ? entries.map(line)
      : [
          ...entries.slice(0, MONEY_SHOWN).map(line),
          rest(entries.length - MONEY_SHOWN, entries.slice(MONEY_SHOWN)),
        ];
  const overdue = (yield* owedInvoices({ orgId, now, seen })).filter((one) => one.overdue);
  const asides = yield* invoiceAsides({ orgId, at: now, viewer: input.viewer, invoices: overdue });
  // Only the owner level can open the chat a card waits in.
  const cards = input.viewer._tag === "ownerLevel";
  const told = overdue.filter(
    (one) =>
      !asides.has(one.recordId) &&
      !saysName(one.number, one.title) &&
      !names(said, one.partyTitle ?? one.billTo ?? null),
  );
  const invoiceReminders = yield* reminderClauses({
    orgId,
    cards,
    noun: "reminder",
    entries: told.map((one) => ({ recordId: one.recordId, since: one.dueAt ?? now })),
  });
  // Longest overdue first: what the pulse chases soonest is never the part cut.
  const invoices = shown(
    told.toSorted((a, b) => b.daysOverdue - a.daysOverdue),
    (one) => {
      const name = one.partyTitle ?? one.billTo;
      const amount = formatMoneyPlain(one.balance);
      const entry = entryName(one.number, one.title);
      const owed =
        name === undefined ? `${entry} is owed ${amount}` : `${name} owes ${amount} on ${entry}`;
      return `${owed}, ${overdueText(one.daysOverdue)}; ${invoiceReminders.get(one.recordId)}.`;
    },
    (count, cut) =>
      `and ${count} more overdue invoice${count === 1 ? "" : "s"}, ${total(cut.map((one) => one.balance))} in all.`,
  );
  const limits = yield* thresholds(orgId);
  const quotes = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    clientId: string | null;
    client: string | null;
    fieldsJson: string;
    minor: number | null;
    currency: string | null;
    number: unknown;
    lastAt: number;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, r.party_id AS "clientId", c.title AS client, r.amount_minor AS minor, r.fields_json AS "fieldsJson",
      r.currency, json_extract(r.fields_json, '$.number') AS number,
      COALESCE((SELECT MAX(ch.at) FROM kin_record_changes ch
        WHERE ch.org_id = r.org_id AND ch.record_id = r.record_id), r.updated_at) AS "lastAt"
    FROM kin_records r
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'quotes' AND r.state = 'waiting'
      AND ${countedEntry(sql)} AND ${seen}
    ORDER BY "lastAt", r.key`;
  const waiting = quotes.filter(
    (one) =>
      one.lastAt <= now - toMs(limits("quote_follow_up_days", one.clientId ?? undefined)) &&
      !saysName(one.number, one.title),
  );
  // The quote's own mail moves it to waiting, a change at or after its send: only later mail follows up.
  const followUps = yield* reminderClauses({
    orgId,
    cards,
    noun: "follow-up",
    entries: waiting.map((one) => ({ recordId: one.recordId, since: one.lastAt })),
  });
  const unanswered = shown(
    waiting,
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
      const stands = followUps.get(one.recordId);
      return name === undefined
        ? `No answer to ${quote} in ${days}; ${stands}.`
        : `${name} hasn't answered ${quote} in ${days}; ${stands}.`;
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
