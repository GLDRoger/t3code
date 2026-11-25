import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinEvent,
  KinEventId,
  KinMemberId,
  KinMessageId,
  KinPersonId,
  KinWakeupId,
  TrimmedNonEmptyString,
  formatKinWhen,
  type KinWidgetId,
  type KinOrgId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import { textLocale } from "../work/companyProfile.ts";
import { ownerZone, recordName } from "../work/recordRows.ts";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import {
  SHARED_REFUSAL,
  aborted,
  effectiveAudience,
  turnAsker,
  turnChat,
  turnPeople,
} from "./Audience.ts";
import { wakeEvent } from "./ChatWake.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import { resolveLead } from "./LeadMemory.ts";
import { messageBodyLimit } from "./quote.ts";
import { teammatesLimited } from "./KinBudget.ts";
import * as LeadAccess from "./LeadAccess.ts";
import * as Reach from "./Reach.ts";
import { directKey } from "./LeadAccess.ts";
import { outsideStamp, renderSource, stampEvent } from "./OutsideContent.ts";
import { type TeammateAsk, forward, forwardEventId } from "./routeCard.ts";
import { choiceExpired } from "../widgets/choiceCard.ts";
import { isHeld, type KinLevelGate } from "./LevelGate.ts";
import { ownerLevel, ownsAgent } from "../people/KinAccess.ts";
import { personMiss, personNamed } from "../people/personNamed.ts";
import { signedIn } from "../people/signedIn.ts";
import * as KinPulse from "../pulse/KinPulse.ts";
import { leftKind, nextCheckIn } from "../pulse/leftForCheckIn.ts";
import { relayPrefix } from "../reply/promises.ts";
import { heldUntil, holdFor, holdLine, theirTime, urgentNow } from "../triggers/quietHold.ts";
import { unreadableBy } from "../work/teamView.ts";
import { TurnEvent } from "./eventIds.ts";

export const LeadsResult = Schema.Struct({
  leads: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      // Both only when the owner alone set off this wake-up; anywhere else, names only.
      domain: Schema.optional(Schema.String),
      // What the owner said it is for.
      charter: Schema.optional(Schema.String),
      you: Schema.Boolean,
    }),
  ),
});
/** Refused: this turn gave `agent` the task or put them on it, so its wake carries the brief. */
export const alreadyOnIt = (agent: string, titles: ReadonlyArray<string>) =>
  `Nothing was passed on: ${agent} already has ${titles.map((title) => JSON.stringify(title)).join(" and ")}, which you gave them or put them on in this turn, and that already wakes them with it.`;
export const HandOffInput = Schema.Struct({
  to: TrimmedNonEmptyString.check(Schema.isMaxLength(80)).annotate({
    description: "The agent to pass it to, by name or domain, as kin_leads lists them.",
  }),
  request: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)).annotate({
    description:
      "What you are passing on, in the owner's terms, with anything useful you already found. The owner's own message goes along with it.",
  }),
  sourceEventId: TurnEvent,
  wantsAnswer: Schema.Boolean.annotate({
    description:
      "true: you need their answer to finish the owner's request. false: the job is theirs to finish.",
  }),
  fact: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(300)).annotate({
      description:
        "From a check-in: the key of the pulse fact the other agent should act on, as pulse_read gives it.",
    }),
  ),
});
export const HandOffResult = Schema.Union([
  Schema.Struct({
    // The lead it went to, by name, to tell the owner.
    to: Schema.String,
    passed: Schema.Literal(true),
    // A teammate's request: what they were already shown of it.
    note: Schema.optional(Schema.String),
    // After an outside read: what it went with, as this turn may name it.
    source: Schema.optional(Schema.String),
  }),
  // Not passed on: the note says why (today's limit, or a card an earlier build drew).
  Schema.Struct({ passed: Schema.Literal(false), note: Schema.String }),
]);
export const TakePrivateInput = Schema.Struct({
  sourceEventId: TurnEvent,
  agent: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(80)).annotate({
      description:
        "Another agent in this group who should answer it, by name or domain. Leave out to answer it yourself.",
    }),
  ),
});
export const TakePrivateResult = Schema.Struct({
  // Who asked, by name, and the agent answering them in their direct chat.
  person: Schema.String,
  agent: Schema.String,
  continued: Schema.Literal(true),
});

/** Room for a message with the pointers it was asked for; the description still asks for brief. */
const RELAY_MAX = 2_000;
export const RelayInput = Schema.Struct({
  to: TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
    description: "The person, by name as people_read gives it.",
  }),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(RELAY_MAX)).annotate({
    description:
      "The message, written for them, in at most 2,000 characters: a request in the asker's words with the task key, or the answer back.",
  }),
  sourceEventId: TurnEvent,
  urgent: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description:
        "Only when it can't wait for their quiet hours to end: why, in a few words. Logged; it skips quiet hours and rings them.",
    }),
  ),
  checkIn: Schema.optional(Schema.Boolean).annotate({
    description:
      "true: not now but at the owner's next check-in with you, which Kin gives it to tell them once. Only to the owner.",
  }),
});
export const RelayResult = Schema.Struct({
  to: Schema.String,
  sent: Schema.Literal(true),
  note: Schema.String,
  // After an outside read: what it went with, as this turn may name it.
  source: Schema.optional(Schema.String),
});
/** What the agent tells the asker of a line left for the owner's check-in (`leftForCheckIn.ts`). */
export const leftNote = (
  name: string,
  next: { readonly title: string; readonly when: string },
  asker: string,
) =>
  `Left for ${name}'s next check-in with you (${next.title}, ${next.when} on the company's clock), which Kin gives it to tell once; if none tells it by the day after, it is sent as a message. Tell ${asker} ${name} hears it then.`;
/** What `relay` posts with: the gate's message to one person (`KinLevelGate.postTo`). */
type PostTo = KinLevelGate["Service"]["postTo"];

const NOTHING = "Nothing was passed on.";
/** What a hand-off or relay sent after an outside read tells the sending agent. */
const AS_REQUEST = " It went as a request, with its source.";
/** An urgent message's word on what it withdrew (`urgentNow`), so anything unrelated is sent again. */
const replacedLine = (name: string, replaced: number | undefined) =>
  replaced === undefined || replaced === 0
    ? ""
    : ` This replaced your held ${replaced === 1 ? "message" : `${replaced} messages`} to ${name}.`;
const refuse = (message: string) =>
  new KinChatError({ reason: "not_allowed", message: `${message} ${NOTHING}` });
const missing = () => new KinChatError({ reason: "not_found", message: "Kin record not found." });
const unavailable = () =>
  new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const isChatError = Schema.is(KinChatError);
const guarded =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchIf(
        (error): error is Exclude<E, KinChatError> => !isChatError(error),
        (error) =>
          Effect.logError(
            "Kin hand-off failed",
            isSqlError(error) ? toPersistenceSqlError(label)(error) : error,
          ).pipe(Effect.andThen(Effect.fail(unavailable()))),
      ),
    );

const Colleague = Schema.Struct({
  agentId: KinAgentId,
  name: Schema.String,
  domain: Schema.String,
  charter: Schema.String,
  ownerChatId: KinChatId,
  ownerPersonId: KinPersonId,
  memberId: Schema.NullOr(KinMemberId),
});
type Colleague = typeof Colleague.Type;
const decodeColleagues = Schema.decodeUnknownEffect(Schema.Array(Colleague));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(KinEvent));
const decodeEvents = Schema.decodeUnknownEffect(Schema.Array(Schema.fromJsonString(KinEvent)));
/**
 * Whether only the owner could have put this in front of the lead: their own words in its own
 * chat with them, a routine, or a reminder they asked for there. Anything a teammate, another
 * lead, GitHub or a worker could have shaped is not.
 */
const fromOwnerAlone = (event: KinEvent, self: Colleague) => {
  switch (event._tag) {
    case "chat.message":
    case "widget.action":
    case "chat.reaction":
      return (
        event.chatId === self.ownerChatId &&
        (event._tag !== "chat.message" || event.origin === undefined) &&
        event.provenance._tag === "human" &&
        ownsAgent(self, event.provenance.personId)
      );
    case "routine":
      return true;
    case "deferral.due":
      return event.origin === undefined;
    default:
      return false;
  }
};
const fold = (value: string) => value.trim().toLowerCase();
const describe = (leads: ReadonlyArray<{ readonly name: string; readonly domain: string }>) =>
  leads.map((lead) => `${lead.name} (${lead.domain})`).join(", ");
/** The agents a name picks: by name, else by domain. */
const matching = <T extends { readonly name: string; readonly domain: string }>(
  agents: ReadonlyArray<T>,
  to: string,
) => {
  const wanted = fold(to);
  const byName = agents.filter((entry) => fold(entry.name) === wanted);
  return byName.length > 0 ? byName : agents.filter((entry) => fold(entry.domain) === wanted);
};
const ONE_HOP =
  "This was already passed on to you by another agent, so it stops with you. Answer it, or say in one line what you can't do.";

/**
 * A lead passes a request the owner made to another of that owner's leads, and sees which leads
 * there are. The request lands in the other lead's own chat with the owner as Kin's row, saying
 * who passed it on, and wakes that lead. The wake-up carries the chat it was first asked in, as a
 * due deferral does, so it works at no more than that chat allows (`KinLevels.originCap`).
 */
