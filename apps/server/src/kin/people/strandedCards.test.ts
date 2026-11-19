import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
  KinWidgetId,
  ThreadId,
  type KinChatId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { layerKinAuthTest, pairSession } from "../auth/ProofKeySessions.testkit.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Service from "../chat/KinChatService.ts";
import * as Groups from "../chat/KinGroups.ts";
import { KinIdentity, KinIdentityConfig } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as Stop from "../lead/KinStop.ts";
import * as Presence from "../reply/KinPresence.ts";
import * as People from "./KinPeople.ts";

const at = "1970-01-01T00:00:00.000Z";
const layer = Layer.mergeAll(People.layer, Groups.layer).pipe(
  Layer.provideMerge(Service.layer),
  Layer.provideMerge(Stop.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(Presence.layer),
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(
    KinIdentity.layer.pipe(
      Layer.provide(
        Layer.succeed(KinIdentityConfig, {
          orgName: "Kin",
          ownerHandle: "owner",
          ownerDisplayName: "Owner",
        }),
      ),
      Layer.provideMerge(Repository.layer),
    ),
  ),
  Layer.provideMerge(layerKinAuthTest("kin-stranded-")),
  Layer.provideMerge(environment),
);
const ownerSession = {
  sessionId: AuthSessionId.make("owner"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
it.effect(
  "taking a co-owner's level closes the send cards it stranded; a promotion or a chat they are not in closes none",
  () =>
    Effect.gen(function* () {
      const service = yield* People.KinPeople;
      const identity = yield* KinIdentity;
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* Repository.KinChatRepository;
      const chats = yield* Service.KinChatService;
      const groups = yield* Groups.KinGroups;
      const { owner } = identity;
      const { orgId } = owner;
      yield* pairSession(ownerSession.sessionId);
      const finance = KinAgentId.make("finance");
      const threadId = ThreadId.make("finance-thread");
      yield* repo.insertAgent({
        orgId,
        agentId: finance,
        ownerPersonId: owner.personId,
        displayName: "Finance",
        role: "lead",
        createdAt: at,
      });
      yield* identity.registerAgentThread({ orgId, agentId: finance, threadId });
      const ownerChat = yield* chats.createDirect(owner, { orgId, agentId: finance });
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES (${finance}, ${orgId}, 'Finance', 0, '{}', '[]', ${ownerChat.chatId})`;
      yield* sql`INSERT INTO kin_connections (org_id, connection_id, label, kind, url_host, auth,
          reach, state, created_at, updated_at)
        VALUES (${orgId}, 'mail', 'Gmail', 'builtin', 'mail.invented.example', 'oauth', 'closed',
          'active', 0, 0)`;
      const join = Effect.fn("test.join")(function* (displayName: string) {
        return (yield* service.accept({
          secret: (yield* service.createInvite(ownerSession, { orgId, displayName })).secret,
        })).person.personId;
      });
      const [meera, zoya, dev] = [yield* join("Meera"), yield* join("Zoya"), yield* join("Dev")];
      for (const personId of [meera, zoya])
        yield* service.setAccess(ownerSession, { orgId, personId, access: "co_owner" });
      const group = Effect.fn("test.group")(function* (title: string, personId: KinPersonId) {
        const made = yield* groups.create([owner], {
          orgId,
          title,
          agentIds: [finance],
          personIds: [],
        });
        yield* groups.addMember([owner], {
          chatId: made.chatId,
          principal: { _tag: "person", personId },
        });
        return made.chatId;
      });
      const launch = yield* group("Launch", meera);
      const books = yield* group("Books", zoya);
      let asks = 0;
      // A mail Finance drew in `chatId`, waiting on its Confirm or already `state`.
      const asked = Effect.fn("test.asked")(function* (chatId: KinChatId, state = "open") {
        const card = yield* chats.ask(
          {
            _tag: "agent",
            orgId,
            agentId: finance,
            ownerPersonId: owner.personId,
            threadId,
            hostPosted: true,
          },
          {
            chatId,
            clientMessageId: `send-${++asks}`,
            question: "Invented: send this email from Gmail?",
            options: [
              { label: "Confirm", kind: "yes" },
              { label: "Cancel", kind: "no" },
            ],
            send: {
              service: "Gmail",
              action: "email",
              from: "owner@invented.example",
              to: ["client@invented.example"],
              cc: [],
              subject: "Invented subject",
              body: "Invented body.",
              attachments: [],
              outcome: null,
            },
          },
        );
        yield* sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name,
            pin_digest, payload_json, agent_id, wakeup_id, chat_id, widget_id, state, proposed_at)
          VALUES (${orgId}, ${`ask-${asks}`}, 'mail', 'mail_send', 'pin', '{}', ${finance}, 'wake',
            ${chatId}, ${card.widgetId}, ${state}, 0)`;
        return card.widgetId;
      });
      const waiting = yield* asked(launch);
      const sending = yield* asked(launch, "sending");
      const ownersOwn = yield* asked(ownerChat.chatId);
      const filed = yield* asked(books);
      // Each mail, and its card: closed or not, and what it says if so.
      const now = sql<{
        widgetId: string;
        state: string;
        reason: string | null;
        closed: number;
        said: string | null;
      }>`SELECT k.widget_id AS "widgetId", k.state, k.reason, w.closed_at IS NOT NULL AS closed,
          json_extract(w.state_json, '$.outcome.text') AS said
        FROM kin_connection_asks k JOIN kin_widgets w ON w.widget_id = k.widget_id
        ORDER BY k.ask_id`;
      const untouched = yield* now;
      assert.deepStrictEqual(
        untouched.map((one) => [one.widgetId, one.closed]),
        [waiting, sending, ownersOwn, filed].map((widgetId) => [widgetId, 0]),
      );

      // A promotion, and a co-owner made a member who is in none of these chats: nothing closes.
      yield* service.setAccess(ownerSession, { orgId, personId: dev, access: "co_owner" });
      assert.deepStrictEqual(yield* now, untouched);
      yield* service.setAccess(ownerSession, { orgId, personId: dev, access: "member" });
      assert.deepStrictEqual(yield* now, untouched);

      // Meera made a member, still in Launch: its waiting mail goes stale and its card says why;
      // the one already sending, the owner's own chat and Books stay as they were.
      yield* service.setAccess(ownerSession, { orgId, personId: meera, access: "member" });
      const why = "Meera is no longer a co-owner here, so this needs asking again.";
      assert.deepStrictEqual(yield* now, [
        { ...untouched[0]!, state: "stale", reason: why, closed: 1, said: `Closed: ${why}` },
        ...untouched.slice(1),
      ]);
      // A Confirm from the card as it was does nothing.
      const [shown] = yield* sql<{ revision: number; confirm: string }>`SELECT revision,
          json_extract(state_json, '$.options[0].optionId') AS confirm
        FROM kin_widgets WHERE widget_id = ${waiting}`;
      assert.propertyVal(
        yield* chats
          .act(owner, {
            widgetId: KinWidgetId.make(waiting),
            revision: shown!.revision - 1,
            actionId: "choose",
            value: shown!.confirm,
            clientActionId: "late-confirm",
          })
          .pipe(Effect.flip),
        "reason",
        "widget_changed",
      );

      // The mail already sending still reports there: the owner-only write is refused as such,
      // and its status lands as a plain one.
      const outcome = (state: "sent" | "failed", reason: string | null) => ({
        orgId,
        widgetId: KinWidgetId.make(sending),
        outcome: { state, reason, at },
      });
      assert.isTrue(
        Repository.isPrivateWriteRefused(
          yield* chats.setSendOutcome(outcome("failed", "Invented reason.")).pipe(Effect.flip),
        ),
      );
      yield* chats.setSendOutcome({ ...outcome("sent", null), audience: "chat" });
      assert.deepStrictEqual(
        yield* sql`SELECT json_extract(state_json, '$.send.outcome.state') AS state
          FROM kin_widgets WHERE widget_id = ${sending}`,
        [{ state: "sent" }],
      );

      // Removed while a co-owner, Zoya's Books mail closes the same way.
      yield* service.removeAccess(ownerSession, { orgId, personId: zoya });
      const gone = "Zoya is no longer a co-owner here, so this needs asking again.";
      assert.deepInclude((yield* now).at(-1), {
        state: "stale",
        reason: gone,
        closed: 1,
        said: `Closed: ${gone}`,
      });
    }).pipe(Effect.provide(layer)),
);
