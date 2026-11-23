import {
  kinWhenParts,
  KIN_TEXT_LOCALE,
  type KinOrgId,
  type KinPersonId,
  KinPersonId as PersonId,
  type KinPulseFact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { ownerLevel } from "../people/KinAccess.ts";
import { validZone } from "../triggers/quietHold.ts";
import { storedWorkHours } from "../triggers/quietHours.ts";
import { dueWhenText, endOfDay, ownerZone, startOfDay } from "../work/recordRows.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "../work/teamView.ts";
import { asideOf, type Hold } from "./holds.ts";
import { holderLine, noticeHolder } from "./holderNotice.ts";
import { DEAL_SENSES } from "./senses/deals.ts";
import { type SenseContext, type SensedFact } from "./senses/shared.ts";
import { DAY_MS, HOUR_MS } from "./thresholds.ts";
import { forHolder, markTold, untold } from "./told.ts";
import type { KinShell as Shell } from "@t3tools/contracts";
import { sectionOn } from "../shell/KinShell.ts";
import { morningMoneyLines } from "./morningMoney.ts";

/**
 * A teammate's own morning page: "Good morning, <name>" over Needs you, Clients and Coming up,
 * written by Kin from their own facts at the start of their day. Nothing to say, no page.
 */

const WEEKDAYS = [1, 2, 3, 4, 5];
const DEFAULT_AT = "08:00";
/** After the start of their day, how long a page that couldn't go yet (quiet, away) may still go. */
const WINDOW_MS = 6 * HOUR_MS;
const COMING_DAYS = 7;
const SHOWN = 8;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The told row that says this person's page for a day went out. */
const morningKey = (day: string) => `person-morning:${day}`;

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

interface Candidate {
  readonly personId: string;
  readonly zone: string | null;
  readonly hours: string | null;
  readonly morning: string | null;
}

/** `kin_people.morning_json`: the page as its person set it, since `since` (epoch ms). */
const StoredMorning = Schema.Struct({
  at: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  days: Schema.Array(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(6)),
  ).check(Schema.isMinLength(1)),
  on: Schema.Boolean,
  since: Schema.optional(Schema.Number),
});
export type StoredMorning = typeof StoredMorning.Type;
const decodeMorning = Schema.decodeUnknownOption(Schema.fromJsonString(StoredMorning));
export const morningJson = Schema.encodeSync(Schema.fromJsonString(StoredMorning));

/**
 * When a person's page comes: as they set it, else at their working hours' start on their working
 * days, else 08:00 on weekdays. A setting's `since` keeps a time already past that day for the next.
 */
export const morningOf = (hoursJson: string | null, morningJson: string | null = null) => {
  const set = morningJson === null ? undefined : Option.getOrUndefined(decodeMorning(morningJson));
  if (set !== undefined) return set;
  const hours = storedWorkHours(hoursJson);
  return hours === undefined || hours.days.length === 0
    ? { at: DEFAULT_AT, days: WEEKDAYS, on: true }
    : { at: hours.start, days: hours.days, on: true };
};

/** The page due for this person at `at`: its day and the minute it was set for, else undefined. */
const morningStart = (
  morning: {
    readonly at: string;
    readonly days: ReadonlyArray<number>;
    readonly on?: boolean;
    readonly since?: number | undefined;
  },
  zone: string,
  at: number,
) => {
  if (morning.on === false) return undefined;
  const parts = kinWhenParts(at, zone);
  const day = DAY_NAMES.indexOf(parts.weekday);
  if (!morning.days.includes(day)) return undefined;
  const elapsed = (parts.hour * 60 + parts.minute - minutes(morning.at)) * 60_000;
  if (elapsed < 0 || elapsed >= WINDOW_MS) return undefined;
  const start = at - (at % 60_000) - elapsed;
  return morning.since !== undefined && start < morning.since
    ? undefined
    : { day: parts.isoDay, start };
};