export class KinHandoff extends Context.Service<
  KinHandoff,
  {
    readonly leads: (
      scope: McpInvocationScope,
    ) => Effect.Effect<typeof LeadsResult.Type, KinChatError>;
    readonly handOff: (
      scope: McpInvocationScope,
      input: typeof HandOffInput.Type,
    ) => Effect.Effect<typeof HandOffResult.Type, KinChatError>;
    /**
     * A person's own message in a group goes on in their direct chat with this lead or another in
     * the group: Kin posts their words there as theirs, which wakes that lead with that person's
     * access and nothing of the group's chat. Once per message.
     */
    readonly takePrivate: (
      scope: McpInvocationScope,
      input: typeof TakePrivateInput.Type,
    ) => Effect.Effect<typeof TakePrivateResult.Type, KinChatError>;
    /**
     * A message between a person and the owner side, through this lead. In a teammate's turn,
     * their request goes to the owner, a co-owner or a project's lead as Kin's row quoting them,
     * in that person's chat with the lead, waiting on them. In an owner-level turn, the lead's
     * own words go to a teammate in their chat with it (`postTo`). Once per person per turn.
     */
    readonly relay: (
      scope: McpInvocationScope,
      input: typeof RelayInput.Type,
      postTo: PostTo,
    ) => Effect.Effect<typeof RelayResult.Type, KinChatError>;
    /**
     * A wake-up that answered a hand-off ended: its last reply in that chat goes back to the agent
     * that passed it on, as a quiet callout naming who answered, and wakes that agent to carry on.
     */
    readonly reportBack: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: string;
    }) => Effect.Effect<void>;
    /**
     * A wake-up that finished work for a teammate's relayed request (`workFor`) ended: each one
     * it sent nothing gets one Kin line in their chat with the agent, so none is left unanswered.
     */
    readonly workDone: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: string;
      readonly owed: ReadonlyArray<{ readonly eventId: string; readonly personId: KinPersonId }>;
    }) => Effect.Effect<void>;
  }
>()("t3/kin/lead/Handoff/KinHandoff") {}

/**
 * A held relay's or question's arrival, said by Kin in the asking chat: every reader's client shows the time
 * on their own clock, naming the receiver's when it differs. Silent: they just asked.
 */
