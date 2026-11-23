import {
  KinAgentId,
  KinPersonId,
  KinRecordId,
  type KinOrgId,
  type KinPulseActor,
  type KinPulseFact,
  formatKinLate,
  formatKinWhen,
  KIN_TEXT_LOCALE,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as SqlClient from "effect/sql/SqlClient";

import type { SectionId } from "../../shell/sections.ts";
import { dayIn } from "../../work/money.ts";
import { issuedNumber, labelledNow } from "../../work/recordRows.ts";
import { DAY_MS, HOUR_MS, type Threshold } from "../thresholds.ts";

/** What every sense reads with: the org, the instant, the owner's zone and who acts by default. */
export interface SenseContext {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly zone: string;
  /** The Chief of staff, else the first live agent. */
  readonly chief: KinAgentId | undefined;
  /** The Finance agent, else the Chief of staff. */
  readonly finance: KinAgentId | undefined;
  /** The Tech agent (engineering), else the Chief of staff. */
  readonly tech: KinAgentId | undefined;
  readonly liveAgents: ReadonlySet<string>;
}

/**
 * A fact before its stored handling is joined on. `yours` words it for one person it names
 * ("Your meeting …"); the read for that person uses it, and it never leaves the server.
 * `quietForMs` bounds "not a problem" on a fact that stays true as it worsens.
 */
export type SensedFact = Omit<KinPulseFact, "handled"> & {
  readonly yours?: (personId: string) => string | undefined;
  readonly quietForMs?: number;
  /** The section whose switch silences it, when its sense alone doesn't say: a list's own too. */
  readonly section?: SectionId | `list:${string}`;
};

/** An entry with its project and client, as every record sense selects it (`r`, `p`, `c`). */
export interface EntryRow {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly dueAt: number | null;
  readonly dateAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly sensitive: number;
  readonly projectKey: string | null;
  readonly projectTitle: string | null;
  readonly clientKey: string | null;
  readonly clientTitle: string | null;
  readonly clientId: string | null;
  readonly number: unknown;
}

export const entryColumns = (sql: SqlClient.SqlClient) => sql`r.record_id AS "recordId", r.key,
  r.title, r.owner_kind AS "ownerKind", r.owner_id AS "ownerId", r.due_at AS "dueAt",
  r.date_at AS "dateAt", r.created_at AS "createdAt", r.updated_at AS "updatedAt",
  r.amount_minor AS "amountMinor", r.currency, ${labelledNow(sql)} AS sensitive,
  p.key AS "projectKey", p.title AS "projectTitle", c.key AS "clientKey", c.title AS "clientTitle",
  c.record_id AS "clientId", json_extract(r.fields_json, '$.number') AS "number"`;

export const entryJoins = (sql: SqlClient.SqlClient) => sql`kin_records r
  LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id
  LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = COALESCE(r.party_id, p.party_id)`;

export const entrySubject = (row: EntryRow) => ({
  kind: "record" as const,
  key: row.key,
  title: row.title,
  recordId: KinRecordId.make(row.recordId),
  ...issuedNumber(row.number),
});

export const entryScope = (row: EntryRow) => ({
  ...(row.projectKey === null ? {} : { projectKey: row.projectKey }),
  ...(row.projectTitle === null ? {} : { projectTitle: row.projectTitle }),
  ...(row.clientKey === null ? {} : { clientKey: row.clientKey }),
  ...(row.clientTitle === null ? {} : { clientTitle: row.clientTitle }),
});

/** Work goes to whoever holds the entry: its agent if live, the person, else the Chief of staff. */
export const holderOf = (ctx: SenseContext, row: EntryRow): KinPulseActor =>
  row.ownerKind === "agent" && ctx.liveAgents.has(row.ownerId)
    ? { _tag: "agent", agentId: KinAgentId.make(row.ownerId) }
    : row.ownerKind === "person"
      ? { _tag: "person", personId: KinPersonId.make(row.ownerId) }
      : agentOrOwner(ctx.chief);

export const agentOrOwner = (agentId: KinAgentId | undefined): KinPulseActor =>
  agentId === undefined ? { _tag: "owner" } : { _tag: "agent", agentId };

export const measure = (value: number, t: Threshold) => ({
  value: Math.floor(value),
  unit: t.unit,
  threshold: t.value,
  from: t.from,
});

/** Whole hours or days between two instants, in the threshold's unit. */
export const elapsed = (from: number, to: number, unit: "hours" | "days") =>
  Math.floor((to - from) / (unit === "hours" ? HOUR_MS : DAY_MS));

export const dayOf = (ctx: SenseContext, ms: number) => dayIn(ms, ctx.zone);
/** How long ago a day was in the owner's zone, by calendar day: "today", "yesterday", "3 days ago". */
export const daysAgoText = (ctx: SenseContext, ms: number) => {
  const days = Math.round((Date.parse(dayOf(ctx, ctx.at)) - Date.parse(dayOf(ctx, ms))) / DAY_MS);
  return days < 1 ? "today" : days === 1 ? "yesterday" : `${daysText(days)} ago`;
};
/** A moment in the owner's zone, such as "Thu 19 Nov, 15:00". */
export const whenOf = (ctx: SenseContext, ms: number) =>
  formatKinWhen(ms, "dayTime", { zone: ctx.zone, locale: KIN_TEXT_LOCALE });
/** How long since `ms`, to follow a verb: "for 5 hours", "for 12 days", "since 1 Jan 1999". */
export const lateText = (ctx: SenseContext, ms: number) =>
  formatKinLate(ms, ctx.at, { zone: ctx.zone, locale: KIN_TEXT_LOCALE });
export const daysText = (days: number) => (days === 1 ? "1 day" : `${days} days`);
export const hoursText = (hours: number) => (hours === 1 ? "1 hour" : `${hours} hours`);
/** An instant as facts carry it. */
export const iso = (ms: number) => DateTime.makeUnsafe(ms);
