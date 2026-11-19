import {
  KIN_CHOICE_CARD_TTL_MS,
  KinChatError,
  type KinOrgId,
  type KinPersonId,
  formatKinWhen,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { accessOf, accessSql } from "../people/KinAccess.ts";
import { textLocale } from "../work/companyProfile.ts";
import { ownerZone } from "../work/recordRows.ts";
import { DAY_MS, type RuleContext } from "./rules.ts";

/*
 * The stored side of recommendations (`kin_recommendations`): what Kin asked, what the owner
 * answered, and until when a rule stays quiet. Everything else is read live from the card.
 */

/** Not now: 30 days, then 90, then for good. */
export const DECLINE_QUIET_MS = [30 * DAY_MS, 90 * DAY_MS] as const;
/** A card that ran out unanswered is neither a yes nor a no: a week's quiet. */
const RAN_OUT_QUIET_MS = 7 * DAY_MS;
/** A done change undone from Settings is not suggested back for this long. */
export const UNDONE_QUIET_MS = 90 * DAY_MS;

export type StoredRow = {
  readonly recId: string;
  readonly rule: string;
  readonly subject: string;
  readonly widgetId: string;
  readonly noticed: string;
  readonly state: "open" | "done" | "declined" | "stale";
  readonly postedAt: number;
  readonly decidedAt: number | null;
  readonly quietUntil: number | null;
  readonly cardAt: string | null;
  readonly closedAt: string | null;
};

const columns = `r.rec_id AS "recId", r.rule, r.subject, r.widget_id AS "widgetId", r.noticed,
  r.state, r.posted_at AS "postedAt", r.decided_at AS "decidedAt", r.quiet_until AS "quietUntil",
  w.updated_at AS "cardAt", w.closed_at AS "closedAt"`;

export const storedRows = Effect.fn("KinRecommendLedger.rows")(function* (
  orgId: KinOrgId,
  where: { readonly recId?: string; readonly rule?: string; readonly subject?: string },
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<StoredRow>`SELECT ${sql.literal(columns)} FROM kin_recommendations r
    LEFT JOIN kin_widgets w ON w.org_id = r.org_id AND w.widget_id = r.widget_id
    WHERE r.org_id = ${orgId}
      ${where.recId === undefined ? sql`` : sql`AND r.rec_id = ${where.recId}`}
      ${where.rule === undefined ? sql`` : sql`AND r.rule = ${where.rule}`}
      ${where.subject === undefined ? sql`` : sql`AND r.subject = ${where.subject}`}
    ORDER BY r.posted_at DESC, r.rec_id DESC LIMIT ${limit}`;
});

/** When an open row's card stopped taking taps, or undefined while it still waits on the owner. */
export const ranOutAt = (row: StoredRow, at: number) => {
  if (row.state !== "open") return undefined;
  const expires =
    row.cardAt === null ? row.postedAt : Date.parse(row.cardAt) + KIN_CHOICE_CARD_TTL_MS;
  if (row.closedAt !== null) return Math.min(Date.parse(row.closedAt), expires);
  return expires <= at ? expires : undefined;
};

/**
 * Until when this rule and subject stay quiet after `row`, its latest: an open card, for as long
 * as it waits; after Not now, Undo or a card that ran out, its stored or default quiet. `null`
 * is for good; `undefined` is not quiet.
 */
export const quietAfter = (row: StoredRow | undefined, at: number): number | null | undefined => {
  if (row === undefined) return undefined;
  const ran = ranOutAt(row, at);
  const until =
    row.state === "open"
      ? ran === undefined
        ? null
        : (row.quietUntil ?? ran + RAN_OUT_QUIET_MS)
      : row.state === "declined"
        ? row.quietUntil
        : row.state === "done"
          ? (row.quietUntil ?? undefined)
          : undefined;
  if (until === undefined) return undefined;
  if (until === null) return null;
  return until > at ? until : undefined;
};

/** The owner alone, never a co-owner, sees or answers a suggestion. */
export const isOwner = Effect.fn("KinRecommendLedger.isOwner")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  return (yield* accessOf(orgId, personId)) === "owner";
});

const ownerName = Effect.fn("KinRecommendLedger.ownerName")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ name: string }>`SELECT p.display_name AS name FROM kin_people p
    WHERE p.org_id = ${orgId} AND p.removed_at IS NULL AND ${sql.literal(accessSql("p"))} = 'owner'
    ORDER BY p.person_id LIMIT 1`;
  return row?.name ?? "the owner";
});

export const onlyOwner = Effect.fn("KinRecommendLedger.onlyOwner")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  if (yield* isOwner(orgId, personId)) return;
  return yield* new KinChatError({
    reason: "not_allowed",
    message: `Only ${yield* ownerName(orgId)} can answer this.`,
  });
});

export const ruleContext = Effect.fn("KinRecommendLedger.context")(function* (
  orgId: KinOrgId,
  ownerId: KinPersonId,
  at: number,
) {
  return {
    orgId,
    at,
    ownerId,
    zone: yield* ownerZone(orgId),
    locale: yield* textLocale(orgId),
  } satisfies RuleContext;
});

/** "12 Nov", on the owner's clock. */
export const dayOf = (ctx: RuleContext, at: number) =>
  formatKinWhen(at, "date", { zone: ctx.zone, locale: ctx.locale });
