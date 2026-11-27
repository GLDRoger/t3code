import {
  KIN_CHOICE_CARD_TTL_MS,
  KinChatError,
  type KinBillSendersResult,
  type KinChoiceOutcome,
  type KinOrgId,
  type KinPersonId,
  KinWidgetId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatService } from "../../chat/KinChatService.ts";
import { KinRefreshObserver } from "../../chat/KinRefreshHub.ts";
import { normalizeAddress } from "../../connections/MailSignals.ts";
import { onlyOwnerLevel } from "../mailSenderAccess.ts";
import { queueHeld } from "./billSenderArrivals.ts";

const OWNER_ONLY = "Only an owner or co-owner can manage billing senders.";
const changed = () =>
  new KinChatError({
    reason: "conflict",
    message: "This billing address has already changed.",
  });

type Decision = "approved" | "declined" | "removed";
export const decisionLabel = (state: Exclude<Decision, "removed">) =>
  state === "approved" ? "Approve" : "Not a billing sender";
export const decisionOutcome = (
  state: Exclude<Decision, "removed">,
  address: string,
): KinChoiceOutcome =>
  state === "approved"
    ? {
        title: "Billing sender approved",
        text: `Kin can suggest expenses from verified mail from ${address}.`,
      }
    : { title: "Billing sender declined", text: `Kin will not ask about ${address} again.` };

export const list = Effect.fn("KinBillSenders.list")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const activeAfter = DateTime.formatIso(DateTime.makeUnsafe(now - KIN_CHOICE_CARD_TTL_MS));
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* onlyOwnerLevel(orgId, personId, OWNER_ONLY);
        const rows = yield* sql<
          Omit<KinBillSendersResult["rows"][number], "askedInChat"> & {
            readonly askedInChat: 0 | 1;
          }
        >`SELECT b.address, b.name, CASE b.state WHEN 'candidate' THEN 'waiting' ELSE b.state END AS state,
      b.seen_count AS "seenCount", b.first_seen_at AS "firstSeenAt", b.last_seen_at AS "lastSeenAt",
      b.decided_at AS "decidedAt", p.display_name AS "decidedBy",
      (b.state = 'candidate' AND w.widget_id IS NOT NULL AND w.closed_at IS NULL
        AND w.updated_at > ${activeAfter}) AS "askedInChat"
      FROM kin_bill_senders b
      LEFT JOIN kin_people p ON p.org_id = b.org_id AND p.person_id = b.decided_by_person_id
      LEFT JOIN kin_widgets w ON w.org_id = b.org_id AND w.widget_id = b.widget_id
      WHERE b.org_id = ${orgId} AND b.state <> 'removed' ORDER BY b.address`;
        return { rows: rows.map((row) => ({ ...row, askedInChat: row.askedInChat === 1 })) };
      }),
    )
    .pipe(NodeSqliteClient.readOnly);
});

const closeCard = Effect.fn("KinBillSenders.closeCard")(function* (
  orgId: KinOrgId,
  widgetId: string | null,
  state: Exclude<Decision, "removed">,
  address: string,
) {
  if (widgetId === null) return;
  yield* (yield* KinChatService).closeReplaced({
    orgId,
    widgetId: KinWidgetId.make(widgetId),
    outcome: decisionOutcome(state, address),
  });
});

export const decide = Effect.fn("KinBillSenders.decide")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  value: string,
  state: Decision,
  tapped?: KinWidgetId,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* onlyOwnerLevel(orgId, personId, OWNER_ONLY);
      const address = normalizeAddress(value);
      if (address === undefined) return yield* changed();
      const from = state === "removed" ? "approved" : "candidate";
      const [row] = yield* sql<{
        widgetId: string | null;
      }>`UPDATE kin_bill_senders SET state = ${state},
      decided_by_person_id = ${personId}, decided_at = ${now}
      WHERE org_id = ${orgId} AND address = ${address} AND state = ${from}
        ${tapped === undefined ? sql`` : sql`AND widget_id = ${tapped}`}
      RETURNING widget_id AS "widgetId"`;
      if (row === undefined) return yield* changed();
      if (tapped === undefined && state !== "removed")
        yield* closeCard(orgId, row.widgetId, state, address);
      yield* (yield* KinRefreshObserver).touch(orgId, "billSenders");
    }),
  );
});

export const add = Effect.fn("KinBillSenders.add")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  value: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* onlyOwnerLevel(orgId, personId, OWNER_ONLY);
      const address = normalizeAddress(value);
      if (address === undefined)
        return yield* new KinChatError({
          reason: "invalid_state",
          message: "Enter a full email address for the billing sender.",
        });
      const [before] = yield* sql<{ state: string }>`SELECT state FROM kin_bill_senders
        WHERE org_id = ${orgId} AND address = ${address}`;
      const [row] = yield* sql<{ widgetId: string | null }>`INSERT INTO kin_bill_senders
        (org_id, address, state, decided_by_person_id, decided_at, created_at)
      VALUES (${orgId}, ${address}, 'approved', ${personId}, ${now}, ${now})
      ON CONFLICT (org_id, address) DO UPDATE SET state = 'approved',
        decided_by_person_id = excluded.decided_by_person_id, decided_at = excluded.decided_at
      WHERE kin_bill_senders.state <> 'approved'
      RETURNING widget_id AS "widgetId"`;
      if (row === undefined) return;
      yield* closeCard(orgId, row.widgetId, "approved", address);
      if (before?.state === "declined") yield* queueHeld(orgId, address, now);
      yield* (yield* KinRefreshObserver).touch(orgId, "billSenders");
      if (before?.state === "declined")
        return { message: `Kin will read held bills from ${address}.` };
    }),
  );
});
