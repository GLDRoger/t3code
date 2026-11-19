import {
  KIN_CHOICE_CARD_TTL_MS,
  KinChatError,
  type KinOrgId,
  type KinPersonId,
  formatKinWhen,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { accessOf, accessSql } from "../people/KinAccess.ts";
import { textLocale } from "../work/companyProfile.ts";
import { RecommendChange } from "../widgets/cardPlans.ts";
import { ownerZone } from "../work/recordRows.ts";
import { DAY_MS, type RuleContext } from "./rules.ts";

/*
 * The stored side of recommendations (`kin_recommendations`): what Kin asked and offered, what
 * the owner answered, and until when a rule stays quiet. Never the chat.
 */

/** Not now: 30 days, then 90, then for good. */
export const DECLINE_QUIET_MS = [30 * DAY_MS, 90 * DAY_MS] as const;
/** A card that ran out unanswered is neither a yes nor a no: a week's quiet. */
const RAN_OUT_QUIET_MS = 7 * DAY_MS;

type Row = {
  readonly recId: string;
  readonly rule: string;
  readonly subject: string;
  readonly widgetId: string;
  readonly changeJson: string;
  readonly noticed: string;
  readonly state: "open" | "done" | "declined" | "stale";
  readonly postedAt: number;
  readonly endedAt: number | null;
  readonly decidedAt: number | null;
  readonly quietUntil: number | null;
};
export type StoredRow = Omit<Row, "changeJson"> & {
  /** What Do it changes; undefined only on a row this build can't read. */
  readonly change: RecommendChange | undefined;
};

const ChangeJson = Schema.fromJsonString(RecommendChange);
const decodeChange = Schema.decodeUnknownOption(ChangeJson);
export const encodeChange = Schema.encodeEffect(ChangeJson);

const columns = `r.rec_id AS "recId", r.rule, r.subject, r.widget_id AS "widgetId",
  r.change_json AS "changeJson", r.noticed, r.state, r.posted_at AS "postedAt",
  r.ended_at AS "endedAt", r.decided_at AS "decidedAt", r.quiet_until AS "quietUntil"`;

export const storedRows = Effect.fn("KinRecommendLedger.rows")(function* (
  orgId: KinOrgId,
  where: { readonly recId?: string; readonly rule?: string; readonly subject?: string },
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<Row>`SELECT ${sql.literal(columns)} FROM kin_recommendations r
    WHERE r.org_id = ${orgId}
      ${where.recId === undefined ? sql`` : sql`AND r.rec_id = ${where.recId}`}
      ${where.rule === undefined ? sql`` : sql`AND r.rule = ${where.rule}`}
      ${where.subject === undefined ? sql`` : sql`AND r.subject = ${where.subject}`}
    ORDER BY r.posted_at DESC, r.rec_id DESC LIMIT ${limit}`;
  return rows.map(({ changeJson, ...row }): StoredRow => ({
    ...row,
    change: Option.getOrUndefined(decodeChange(changeJson)),
  }));
});

/**
 * When an open row's card stopped taking taps unanswered: its chat cleared, or its time limit
 * (the card is never redrawn, so it ran from posting). Undefined while it still waits.
 */
export const ranOutAt = (row: StoredRow, at: number) => {
  if (row.state !== "open") return undefined;
  const expires = row.postedAt + KIN_CHOICE_CARD_TTL_MS;
  if (row.endedAt !== null) return Math.min(row.endedAt, expires);
  return expires <= at ? expires : undefined;
};

/**
 * Until when this rule and subject stay quiet after `row`, its latest: an open card, for as long
 * as it waits; after Not now or a card that ran out, its stored or default quiet. `null`
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
