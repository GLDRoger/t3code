import { formatKinWhen, KIN_TEXT_LOCALE, type KinOrgId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatService } from "../../chat/KinChatService.ts";
import { KinRefreshObserver } from "../../chat/KinRefreshHub.ts";
import { chatShared } from "../../chat/sharing.ts";
import { isOrgPaused } from "../../lead/orgState.ts";
import { isOwnerHimself } from "../../people/KinAccess.ts";
import { sectionOnFor } from "../../shell/KinShell.ts";
import { type BillSenderPlan, sealPlans } from "../../widgets/cardPlans.ts";
import { dayIn } from "../money.ts";
import { ownerZone } from "../recordRows.ts";
import { billReader } from "../billReader.ts";
import { orgOwner } from "../toolNames.ts";
import { decisionLabel } from "./billSenders.ts";

const DAILY_CARDS = 3;

export const offer = Effect.fn("KinBillSenders.offerCards")(function* (
  orgId: KinOrgId,
  now: number,
  moneyOn?: boolean,
) {
  if (!(moneyOn ?? (yield* sectionOnFor(orgId, "money")))) return;
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* KinChatService;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const zone = yield* ownerZone(orgId);
      const day = dayIn(now, zone);
      const [posted] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_bill_senders
      WHERE org_id = ${orgId} AND card_day = ${day}`;
      const room = DAILY_CARDS - (posted?.count ?? 0);
      if (room <= 0) return;
      const candidates = yield* sql<{
        address: string;
        seenCount: number;
        lastSeenAt: number;
        knownBiller: number;
      }>`SELECT address, seen_count AS "seenCount", last_seen_at AS "lastSeenAt",
        known_biller AS "knownBiller"
      FROM kin_bill_senders WHERE org_id = ${orgId} AND state = 'candidate' AND widget_id IS NULL
        AND created_at <= ${now}
      ORDER BY created_at, address LIMIT ${room}`;
      if (candidates.length === 0 || (yield* isOrgPaused(orgId))) return;
      const reader = yield* billReader(orgId);
      const ownerId = yield* orgOwner(orgId);
      if (
        reader === undefined ||
        ownerId === null ||
        !isOwnerHimself({ personId: ownerId }, reader.ownerPersonId)
      )
        return;
      const chatId = reader.ownerChatId;
      if (yield* chatShared(sql, { orgId, chatId })) return;
      const [thread] = yield* sql<{ threadId: string }>`SELECT l.thread_id AS "threadId"
      FROM kin_leads l JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id
      WHERE l.org_id = ${orgId} AND l.agent_id = ${reader.agentId} AND l.thread_id IS NOT NULL
        AND c.kind = 'direct' AND c.archived_at IS NULL
        AND c.direct_key = ${`${reader.ownerPersonId}:${reader.agentId}`}`;
      if (thread === undefined) return;
      for (const { address, seenCount, lastSeenAt, knownBiller } of candidates) {
        const date = formatKinWhen(lastSeenAt, "date", { zone, locale: KIN_TEXT_LOCALE });
        const seen =
          seenCount === 1
            ? `Kin saw 1 mail from this address that looks like a bill, on ${date}.`
            : `Kin saw ${seenCount} mails from this address that look like bills, the newest on ${date}.`;
        const question = `Read bills from ${address}?`;
        const plans = (["approved", "declined"] as const).map(
          (state) =>
            ({
              kind: "bill_sender",
              address,
              state,
            }) satisfies BillSenderPlan,
        );
        const widget = yield* chat.ask(
          {
            _tag: "agent",
            hostPosted: true,
            orgId,
            agentId: reader.agentId,
            ownerPersonId: reader.ownerPersonId,
            threadId: ThreadId.make(thread.threadId),
          },
          {
            chatId,
            clientMessageId: `kin-bill-sender:${address}`,
            question: question.length <= 240 ? question : "Read bills from this address?",
            detail: [
              ...(question.length <= 240 ? [] : [address]),
              seen,
              ...(knownBiller === 1 ? ["Kin filed a bill from this sender before."] : []),
              "Approving lets mail from this exact address, when its mail server vouches for it, become suggested expenses.",
              "Approving also reads the mail Kin held from it in the last 30 days.",
              "Nothing counts in Money until you keep it.",
            ].join(" "),
            options: plans.map((plan) => ({ label: decisionLabel(plan.state) })),
            silent: true,
          },
        );
        yield* sealPlans({
          orgId,
          chatId,
          widgetId: widget.widgetId,
          plans: plans.map((plan, i) => ({ optionId: `option-${i + 1}`, plan })),
          now,
        });
        yield* sql`UPDATE kin_bill_senders SET widget_id = ${widget.widgetId}, card_day = ${day}
        WHERE org_id = ${orgId} AND address = ${address}`;
      }
      yield* (yield* KinRefreshObserver).touch(orgId, "billSenders");
    }),
  );
});