/** The day whose page is due for this person at `at`, or undefined outside its window. */
export const morningDue = (morning: Parameters<typeof morningStart>[0], zone: string, at: number) =>
  morningStart(morning, zone, at)?.day;

/**
 * Who gets a morning page (`only`: just this person). Whoever has an agent of their own reads its
 * brief instead; the rest with Clients on, in a company with a deal or a prospect.
 */
export const pageReaders = Effect.fn("KinPulse.pageReaders")(function* (
  orgId: KinOrgId,
  only?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [selling] = yield* sql`SELECT 1 FROM kin_records WHERE org_id = ${orgId}
    AND ((register_id = 'deals' AND state = 'open')
      OR (register_id = 'clients' AND category = 'prospect' AND state <> 'dropped'))
    LIMIT 1`;
  if (selling === undefined) return [];
  return yield* sql<Candidate>`SELECT p.person_id AS "personId", p.time_zone AS zone,
      p.work_hours_json AS hours, p.morning_json AS morning FROM kin_people p
    WHERE p.org_id = ${orgId} AND p.removed_at IS NULL
      AND ${only === undefined ? sql`1 = 1` : sql`p.person_id = ${only}`}
      AND (p.access IN ('owner', 'co_owner') OR p.sees_clients = 1)
      AND NOT EXISTS (SELECT 1 FROM kin_agents a WHERE a.org_id = p.org_id
        AND a.owner_person_id = p.person_id AND a.retired_at IS NULL)
    ORDER BY p.person_id`;
});

/** Whether someone's page minute fell after `from`, up to `to`: the pulse runs then, not later. */
export const pageMinuteSince = Effect.fn("KinPulse.pageMinuteSince")(function* (
  orgId: KinOrgId,
  from: number,
  to: number,
) {
  const people = yield* pageReaders(orgId);
  if (people.length === 0) return false;
  const zone = yield* ownerZone(orgId);
  return people.some((person) => {
    const due = morningStart(
      morningOf(person.hours, person.morning),
      validZone(person.zone) ?? zone,
      to,
    );
    return due !== undefined && due.start > from;
  });
});

/** Of these deal facts, the records imported since `from`: an import alone is no news until a morning. */
export const importedSince = Effect.fn("KinPulse.importedSince")(function* (
  orgId: KinOrgId,
  facts: ReadonlyArray<Pick<KinPulseFact, "sense" | "subject">>,
  from: number,
) {
  const ids = facts.flatMap((fact) =>
    DEAL_SENSES.has(fact.sense) && fact.subject.recordId !== undefined
      ? [fact.subject.recordId]
      : [],
  );
  if (ids.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string }>`SELECT record_id AS "recordId" FROM kin_records
    WHERE org_id = ${orgId} AND record_id IN ${sql.in(ids)}
      AND origin_key LIKE 'import:%' AND created_at >= ${from}
    ORDER BY record_id`;
  return new Set(rows.map((row) => row.recordId));
});

/**
 * One page's body: only the sections with something in them. A section's title is a "Clients:"
 * line, which a page reads as its heading and an older phone, drawing it as a notice, as plain text.
 */
export const morningBody = (sections: {
  readonly needsYou: ReadonlyArray<string>;
  /** Already cut to length (`morningMoneyLines`). */
  readonly money?: ReadonlyArray<string>;
  readonly clients: ReadonlyArray<string>;
  readonly comingUp: ReadonlyArray<string>;
}) => {
  const section = (title: string, lines: ReadonlyArray<string>) =>
    lines.length === 0
      ? []
      : [
          [
            `${title}:`,
            ...lines.slice(0, SHOWN).map((line) => `- ${line}`),
            ...(lines.length > SHOWN ? [`- and ${lines.length - SHOWN} more`] : []),
          ].join("\n"),
        ];
  return [
    ...section("Needs you", sections.needsYou),
    ...section("Money", sections.money ?? []),
    ...section("Clients", sections.clients),
    ...section("Coming up", sections.comingUp),
  ].join("\n\n");
};

