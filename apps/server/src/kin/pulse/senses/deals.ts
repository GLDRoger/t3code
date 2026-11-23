import {
  formatKinWhen,
  KIN_PROMISE_SENSES,
  KIN_TEXT_LOCALE,
  KinPersonId,
  KinRecordId,
  type KinPulseActor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { lastContacts } from "../../work/touches.ts";
import { DAY_MS, thresholds } from "../thresholds.ts";
import { daysAgoText, daysText, iso, type SenseContext, type SensedFact } from "./shared.ts";
import { SENSE_CAP } from "./work.ts";

interface DealRow {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly dueAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sensitive: number;
  readonly clientId: string;
  readonly clientKey: string;
  readonly clientTitle: string;
  readonly clientOwnerKind: string;
  readonly clientOwnerId: string;
  /** Open follow-ups of ours linked to it: its next steps. */
  readonly steps: number;
  /** The newest a linked follow-up was closed, or changed. */
  readonly stepClosedAt: number | null;
  readonly stepChangedAt: number | null;
  readonly commentAt: number | null;
}

interface ProspectRow {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly sensitive: number;
  readonly stepClosedAt: number | null;
}

/**
 * Who hears a deal's fact: whoever looks after it; for an agent's, the client's person; else, or
 * when that person has left, the owner.
 */
const hearer = (
  present: ReadonlySet<string>,
  ...owners: ReadonlyArray<{ readonly kind: string; readonly id: string }>
): KinPulseActor => {
  for (const owner of owners)
    if (owner.kind === "person" && present.has(owner.id))
      return { _tag: "person", personId: KinPersonId.make(owner.id) };
  return { _tag: "owner" };
};

/**
 * Deals nobody is moving: an open deal with no next step (and a prospect with neither a deal nor
 * one), a deal gone quiet for `deal_quiet_days`, and a deal past its expected day.
 */
export const dealSenses = Effect.fn("KinPulse.dealSenses")(function* (ctx: SenseContext) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const deals = yield* sql<DealRow>`SELECT d.record_id AS "recordId", d.key, d.title,
      d.owner_kind AS "ownerKind", d.owner_id AS "ownerId", d.due_at AS "dueAt",
      d.created_at AS "createdAt", d.updated_at AS "updatedAt",
      (d.sensitive = 1 OR c.sensitive = 1) AS sensitive,
      c.record_id AS "clientId", c.key AS "clientKey", c.title AS "clientTitle",
      c.owner_kind AS "clientOwnerKind", c.owner_id AS "clientOwnerId",
      (SELECT COUNT(*) FROM kin_record_links l JOIN kin_records w ON w.org_id = l.org_id
        AND w.record_id = l.record_id
        WHERE l.org_id = d.org_id AND l.kind = 'record' AND l.target = d.record_id
          AND w.register_id = 'work' AND w.side = 'ours'
          AND w.state NOT IN ('done', 'dropped')) AS steps,
      (SELECT MAX(w.closed_at) FROM kin_record_links l JOIN kin_records w ON w.org_id = l.org_id
        AND w.record_id = l.record_id
        WHERE l.org_id = d.org_id AND l.kind = 'record' AND l.target = d.record_id
          AND w.register_id = 'work') AS "stepClosedAt",
      (SELECT MAX(w.updated_at) FROM kin_record_links l JOIN kin_records w ON w.org_id = l.org_id
        AND w.record_id = l.record_id
        WHERE l.org_id = d.org_id AND l.kind = 'record' AND l.target = d.record_id
          AND w.register_id = 'work') AS "stepChangedAt",
      (SELECT MAX(m.created_at) FROM kin_record_comments m
        WHERE m.org_id = d.org_id AND m.record_id = d.record_id AND m.removed_at IS NULL)
        AS "commentAt"
    FROM kin_records d
    JOIN kin_records c ON c.org_id = d.org_id AND c.record_id = d.party_id
    WHERE d.org_id = ${orgId} AND d.register_id = 'deals' AND d.state = 'open'
    ORDER BY d.created_at, d.key LIMIT ${SENSE_CAP}`;
  // A prospect's next step is any open entry of ours for it (`crm.ts` `next`), deal or none.
  const prospects = yield* sql<ProspectRow>`SELECT c.record_id AS "recordId", c.key, c.title,
      c.owner_kind AS "ownerKind", c.owner_id AS "ownerId", c.created_at AS "createdAt",
      c.sensitive,
      (SELECT MAX(w.closed_at) FROM kin_records w WHERE w.org_id = c.org_id
        AND w.party_id = c.record_id AND w.register_id = 'work') AS "stepClosedAt"
    FROM kin_records c
    WHERE c.org_id = ${orgId} AND c.register_id = 'clients' AND c.category = 'prospect'
      AND c.state <> 'dropped'
      AND NOT EXISTS (SELECT 1 FROM kin_records d WHERE d.org_id = c.org_id
        AND d.register_id = 'deals' AND d.party_id = c.record_id AND d.state = 'open')
      AND NOT EXISTS (SELECT 1 FROM kin_records w WHERE w.org_id = c.org_id
        AND w.register_id = 'work' AND w.party_id = c.record_id AND w.side = 'ours'
        AND w.state NOT IN ('done', 'dropped'))
    ORDER BY c.created_at, c.key LIMIT ${SENSE_CAP}`;
  if (deals.length === 0 && prospects.length === 0) return [];
  const present = new Set(
    (yield* sql<{ personId: string }>`SELECT person_id AS "personId" FROM kin_people
      WHERE org_id = ${orgId} AND removed_at IS NULL ORDER BY person_id`).map(
      (row) => row.personId,
    ),
  );
  const limits = yield* thresholds(orgId);
  const contacts = yield* lastContacts(orgId, [...new Set(deals.map((deal) => deal.clientId))], at);
  const quiet = limits("deal_quiet_days");
  const facts: Array<SensedFact> = [];
  for (const deal of deals) {
    const named = `${deal.title} for ${deal.clientTitle}`;
    const base = {
      family: "work" as const,
      subject: {
        kind: "record" as const,
        key: deal.key,
        title: deal.title,
        recordId: KinRecordId.make(deal.recordId),
      },
      scope: { clientKey: deal.clientKey, clientTitle: deal.clientTitle },
      actor: hearer(
        present,
        { kind: deal.ownerKind, id: deal.ownerId },
        ...(deal.ownerKind === "agent"
          ? [{ kind: deal.clientOwnerKind, id: deal.clientOwnerId }]
          : []),
      ),
      sensitive: deal.sensitive === 1,
      wake: "sweep" as const,
    };
    if (deal.steps === 0) {
      // From when its last step was closed, or it was made with none: a new episode each time.
      const since = Math.max(deal.createdAt, deal.stepClosedAt ?? 0);
      facts.push({
        ...base,
        sense: "deal_no_next_step",
        key: `deal_no_next_step:${deal.key}:${since}`,
        since: iso(since),
        consequence: `${named} has no next step.`,
      });
    }
    const last = Math.max(
      deal.createdAt,
      deal.updatedAt,
      deal.stepChangedAt ?? 0,
      deal.commentAt ?? 0,
      contacts.get(deal.clientId) ?? 0,
    );
    const days = Math.floor((at - last) / DAY_MS);
    if (days >= quiet.value)
      facts.push({
        ...base,
        sense: "deal_quiet",
        key: `deal_quiet:${deal.key}:${last}`,
        since: iso(last + quiet.value * DAY_MS),
        measure: { value: days, unit: "days", threshold: quiet.value, from: quiet.from },
        consequence: `${named} has been quiet for ${daysText(days)}: no contact, note, stage move or next-step change.`,
      });
    if (deal.dueAt !== null && deal.dueAt < at)
      facts.push({
        ...base,
        sense: "deal_date_passed",
        key: `deal_date_passed:${deal.key}:due=${deal.dueAt}`,
        since: iso(deal.dueAt),
        consequence: `${named} was expected by ${formatKinWhen(deal.dueAt, "day", { zone: ctx.zone, locale: KIN_TEXT_LOCALE })}, ${daysAgoText(ctx, deal.dueAt)}, and is still open.`,
      });
  }
  for (const prospect of prospects) {
    const since = Math.max(prospect.createdAt, prospect.stepClosedAt ?? 0);
    facts.push({
      sense: "deal_no_next_step",
      family: "work",
      key: `deal_no_next_step:${prospect.key}:${since}`,
      subject: {
        kind: "record",
        key: prospect.key,
        title: prospect.title,
        recordId: KinRecordId.make(prospect.recordId),
      },
      scope: { clientKey: prospect.key, clientTitle: prospect.title },
      since: iso(since),
      consequence: `${prospect.title} is a prospect with no deal and no next step.`,
      actor: hearer(present, { kind: prospect.ownerKind, id: prospect.ownerId }),
      sensitive: prospect.sensitive === 1,
      wake: "sweep",
    });
  }
  return facts;
});

/** The senses this file raises, a deal's own (`shell/sections.ts` puts them in Deals). */
export const DEAL_SENSES: ReadonlySet<string> = new Set([
  "deal_no_next_step",
  "deal_quiet",
  "deal_date_passed",
]);

/**
 * Facts a person hears as the one who looks after the deal or client: a deal's, and a contract's
 * notice day (`money.ts`), which is about the project, not a deal.
 */
export const LOOKED_AFTER_SENSES: ReadonlySet<string> = new Set([
  ...DEAL_SENSES,
  ...KIN_PROMISE_SENSES,
]);
