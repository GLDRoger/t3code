import {
  type KinAgentId,
  KinChatError,
  KinChatId,
  KinEventId,
  type KinMessage,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import type { RoutePlan } from "../widgets/cardPlans.ts";
import { wakeEvent } from "./ChatWake.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import * as LeadProvision from "./KinLeadProvision.ts";
import { directKey } from "./LeadAccess.ts";
import { stampEvent } from "./OutsideContent.ts";

/*
 * A teammate's own request for an agent another agent owns (`KinHandoff.passOn`): their words go
 * to that agent as theirs, at their access, or the owner is asked once on a card whose two
 * answers are fixed actions (`cardActions.ts`) that run here, as the owner's tap, with no turn.
 */

const hashOf = (key: string) =>
  NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
/** The wake-up a routed request starts: one per teammate message, whoever retries. */
export const forwardEventId = (messageId: string) =>
  KinEventId.make(`forward-${hashOf(`forward:${messageId}`)}`);

const isChatError = Schema.is(KinChatError);
const unavailable = () =>
  new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

/** A teammate's own stored message in their direct chat with a lead, and who they are. */
export type TeammateAsk = {
  readonly message: KinMessage;
  readonly personId: KinPersonId;
  readonly personName: string;
};

const LABEL_MAX = 80;
const NOT_THIS_TIME = "Not this time";
/** The card's button and the line under it, for each answer: written by Kin. */
export const routeShown = (plan: Pick<RoutePlan, "answer" | "personName" | "agentName">) => {
  if (plan.answer === "decline")
    return {
      label: NOT_THIS_TIME,
      line: `Tell ${plan.personName} it wasn't passed on`,
    };
  const label = `Let ${plan.personName} talk to ${plan.agentName}`;
  return {
    label: label.length <= LABEL_MAX ? label : `Let them talk to ${plan.agentName}`.slice(0, 80),
    line: `Let ${plan.personName} message ${plan.agentName}, and pass this request on`,
  };
};

/**
 * A teammate's own words, posted again as theirs in their direct chat with the agent that owns
 * them, marked as passed on (`origin`), which wakes that agent there once at their access. Kin's
 * write, not their send: nothing they are waiting on there takes it as their reply.
 */
export const forward = Effect.fn("KinRouteCard.forward")(function* (input: {
  readonly ask: TeammateAsk;
  readonly from: { readonly agentId: KinAgentId; readonly name: string };
  readonly to: { readonly agentId: KinAgentId; readonly name: string };
  readonly outside: string | undefined;
}) {
  const chat = yield* KinChatService;
  const queue = yield* KinEventQueue;
  const { message, personId } = input.ask;
  const { orgId } = message;
  const asker = { _tag: "person" as const, orgId, personId };
  const direct = yield* chat.createDirect(asker, { orgId, agentId: input.to.agentId });
  const key = `forward:${message.messageId}`;
  yield* chat.notice({
    orgId,
    chatId: direct.chatId,
    audience: "chat",
    messageId: KinMessageId.make(`kin-forward-${hashOf(key)}`),
    body: `Passed on from your chat with ${input.from.name}. ${input.to.name} answers you here.`,
  });
  const copy = yield* chat.send(asker, {
    chatId: direct.chatId,
    clientMessageId: key,
    body: message.body,
    passedOn: {
      agentId: input.from.agentId,
      chatId: message.chatId,
      messageId: message.messageId,
    },
  });
  const woke = wakeEvent(copy, input.to.agentId, undefined);
  if (woke._tag !== "chat.message") return yield* unavailable();
  const eventId = forwardEventId(message.messageId);
  yield* queue
    .enqueue({
      ...woke,
      eventId,
      origin: { agentId: input.from.agentId, chatId: message.chatId, personId },
    })
    .pipe(
      Effect.mapError((error) =>
        isChatError(error)
          ? error
          : new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
      ),
    );
  yield* stampEvent(orgId, eventId, input.outside);
  yield* chat.notice({
    orgId,
    chatId: message.chatId,
    audience: "chat",
    messageId: KinMessageId.make(`kin-forwarded-${hashOf(key)}`),
    body: `Passed on to ${input.to.name}, who answers you in your chat with it.`,
    silent: true,
  });
  return eventId;
});

const NOT_PASSED = "Not passed on";
const gone = {
  title: NOT_PASSED,
  text: "The person, the agents or the message are no longer here, so nothing changed.",
};

/**
 * The owner's tap on a route card, in the tap's transaction. Checked again now: the person, both
 * agents, the message in its chat and the card's own hand-off must still be as drawn; otherwise
 * the card closes having done nothing. The grant the source chat had is not needed: this is the
 * owner's decision.
 */
export const runRoute = Effect.fn("KinRouteCard.run")(function* (
  tap: {
    readonly orgId: KinOrgId;
    readonly widget: { readonly widgetId: string };
    readonly personId: KinPersonId;
  },
  plan: RoutePlan,
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const { orgId } = tap;
  if (!(yield* ownerLevel(orgId, tap.personId)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only an owner can answer this.",
    });
  const settle = (state: "passed" | "declined" | "stale") =>
    sql`UPDATE kin_handoffs SET route_state = ${state}
      WHERE org_id = ${orgId} AND message_id = ${plan.messageId}
        AND route_widget_id = ${tap.widget.widgetId} AND route_state = 'pending'
      RETURNING message_id`;
  const [row] = yield* sql<{ state: string }>`SELECT route_state AS state FROM kin_handoffs
    WHERE org_id = ${orgId} AND message_id = ${plan.messageId}
      AND route_widget_id = ${tap.widget.widgetId} AND to_agent_id = ${plan.agentId}`;
  if (row?.state !== "pending") return gone;
  const message = Option.getOrUndefined(
    yield* repo.getMessage({ orgId, messageId: KinMessageId.make(plan.messageId) }),
  );
  const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${plan.personId} AND removed_at IS NULL`;
  const agents = yield* sql<{ agentId: KinAgentId; name: string }>`SELECT l.agent_id AS "agentId",
      l.name FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${orgId} AND a.role = 'lead' AND a.retired_at IS NULL
      AND l.agent_id IN (${plan.draw.agentId}, ${plan.agentId})
    ORDER BY l.agent_id`;
  const from = agents.find((agent) => agent.agentId === plan.draw.agentId);
  const to = agents.find((agent) => agent.agentId === plan.agentId);
  const [chatRow] = yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${orgId}
    AND chat_id = ${plan.chatId} AND kind = 'direct'
    AND direct_key = ${directKey(KinPersonId.make(plan.personId), plan.draw.agentId as KinAgentId)}`;
  if (
    message === undefined ||
    message.chatId !== plan.chatId ||
    message.author._tag !== "human" ||
    message.author.personId !== plan.personId ||
    message.kind !== "text" ||
    message.status !== "posted" ||
    person === undefined ||
    from === undefined ||
    to === undefined ||
    chatRow === undefined
  ) {
    yield* settle("stale");
    return gone;
  }
  const chat = yield* KinChatService;
  if (plan.answer === "decline") {
    if ((yield* settle("declined")).length === 0) return yield* unavailable();
    yield* chat.notice({
      orgId,
      chatId: KinChatId.make(plan.chatId),
      audience: "chat",
      messageId: KinMessageId.make(`kin-forward-declined-${hashOf(plan.messageId)}`),
      body: "The owner didn't pass this request on this time.",
    });
    return { title: NOT_PASSED, text: `${person.name} was told it wasn't passed on.` };
  }
  const personId = KinPersonId.make(plan.personId);
  yield* LeadProvision.allow({
    editor: { _tag: "person", personId: tap.personId },
    orgId,
    agentId: to.agentId,
    personId,
  }).pipe(
    Effect.mapError((error) =>
      isChatError(error)
        ? error
        : new KinChatError({ reason: "not_allowed", message: error.message }),
    ),
  );
  // The card's answer is settled once (its revision and plan receipt), and the request goes once.
  if ((yield* settle("passed")).length === 0) return yield* unavailable();
  const [stamp] = yield* sql<{ source: string }>`SELECT outside_from AS source
    FROM kin_event_outside WHERE org_id = ${orgId} AND event_id = ${tap.widget.widgetId}`;
  yield* forward({
    ask: { message, personId, personName: person.name },
    from,
    to,
    outside: stamp?.source,
  });
  return {
    title: "Passed on",
    text: `${person.name} may message ${to.name} from now on, and their request went there.`,
  };
});