export const arrivesNote = Effect.fn("KinHandoff.arrivesNote")(function* (
  chat: Pick<KinChatService["Service"], "notice">,
  ctx: { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly wakeupId: string },
  name: string,
  held: { readonly at: number; readonly zone: string; readonly why: "quiet" | "off" | "away" },
  key: string,
  audience: "owner" | "chat",
) {
  const here = yield* turnChat(ctx);
  if (here === undefined) return;
  const text = theirTime(held.at, held.zone, yield* textLocale(ctx.orgId));
  const why =
    held.why === "away"
      ? `${name} is away`
      : held.why === "off"
        ? `Outside ${name}'s working hours`
        : `In ${name}'s quiet hours`;
  yield* chat
    .notice({
      orgId: ctx.orgId,
      chatId: KinChatId.make(here.chatId),
      messageId: KinMessageId.make(`kin-arrives:${key}`),
      audience,
      body: `${why}: it arrives at ${text}.`,
      silent: true,
      when: {
        at: DateTime.formatIso(DateTime.makeUnsafe(held.at)),
        zone: held.zone,
        text,
        of: name,
      },
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin couldn't say when a relay arrives", cause),
      ),
    );
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const chat = yield* KinChatService;
  const repo = yield* KinChatRepository;
  const queue = yield* KinEventQueue;
  const dailyTurns = yield* LeadAccess.dailyTurns;
  const lead = (scope: McpInvocationScope) =>
    resolveLead(scope).pipe(
      Effect.provideService(KinIdentity, identity),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  type Lead = Effect.Success<ReturnType<typeof lead>>;

  /**
   * The live leads of the caller's owner, the caller included, oldest first, each with a direct
   * chat that binds exactly that owner and that lead. Another person's leads and another org's
   * are never listed, so they can't be reached either.
   */
  const colleagues = Effect.fn("KinHandoff.colleagues")(function* (ctx: Lead) {
    const rows = yield* sql`
      SELECT l.agent_id AS "agentId", l.name, l.domain, l.charter,
        l.owner_chat_id AS "ownerChatId", a.owner_person_id AS "ownerPersonId",
        (SELECT m.member_id FROM kin_chat_members m WHERE m.org_id = l.org_id
          AND m.chat_id = l.owner_chat_id AND m.principal_kind = 'agent'
          AND m.agent_id = l.agent_id AND m.left_at IS NULL
          ORDER BY m.joined_at, m.member_id LIMIT 1) AS "memberId"
      FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      JOIN kin_agents me ON me.org_id = l.org_id AND me.agent_id = ${ctx.agentId}
        AND me.role = 'lead' AND me.retired_at IS NULL
      JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id
        AND c.kind = 'direct' AND c.direct_key = a.owner_person_id || ':' || l.agent_id
      WHERE l.org_id = ${ctx.orgId} AND a.role = 'lead' AND a.retired_at IS NULL
        AND a.owner_person_id = me.owner_person_id
      ORDER BY a.created_at, l.agent_id`;
    return yield* decodeColleagues(rows);
  });

  /** The events that woke this lead now, as stored. */
  const wakeEvents = Effect.fn("KinHandoff.wakeEvents")(function* (ctx: Lead) {
    const rows = yield* sql<{ json: string }>`SELECT json FROM kin_events
      WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId}
      ORDER BY event_id`;
    return yield* decodeEvents(rows.map((row) => row.json));
  });

  /** A person's own text in a live group, from this wake-up's stored events and messages. */
  const groupAsk = Effect.fn("KinHandoff.groupAsk")(function* (ctx: Lead, sourceEventId: string) {
    const [stored] = yield* sql<{ json: string }>`SELECT json FROM kin_events
      WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId}
        AND event_id = ${sourceEventId} ORDER BY event_id`;
    if (stored === undefined) return yield* missing();
    const event = yield* decodeEvent(stored.json);
    if (event._tag !== "chat.message" || event.origin !== undefined) return undefined;
    const message = yield* repo
      .getMessage({ orgId: ctx.orgId, messageId: event.messageId })
      .pipe(Effect.map(Option.getOrUndefined));
    if (
      message === undefined ||
      message.chatId !== event.chatId ||
      message.author._tag !== "human" ||
      message.kind !== "text" ||
      message.status !== "posted"
    )
      return undefined;
    const [room] = yield* sql<{ title: string | null }>`SELECT title FROM kin_chats
      WHERE org_id = ${ctx.orgId} AND chat_id = ${event.chatId} AND kind <> 'direct'
        AND archived_at IS NULL ORDER BY chat_id`;
    if (room === undefined) return undefined;
    const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
      WHERE org_id = ${ctx.orgId} AND person_id = ${message.author.personId} ORDER BY person_id`;
    return {
      message,
      personId: message.author.personId,
      personName: person?.name ?? "them",
      room: room.title ?? "the group",
    };
  });

  /**
   * A teammate's own text in their direct chat with this lead, from this wake-up's stored event
   * and message. Undefined when the event was asked anywhere else.
   */
  const directAsk = Effect.fn("KinHandoff.directAsk")(function* (ctx: Lead, sourceEventId: string) {
    const access = Effect.provideService(SqlClient.SqlClient, sql);
    const [stored] = yield* sql<{ json: string }>`SELECT json FROM kin_events
      WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId}
        AND event_id = ${sourceEventId} ORDER BY event_id`;
    if (stored === undefined) return yield* missing();
    const event = yield* decodeEvent(stored.json);
    if (event._tag !== "chat.message") return undefined;
    const message = yield* repo
      .getMessage({ orgId: ctx.orgId, messageId: event.messageId })
      .pipe(Effect.map(Option.getOrUndefined));
    if (message === undefined || message.chatId !== event.chatId || message.author._tag !== "human")
      return undefined;
    const personId = message.author.personId;
    const [direct] = yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${ctx.orgId}
      AND chat_id = ${event.chatId} AND kind = 'direct' AND archived_at IS NULL
      AND direct_key = ${directKey(personId, ctx.agentId)}`;
    if (direct === undefined || (yield* ownerLevel(ctx.orgId, personId).pipe(access)))
      return undefined;
    // A copy Kin posted: passed on to this lead (`origin`) or taken private from a group.
    const [copied] =
      message.clientMessageId === undefined
        ? []
        : yield* sql`SELECT 1 FROM kin_handoffs WHERE org_id = ${ctx.orgId}
            AND message_id = ${message.clientMessageId} AND to_agent_id = ${ctx.agentId}`;
    if (event.origin !== undefined || copied !== undefined) return yield* refuse(ONE_HOP);
    if (
      message.kind !== "text" ||
      message.status !== "posted" ||
      event.provenance._tag !== "human" ||
      event.provenance.personId !== personId
    )
      return yield* refuse("Only a person's own message can be passed on.");
    const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
      WHERE org_id = ${ctx.orgId} AND person_id = ${personId} AND removed_at IS NULL
      ORDER BY person_id`;
    if (person === undefined || (yield* turnAsker(ctx).pipe(access)) !== personId)
      return yield* refuse("Only one person's own request can be passed on from here.");
    return { message, personId, personName: person.name } satisfies TeammateAsk;
  });

  /**
   * A teammate's own request goes to the agent that owns it, among the owner's leads they may
   * message (`Reach`); one they may not is refused. Their stored words only, once per message.
   * Cards an earlier build drew to let them talk keep answering retries until they close.
   */
  /**
   * Open tasks this turn gave `target` or put them on that they still hold or are on: the
   * wake-up that brings each already carries its brief.
   */
  const putOnThisTurn = Effect.fn("KinHandoff.putOnThisTurn")(function* (
    ctx: Lead,
    target: { readonly agentId: KinAgentId; readonly name: string },
  ) {
    const rows = yield* sql<{ title: string }>`SELECT DISTINCT r.title, r.key
      FROM kin_events e JOIN kin_record_changes c ON c.org_id = e.org_id
        AND c.record_id = json_extract(e.json, '$.recordId') AND c.seq = json_extract(e.json, '$.seq')
        JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
      WHERE e.org_id = ${ctx.orgId} AND e.agent_id = ${target.agentId} AND e.tag = 'record.changed'
        AND json_extract(e.json, '$.reason') IN ('assigned', 'joined') AND c.actor_kind = 'agent'
        AND c.actor_id = ${ctx.agentId} AND c.wakeup_id = ${ctx.wakeupId}
        AND r.register_id = 'work' AND r.state IN ('open', 'doing', 'waiting')
        AND ((r.owner_kind = 'agent' AND r.owner_id = ${target.agentId})
          OR EXISTS (SELECT 1 FROM json_each(r.fields_json, '$.alsoOn') o
            WHERE o.value = ${`agent:${target.agentId}`}))
      ORDER BY r.key`;
    return rows.length === 0
      ? undefined
      : {
          passed: false as const,
          note: alreadyOnIt(
            target.name,
            rows.map((row) => row.title),
          ),
        };
  });

  const passOn = Effect.fn("KinHandoff.passOn")(function* (
    ctx: Lead,
    ask: TeammateAsk,
    input: typeof HandOffInput.Type,
  ) {
    const access = Effect.provideService(SqlClient.SqlClient, sql);
    const all = yield* colleagues(ctx);
    const self = all.find((entry) => entry.agentId === ctx.agentId);
    if (self === undefined) return yield* missing();
    const others = all.filter((entry) => entry.agentId !== ctx.agentId);
    const reachable: Array<Colleague> = [];
    const restricted: Array<Colleague> = [];
    for (const entry of others)
      ((yield* Reach.reaches(
        ctx.orgId,
        Reach.person(ask.personId),
        Reach.agent(entry.agentId),
      ).pipe(access))
        ? reachable
        : restricted
      ).push(entry);
    // Names are looked up among the reachable first, so a miss never lists the others.
    const reached = matching(reachable, input.to);
    const unreached = reached.length === 0 ? matching(restricted, input.to) : [];
    const target = reached.length === 1 ? reached[0] : undefined;
    const asked = unreached.length === 1 ? unreached[0] : undefined;
    const dest = target ?? asked;
    if (dest === undefined)
      return yield* new KinChatError({
        reason: reached.length > 1 ? "invalid_state" : "not_found",
        message: `${reached.length > 1 ? "Several agents answer to that" : "No agent answers to that"}. ${reachable.length === 0 ? `${ask.personName} may message no other agent.` : `The ones they may message: ${reachable.map((entry) => entry.name).join(", ")}.`} ${NOTHING}`,
      });
    const onIt = target === undefined ? undefined : yield* putOnThisTurn(ctx, target);
    if (onIt !== undefined) return onIt;
    const { messageId } = ask.message;
    const now = yield* Clock.currentTimeMillis;
    const person = ask.personName;
    const agent = dest.name;
    const [ownerRow] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
      WHERE org_id = ${ctx.orgId} AND person_id = ${self.ownerPersonId} ORDER BY person_id`;
    const owner = ownerRow?.name ?? "the owner";
    // Read now, at this call: what they may do is told as it stands, not as it was asked.
    const mayNow = target !== undefined;
    const directly = `${person} may message ${agent} now, so they can ask it directly.`;
    const cannot = `${person} and ${agent} can't message each other here now.`;
    const confirm = `Anything that would leave the company, such as a mail or a payment, still needs ${owner}'s own Confirm.`;
    const alreadyShown = `Kin has posted a line in this chat telling ${person} it went to ${agent}, who answers them in their chat with it, so don't say that again. If you have nothing to add, write exactly NO_REPLY.${mayNow ? "" : ` ${person} may not message ${agent} now.`}`;
    const asksOnCard = `The card asks ${owner} to let this request reach ${agent} and to let ${person} message ${agent} from then on. ${confirm} When a yes or a not this time takes effect, Kin posts it in this chat.`;
    const waits = {
      passed: false as const,
      note: mayNow
        ? `${owner} was asked on a card whether to let ${person} message ${agent} and hasn't answered yet, so this request has not gone to ${agent}. ${directly}`
        : `${person} may not message ${agent}, so ${owner} has been asked on a card whether to let them and hasn't answered yet; nothing has gone to ${agent}. ${asksOnCard} Tell ${person} it is with ${owner}, and promise nothing more.`,
    };
    const alreadyAsked = {
      passed: false as const,
      note: mayNow
        ? `${owner} was asked on a card about an earlier request of ${person}'s for ${agent} and hasn't answered yet; this message was not passed on. ${directly}`
        : `${owner} has already been asked on a card about an earlier request of ${person}'s for ${agent} and hasn't answered yet, so this message was not passed on. That card asks ${owner} to let that earlier request reach ${agent} and to let ${person} message ${agent} from then on. ${confirm} Tell ${person} so, and promise nothing more.`,
    };
    /** Who answered the card, by name, and when, on the owner's clock; nothing when not stored. */
    const decision = Effect.fnUntraced(function* (widgetId: KinWidgetId) {
      const [tap] = yield* sql<{ name: string | null; at: string }>`SELECT
          p.display_name AS name, m.created_at AS at
        FROM kin_card_plans c
        JOIN kin_messages m ON m.org_id = c.org_id AND m.message_id = c.ran_message_id
        LEFT JOIN kin_people p ON p.org_id = m.org_id AND p.person_id = m.author_person_id
        WHERE c.org_id = ${ctx.orgId} AND c.widget_id = ${widgetId} AND c.ran_message_id IS NOT NULL
        ORDER BY m.seq LIMIT 1`;
      if (tap?.name == null) return undefined;
      const clock = {
        zone: yield* ownerZone(ctx.orgId).pipe(access),
        locale: yield* textLocale(ctx.orgId).pipe(access),
      };
      return {
        by: tap.name,
        on: formatKinWhen(Date.parse(tap.at), "dayTime", clock).replace(/,/g, ""),
      };
    });
    /**
     * Where this message already went: there again is what came of it as it stands now, from
     * the card it was asked on or waited on, elsewhere refused.
     */
    const recorded = Effect.fnUntraced(function* () {
      const [record] = yield* sql<{
        toAgentId: KinAgentId;
        state: string | null;
        widgetId: KinWidgetId | null;
      }>`SELECT to_agent_id AS "toAgentId", route_state AS state, route_widget_id AS "widgetId"
        FROM kin_handoffs WHERE org_id = ${ctx.orgId} AND message_id = ${messageId}
        ORDER BY message_id`;
      if (record === undefined) return undefined;
      if (record.toAgentId !== dest.agentId)
        return yield* refuse(
          "This request is already recorded for another agent, and a request goes to one agent only.",
        );
      const letThem = (tap: { by: string; on: string } | undefined) =>
        tap === undefined
          ? `On the card, the answer was to let ${person} message ${agent}`
          : `${tap.by} let ${person} message ${agent} on ${tap.on}`;
      if (record.state === "passed") {
        if (record.widgetId === null)
          return { to: agent, passed: true as const, note: alreadyShown };
        return {
          to: agent,
          passed: true as const,
          note: `${letThem(yield* decision(record.widgetId))}, and this request was put in ${person}'s chat with ${agent} for ${agent} to answer. ${alreadyShown}`,
        };
      }
      // The card's own request: this message, or the earlier one this message waited on.
      const [card] =
        record.widgetId === null || (record.state !== "pending" && record.state !== "waited")
          ? []
          : yield* sql<{ state: string; chatId: string | null; fromAgentId: KinAgentId }>`SELECT
                h.route_state AS state, m.chat_id AS "chatId", h.from_agent_id AS "fromAgentId"
              FROM kin_handoffs h LEFT JOIN kin_messages m ON m.org_id = h.org_id
                AND m.message_id = h.message_id
              WHERE h.org_id = ${ctx.orgId} AND h.route_widget_id = ${record.widgetId}
                AND h.route_state <> 'waited'
              ORDER BY h.message_id LIMIT 1`;
      const state = card?.state ?? record.state;
      const waited = record.state === "waited";
      const earlier = waited ? "an earlier request" : "this request";
      const again = mayNow ? directly : cannot;
      const notPassed = waited
        ? "so it was not passed on, and neither was this message, which waited on it"
        : "so nothing was passed on";
      if (state === "pending" && record.widgetId !== null) {
        const widget = yield* repo.getWidget({ orgId: ctx.orgId, widgetId: record.widgetId });
        if (Option.isSome(widget) && widget.value.closedAt === null) {
          if (!choiceExpired(widget.value, now)) return waited ? alreadyAsked : waits;
          return {
            passed: false as const,
            note: `The card asking ${owner} about ${earlier} of ${person}'s for ${agent} expired unanswered, ${notPassed}. Tell ${person} so; ${again}`,
          };
        }
        // Kin doesn't keep who cleared a chat; a closed card that ran nothing was never answered.
        const ended = Option.isNone(widget)
          ? "was cleared from the chat before anyone answered it"
          : "was closed before anyone answered it";
        return {
          passed: false as const,
          note: `The card asking ${owner} about ${earlier} of ${person}'s for ${agent} ${ended}, ${notPassed}. Tell ${person} so; ${again}`,
        };
      }
      if (state === "declined" && record.widgetId !== null) {
        const tap = yield* decision(record.widgetId);
        const said =
          tap === undefined
            ? `The card about ${earlier} of ${person}'s for ${agent} was answered not this time`
            : `${tap.by} said not this time on ${tap.on} to ${earlier} of ${person}'s for ${agent}`;
        // The decline is posted where the card's own request was asked.
        const from = all.find((entry) => entry.agentId === card?.fromAgentId)?.name;
        const where =
          !waited || card?.chatId === ask.message.chatId
            ? "in this chat"
            : from === undefined
              ? "in the chat that request was asked in"
              : `in ${person}'s chat with ${from}`;
        return {
          passed: false as const,
          note: `${said}, ${notPassed}. Kin posted that answer ${where}. Tell ${person} it was declined; ${mayNow ? directly : cannot}`,
        };
      }
      if (state === "passed" && record.widgetId !== null) {
        return {
          passed: false as const,
          note: `${letThem(yield* decision(record.widgetId))}, and their earlier request went there; this message was not passed on. ${mayNow ? `Tell ${person} they can message ${agent} directly now.` : `${person} may not message ${agent} now, so tell them this message wasn't passed on.`}`,
        };
      }
      // Kin's copy is in the other chat; only the turn's cancelling is known, not what was read.
      const [copied] =
        record.state === "stale"
          ? yield* sql`SELECT 1 FROM kin_messages WHERE org_id = ${ctx.orgId}
              AND origin_json IS NOT NULL AND json_extract(origin_json, '$.messageId') = ${messageId}
              AND status = 'posted' ORDER BY seq LIMIT 1`
          : [];
      if (copied !== undefined)
        return {
          passed: false as const,
          note: `This request is in ${person}'s chat with ${agent}, but the turn that would have answered it was cancelled. ${mayNow ? `${person} can ask ${agent} about it there.` : `${person} may not message ${agent} now.`} Tell ${person} so, and promise nothing more.`,
        };
      if (waited)
        return {
          passed: false as const,
          note: `${card === undefined ? `What came of the earlier request of ${person}'s for ${agent} is no longer recorded` : `An earlier request of ${person}'s for ${agent} was cancelled without an answer from ${agent}`}, and this message, which waited on it, was not passed on. Tell ${person} so; ${again}`,
        };
      return {
        passed: false as const,
        note: `This request to ${agent} was cancelled without an answer from ${agent}. Tell ${person} so; ${again}`,
      };
    });
    const before = yield* recorded();
    if (before !== undefined) return before;
    if (target === undefined)
      return yield* new KinChatError({
        reason: "not_allowed",
        message: Reach.restrictedLine(person, agent, person),
      });
    // Their turns count as ChatWake counts them: one past today's would not be admitted.
    const used = yield* LeadAccess.recentTurns({
      orgId: ctx.orgId,
      personId: ask.personId,
      now,
    }).pipe(access);
    if (used.turns >= dailyTurns && (yield* teammatesLimited(ctx.orgId).pipe(access)))
      return {
        passed: false as const,
        note: `${ask.personName} has reached today's limit, so nothing was passed on. Tell them they can ask again later.`,
      };
    const claimed = yield* sql`INSERT INTO kin_handoffs
        (org_id, message_id, from_agent_id, to_agent_id, event_id, created_at, route_state)
      VALUES (${ctx.orgId}, ${messageId}, ${ctx.agentId}, ${target.agentId},
        ${forwardEventId(messageId)}, ${now}, 'passed')
      ON CONFLICT (org_id, message_id) DO NOTHING RETURNING message_id`;
    if (claimed.length === 0) return (yield* recorded()) ?? (yield* unavailable());
    const outside = yield* outsideStamp(ctx).pipe(access);
    yield* forward({ ask, from: self, to: target, outside }).pipe(
      Effect.provideService(KinChatService, chat),
      Effect.provideService(KinEventQueue, queue),
      Effect.provideService(KinChatRepository, repo),
      access,
    );
    return { to: target.name, passed: true as const, note: alreadyShown };
  });

  /**
   * The teammate's message a routed request started from, when this event is that message or
   * its passed-on copy: the owner side is asked about it once, by whichever agent asks first.
   * A copy (`origin`) whose original or hand-off is gone is "cleared": nothing is left to quote.
   */
  const routedFrom = Effect.fn("KinHandoff.routedFrom")(function* (
    ctx: Lead,
    sourceEventId: string,
  ) {
    const [source] = yield* sql<{ asked: string | null; copied: number }>`SELECT
        COALESCE(json_extract(c.origin_json, '$.messageId'), json_extract(e.json, '$.messageId'))
          AS asked,
        (c.origin_json IS NOT NULL OR json_extract(e.json, '$.origin.personId') IS NOT NULL)
          AS copied
      FROM kin_events e LEFT JOIN kin_messages c ON c.org_id = e.org_id
        AND c.message_id = json_extract(e.json, '$.messageId')
      WHERE e.org_id = ${ctx.orgId} AND e.agent_id = ${ctx.agentId}
        AND e.wakeup_id = ${ctx.wakeupId} AND e.event_id = ${sourceEventId}
        AND e.tag = 'chat.message'
      ORDER BY e.event_id LIMIT 1`;
    if (source === undefined) return undefined;
    const [row] =
      source.asked === null
        ? []
        : yield* sql<{ messageId: string; body: string | null }>`SELECT
              h.message_id AS "messageId", o.body
            FROM kin_handoffs h LEFT JOIN kin_messages o ON o.org_id = h.org_id
              AND o.message_id = h.message_id AND o.status = 'posted'
            WHERE h.org_id = ${ctx.orgId} AND h.message_id = ${source.asked}
              AND h.route_state = 'passed'
            ORDER BY h.message_id`;
    if (row?.body != null) return { messageId: row.messageId, body: row.body };
    return source.copied === 1 ? ("cleared" as const) : undefined;
  });

  /** The live leads in a chat now, who joined first first. */
  const roomAgents = Effect.fn("KinHandoff.roomAgents")(function* (ctx: Lead, chatId: string) {
    return yield* sql<{ agentId: KinAgentId; name: string; domain: string }>`
      SELECT l.agent_id AS "agentId", l.name, l.domain FROM kin_chat_members m
      JOIN kin_leads l ON l.org_id = m.org_id AND l.agent_id = m.agent_id
      JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
        AND a.role = 'lead' AND a.retired_at IS NULL
      WHERE m.org_id = ${ctx.orgId} AND m.chat_id = ${chatId} AND m.principal_kind = 'agent'
        AND m.left_at IS NULL
      ORDER BY m.joined_at, l.agent_id`;
  });

  /** One of these by name, else by domain; the refusal names the ones there are. */
  const pick = <T extends { readonly name: string; readonly domain: string }>(
    agents: ReadonlyArray<T>,
    to: string,
  ) => {
    const wanted = fold(to);
    const byName = agents.filter((entry) => fold(entry.name) === wanted);
    const matches =
      byName.length > 0 ? byName : agents.filter((entry) => fold(entry.domain) === wanted);
    if (matches.length === 1) return Effect.succeed(matches[0]!);
    return Effect.fail(
      new KinChatError({
        reason: matches.length === 0 ? "not_found" : "invalid_state",
        message: `${matches.length === 0 ? "No agent here answers to that name or domain" : "Several agents answer to that"}. The agents are: ${describe(agents)}. ${NOTHING} Call again with one of those names.`,
      }),
    );
  };

  /**
   * In a group: the agent there whose domain owns a person's message answers it there, as if they
   * had named it. One agent per message, and it can't be passed on again.
   */
  const passInRoom = Effect.fn("KinHandoff.passInRoom")(function* (
    ctx: Lead,
    input: typeof HandOffInput.Type,
  ) {
    const ask = yield* groupAsk(ctx, input.sourceEventId);
    if (ask === undefined)
      return yield* refuse(
        "In a chat with other people, only a person's own message in a group can be passed on, to an agent in that group. Answer what everyone here may see.",
      );
    const others = (yield* roomAgents(ctx, ask.message.chatId)).filter(
      (entry) => entry.agentId !== ctx.agentId,
    );
    if (others.length === 0)
      return yield* refuse(
        "No other agent is in this group. Answer it yourself, or take it private with kin_take_private.",
      );
    const target = yield* pick(others, input.to);
    // Being in one group doesn't carry a request across a restricted pair.
    if (
      !(yield* Reach.reaches(
        ctx.orgId,
        Reach.person(ask.personId),
        Reach.agent(target.agentId),
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
    )
      return yield* new KinChatError({
        reason: "not_allowed",
        message: Reach.restrictedLine(ask.personName, target.name, ask.personName),
      });
    const { messageId } = ask.message;
    const claimed = yield* sql<{ toAgentId: KinAgentId }>`INSERT INTO kin_handoffs
        (org_id, message_id, from_agent_id, to_agent_id, event_id, created_at, wants_answer)
      VALUES (${ctx.orgId}, ${messageId}, ${ctx.agentId}, ${target.agentId},
        ${wakeEvent(ask.message, target.agentId, undefined).eventId}, ${yield* Clock.currentTimeMillis},
        ${input.wantsAnswer ? 1 : 0})
      ON CONFLICT (org_id, message_id) DO NOTHING RETURNING to_agent_id AS "toAgentId"`;
    if (claimed.length === 0) {
      const [record] = yield* sql<{ toAgentId: KinAgentId }>`SELECT to_agent_id AS "toAgentId"
        FROM kin_handoffs WHERE org_id = ${ctx.orgId} AND message_id = ${messageId}
        ORDER BY message_id`;
      if (record?.toAgentId === target.agentId) return { to: target.name, passed: true as const };
      return yield* refuse(
        "This was already passed on, and a request goes to one agent only. Answer what you can, or say in one line who has it.",
      );
    }
    // The same event a mention makes: an agent named in the message already has it, so it answers once.
    // After an outside read it is this agent's pass, not the person's ask, and carries the read.
    const event = wakeEvent(ask.message, target.agentId, undefined);
    const read = yield* outsideStamp(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    yield* (
      read === undefined
        ? queue.enqueue(event)
        : queue
            .enqueue(
              event._tag === "chat.message"
                ? { ...event, origin: { agentId: ctx.agentId, chatId: ask.message.chatId } }
                : event,
            )
            .pipe(
              Effect.tap(() =>
                stampEvent(ctx.orgId, event.eventId, read).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                ),
              ),
              sql.withTransaction,
            )
    ).pipe(Effect.catchTags({ KinEventQueueConflict: () => Effect.void }));
    return { to: target.name, passed: true as const };
  });

  const takePrivate = Effect.fn("KinHandoff.takePrivate")(function* (
    scope: McpInvocationScope,
    input: typeof TakePrivateInput.Type,
  ) {
    const ctx = yield* lead(scope);
    const ask = yield* groupAsk(ctx, input.sourceEventId);
    if (ask === undefined)
      return yield* refuse(
        "Only a person's own message in a group can be taken private. Answer it here with what everyone here may see.",
      );
    const agents = yield* roomAgents(ctx, ask.message.chatId);
    const target =
      input.agent === undefined
        ? agents.find((entry) => entry.agentId === ctx.agentId)
        : yield* pick(agents, input.agent);
    if (target === undefined) return yield* missing();
    const key = `private:${ask.message.messageId}`;
    const claimed = yield* sql`INSERT INTO kin_handoffs
        (org_id, message_id, from_agent_id, to_agent_id, event_id, created_at)
      VALUES (${ctx.orgId}, ${key}, ${ctx.agentId}, ${target.agentId}, ${key},
        ${yield* Clock.currentTimeMillis})
      ON CONFLICT (org_id, message_id) DO NOTHING RETURNING to_agent_id`;
    if (claimed.length === 0) {
      const [record] = yield* sql<{ toAgentId: KinAgentId }>`SELECT to_agent_id AS "toAgentId"
        FROM kin_handoffs WHERE org_id = ${ctx.orgId} AND message_id = ${key} ORDER BY message_id`;
      if (record?.toAgentId !== target.agentId)
        return yield* refuse(
          "This was already taken private with another agent. Say in one line that it is answered directly.",
        );
    }
    const asker = { _tag: "person" as const, orgId: ctx.orgId, personId: ask.personId };
    const direct = yield* chat.createDirect(asker, { orgId: ctx.orgId, agentId: target.agentId });
    // The person's own words, posted as theirs in their own chat: that wakes the lead there at
    // their access, from stored rows, and carries nothing of the group's chat or this turn. Kin's
    // copy (its claim's key is its client id), so nothing waiting there takes it as their reply.
    yield* chat.notice({
      orgId: ctx.orgId,
      chatId: direct.chatId,
      audience: "chat",
      messageId: KinMessageId.make(
        `kin-private-${NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
      ),
      body: `From ${ask.room}. ${target.name} answers you here.`,
    });
    yield* chat.send(asker, {
      chatId: direct.chatId,
      clientMessageId: key,
      body: ask.message.body,
      replies: false,
    });
    return { person: ask.personName, agent: target.name, continued: true as const };
  }, guarded("KinHandoff.takePrivate"));

  const personNamedIn = Effect.fn("KinHandoff.personNamed")(function* (ctx: Lead, name: string) {
    const found = yield* personNamed(ctx.orgId, name).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (found._tag !== "found")
      return yield* new KinChatError({
        reason: found._tag === "none" ? "not_found" : "invalid_state",
        message: `${personMiss(name, found)} Nothing was sent.`,
      });
    return { personId: found.item.id, name: found.item.name };
  });

  const relay = Effect.fn("KinHandoff.relay")(function* (
    scope: McpInvocationScope,
    input: typeof RelayInput.Type,
    postTo: PostTo,
  ) {
    const ctx = yield* lead(scope);
    const access = Effect.provideService(SqlClient.SqlClient, sql);
    if (yield* aborted(ctx).pipe(access)) return yield* refuse(SHARED_REFUSAL);
    const [source] = yield* sql<{ chatId: string | null }>`SELECT
        json_extract(json, '$.chatId') AS "chatId" FROM kin_events WHERE org_id = ${ctx.orgId}
      AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId}
      AND event_id = ${input.sourceEventId} LIMIT 1`;
    if (source === undefined) return yield* missing();
    const to = yield* personNamedIn(ctx, input.to);
    const [self] = yield* sql<{ name: string; owner: KinPersonId; ownerChatId: KinChatId }>`
      SELECT l.name, a.owner_person_id AS owner, l.owner_chat_id AS "ownerChatId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${ctx.orgId} AND l.agent_id = ${ctx.agentId} ORDER BY l.agent_id`;
    if (self === undefined) return yield* missing();
    const hash = NodeCrypto.createHash("sha256").update(to.personId).digest("hex").slice(0, 16);
    const next =
      input.checkIn === true ? yield* nextCheckIn(ctx.orgId, ctx.agentId).pipe(access) : undefined;
    if (input.checkIn === true && to.personId !== self.owner)
      return yield* refuse(
        `Only the owner has check-ins with you: leave out checkIn to send it to ${to.name} now.`,
      );
    if (input.checkIn === true && next === undefined)
      return yield* refuse(
        `None of your check-ins with ${to.name} is on: leave out checkIn to send it now.`,
      );
    const messageId = KinMessageId.make(
      next === undefined ? `${relayPrefix(ctx.wakeupId)}${hash}` : leftKind(ctx.wakeupId, hash),
    );
    const toOwnerSide =
      (yield* ownerLevel(ctx.orgId, to.personId).pipe(access)) || to.personId === self.owner;
    const sender = yield* turnAsker(ctx).pipe(access);
    const [senderRow] =
      sender === null
        ? []
        : yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
            WHERE org_id = ${ctx.orgId} AND person_id = ${sender} ORDER BY person_id`;
    const reach = yield* Reach.mayReach(
      ctx.orgId,
      Reach.person(to.personId),
      Reach.agent(ctx.agentId),
    ).pipe(access);
    const unreached = new KinChatError({
      reason: "not_allowed",
      message:
        reach === "removed"
          ? `${to.name} is no longer on the team, so nothing was sent.`
          : Reach.restrictedLine(
              to.name,
              self.name,
              sender === self.owner ? null : senderRow?.name,
            ),
    });
    if (reach !== "allowed") return yield* unreached;
    // Whoever the words are from must reach them too, whichever agent carries them.
    const fromRestricted = Effect.fn("KinHandoff.relay.fromRestricted")(function* (
      from: KinPersonId,
      name: string | undefined,
    ) {
      if (from === to.personId) return;
      const pair = yield* Reach.mayReach(
        ctx.orgId,
        Reach.person(from),
        Reach.person(to.personId),
      ).pipe(access);
      if (pair === "restricted")
        return yield* new KinChatError({
          reason: "not_allowed",
          message: Reach.restrictedLine(to.name, name ?? "they", name ?? null),
        });
    });
    if (sender !== null) yield* fromRestricted(KinPersonId.make(sender), senderRow?.name);
    const theirChat =
      to.personId === self.owner
        ? self.ownerChatId
        : (yield* chat
            .createDirect(
              { _tag: "person", orgId: ctx.orgId, personId: to.personId },
              { orgId: ctx.orgId, agentId: ctx.agentId },
            )
            .pipe(Effect.mapError(() => unreached))).chatId;
    if (theirChat === source.chatId)
      return yield* refuse(`You are answering ${to.name} in this chat: answer them here.`);
    // Still sent: it waits in their chat for when they first sign in.
    const unseen = (yield* signedIn(ctx.orgId, to.personId).pipe(access))
      ? undefined
      : `${to.name} hasn't signed in to Kin yet: it waits in their chat with you and reaches them when they do. Nobody was alerted.`;
    // Words sent after the turn read outside text say so wherever they are drawn as someone's.
    // Each reader is named what they may see of it (`renderSource`): the recipient, and this turn.
    const read = yield* outsideStamp(ctx).pipe(access);
    const ownerTurn = (yield* effectiveAudience(ctx).pipe(access)) === "owner_only";
    const afterReading =
      read === undefined ? {} : { afterReading: renderSource(read, toOwnerSide) };
    const sentAs = read === undefined ? "" : AS_REQUEST;
    const named = read === undefined ? {} : { source: renderSource(read, ownerTurn) };
    if (ownerTurn) {
      const direct = { chatId: theirChat };
      // Whose words these are: the one person the turn acts for, drawn as sent by them.
      const sentBy =
        sender === null
          ? {}
          : {
              relay: {
                kind: "sent_by" as const,
                agentId: ctx.agentId,
                personId: KinPersonId.make(sender),
                ...(senderRow === undefined ? {} : { personName: senderRow.name }),
                ...afterReading,
              },
            };
      if (next !== undefined) {
        yield* holdLine({
          orgId: ctx.orgId,
          chatId: direct.chatId,
          personId: to.personId,
          key: messageId,
          body: input.text,
          audience: "chat",
          at: next.fallbackAt,
          agentId: ctx.agentId,
          ...sentBy,
        }).pipe(access);
        return {
          to: to.name,
          sent: true as const,
          note: `${leftNote(to.name, next, "the asker")}${sentAs}`,
          ...named,
        };
      }
      const posted = yield* postTo(
        { ...ctx, wakeupId: KinWakeupId.make(ctx.wakeupId) },
        to.personId,
        {
          chatId: direct.chatId,
          clientMessageId: messageId,
          body: input.text,
          intent: "answer",
          urgent: input.urgent,
          ...sentBy,
        },
      );
      if (isHeld(posted))
        yield* arrivesNote(chat, ctx, to.name, posted, messageId, "owner").pipe(access);
      return {
        to: to.name,
        sent: true as const,
        note: `${
          unseen ??
          (isHeld(posted)
            ? `${heldUntil(to.name, posted)}; Kin delivers it in their chat with you then. Tell the asker they'll have it then; their answer arrives there.`
            : `Sent in ${to.name}'s chat with you; their answer arrives there.`)
        }${isHeld(posted) ? "" : replacedLine(to.name, posted.replaced)}${sentAs}`,
        ...named,
      };
    }
    // A teammate's turn: their request or their words, to anyone in the company.
    const askers = (yield* turnPeople(ctx).pipe(access))?.askers ?? [];
    const asker = askers.length === 1 ? askers[0] : undefined;
    if (asker === undefined)
      return yield* refuse("Only one person's own request can be passed on from here.");
    if (asker !== sender)
      yield* fromRestricted(
        asker,
        (yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
          WHERE org_id = ${ctx.orgId} AND person_id = ${asker} ORDER BY person_id`)[0]?.name,
      );
    const original = yield* routedFrom(ctx, input.sourceEventId);
    if (original === "cleared")
      return yield* new KinChatError({
        reason: "not_found",
        message: "The message this was about has been cleared, so nothing was sent.",
      });
    // As it is sent, on one line: what is checked for its reader is exactly what they will read.
    const flat = (text: string) => text.replace(/\s+/g, " ");
    // A routed relay quotes her stored words too, so they are held to the same reader.
    if (!toOwnerSide)
      for (const text of [
        input.text,
        ...(original === undefined ? [] : [original.body]),
        ...(afterReading.afterReading === undefined ? [] : [afterReading.afterReading]),
      ]) {
        const why = yield* unreadableBy(ctx.orgId, to.personId, flat(text), asker).pipe(access);
        if (why !== undefined)
          return yield* refuse(
            `Not for ${to.name}: ${why}. Send it without that, or ask the owner to share it with ${to.name}.`,
          );
      }
    const [who] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
      WHERE org_id = ${ctx.orgId} AND person_id = ${asker} ORDER BY person_id`;
    const askedAlready = `The owner side was already asked about this request, so nothing more was sent. Tell ${who?.name ?? "them"} it is with them.`;
    // Before a chat is opened for it; the claim below still decides.
    if (original !== undefined) {
      const [free] = yield* sql`SELECT 1 FROM kin_handoffs
        WHERE org_id = ${ctx.orgId} AND message_id = ${original.messageId}
          AND route_state = 'passed'
          AND (asked_message_id IS NULL OR asked_message_id = ${messageId})`;
      if (free === undefined) return yield* refuse(askedAlready);
    }
    const chatId = theirChat;
    const quoted = (text: string) => `"${flat(text).replace(/"/g, "'")}"`;
    // Their words, quoted and named as theirs: a request to decide, never the owner's instruction.
    // A routed request quotes what they stored, and the agent's own words are named as its.
    const body =
      original === undefined
        ? `${who?.name ?? "A teammate"} asked ${self.name}:\n${quoted(input.text)}`
        : `${who?.name ?? "A teammate"} asked:\n${quoted(original.body)}\n${self.name} suggests: ${flat(input.text)}`;
    const where = { orgId: ctx.orgId, personId: to.personId, chatId };
    const relay = {
      kind: "sent_by" as const,
      agentId: ctx.agentId,
      personId: asker,
      ...(who === undefined ? {} : { personName: who.name }),
      ...afterReading,
    };
    // One step: the one ask about a routed request, and the message that carries it.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (original !== undefined) {
          const claimed = yield* sql`UPDATE kin_handoffs SET asked_message_id = ${messageId}
            WHERE org_id = ${ctx.orgId} AND message_id = ${original.messageId}
              AND route_state = 'passed'
              AND (asked_message_id IS NULL OR asked_message_id = ${messageId})
            RETURNING message_id`;
          if (claimed.length === 0) return yield* refuse(askedAlready);
        }
        if (next !== undefined) {
          yield* holdLine({
            ...where,
            key: messageId,
            body,
            audience: "chat",
            at: next.fallbackAt,
            waits: true,
            agentId: ctx.agentId,
            relay,
          }).pipe(access);
          return {
            to: to.name,
            sent: true as const,
            note: `${leftNote(to.name, next, who?.name ?? "the asker")}${sentAs}`,
            ...named,
          };
        }
        const replaced =
          input.urgent === undefined
            ? 0
            : yield* urgentNow({
                ...where,
                agentId: ctx.agentId,
                wakeupId: ctx.wakeupId,
                reason: input.urgent,
              }).pipe(access);
        const held = input.urgent === undefined ? yield* holdFor(where).pipe(access) : undefined;
        if (held !== undefined) {
          const at = yield* holdLine({
            ...where,
            key: messageId,
            body,
            audience: "chat",
            at: held.at,
            waits: true,
            agentId: ctx.agentId,
            relay,
          }).pipe(access);
          yield* arrivesNote(chat, ctx, to.name, { ...held, at }, messageId, "chat").pipe(access);
          return {
            to: to.name,
            sent: true as const,
            note: `${
              unseen ??
              `${heldUntil(to.name, { ...held, at })}; Kin delivers it then, waiting on them in their chat with you. Tell ${who?.name ?? "the asker"} it reaches ${to.name} then; the answer comes back through you.`
            }${sentAs}`,
            ...named,
          };
        }
        yield* chat.notice({
          orgId: ctx.orgId,
          chatId,
          audience: "chat",
          messageId,
          waitingFor: to.personId,
          body,
          from: ctx.agentId,
          relay,
        });
        return {
          to: to.name,
          sent: true as const,
          note: `${
            unseen ??
            `It waits on ${to.name} in their chat with you, quoted as ${who?.name ?? "the asker"}'s words. Tell them it is with ${to.name}; the answer comes back through you.`
          }${replacedLine(to.name, replaced)}${sentAs}`,
          ...named,
        };
      }),
    );
  }, guarded("KinHandoff.relay"));

  const leads = Effect.fn("KinHandoff.leads")(function* (scope: McpInvocationScope) {
    const ctx = yield* lead(scope);
    const all = yield* colleagues(ctx);
    const self = all.find((entry) => entry.agentId === ctx.agentId);
    if (self === undefined) return yield* missing();
    if (
      (yield* effectiveAudience(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql))) ===
      "owner_only"
    )
      return {
        leads: all.map(({ agentId, name, domain, charter }) => ({
          name,
          domain,
          charter,
          you: agentId === ctx.agentId,
        })),
      };
    // Someone else may be reading the answer: names only, of the agents they may all message,
    // and from a group only those in it, as a hand-off there reaches only them.
    const people =
      (yield* turnPeople(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql)))?.people ?? [];
    const chats = [
      ...new Set(
        (yield* wakeEvents(ctx)).flatMap((event) =>
          event._tag === "chat.message" ||
          event._tag === "widget.action" ||
          event._tag === "chat.reaction"
            ? [event.chatId]
            : [],
        ),
      ),
    ];
    const present =
      chats.length === 0
        ? []
        : yield* sql<{ agentId: string }>`SELECT DISTINCT m.agent_id AS "agentId"
            FROM kin_chat_members m JOIN kin_chats c ON c.org_id = m.org_id
              AND c.chat_id = m.chat_id AND c.kind <> 'direct'
            WHERE m.org_id = ${ctx.orgId} AND m.chat_id IN ${sql.in(chats)}
              AND m.principal_kind = 'agent' AND m.left_at IS NULL
            ORDER BY m.agent_id`;
    const [group] =
      chats.length === 0
        ? []
        : yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${ctx.orgId}
            AND chat_id IN ${sql.in(chats)} AND kind <> 'direct' LIMIT 1`;
    const seen = new Set(present.map((row) => row.agentId));
    const named: Array<{ name: string; you: boolean }> = [];
    for (const entry of all) {
      let open = group === undefined || seen.has(entry.agentId);
      for (const personId of people)
        open &&= yield* Reach.reaches(
          ctx.orgId,
          Reach.person(KinPersonId.make(personId)),
          Reach.agent(entry.agentId),
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      if (open || entry.agentId === ctx.agentId)
        named.push({ name: entry.name, you: entry.agentId === ctx.agentId });
    }
    return { leads: named };
  }, guarded("KinHandoff.leads"));

  /** One other live lead of the owner's, by name or domain. */
  const targetOf = Effect.fnUntraced(function* (
    ctx: Lead,
    all: ReadonlyArray<Colleague>,
    to: string,
  ) {
    const others = all.filter((entry) => entry.agentId !== ctx.agentId);
    if (others.length === 0)
      return yield* refuse("There is no other agent to pass this to. Answer it yourself.");
    const wanted = fold(to);
    const byName = others.filter((entry) => fold(entry.name) === wanted);
    const matches =
      byName.length > 0 ? byName : others.filter((entry) => fold(entry.domain) === wanted);
    const [target] = matches;
    if (matches.length !== 1 || target === undefined)
      return yield* new KinChatError({
        reason: matches.length === 0 ? "not_found" : "invalid_state",
        message: `${matches.length === 0 ? "No agent here answers to that name or domain" : "Several agents answer to that"}. The agents are: ${describe(others)}. ${NOTHING} Call again with one of those names.`,
      });
    return target;
  });

  /**
   * From a check-in, a pulse fact another agent acts on: Kin's own words for the fact, then the
   * lead's line, land in that agent's chat with the owner and wake it there. Once per fact a turn.
   */
  /**
   * What an outside read is called for each reader (`renderSource`): the person whose chat the
   * pass lands in, and this turn's own readers.
   */
  const readNames = Effect.fnUntraced(function* (
    ctx: Lead,
    read: string | undefined,
    readerId: KinPersonId,
  ) {
    if (read === undefined) return undefined;
    const access = Effect.provideService(SqlClient.SqlClient, sql);
    return {
      notice: renderSource(
        read,
        yield* ownerLevel(ctx.orgId, readerId).pipe(
          access,
          Effect.orElseSucceed(() => false),
        ),
      ),
      turn: renderSource(read, (yield* effectiveAudience(ctx).pipe(access)) === "owner_only"),
    };
  });

  const passFact = Effect.fnUntraced(function* (
    ctx: Lead,
    self: Colleague,
    all: ReadonlyArray<Colleague>,
    event: Extract<KinEvent, { _tag: "pulse" }>,
    input: typeof HandOffInput.Type,
  ) {
    const memberId = self.memberId;
    if (memberId === null) return yield* missing();
    if (input.fact === undefined)
      return yield* refuse(
        "From a check-in, pass a fact: its key from pulse_read in fact, and what the other agent should do in request.",
      );
    const now = yield* Clock.currentTimeMillis;
    const facts = yield* KinPulse.read({
      orgId: ctx.orgId,
      at: now,
      viewer: { _tag: "owner" },
      includeHandled: true,
      limit: 200,
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const fact = facts.facts.find((one) => one.key === input.fact);
    if (fact === undefined || fact.aside !== undefined)
      return yield* refuse(
        "That fact isn't open now: pulse_read lists the open ones. Nothing was passed on.",
      );
    if (fact.stage === "heads_up")
      return yield* refuse(
        `${fact.subject.key} is a renewal before its draft day: mention it, don't hand it over yet (${fact.consequence}). Nothing was passed on.`,
      );
    const target = yield* targetOf(ctx, all, input.to);
    const key = `handoff:fact:${ctx.wakeupId}:${fact.key}`;
    const id = NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
    const messageId = KinMessageId.make(`kin-handoff:${id}`);
    const claimed = yield* sql`INSERT INTO kin_handoffs
        (org_id, message_id, from_agent_id, to_agent_id, event_id, created_at, to_chat_id, wants_answer)
      VALUES (${ctx.orgId}, ${messageId}, ${ctx.agentId}, ${target.agentId}, ${`handoff-${id}`},
        ${now}, ${target.ownerChatId}, ${input.wantsAnswer ? 1 : 0})
      ON CONFLICT (org_id, message_id) DO NOTHING RETURNING to_agent_id`;
    if (claimed.length === 0) return { to: target.name, passed: true as const };
    const about =
      fact.subject.key === fact.subject.title
        ? fact.subject.title
        : `${recordName(fact.subject.key, fact.subject.number)} ${fact.subject.title}`;
    const body = [
      input.request.replace(/\s+/g, " "),
      `From ${event.checkIn?.title ?? "Kin's facts"}: ${about}: ${fact.consequence} (${fact.key})`,
    ]
      .join("\n")
      .slice(0, messageBodyLimit);
    const read = yield* outsideStamp(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const named = yield* readNames(ctx, read, target.ownerPersonId);
    // Shown the T3 way, on the owner's side as sent by the passing agent; he didn't write it.
    const { message } = yield* chat.notice({
      orgId: ctx.orgId,
      chatId: target.ownerChatId,
      audience: "owner",
      messageId,
      body,
      relay: {
        kind: "sent_by",
        agentId: ctx.agentId,
        ...(named === undefined ? {} : { afterReading: named.notice }),
      },
      silent: true,
    });
    yield* queue.enqueue({
      _tag: "chat.message",
      orgId: ctx.orgId,
      eventId: KinEventId.make(`handoff-${id}`),
      agentId: target.agentId,
      receivedAt: DateTime.makeUnsafe(message.createdAt),
      dedupeKey: key,
      provenance: {
        _tag: "agent",
        agentId: ctx.agentId,
        memberId,
        ownerPersonId: self.ownerPersonId,
        threadId: ctx.threadId,
      },
      chatId: target.ownerChatId,
      messageId: message.messageId,
      origin: { agentId: ctx.agentId, chatId: self.ownerChatId },
    });
    // A check-in that showed outside text passes it on marked, like any hand-off.
    yield* stampEvent(ctx.orgId, `handoff-${id}`, read).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    return {
      to: target.name,
      passed: true as const,
      ...(named === undefined
        ? {}
        : {
            note: `Passed to ${target.name} as a request, with its source: what ${target.name} makes from it waits to be kept.`,
            source: named.turn,
          }),
    };
  });

  const handOff = Effect.fn("KinHandoff.handOff")(function* (
    scope: McpInvocationScope,
    input: typeof HandOffInput.Type,
  ) {
    const ctx = yield* lead(scope);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const access = Effect.provideService(SqlClient.SqlClient, sql);
        if (yield* aborted(ctx).pipe(access)) return yield* refuse(SHARED_REFUSAL);
        // Others read this turn: a teammate's own request goes on at their access, else only
        // within the group it answers, never to a private chat.
        if (
          (yield* effectiveAudience(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql))) !==
          "owner_only"
        ) {
          const ask = yield* directAsk(ctx, input.sourceEventId);
          return ask === undefined ? yield* passInRoom(ctx, input) : yield* passOn(ctx, ask, input);
        }
        const all = yield* colleagues(ctx);
        const self = all.find((entry) => entry.agentId === ctx.agentId);
        if (self === undefined || self.memberId === null) return yield* missing();
        const [stored] = yield* sql<{ json: string }>`SELECT json FROM kin_events
          WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId}
            AND event_id = ${input.sourceEventId} ORDER BY event_id`;
        if (stored === undefined) return yield* missing();
        const event = yield* decodeEvent(stored.json);
        if (event._tag === "pulse") return yield* passFact(ctx, self, all, event, input);
        // Asked in a group of the owner and agents: the agent there answers it there.
        if (event._tag === "chat.message" && event.chatId !== self.ownerChatId)
          return yield* passInRoom(ctx, input);
        // One hop: what was passed on is answered where it landed, so two leads can't trade it.
        if (event._tag === "chat.message" && event.origin !== undefined)
          return yield* refuse(ONE_HOP);
        // Only the owner's own words in this lead's own chat with them: the owner could have
        // written to the other lead directly, so passing it on reaches nothing new.
        const [asked] =
          event._tag !== "chat.message"
            ? []
            : yield* sql<{ body: string }>`SELECT m.body FROM kin_messages m
                WHERE m.org_id = ${ctx.orgId} AND m.message_id = ${event.messageId}
                  AND m.chat_id = ${event.chatId} AND m.chat_id = ${self.ownerChatId}
                  AND m.author_kind = 'human' AND m.author_person_id = ${self.ownerPersonId}
                  AND m.kind = 'text' AND m.status = 'posted'
                ORDER BY m.message_id`;
        if (asked === undefined || event._tag !== "chat.message")
          return yield* refuse(
            "A request can be passed on only when the owner wrote it to you in your own chat with them. Say in one line which agent owns it instead.",
          );
        // What the lead adds was written with all of this wake-up in view, so it carries only
        // when the owner alone set it off.
        if (!(yield* wakeEvents(ctx)).every((entry) => fromOwnerAlone(entry, self)))
          return yield* refuse(
            "Something from outside your own chat with the owner came in with this, so it can't be passed on now. Say in one line which agent owns it instead.",
          );
        const target = yield* targetOf(ctx, all, input.to);
        /** Where this owner message already went: there again is the same hand-off, else refused. */
        const already = Effect.fnUntraced(function* () {
          const [record] = yield* sql<{ toAgentId: KinAgentId }>`SELECT to_agent_id AS "toAgentId"
            FROM kin_handoffs WHERE org_id = ${ctx.orgId} AND message_id = ${event.messageId}
            ORDER BY message_id`;
          if (record === undefined) return undefined;
          if (record.toAgentId === target.agentId)
            return { to: target.name, passed: true as const };
          const went = all.find((entry) => entry.agentId === record.toAgentId)?.name;
          return yield* refuse(
            `This was already passed on${went === undefined ? "" : ` to ${went}`}, and a request goes to one agent only. Tell the owner where it went instead.`,
          );
        });
        const before = yield* already();
        if (before !== undefined) return before;
        const onIt = yield* putOnThisTurn(ctx, target);
        if (onIt !== undefined) return onIt;
        const dedupeKey = `handoff:${event.messageId}`;
        const id = NodeCrypto.createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
        // The lead's own words, then the owner's whole, quoted, so neither passes for the other.
        // Who sent it travels as the row's sender (`relay`), drawn the way T3 draws a message
        // another thread sent.
        const note = input.request.replace(/\s+/g, " ");
        const quoted = `The owner wrote: "${asked.body}"`;
        const adds = fold(note) === fold(asked.body) ? [] : [note];
        const body = [...adds, quoted].join("\n");
        // The other lead is shown no more than this of a message; Kin won't pass on part of one.
        if (body.length > messageBodyLimit)
          return yield* refuse(
            quoted.length > messageBodyLimit
              ? "The owner's message is too long for another agent to be shown whole, and Kin won't pass on part of it. Say in one line which agent owns it, so the owner can send it there."
              : "With what you add, this is too long for another agent to be shown whole. Add less and call again.",
          );
        // One hand-off per owner message, whatever words, lead name or wake-up a retry uses. The
        // row is claimed before anything is posted, so a second destination never gets it.
        const claimed = yield* sql<{ toAgentId: KinAgentId }>`INSERT INTO kin_handoffs
            (org_id, message_id, from_agent_id, to_agent_id, event_id, created_at, to_chat_id, wants_answer)
          VALUES (${ctx.orgId}, ${event.messageId}, ${ctx.agentId}, ${target.agentId},
            ${`handoff-${id}`}, ${yield* Clock.currentTimeMillis}, ${target.ownerChatId},
            ${input.wantsAnswer ? 1 : 0})
          ON CONFLICT (org_id, message_id) DO NOTHING RETURNING to_agent_id AS "toAgentId"`;
        if (claimed.length === 0) return (yield* already()) ?? (yield* unavailable());
        const read = yield* outsideStamp(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        const named = yield* readNames(ctx, read, target.ownerPersonId);
        const { message } = yield* chat.notice({
          orgId: ctx.orgId,
          chatId: target.ownerChatId,
          audience: "owner",
          messageId: KinMessageId.make(`kin-handoff:${id}`),
          body,
          relay: {
            kind: "sent_by",
            agentId: ctx.agentId,
            ...(named === undefined ? {} : { afterReading: named.notice }),
          },
          silent: true,
        });
        yield* queue.enqueue({
          _tag: "chat.message",
          orgId: ctx.orgId,
          eventId: KinEventId.make(`handoff-${id}`),
          agentId: target.agentId,
          receivedAt: DateTime.makeUnsafe(message.createdAt),
          dedupeKey,
          // The passing lead said it, so what the other lead remembers of it is agent-trust.
          provenance: {
            _tag: "agent",
            agentId: ctx.agentId,
            memberId: self.memberId,
            ownerPersonId: self.ownerPersonId,
            threadId: ctx.threadId,
          },
          chatId: target.ownerChatId,
          messageId: message.messageId,
          origin: { agentId: ctx.agentId, chatId: self.ownerChatId },
        });
        // Passed on after an outside read: the other lead's turn starts outside-read too.
        yield* stampEvent(ctx.orgId, `handoff-${id}`, read).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        return {
          to: target.name,
          passed: true as const,
          ...(named === undefined
            ? {}
            : {
                note: `Passed to ${target.name} as a request, with its source: what ${target.name} makes from it waits to be kept.`,
                source: named.turn,
              }),
        };
      }),
    );
  }, guarded("KinHandoff.handOff"));

  /** A copied answer's last line when its turn left a card open in its own chat: where it is. */
  const cardElsewhere = Effect.fn("KinHandoff.cardElsewhere")(function* (
    input: { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly wakeupId: string },
    handoff: { readonly toChatId: KinChatId; readonly noticeSeq: number },
  ) {
    const cards = yield* sql<{ type: string; state: string; updatedAt: string }>`SELECT w.type,
        w.state_json AS state, w.updated_at AS "updatedAt"
      FROM kin_widgets w JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
        JOIN kin_wakeups k ON k.org_id = m.org_id AND k.wakeup_id = ${input.wakeupId}
          AND k.thread_id = m.author_thread_id
      WHERE w.org_id = ${input.orgId} AND w.chat_id = ${handoff.toChatId}
        AND w.type IN ('choice', 'approval') AND w.closed_at IS NULL
        AND m.author_agent_id = ${input.agentId} AND m.seq > ${handoff.noticeSeq}
      ORDER BY m.seq`;
    const now = yield* Clock.currentTimeMillis;
    const open = cards.some(
      (card) =>
        card.type !== "choice" ||
        !choiceExpired({ updatedAt: card.updatedAt, state: JSON.parse(card.state) }, now),
    );
    if (!open) return "";
    const [named] = yield* sql<{ name: string }>`SELECT name FROM kin_leads
      WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} ORDER BY agent_id`;
    return named === undefined ? "" : `\n\nAnswer on the card in your chat with ${named.name}.`;
  });

  const reportBack = Effect.fn("KinHandoff.reportBack")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: string;
    }) {
      const owed = yield* sql<{
        messageId: string;
        fromAgentId: KinAgentId;
        toChatId: KinChatId;
        noticeSeq: number;
        wantsAnswer: number | null;
      }>`SELECT h.message_id AS "messageId", h.from_agent_id AS "fromAgentId",
          h.to_chat_id AS "toChatId", h.wants_answer AS "wantsAnswer",
          COALESCE((SELECT n.seq FROM kin_messages n WHERE n.org_id = h.org_id
            AND n.message_id = json_extract(e.json, '$.messageId')), 0) AS "noticeSeq"
        FROM kin_handoffs h JOIN kin_events e ON e.org_id = h.org_id AND e.event_id = h.event_id
        WHERE h.org_id = ${input.orgId} AND h.to_agent_id = ${input.agentId}
          AND e.wakeup_id = ${input.wakeupId} AND h.reply_message_id IS NULL
          AND h.to_chat_id IS NOT NULL
        ORDER BY h.created_at`;
      for (const handoff of owed) {
        // Its last word there in this wake-up: the reply grows in place, so the finished one.
        const [reply] = yield* sql<{ messageId: KinMessageId }>`SELECT m.message_id AS "messageId"
          FROM kin_messages m JOIN kin_wakeups w ON w.org_id = m.org_id
            AND w.wakeup_id = ${input.wakeupId} AND w.thread_id = m.author_thread_id
          WHERE m.org_id = ${input.orgId} AND m.chat_id = ${handoff.toChatId}
            AND m.author_kind = 'agent' AND m.author_agent_id = ${input.agentId}
            AND m.status = 'posted' AND m.kind = 'text' AND m.seq > ${handoff.noticeSeq}
          ORDER BY m.seq DESC LIMIT 1`;
        if (reply === undefined) continue;
        const message = yield* repo.getMessage({ orgId: input.orgId, messageId: reply.messageId });
        if (Option.isNone(message) || message.value.author._tag !== "agent") continue;
        const author = message.value.author;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const claimed = yield* sql`UPDATE kin_handoffs SET reply_message_id = ${reply.messageId}
              WHERE org_id = ${input.orgId} AND message_id = ${handoff.messageId}
                AND reply_message_id IS NULL RETURNING message_id`;
            if (claimed.length === 0) return;
            const [asker] = yield* sql<{
              ownerChatId: KinChatId;
              ownerPersonId: KinPersonId;
            }>`SELECT l.owner_chat_id AS "ownerChatId", a.owner_person_id AS "ownerPersonId"
              FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
                AND a.retired_at IS NULL
              WHERE l.org_id = ${input.orgId} AND l.agent_id = ${handoff.fromAgentId}`;
            if (asker === undefined) return;
            const where = yield* cardElsewhere(input, handoff);
            // Keyed by the answer, not the hand-off: one reply to several hand-offs is one relay.
            const key = `handoff-back:${reply.messageId}:${asker.ownerChatId}`;
            const id = NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
            // An answer written after its turn read outside text goes back marked, like a hand-off.
            const read = yield* outsideStamp(input).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            const afterReading =
              read === undefined
                ? {}
                : {
                    afterReading: renderSource(
                      read,
                      yield* ownerLevel(input.orgId, asker.ownerPersonId).pipe(
                        Effect.provideService(SqlClient.SqlClient, sql),
                        Effect.orElseSucceed(() => false),
                      ),
                    ),
                  };
            const { message: back } = yield* chat.notice({
              orgId: input.orgId,
              chatId: asker.ownerChatId,
              audience: "owner",
              messageId: KinMessageId.make(`kin-handoff-back:${id}`),
              body: `${message.value.body.slice(0, messageBodyLimit - where.length)}${where}`,
              relay: { kind: "reply_from", agentId: input.agentId, ...afterReading },
              silent: true,
            });
            if (handoff.wantsAnswer === 0) return;
            // The asking lead's turn that handed the message on: this answer is its result.
            const asked = yield* sql<{ wakeupId: KinWakeupId }>`SELECT DISTINCT
                wakeup_id AS "wakeupId" FROM kin_events
              WHERE org_id = ${input.orgId} AND agent_id = ${handoff.fromAgentId}
                AND wakeup_id IS NOT NULL AND tag = 'chat.message'
                AND json_extract(json, '$.messageId') = ${handoff.messageId}
              ORDER BY wakeup_id`;
            yield* queue
              .enqueue({
                _tag: "chat.message",
                orgId: input.orgId,
                eventId: KinEventId.make(`handoff-back-${id}`),
                agentId: handoff.fromAgentId,
                receivedAt: DateTime.makeUnsafe(back.createdAt),
                dedupeKey: key,
                provenance: author,
                chatId: asker.ownerChatId,
                messageId: back.messageId,
                origin: { agentId: handoff.fromAgentId, chatId: asker.ownerChatId },
                ...(asked.length === 0 ? {} : { askedIn: asked.map((row) => row.wakeupId) }),
              })
              .pipe(
                Effect.tap(() =>
                  stampEvent(input.orgId, `handoff-back-${id}`, read).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  ),
                ),
                Effect.catchTags({
                  KinEventQueueConflict: () => Effect.void,
                  KinEventQueueRetiredAgent: () => Effect.void,
                  KinEventQueueUnknownAgent: () => Effect.void,
                }),
              );
          }),
        );
      }
    },
    Effect.catchCause((cause) => Effect.logError("Kin hand-off report-back failed", { cause })),
  );

  const workDone = Effect.fn("KinHandoff.workDone")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: string;
      readonly owed: ReadonlyArray<{ readonly eventId: string; readonly personId: KinPersonId }>;
    }) {
      const prefix = relayPrefix(input.wakeupId);
      for (const { eventId, personId } of input.owed) {
        const [direct] = yield* sql<{
          chatId: KinChatId;
          name: string;
        }>`SELECT c.chat_id AS "chatId",
            l.name FROM kin_chats c JOIN kin_leads l ON l.org_id = c.org_id
              AND l.agent_id = ${input.agentId}
          WHERE c.org_id = ${input.orgId} AND c.kind = 'direct' AND c.archived_at IS NULL
            AND c.direct_key = ${`${personId}:${input.agentId}`}`;
        if (direct === undefined) continue;
        const sent = yield* sql`SELECT 1 FROM kin_messages WHERE org_id = ${input.orgId}
            AND chat_id = ${direct.chatId} AND (substr(message_id, 1, ${prefix.length}) = ${prefix}
              OR substr(client_message_id, 1, ${prefix.length + 5}) = ${`send:${prefix}`})
          UNION ALL SELECT 1 FROM kin_held_posts WHERE org_id = ${input.orgId}
            AND chat_id = ${direct.chatId} AND substr(kind, 1, ${prefix.length}) = ${prefix}
          LIMIT 1`;
        if (sent.length > 0) continue;
        if (
          !(yield* Reach.reaches(
            input.orgId,
            Reach.person(personId),
            Reach.agent(input.agentId),
          ).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
        )
          continue;
        const id = NodeCrypto.createHash("sha256")
          .update(`${eventId}:${personId}`)
          .digest("hex")
          .slice(0, 32);
        yield* chat.notice({
          orgId: input.orgId,
          chatId: direct.chatId,
          audience: "chat",
          messageId: KinMessageId.make(`kin-work-done:${id}`),
          body: `The work ${direct.name} started for your request is finished; the owner's side has the result.`,
        });
      }
    },
    Effect.catchCause((cause) => Effect.logError("Kin finished-work line failed", { cause })),
  );

  return KinHandoff.of({ leads, handOff, takePrivate, relay, reportBack, workDone });
});

export const layer = Layer.effect(KinHandoff, make);
