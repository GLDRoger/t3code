import {
  KinChatId,
  type KinChoiceOutcome,
  type KinOrgId,
  KinPersonId,
  KinWidgetId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatService } from "../chat/KinChatService.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { noticeHolder } from "../pulse/holderNotice.ts";
import { type LeaverPlan, sealPlans } from "../widgets/cardPlans.ts";
import { handOverLeaver, LEAVER_OWNERS_ONLY, type LeaverHeld, leaverHeld } from "../work/deals.ts";
import { accessSql, ownerLevel } from "./KinAccess.ts";

/*
 * When someone who looked after clients leaves: one card for the owner and each co-owner, in their
 * chat with the Chief of staff, with "Give them to…" one person or "Leave them as they are". The
 * first answer closes every copy. Everything said here is Kin's own words, never an agent's.
 */

/** One option per person who could take them, and Leave: a choice card holds eight. */
const RECEIVERS_SHOWN = 7;
const LABEL_MAX = 80;
const LEAVE = "Leave them as they are";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "4 open deals, 7 prospects, 2 clients and 5 follow-ups": only the kinds there are. */
const heldText = (held: LeaverHeld) => {
  const parts = [
    held.deals > 0 ? plural(held.deals, "open deal", "open deals") : null,
    held.prospects > 0 ? plural(held.prospects, "prospect", "prospects") : null,
    held.clients > 0 ? plural(held.clients, "client", "clients") : null,
    held.followUps > 0 ? plural(held.followUps, "follow-up", "follow-ups") : null,
    held.promises > 0 ? plural(held.promises, "promise", "promises") : null,
  ].filter((part) => part !== null);
  return parts.length < 2
    ? (parts[0] ?? "nothing open")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
};
const heldCount = (held: LeaverHeld) =>
  held.deals + held.prospects + held.clients + held.followUps + held.promises;

const clamp = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The card's button and the line under it, for each answer. */
export const leaverShown = (plan: Pick<LeaverPlan, "personName" | "to">) =>
  plan.to === null
    ? {
        label: LEAVE,
        line: `They stay in ${plan.personName}'s name, and are ${plan.personName}'s again if ${plan.personName} comes back`,
      }
    : {
        label: clamp(`Give them to ${plan.to.name}`, LABEL_MAX),
        line: `${plan.to.name} looks after every one from now on, and is told once`,
      };

