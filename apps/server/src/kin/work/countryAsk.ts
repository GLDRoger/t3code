import {
  KinAgentId,
  KinAnswerCountryCardInput,
  KinChatError,
  KinChatId,
  KinCountryCardState,
  type KinOrgId,
  KinPersonId,
  KinWidgetId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import * as Reach from "../lead/Reach.ts";
import { ownerLevelPeople } from "../people/KinAccess.ts";
import type { SenseContext } from "../pulse/senses/shared.ts";
import { DAY_MS } from "../pulse/thresholds.ts";
import { holdFor } from "../triggers/quietHold.ts";
import {
  countryAskProfile,
  readProfile,
  setProfile,
  unknownCountry,
  writeCountryAsk,
} from "./companyProfile.ts";
import { COUNTRY_CURRENCIES, countryCurrency } from "./countryCurrency.ts";
import { theOwner } from "./ownerWork.ts";
import { iso, workFailure } from "./recordRows.ts";

const notFound = new KinChatError({ reason: "not_found", message: "Kin record not found." });
const decodeState = Schema.decodeUnknownEffect(KinCountryCardState);
const countryNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
const clientMessageId = (round: 1 | 2, personId: string) => `kin-country-ask:${round}:${personId}`;

/** The countries the company's records allow: a GSTIN or PAN is India's; else its currency's. */
const recordsFit = (profile: { readonly taxNumber: boolean; readonly homeCurrency: string }) => {
  if (profile.taxNumber) return ["IN"];
  const fit = Object.keys(COUNTRY_CURRENCIES).filter(
    (code) => COUNTRY_CURRENCIES[code] === profile.homeCurrency,
  );
  return fit.length === 0 ? undefined : fit;
};

const asked = Effect.fn("KinCountryAsk.asked")(function* (
  orgId: KinOrgId,
  profile?: Effect.Success<ReturnType<typeof countryAskProfile>>,
) {
  const { hasRow, pending, country, ask } = profile ?? (yield* countryAskProfile(orgId));
  return (
    hasRow &&
    !pending &&
    country === null &&
    (ask === undefined ||
      (ask.nextAt !== null && !ask.done && (yield* Clock.currentTimeMillis) >= ask.nextAt))
  );
});

/** One round's cards; else the open ones, or with `closed` every card of every round. */
const countryCards = Effect.fn("KinCountryAsk.cards")(function* (
  orgId: KinOrgId,
  round?: 1 | 2,
  closed = false,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ widgetId: KinWidgetId; clientId: string; closedAt: string | null }>`
    SELECT w.widget_id AS "widgetId", m.client_message_id AS "clientId", w.closed_at AS "closedAt"
    FROM kin_widgets w JOIN kin_messages m ON m.org_id = w.org_id AND m.chat_id = w.chat_id
      AND m.message_id = w.message_id
    WHERE w.org_id = ${orgId} AND w.type = 'country'
      AND m.client_message_id GLOB ${round === undefined ? "kin-country-ask:*" : `kin-country-ask:${round}:*`}
      AND (${round === undefined && !closed ? 0 : 1} OR w.closed_at IS NULL)
    ORDER BY w.widget_id`;
});

const closeCards = Effect.fn("KinCountryAsk.closeCards")(function* (
  orgId: KinOrgId,
  cards: Effect.Success<ReturnType<typeof countryCards>>,
  answered: NonNullable<KinCountryCardState["answered"]>,
  repo: KinChatRepository["Service"],
  hub: KinChatHub["Service"],
) {
  const at = iso(yield* Clock.currentTimeMillis);
  const resolution = answered._tag === "set" ? "closed" : "answered";
  for (const { widgetId } of cards) {
    const found = yield* repo.getWidget({ orgId, widgetId });
    if (Option.isNone(found)) return yield* notFound;
    const widget = found.value;
    const state = yield* decodeState(widget.state);
    // A card put off for 30 days would still say Kin asks again once the country is set.
    const putOff = state.answered?._tag === "not_now" && state.answered.round === 1;
    if (widget.closedAt !== null && !putOff) continue;
    const closed = yield* repo.updateWidget({
      ...widget,
      audience: "chat",
      state: { ...state, answered },
      expectedRevision: widget.revision,
      awaiting: [],
      closedAt: widget.closedAt ?? at,
      updatedAt: at,
    });
    for (const item of yield* repo.waitingForWidget(closed)) {
      if (!(yield* repo.resolveWaiting({ ...item, resolution, resolvedAt: at }))) continue;
      const resolved = yield* repo.getWaiting(item);
      if (Option.isSome(resolved))
        yield* hub.publish({ type: "waiting.updated", orgId, item: resolved.value });
    }
    yield* hub.publish({ type: "widget.updated", orgId, widget: closed });
  }
});