/**
 * Each teammate whose day starts now gets their page once: their own late and due work, follow-ups
 * today and deals that need a word (only what they haven't been told as it stands), and what is
 * coming up. Those facts count as told, so no other notice repeats them. Returns who got one.
 */
export const morningPages = Effect.fn("KinPulse.morningPages")(function* (input: {
  readonly ctx: SenseContext;
  /** Open facts as sensed, not handled. */
  readonly open: ReadonlyArray<SensedFact>;
  readonly holds: ReadonlyArray<Hold>;
  readonly shell: Shell;
  /** The facts this person may see (`visibleTo`). */
  readonly sees: (
    personId: KinPersonId,
  ) => Effect.Effect<ReadonlyArray<SensedFact>, SqlError.SqlError, SqlClient.SqlClient>;
}) {
  const { ctx } = input;
  const { orgId, at } = ctx;
  const sql = yield* SqlClient.SqlClient;
  const sent: Array<{ readonly personId: string; readonly day: string }> = [];
  if (ctx.chief === undefined) return sent;
  const people = yield* pageReaders(orgId);
  for (const person of people) {
    const zone = validZone(person.zone) ?? ctx.zone;
    const morning = morningOf(person.hours, person.morning);
    const day = morningDue(morning, zone, at);
    if (day === undefined) continue;
    const [done] = yield* sql`SELECT 1 FROM kin_pulse_told WHERE org_id = ${orgId}
      AND person_id = ${person.personId} AND fact_key = ${morningKey(day)} LIMIT 1`;
    if (done !== undefined) continue;
    const personId = PersonId.make(person.personId);
    const reader = { _tag: "people" as const, people: [personId] };
    const raw = new Map(input.open.map((fact) => [fact.key, fact]));
    const seen = (yield* input.sees(personId)).filter((fact) => {
      const sensed = raw.get(fact.key);
      return (
        fact.actor._tag === "person" &&
        fact.actor.personId === personId &&
        sensed !== undefined &&
        asideOf(sensed, input.holds, reader) === undefined
      );
    });
    const facts = yield* untold({
      orgId,
      personId,
      facts: seen.map(({ yours: _yours, section: _section, ...fact }): KinPulseFact => ({
        ...fact,
        handled: null,
      })),
      at,
      zone: ctx.zone,
      anyState: true,
    });
    const from = startOfDay(day, zone);
    const late = yield* importedSince(orgId, facts, from + minutes(morning.at) * 60_000);
    const deals = facts.filter(
      (fact) =>
        DEAL_SENSES.has(fact.sense) &&
        (fact.subject.recordId === undefined || !late.has(fact.subject.recordId)),
    );
    const work = facts.filter((fact) => forHolder(fact, at, ctx.zone));
    const to = endOfDay(day, zone);
    const [today] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.side = 'ours'
        AND r.state IN ('open', 'doing', 'waiting') AND r.party_id IS NOT NULL
        AND r.owner_kind = 'person' AND r.owner_id = ${personId}
        AND r.due_at >= ${from} AND r.due_at <= ${to}`;
    const followUps = sectionOn(input.shell, "clients") ? (today?.count ?? 0) : 0;
    const clients = [
      ...(followUps === 0 ? [] : [`Follow-ups today: ${followUps}.`]),
      ...deals.map((fact) => fact.consequence),
    ];
    // Money still owed or unanswered, for a reader who may see it: every morning until settled.
    const money = yield* morningMoneyLines({
      orgId,
      now: at,
      viewer: (yield* ownerLevel(orgId, personId)) ? KIN_OWNER_LEVEL : viewerOfPeople([personId]),
    });
    // Written from what is true at its minute, and only with something untold: else none that day.
    if ((clients.length === 0 || deals.length + work.length === 0) && money.length === 0) {
      yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id, sig, told_at)
        VALUES (${orgId}, ${personId}, ${morningKey(day)}, 'none', ${day}, ${at})
        ON CONFLICT DO NOTHING`;
      continue;
    }
    const dues = new Map(
      work.length === 0
        ? []
        : (yield* sql<{ recordId: string; dueAt: number }>`SELECT record_id AS "recordId",
            due_at AS "dueAt" FROM kin_records WHERE org_id = ${orgId}
              AND record_id IN ${sql.in(work.flatMap((fact) => fact.subject.recordId ?? []))}
              AND due_at IS NOT NULL ORDER BY record_id`).map((row) => [row.recordId, row.dueAt]),
    );
    const needsYou = work.flatMap((fact) => {
      const due = fact.subject.recordId === undefined ? undefined : dues.get(fact.subject.recordId);
      if (due === undefined) return [];
      const line = holderLine(ctx, fact, due);
      return [`${line.key} ${line.title}, ${line.state}`];
    });
    const day7 = to + COMING_DAYS * DAY_MS;
    const clock = { zone, locale: KIN_TEXT_LOCALE };
    const when = (row: { readonly dueAt: number; readonly allDay: number }) =>
      dueWhenText(row.dueAt, row.allDay === 1, ctx.zone, clock, "day");
    const steps = !sectionOn(input.shell, "clients")
      ? []
      : yield* sql<{
          title: string;
          client: string;
          dueAt: number;
          allDay: number;
        }>`SELECT r.title, c.title AS client, r.due_at AS "dueAt", r.due_all_day AS "allDay"
      FROM kin_records r JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
      WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.side = 'ours'
        AND r.state IN ('open', 'doing', 'waiting')
        AND r.owner_kind = 'person' AND r.owner_id = ${personId}
        AND r.due_at > ${to} AND r.due_at <= ${day7}
      ORDER BY r.due_at, r.key LIMIT ${SHOWN}`;
    const expected = !sectionOn(input.shell, "deals")
      ? []
      : yield* sql<{
          title: string;
          client: string;
          dueAt: number;
          allDay: number;
        }>`SELECT r.title, c.title AS client, r.due_at AS "dueAt", r.due_all_day AS "allDay"
      FROM kin_records r JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
      WHERE r.org_id = ${orgId} AND r.register_id = 'deals' AND r.state = 'open'
        AND r.owner_kind = 'person' AND r.owner_id = ${personId}
        AND r.due_at > ${to} AND r.due_at <= ${day7}
      ORDER BY r.due_at, r.key LIMIT ${SHOWN}`;
    const comingUp = [
      ...steps.map((row) => ({
        at: row.dueAt,
        line: `${row.title} (${row.client}), ${when(row)}.`,
      })),
      ...expected.map((row) => ({
        at: row.dueAt,
        line: `${row.title} for ${row.client} is expected by ${when(row)}.`,
      })),
    ]
      .toSorted((a, b) => a.at - b.at)
      .map((one) => one.line);
    const body = morningBody({ needsYou, money, clients, comingUp });
    const messageId = yield* noticeHolder({
      orgId,
      personId,
      agentId: ctx.chief,
      body,
      key: NodeCrypto.createHash("sha256")
        .update(`${orgId}\0${personId}\0morning\0${day}`)
        .digest("hex")
        .slice(0, 32),
      form: "brief",
      onlyIfFree: true,
    });
    if (messageId === undefined) continue;
    yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id, sig, told_at)
      VALUES (${orgId}, ${personId}, ${morningKey(day)}, ${messageId}, ${day}, ${at})
      ON CONFLICT DO NOTHING`;
    yield* markTold({
      orgId,
      personId,
      eventId: messageId,
      facts: [...deals, ...work],
      at,
      zone: ctx.zone,
    });
    sent.push({ personId, day });
  }
  return sent;
});