/** Where the card goes for `personId`: their direct chat with the lead, opened if needed. */
const chatFor = Effect.fn("KinLeaver.chatFor")(function* (
  lead: NonNullable<Effect.Success<ReturnType<typeof liveLead>>>,
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [open] = yield* sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
    JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
      AND m.principal_kind = 'person' AND m.person_id = ${personId} AND m.left_at IS NULL
    WHERE c.org_id = ${orgId} AND c.kind = 'direct'
      AND c.direct_key = ${LeadAccess.directKey(personId, lead.agentId)}
    ORDER BY c.chat_id LIMIT 1`;
  if (open !== undefined) return KinChatId.make(open.chatId);
  const chat = yield* (yield* KinChatService).createDirect(
    { _tag: "person", orgId, personId },
    { orgId, agentId: lead.agentId },
  );
  return chat.chatId;
});

/**
 * In the removal's transaction: when `gone` looked after anything a hand-over moves, one card for
 * the owner and each co-owner. A card that can't be posted is logged and never fails the removal.
 */
export const leaverCards = Effect.fn("KinLeaver.cards")(function* (input: {
  readonly orgId: KinOrgId;
  readonly gone: { readonly personId: KinPersonId; readonly displayName: string };
  readonly removedAt: number;
}) {
  const { orgId, gone, removedAt } = input;
  const held = yield* leaverHeld(orgId, gone.personId);
  if (heldCount(held) === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
  if (lead === undefined) return;
  const [thread] = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
    FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${lead.agentId}
      AND thread_id IS NOT NULL`;
  if (thread === undefined) return;
  // Whoever could hold them, the one who already looks after the most first.
  const receivers = yield* sql<{ personId: string; name: string }>`SELECT p.person_id AS
      "personId", p.display_name AS name FROM kin_people p
    WHERE p.org_id = ${orgId} AND p.removed_at IS NULL AND p.person_id != ${gone.personId}
      AND (${sql.literal(accessSql("p"))} IN ('owner', 'co_owner') OR p.sees_clients = 1)
    ORDER BY (SELECT COUNT(*) FROM kin_records r WHERE r.org_id = p.org_id
        AND r.owner_kind = 'person' AND r.owner_id = p.person_id AND r.state = 'open'
        AND r.register_id IN ('clients', 'deals')) DESC, p.display_name, p.person_id`;
  const shown = receivers.slice(0, RECEIVERS_SHOWN);
  const plans = [...shown.map((one) => ({ personId: one.personId, name: one.name })), null].map(
    (to) =>
      ({
        kind: "leaver",
        personId: gone.personId,
        personName: gone.displayName,
        removedAt,
        to,
      }) satisfies LeaverPlan,
  );
  const words = plans.map(leaverShown);
  const more = receivers.length - shown.length;
  const detail = [
    `Until someone chooses, they stay in ${gone.displayName}'s name and can still be found.`,
    ...(more > 0
      ? [
          `${plural(more, "more person", "more people")} could take them; to give one to them, change who looks after it on its page.`,
        ]
      : []),
  ].join(" ");
  const asked = yield* sql<{ personId: string }>`SELECT person_id AS "personId" FROM kin_people p
    WHERE p.org_id = ${orgId} AND p.removed_at IS NULL
      AND ${sql.literal(accessSql("p"))} IN ('owner', 'co_owner')
    ORDER BY p.person_id`;
  const chat = yield* KinChatService;
  for (const { personId } of asked)
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const chatId = yield* chatFor(lead, orgId, KinPersonId.make(personId));
          const card = yield* chat.ask(
            {
              _tag: "agent",
              hostPosted: true,
              orgId,
              agentId: lead.agentId,
              ownerPersonId: lead.ownerPersonId,
              threadId: ThreadId.make(thread.threadId),
            },
            {
              chatId,
              clientMessageId: `kin-leaver:${gone.personId}:${removedAt}`,
              question: clamp(
                `${gone.displayName} left the team and looked after ${heldText(held)}. Who takes them?`,
                240,
              ),
              detail,
              options: words.map((one) => ({ label: one.label })),
              actions: words,
              untilAnswered: true,
              forChat: true,
              silent: true,
            },
          );
          yield* sealPlans({
            orgId,
            chatId,
            widgetId: card.widgetId,
            plans: plans.map((plan, index) => ({ optionId: `option-${index + 1}`, plan })),
            now: removedAt,
          });
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin couldn't ask who takes what a leaver looked after", { cause }),
        ),
      );
});

/** Every open card about `personId`'s leaving; `removedAt` limits it to that removal's. */
const openCards = Effect.fn("KinLeaver.openCards")(function* (
  orgId: KinOrgId,
  personId: string,
  removedAt?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ widgetId: string }>`SELECT DISTINCT p.widget_id AS "widgetId"
    FROM kin_card_plans p JOIN kin_widgets w ON w.org_id = p.org_id AND w.widget_id = p.widget_id
    WHERE p.org_id = ${orgId} AND json_extract(p.plan_json, '$.kind') = 'leaver'
      AND json_extract(p.plan_json, '$.personId') = ${personId} AND w.closed_at IS NULL
      ${removedAt === undefined ? sql`` : sql`AND json_extract(p.plan_json, '$.removedAt') = ${removedAt}`}
    ORDER BY p.widget_id`;
  return rows.map((row) => KinWidgetId.make(row.widgetId));
});

type CardChat = Pick<KinChatService["Service"], "closeReplaced">;