export const postCountryAsk = Effect.fn("KinCountryAsk.post")(
  function* (ctx: SenseContext) {
    const chats = yield* Effect.serviceOption(KinChatService);
    if (Option.isNone(chats)) return;
    const { orgId } = ctx;
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const profile = yield* countryAskProfile(orgId);
        const { ask, country } = profile;
        if (country !== null) {
          if (ask === undefined || ask.done) return;
          const repo = yield* Effect.serviceOption(KinChatRepository);
          const hub = yield* Effect.serviceOption(KinChatHub);
          if (Option.isNone(repo) || Option.isNone(hub)) return;
          yield* closeCards(
            orgId,
            yield* countryCards(orgId, undefined, true),
            { _tag: "set", country },
            repo.value,
            hub.value,
          );
          yield* writeCountryAsk(orgId, { round: ask.round, nextAt: null, done: true });
          return;
        }
        if (ctx.chief === undefined) return;
        const starts = yield* asked(orgId, profile);
        if (!starts && (ask === undefined || ask.done || ask.nextAt !== null)) return;
        const round = starts && ask !== undefined ? 2 : (ask?.round ?? 1);
        const cards = yield* countryCards(orgId, round);
        // A held owner can still receive this round while another owner's card waits for an answer.
        if (!starts && !cards.some((card) => card.closedAt === null)) return;
        const posted = new Set(cards.map((card) => card.clientId));
        const people = [...(yield* ownerLevelPeople(orgId))].filter(
          (personId) => !posted.has(clientMessageId(round, personId)),
        );
        if (people.length === 0) return;
        const company =
          profile.company ||
          (yield* sql<{ name: string }>`SELECT name FROM kin_orgs WHERE org_id = ${orgId}`)[0]
            ?.name;
        if (company === undefined) return;
        const fits = recordsFit(profile);
        const state = {
          company,
          round,
          question: `Which country is ${company} in? It sets tax words and date formats.`,
          ...(fits === undefined ? {} : { fits }),
        } satisfies KinCountryCardState;
        let marked = !starts;
        for (const id of people) {
          const personId = KinPersonId.make(id);
          const clientId = clientMessageId(round, personId);
          if ((yield* holdFor({ orgId, personId, chatId: undefined })) !== undefined) continue;
          const via = yield* Reach.carrierFor(orgId, personId, ctx.chief);
          if (via === null) continue;
          const [lead] = yield* sql<{ threadId: string; ownerPersonId: string }>`SELECT
            l.thread_id AS "threadId", a.owner_person_id AS "ownerPersonId"
          FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
            AND a.retired_at IS NULL
          JOIN kin_agent_threads t ON t.org_id = l.org_id AND t.thread_id = l.thread_id
            AND t.agent_id = l.agent_id AND t.ended_at IS NULL
          JOIN kin_people p ON p.org_id = a.org_id AND p.person_id = ${personId}
            AND p.removed_at IS NULL
          WHERE l.org_id = ${orgId} AND l.agent_id = ${via} AND l.thread_id IS NOT NULL`;
          if (lead === undefined) continue;
          const [open] = yield* sql<{
            chatId: string;
          }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
          JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
            AND m.principal_kind = 'person' AND m.person_id = ${personId} AND m.left_at IS NULL
          WHERE c.org_id = ${orgId} AND c.kind = 'direct'
            AND c.direct_key = ${LeadAccess.directKey(personId, via)}
          ORDER BY c.chat_id LIMIT 1`;
          const chatId =
            open === undefined
              ? (yield* chats.value.createDirect(
                  { _tag: "person", orgId, personId },
                  { orgId, agentId: via },
                )).chatId
              : KinChatId.make(open.chatId);
          const card = yield* chats.value.upsertWidget(
            {
              _tag: "agent",
              hostPosted: true,
              orgId,
              agentId: KinAgentId.make(via),
              threadId: ThreadId.make(lead.threadId),
              ownerPersonId: KinPersonId.make(lead.ownerPersonId),
            },
            { chatId, type: "country", state, awaiting: [personId] },
          );
          // A server-only key: chat-send retry ids cannot reserve it or masquerade as a country ask.
          yield* sql`UPDATE kin_messages SET client_message_id = ${clientId}
          WHERE org_id = ${orgId} AND chat_id = ${chatId} AND message_id = ${card.messageId}`;
          if (!marked) {
            yield* writeCountryAsk(orgId, { round, nextAt: null });
            marked = true;
          }
        }
      }),
    );
  },
  Effect.catch((error) =>
    Effect.logWarning("Kin could not post or close its country card", { errorTag: error._tag }),
  ),
);

export const answerCountryCard = Effect.fn("KinCountryAsk.answer")(function* (
  people: ReadonlyArray<PersonIdentity>,
  { orgId, widgetId, answer }: KinAnswerCountryCardInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { personId } = yield* theOwner(people, orgId);
      const found = yield* repo.getWidget({ orgId, widgetId });
      if (Option.isNone(found) || found.value.type !== "country") return yield* notFound;
      const widget = found.value;
      const state = yield* decodeState(widget.state).pipe(Effect.mapError(() => notFound));
      const [person] = yield* sql<{ name: string }>`SELECT p.display_name AS name FROM kin_people p
        JOIN kin_chat_members m ON m.org_id = p.org_id AND m.person_id = p.person_id AND m.left_at IS NULL
        JOIN kin_messages msg ON msg.org_id = m.org_id AND msg.chat_id = m.chat_id
        WHERE p.org_id = ${orgId} AND p.person_id = ${personId} AND p.removed_at IS NULL
          AND m.chat_id = ${widget.chatId} AND msg.message_id = ${widget.messageId}
          AND msg.client_message_id = ${clientMessageId(state.round, personId)}`;
      if (person === undefined) return yield* notFound;
      const profile = yield* readProfile(orgId);
      if (widget.closedAt !== null) {
        if (state.answered?._tag === "not_now" && answer._tag === "not_now") return profile;
        if (
          (state.answered?._tag !== "chose" && state.answered?._tag !== "set") ||
          answer._tag !== "country" ||
          profile.country === null
        )
          return yield* notFound;
      }
      if (answer._tag === "country" && countryCurrency(answer.country) === undefined)
        return yield* unknownCountry(answer.country);
      if (
        profile.country !== null &&
        answer._tag === "country" &&
        profile.country !== answer.country
      ) {
        const by =
          state.answered?._tag === "chose" && state.answered.country === profile.country
            ? state.answered.by
            : "Someone";
        return yield* new KinChatError({
          reason: "invalid_state",
          message: `${by} already chose ${countryNames.of(profile.country) ?? profile.country}. Change it in Settings, Company details.`,
        });
      }
      if (widget.closedAt !== null) return profile;
      const cards = yield* countryCards(orgId, undefined, answer._tag === "country");
      if (answer._tag === "country") {
        const saved =
          profile.country === answer.country
            ? profile
            : yield* setProfile(
                orgId,
                { _tag: "person", personId },
                { country: answer.country, homeCurrency: profile.homeCurrency },
                undefined,
              );
        yield* closeCards(
          orgId,
          cards,
          { _tag: "chose", by: person.name, country: answer.country },
          repo,
          hub,
        );
        return saved;
      }
      if (profile.country !== null) {
        yield* closeCards(orgId, cards, { _tag: "set", country: profile.country }, repo, hub);
        return profile;
      }
      const round = state.round;
      const now = yield* Clock.currentTimeMillis;
      yield* writeCountryAsk(
        orgId,
        round === 1 ? { round, nextAt: now + 30 * DAY_MS } : { round, nextAt: null, done: true },
      );
      yield* closeCards(orgId, cards, { _tag: "not_now", by: person.name, round }, repo, hub);
      return profile;
    }),
  );
}, workFailure);
