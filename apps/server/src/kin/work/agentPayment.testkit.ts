import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { answerReceiptCard } from "../gendocs/receiptProposals.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as LeadMoney from "./leadMoney.ts";

/**
 * An agent's payment_record as the owner level then confirms it: the card the call drew, tapped
 * Confirm by `personId`, and the invoice as the call answered before it waited for a tap.
 */
export const agentPaid = (
  scope: McpInvocationScope,
  orgId: KinOrgId,
  personId: string,
  input: Parameters<typeof LeadMoney.payment>[1],
) =>
  Effect.gen(function* () {
    const asked = yield* LeadMoney.payment(scope, input);
    if (!("status" in asked) || asked.status !== "proposed")
      return yield* Effect.die(new Error("expected a card"));
    const sql = yield* SqlClient.SqlClient;
    const [card] = yield* sql<{ widgetId: string | null }>`SELECT widget_id AS "widgetId"
      FROM kin_receipt_proposals WHERE org_id = ${orgId} AND proposal_id = ${asked.proposal}`;
    if (card?.widgetId == null) return yield* Effect.die(new Error("no card was drawn"));
    const tapped = yield* sql.withTransaction(
      answerReceiptCard({
        orgId,
        widgetId: card.widgetId,
        personId,
        confirmed: true,
        via: "tap",
        now: yield* Clock.currentTimeMillis,
      }),
    );
    if (tapped?._tag !== "paid") return yield* Effect.die(new Error("the tap recorded nothing"));
    const summary = yield* LeadMoney.paymentSummary(orgId, input.key);
    return { ...summary, paymentId: tapped.paymentId, tdsPaymentId: tapped.tdsPaymentId };
  });

/** The owner level's Confirm on the card an agent's call to take a payment back drew. */
export const agentTook = (orgId: KinOrgId, personId: string, proposal: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [card] = yield* sql<{ widgetId: string | null }>`SELECT widget_id AS "widgetId"
      FROM kin_receipt_proposals WHERE org_id = ${orgId} AND proposal_id = ${proposal}`;
    if (card?.widgetId == null) return yield* Effect.die(new Error("no card was drawn"));
    const tapped = yield* sql.withTransaction(
      answerReceiptCard({
        orgId,
        widgetId: card.widgetId,
        personId,
        confirmed: true,
        via: "tap",
        now: yield* Clock.currentTimeMillis,
      }),
    );
    if (tapped?._tag !== "takenBack") return yield* Effect.die(new Error("nothing was taken back"));
    return tapped;
  });
