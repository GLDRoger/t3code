import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinEvent,
  KinEventId,
  KinMemberId,
  KinMessageId,
  KinPersonId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import { resolveLead } from "./LeadMemory.ts";

export const LeadsResult = Schema.Struct({
  leads: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      domain: Schema.String,
      // What the owner said it is for.
      charter: Schema.String,
      you: Schema.Boolean,
    }),
  ),
});
export const HandOffInput = Schema.Struct({
  to: TrimmedNonEmptyString.check(Schema.isMaxLength(80)).annotate({
    description: "The lead to pass it to, by name or domain, as kin_leads lists them.",
  }),
  request: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)).annotate({
    description:
      "What you are passing on, in the owner's terms, with anything useful you already found. The owner's own message goes along with it.",
  }),
  sourceEventId: TrimmedNonEmptyString.annotate({
    description: "The event of the owner's message you are passing on.",
  }),
});
export const HandOffResult = Schema.Struct({
  // The lead it went to, by name, to tell the owner.
  to: Schema.String,
  passed: Schema.Literal(true),
});

const ORIGINAL_CAP = 1_500;
const NOTHING = "Nothing was passed on.";
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
const fold = (value: string) => value.trim().toLowerCase();
const describe = (leads: ReadonlyArray<Colleague>) =>
  leads.map((lead) => `${lead.name} (${lead.domain})`).join(", ");

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
  }
>()("t3/kin/lead/Handoff/KinHandoff") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const chat = yield* KinChatService;
  const queue = yield* KinEventQueue;
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

  const leads = Effect.fn("KinHandoff.leads")(function* (scope: McpInvocationScope) {
    const ctx = yield* lead(scope);
    return {
      leads: (yield* colleagues(ctx)).map(({ agentId, name, domain, charter }) => ({
        name,
        domain,
        charter,
        you: agentId === ctx.agentId,
      })),
    };
  }, guarded("KinHandoff.leads"));

  const handOff = Effect.fn("KinHandoff.handOff")(function* (
    scope: McpInvocationScope,
    input: typeof HandOffInput.Type,
  ) {
    const ctx = yield* lead(scope);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const all = yield* colleagues(ctx);
        const self = all.find((entry) => entry.agentId === ctx.agentId);
        if (self === undefined || self.memberId === null) return yield* missing();
        const [stored] = yield* sql<{ json: string }>`SELECT json FROM kin_events
          WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId}
            AND event_id = ${input.sourceEventId} ORDER BY event_id`;
        if (stored === undefined) return yield* missing();
        const event = yield* decodeEvent(stored.json);
        // One hop: what was passed on is answered where it landed, so two leads can't trade it.
        if (event._tag === "chat.message" && event.origin !== undefined)
          return yield* refuse(
            "This was already passed on to you by another lead, so it stops with you. Answer it, or say in one line what you can't do.",
          );
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
        if (asked === undefined)
          return yield* refuse(
            "A request can be passed on only when the owner wrote it to you in your own chat with them. Say in one line which lead owns it instead.",
          );
        const others = all.filter((entry) => entry.agentId !== ctx.agentId);
        if (others.length === 0)
          return yield* refuse("There is no other lead to pass this to. Answer it yourself.");
        const wanted = fold(input.to);
        const byName = others.filter((entry) => fold(entry.name) === wanted);
        const matches =
          byName.length > 0 ? byName : others.filter((entry) => fold(entry.domain) === wanted);
        if (matches.length !== 1)
          return yield* new KinChatError({
            reason: matches.length === 0 ? "not_found" : "invalid_state",
            message: `${matches.length === 0 ? "No lead here answers to that name or domain" : "Several leads answer to that"}. The leads are: ${describe(others)}. ${NOTHING} Call again with one of those names.`,
          });
        const [target] = matches;
        // One per asked message and lead, whatever words or wake-up a retry comes with.
        const dedupeKey = `handoff:${event.eventId}:${target!.agentId}`;
        const id = NodeCrypto.createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
        const already = yield* sql`SELECT 1 FROM kin_events
          WHERE org_id = ${ctx.orgId} AND agent_id = ${target!.agentId}
            AND dedupe_key = ${dedupeKey} ORDER BY event_id`;
        if (already.length > 0) return { to: target!.name, passed: true as const };
        // One line, named as the lead's: its words can't pass for the owner's or for Kin's.
        const note = input.request.replace(/\s+/g, " ");
        const original =
          asked.body.length > ORIGINAL_CAP ? `${asked.body.slice(0, ORIGINAL_CAP)}…` : asked.body;
        const { message } = yield* chat.notice({
          orgId: ctx.orgId,
          chatId: target!.ownerChatId,
          messageId: KinMessageId.make(`kin-handoff:${id}`),
          body: [
            `Passed on by ${self.name}`,
            `"${original}"`,
            ...(fold(note) === fold(asked.body) ? [] : [`${self.name} adds: ${note}`]),
          ].join("\n"),
        });
        yield* queue.enqueue({
          _tag: "chat.message",
          orgId: ctx.orgId,
          eventId: KinEventId.make(`handoff-${id}`),
          agentId: target!.agentId,
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
          chatId: target!.ownerChatId,
          messageId: message.messageId,
          origin: { agentId: ctx.agentId, chatId: self.ownerChatId },
        });
        return { to: target!.name, passed: true as const };
      }),
    );
  }, guarded("KinHandoff.handOff"));

  return KinHandoff.of({ leads, handOff });
});

export const layer = Layer.effect(KinHandoff, make);