/** Back with a new link: an unanswered card about their leaving closes, saying so. */
export const leaverBack = Effect.fn("KinLeaver.back")(function* (
  orgId: KinOrgId,
  gone: { readonly personId: KinPersonId; readonly displayName: string },
  chat: CardChat,
) {
  const name = gone.displayName;
  for (const widgetId of yield* openCards(orgId, gone.personId))
    yield* chat.closeReplaced({
      orgId,
      widgetId,
      outcome: {
        title: "Back on the team",
        text: `${name} came back, so what ${name} looked after is ${name}'s again.`,
      },
    });
});

/**
 * A tap on the card, in the tap's transaction: the owner level only, and only while that removal
 * stands. Give moves it all (`handOverLeaver`) and tells whoever takes it once; Leave changes
 * nothing. Either closes every other copy with what was chosen.
 */
export const runLeaver = Effect.fn("KinLeaver.run")(function* (
  tap: {
    readonly orgId: KinOrgId;
    readonly widget: { readonly widgetId: string };
    readonly personId: KinPersonId;
  },
  plan: LeaverPlan,
  chat: CardChat,
) {
  const { orgId } = tap;
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* ownerLevel(orgId, tap.personId))) return yield* LEAVER_OWNERS_ONLY;
  const gone = plan.personName;
  const [me] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${tap.personId}`;
  const byName = me?.name ?? "Someone";
  const [now] = yield* sql<{ removedAt: number | null }>`SELECT removed_at AS "removedAt"
    FROM kin_people WHERE org_id = ${orgId} AND person_id = ${plan.personId}`;
  const settle = Effect.fn("KinLeaver.settle")(function* (
    mine: KinChoiceOutcome,
    others: KinChoiceOutcome,
  ) {
    for (const widgetId of yield* openCards(orgId, plan.personId, plan.removedAt))
      if (widgetId !== tap.widget.widgetId)
        yield* chat.closeReplaced({ orgId, widgetId, outcome: others });
    return mine;
  });
  if (now?.removedAt !== plan.removedAt) {
    const back = {
      title: "Nothing changed",
      text: `${gone} is back on the team, so what ${gone} looked after stays ${gone}'s.`,
    };
    return yield* settle(back, back);
  }
  if (plan.to === null) {
    const held = yield* leaverHeld(orgId, KinPersonId.make(plan.personId));
    const text =
      heldCount(held) === 0
        ? `Nothing open is left in ${gone}'s name.`
        : `${heldText(held)} stay in ${gone}'s name. If ${gone} comes back with a new link, they are ${gone}'s again.`;
    return yield* settle(
      { title: "Left as they are", text },
      { title: "Left as they are", text: `${byName} left them as they are. ${text}` },
    );
  }
  const to = KinPersonId.make(plan.to.personId);
  const held = yield* handOverLeaver({
    orgId,
    by: tap.personId,
    from: KinPersonId.make(plan.personId),
    to,
  });
  const [named] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${to}`;
  const toName = named?.name ?? plan.to.name;
  if (heldCount(held) === 0) {
    const none = {
      title: "Nothing to give",
      text: `${gone} looks after nothing open now, so nothing moved.`,
    };
    return yield* settle(none, none);
  }
  const what = heldText(held);
  if (to !== tap.personId) {
    const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
    if (lead !== undefined)
      yield* noticeHolder({
        orgId,
        personId: to,
        agentId: lead.agentId,
        body: `${byName} gave you what ${gone} looked after: ${what}. Each one's Activity says so.`,
        key: `leaver-${plan.personId}-${plan.removedAt}`,
      });
  }
  const title = clamp(`Given to ${toName}`, 120);
  const after = "To move one on, change who looks after it on its page.";
  return yield* settle(
    {
      title,
      text:
        to === tap.personId
          ? `You now look after ${what} that ${gone} looked after. ${after}`
          : `${toName} now looks after ${what} that ${gone} looked after, and was told. ${after}`,
    },
    {
      title,
      text: `${byName} gave ${toName} ${what} that ${gone} looked after. ${after}`,
    },
  );
});
