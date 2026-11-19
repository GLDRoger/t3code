// @effect-diagnostics nodeBuiltinImport:off -- a fixture file's hash.
import * as NodeCrypto from "node:crypto";
// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, describe, it } from "@effect/vitest";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWidgetId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { fromConnections, poll } from "../pulse/outside.ts";
import * as ConnectionSecrets from "./ConnectionSecrets.ts";
import {
  ASK_CLOSED,
  ASKED,
  type EditCards,
  KinConnections,
  type SaveCards,
  SHARED_CONNECTIONS,
} from "./ConnectionsService.ts";
import * as Connections from "./ConnectionsService.ts";
import { guarded } from "./EgressGuard.ts";
import { type FakeMail, makeFakeMail } from "./FakeMail.ts";
import * as McpGateway from "./McpGateway.ts";

// An invented company with two mail accounts on a local fake; nothing leaves the process.
const orgId = KinOrgId.make("org");
const owner = KinPersonId.make("owner");
const coOwner = KinPersonId.make("asha");
const member = KinPersonId.make("mate");
const lead = KinAgentId.make("cos");
const stamp = "2026-11-01T00:00:00.000Z";
const NOW = Date.UTC(2026, 10, 16, 9);
const ACCOUNTS = "accounts@invented-co.example";
const HELLO = "hello@invented-co.example";
const CLIENT = "Ravi Menon <ravi@lumen.example>";
const people = (personId: KinPersonId) => [{ _tag: "person" as const, orgId, personId }];

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make("cos-thread"),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
};

type Card = Parameters<KinLevelGate["Service"]["ask"]>[1] & {
  readonly widgetId: string;
  /** Every ask's state when this card became visible, oldest first. */
  asksWhenShown?: ReadonlyArray<string>;
};
const gateFor = (cards: Array<Card>) =>
  Layer.unwrap(
    Effect.map(SqlClient.SqlClient, (sql) =>
      Layer.mock(KinLevelGate)({
        ask: (agent, input, bind) =>
          Effect.gen(function* () {
            const widgetId = `w-${cards.length + 1}`;
            const card: Card = { ...input, widgetId };
            cards.push(card);
            const widget = {
              orgId: agent.orgId,
              chatId: input.chatId,
              widgetId: KinWidgetId.make(widgetId),
              messageId: KinMessageId.make(`m-${widgetId}`),
              widgetClass: "native" as const,
              type: "choice",
              revision: 1,
              state: {},
              source: null,
              feed: null,
              awaiting: [owner],
              pinnedAt: null,
              closedAt: null,
              updatedAt: stamp,
            };
            if (bind !== undefined) yield* bind(widget);
            card.asksWhenShown = (yield* sql<{ state: string }>`SELECT state
          FROM kin_connection_asks ORDER BY rowid`).map((one) => one.state);
            return widget;
          }).pipe(Effect.orDie),
        closeReplaced: (_agent, widgetIds) =>
          Effect.sync(() => {
            for (const widgetId of widgetIds)
              cards.push({ ...cards[0]!, widgetId: `closed:${widgetId}` });
          }),
      }),
    ),
  );

const layerFor = (fake: FakeMail, cards: Array<Card>) =>
  Connections.layer.pipe(
    Layer.provide(gateFor(cards)),
    Layer.provide(ConnectionSecrets.layer),
    Layer.provide(McpGateway.layer),
    Layer.provide(
      guarded.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.succeed(
            FetchHttpClient.Fetch,
            fake.handle(() => Promise.reject(new Error("Only the fake mailbox answers here."))),
          ),
        ),
      ),
    ),
    Layer.provide(
      Layer.mock(KinIdentity)({
        owner: people(owner)[0]!,
        isAgentThread: () => true,
        isLeadThread: () => true,
        resolveAgent: () =>
          Effect.succeed({
            _tag: "agent" as const,
            orgId,
            agentId: lead,
            ownerPersonId: owner,
            threadId: ThreadId.make("cos-thread"),
          }),
      }),
    ),
    Layer.provide(Layer.succeed(KinRefreshObserver, { touch: () => Effect.void })),
    Layer.provideMerge(KinEventQueue.layer),
    Layer.provideMerge(KinPersistence.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-mail-e2e-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformCrypto.layer)),
  );

/** The owner, a co-owner and a member, the Chief of staff with a direct chat with each, a client. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${stamp})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${owner}, ${orgId}, 'owner', 'Arjun', ${stamp}, 'owner'),
      (${coOwner}, ${orgId}, 'asha', 'Asha', ${stamp}, 'co_owner'),
      (${member}, ${orgId}, 'mate', 'Meera', ${stamp}, 'member')`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${lead}, ${orgId}, 'Chief of staff', 'lead', ${owner}, ${stamp})`;
  for (const person of [owner, coOwner, member]) {
    const chatId = `cos-${person}`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES (${chatId}, ${orgId}, 'direct', ${`${person}:cos`}, 0, ${stamp})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
        role, joined_at)
      VALUES (${`${chatId}-person`}, ${orgId}, ${chatId}, 'person', ${person},
        ${person === owner ? "owner" : "member"}, ${stamp})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id,
        role, joined_at)
      VALUES (${`${chatId}-lead`}, ${orgId}, ${chatId}, 'agent', ${lead}, 'member', ${stamp})`;
  }
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id, domain)
    VALUES (${lead}, ${orgId}, 'Chief of staff', 0, 'cos-thread', '{}', '[]', 'cos-owner',
      'chief-of-staff')`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
    VALUES (${orgId}, 'clients', 'Clients', 'C', 0), (${orgId}, 'contacts', 'Contacts', 'CT', 0),
      (${orgId}, 'invoices', 'Invoices', 'INV', 0), (${orgId}, 'docs', 'Docs', 'DOC', 0)`;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
      owner_id, created_by_kind, origin_key, created_at, updated_at, party_id, fields_json,
      amount_minor, currency)
    VALUES (${orgId}, 'rec_lumen', 'clients', 'C-1', 'Lumen Studio', 'person', ${owner}, 'person',
        'c1', 0, 0, NULL, '{}', NULL, NULL),
      (${orgId}, 'rec_ravi', 'contacts', 'CT-1', 'Ravi Menon', 'person', ${owner}, 'person',
        'ct1', 0, 0, 'rec_lumen', '{"email":"Ravi@Lumen.example"}', NULL, NULL),
      (${orgId}, 'rec_inv', 'invoices', 'INV-1', 'Lumen Studio: November', 'person', ${owner},
        'person', 'inv', 0, 0, 'rec_lumen', '{}', 5900000, 'INR'),
      (${orgId}, 'rec_doc', 'docs', 'DOC-1', 'Invoice INV/26-27/001', 'person', ${owner},
        'person', 'doc', 0, 0, NULL, '{}', NULL, NULL)`;
  yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode, recipe,
      recipe_commit, entry_record_id, inputs_sha256, number, sensitive, doc_origin,
      worktree_path, branch, chat_id, audience, created_at)
    VALUES (${orgId}, 'job-1', ${lead}, 'boot', 'recipe', 'invoice', 'c0', 'rec_inv', 'in',
      'INV/26-27/001', 1, 'recipe:invoice', '/nowhere', 'kin-doc', 'cos-owner', 'owner_only', 0)`;
  const fs = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig;
  const bytes = new TextEncoder().encode("%PDF-1.4 invented invoice");
  const attachmentId = "kin-00000000-0000-4000-8000-000000000001-pdf";
  yield* fs.makeDirectory(attachmentsDir, { recursive: true });
  yield* fs.writeFile(`${attachmentsDir}/${attachmentId}.pdf`, bytes);
  const file = {
    attachmentId,
    name: "INV-26-27-001.pdf",
    mimeType: "application/pdf",
    bytes: bytes.length,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    pages: 1,
    recipe: { name: "invoice", commit: "c0" },
    inputsHash: "in",
    workerId: "job-1",
    number: "INV/26-27/001",
    draft: false,
  };
  yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body_kind, file_json,
      title, kind, summary, operations_json, actor_kind, via, worker_id, origin_key, created_at)
    VALUES (${orgId}, 'rec_doc', 1, 'file', ${JSON.stringify(file)}, 'Invoice', 'created',
      'made', '[]', 'system', 'recipe', 'job-1', 'v1', 1)`;
});

let wakes = 0;
/** One running turn of the lead: a person's message in their chat, or the pulse event queued. */
const wake = (from: { readonly person: KinPersonId } | { readonly eventId: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wakeupId = `wake-${++wakes}`;
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE org_id = ${orgId}`;
    const eventId = "person" in from ? `msg-${wakeupId}` : from.eventId;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids, audience)
      VALUES (${wakeupId}, ${orgId}, ${lead}, 'cos-thread', 'test', ${NOW}, 'running',
        ${JSON.stringify([eventId])}, 'owner_only')`;
    if (!("person" in from)) {
      yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = ${wakeupId}
        WHERE org_id = ${orgId} AND event_id = ${eventId}`;
      return;
    }
    const chatId = `cos-${from.person}`;
    const messageId = `m-${wakeupId}`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
        created_at)
      VALUES (${messageId}, ${orgId}, ${chatId}, ${wakes}, 'human', ${from.person},
        ${`${chatId}-person`}, ${from.person === owner ? "owner" : "member"}, 'text',
        'Send Ravi the November invoice.', '[]', 'posted', ${stamp})`;
    const event = {
      _tag: "chat.message",
      orgId,
      agentId: lead,
      eventId,
      receivedAt: stamp,
      dedupeKey: null,
      provenance: { _tag: "human", personId: from.person, memberId: `${chatId}-person` },
      chatId,
      messageId,
    };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
        received_at, queued_at, state, wakeup_id)
      VALUES (${eventId}, ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0,
        'claimed', ${wakeupId})`;
  });

/** The owner connects an account at the (fake) vendor and marks its mail tools. */
const connect = (fake: FakeMail, service: "google" | "microsoft", address: string) =>
  Effect.gen(function* () {
    const connections = yield* KinConnections;
    const started = yield* connections.signInStart(people(owner), {
      orgId,
      service,
      returnTo: "web",
    });
    const done = yield* connections.signInFinish(people(owner), {
      orgId,
      response: fake.approve(started.authorizationUrl, address),
    });
    const pin = (tool: string) => done.tools.find((one) => one.name === tool)!.pinDigest;
    yield* connections.setToolModes(people(owner), {
      orgId,
      connectionId: done.connection.connectionId,
      modes: [
        ...["mail_list_threads", "mail_search", "mail_read_thread", "calendar_list_events"].map(
          (tool) => ({ tool, mode: "read" as const, digest: pin(tool) }),
        ),
        ...["mail_send", "mail_reply", "calendar_save_event"].map((tool) => ({
          tool,
          mode: "ask" as const,
          digest: pin(tool),
        })),
      ],
    });
    return done.connection.connectionId;
  });

const setUp = <E>(body: (fake: FakeMail, cards: Array<Card>) => Effect.Effect<void, E, Env>) =>
  Effect.gen(function* () {
    const fake = makeFakeMail();
    fake.addAccount({
      provider: "google",
      address: ACCOUNTS,
      name: "Invented Co Accounts",
      aliases: ["billing@invented-co.example"],
    });
    fake.addAccount({ provider: "microsoft", address: HELLO, name: "Invented Co" });
    const cards: Array<Card> = [];
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seed;
      const connections = yield* KinConnections;
      yield* connections.setSignInClient(people(owner), {
        orgId,
        service: "google",
        client: {
          clientId: "kin-fake.apps.googleusercontent.com",
          clientSecret: Redacted.make("fake-secret"),
        },
      });
      yield* connections.setSignInClient(people(owner), {
        orgId,
        service: "microsoft",
        client: { clientId: "00000000-0000-4000-8000-000000000000" },
      });
      yield* body(fake, cards);
    }).pipe(Effect.provide(layerFor(fake, cards)));
  });
type Env =
  | KinConnections
  | KinEventQueue.KinEventQueue
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | ServerConfig;

const callTool = (connection: string, tool: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    return yield* (yield* KinConnections).call(scope, { connection, tool, arguments: args });
  });
/** A person's tap on a card, in the tap's transaction, then the send once it committed. */
const tap = (widgetId: string, personId: KinPersonId, confirmed = true) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const connections = yield* KinConnections;
    const asked = yield* sql.withTransaction(
      connections.answerAsk({ orgId, widgetId, personId, confirmed, via: "tap", now: NOW }),
    );
    return asked?._tag === "send" ? yield* connections.sendAsk(orgId, asked.askId) : asked;
  });
/** A card as the chat stores it, so an edit checks what the person saw. */
const stored = (card: Card) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const state = {
      question: card.question,
      detail: card.detail ?? null,
      options: [
        { optionId: "option-1", label: "Confirm", kind: "yes" },
        { optionId: "option-2", label: "Cancel", kind: "no" },
      ],
      send: card.send,
      answer: null,
    };
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_agent_id, author_owner_person_id, author_thread_id, author_member_id, author_role,
        kind, body, mentions_json, status, created_at)
      VALUES (${`m-${card.widgetId}`}, ${orgId}, ${card.chatId}, ${1000 + ++wakes}, 'agent',
        ${lead}, ${owner}, 'cos-thread', ${`${card.chatId}-lead`}, 'member', 'text', '', '[]',
        'posted', ${stamp})`;
    yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
        revision, state_json, awaiting_json, updated_at)
      VALUES (${card.widgetId}, ${orgId}, ${card.chatId}, ${`m-${card.widgetId}`}, 'native',
        'choice', 1, ${JSON.stringify(state)}, ${JSON.stringify([owner])},
        '2026-11-16T09:00:00.000Z')`;
  });
/**
 * The chat side of an edit as the transport binds it: the new card shows, and the person's
 * Confirm on it is an ordinary tap. Each tap's answer is kept, to send once the edit commits.
 */
const editCards = (cards: Array<Card>, taps: Array<{ widgetId: string; askId?: string }>) =>
  Effect.map(
    Effect.all([KinConnections, SqlClient.SqlClient]),
    ([connections, sql]): EditCards => ({
      close: (widgetId) =>
        Effect.sync(() => cards.push({ ...cards[0]!, widgetId: `closed:${widgetId}` })),
      post: (_agent, card) =>
        Effect.sync(() => {
          const widgetId = `w-${cards.length + 1}`;
          cards.push({ ...card, options: [], widgetId });
          return {
            orgId,
            chatId: card.chatId,
            widgetId: KinWidgetId.make(widgetId),
            messageId: KinMessageId.make(`m-${widgetId}`),
            widgetClass: "native" as const,
            type: "choice",
            revision: 1,
            state: {
              question: card.question,
              detail: card.detail,
              options: [
                { optionId: "option-1", label: "Confirm", kind: "yes" },
                { optionId: "option-2", label: "Cancel", kind: "no" },
              ],
              send: card.send,
              answer: null,
            },
            source: null,
            feed: null,
            awaiting: [owner],
            pinnedAt: null,
            closedAt: null,
            updatedAt: stamp,
          };
        }),
      // The chat's own membership and reading checks; its tests cover them.
      canTap: () => Effect.void,
      act: (person, input) =>
        connections
          .answerAsk({
            orgId,
            widgetId: input.widgetId,
            personId: person.personId,
            confirmed: input.value === "option-1",
            via: "tap",
            now: NOW,
          })
          .pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.tap((asked) =>
              Effect.sync(() =>
                taps.push({
                  widgetId: input.widgetId,
                  ...(asked?._tag === "send" ? { askId: asked.askId } : {}),
                }),
              ),
            ),
          ),
    }),
  );
/** The person's own words on a card, sent in one step, then the send once it committed. */
const sendEdited = (
  cards: Array<Card>,
  card: Card,
  personId: KinPersonId,
  edit: { to: ReadonlyArray<string>; cc?: ReadonlyArray<string>; subject?: string; body?: string },
  press = "press-1",
  revision = 1,
) =>
  Effect.gen(function* () {
    const connections = yield* KinConnections;
    const taps: Array<{ widgetId: string; askId?: string }> = [];
    const done = yield* connections.sendEdited(
      people(personId),
      {
        orgId,
        widgetId: card.widgetId,
        revision,
        clientActionId: press,
        to: edit.to,
        cc: edit.cc ?? card.send?.cc ?? [],
        subject: edit.subject ?? card.send?.subject ?? "",
        body: edit.body ?? card.send?.body ?? "",
      },
      yield* editCards(cards, taps),
    );
    const outcomes = yield* Effect.forEach(
      taps.flatMap((one) => (one.askId === undefined ? [] : [one.askId])),
      (askId) => connections.sendAsk(orgId, askId),
    );
    return { ...done, taps, outcomes };
  });
/** The chat side of a saved edit: the stored card is redrawn in place, one revision on. */
const saveCards = Effect.map(SqlClient.SqlClient, (sql): SaveCards => ({
  canTap: () => Effect.void,
  rewrite: (card) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ state: string }>`SELECT state_json AS state FROM kin_widgets
          WHERE widget_id = ${card.widgetId} AND revision = ${card.revision}`.pipe(Effect.orDie);
      if (row === undefined)
        return yield* new KinChatError({ reason: "widget_changed", message: "Changed." });
      const state = { ...JSON.parse(row.state), detail: card.detail, send: card.send };
      yield* sql`UPDATE kin_widgets SET state_json = ${JSON.stringify(state)},
            revision = revision + 1
          WHERE widget_id = ${card.widgetId}`.pipe(Effect.orDie);
      return { revision: card.revision + 1 };
    }),
}));
/** A person's words kept on a card without sending; `null` puts the agent's draft back. */
const saveEdited = (
  card: Card,
  personId: KinPersonId,
  revision: number,
  edit: { to: ReadonlyArray<string>; subject: string; body: string } | null,
) =>
  Effect.gen(function* () {
    return yield* (yield* KinConnections).saveEdited(
      people(personId),
      {
        orgId,
        widgetId: card.widgetId,
        revision,
        edit: edit === null ? null : { cc: [], ...edit },
      },
      yield* saveCards,
    );
  });
const outside = Effect.gen(function* () {
  return fromConnections(yield* KinConnections, yield* SqlClient.SqlClient);
});

describe("Kin mail end to end, on a fake mailbox", () => {
  it.effect("wakes on client mail once, replies in its own account and thread, once", () =>
    setUp((fake, cards) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* connect(fake, "google", ACCOUNTS);
        yield* connect(fake, "microsoft", HELLO);
        // Mail that arrives after the accounts were connected is what the poller looks at.
        yield* TestClock.adjust("2 minutes");
        const inbound = fake.deliver({
          to: HELLO,
          from: CLIENT,
          subject: "Launch date",
          body: "Can we move the launch to Friday?\nRavi",
          at: NOW + 60_000,
        });
        fake.deliver({
          to: ACCOUNTS,
          from: "News <news@shop.example>",
          subject: "Weekend sale",
          body: "Everything half off.",
          at: NOW + 90_000,
        });

        const source = yield* outside;
        assert.lengthOf(yield* poll(orgId, NOW + 120_000, source), 1);
        yield* TestClock.adjust("3 minutes");
        assert.lengthOf(yield* poll(orgId, NOW + 300_000, source), 0);
        const events = yield* sql<{ eventId: string; agentId: string; json: string }>`SELECT
            event_id AS "eventId", agent_id AS "agentId", json FROM kin_events
          WHERE org_id = ${orgId} AND tag = 'pulse'`;
        assert.lengthOf(events, 1);
        assert.strictEqual(events[0]!.agentId, lead);
        const [line] = JSON.parse(events[0]!.json).outside;
        assert.deepInclude(line, {
          source: "mail",
          account: HELLO,
          to: HELLO,
          who: CLIENT,
          subject: "Launch date",
          matched: "contact CT-1 Ravi Menon of client C-1 Lumen Studio",
        });
        assert.deepStrictEqual(
          yield* sql`SELECT party_id AS "partyId", kind, note FROM kin_client_touches`,
          [{ partyId: "rec_lumen", kind: "email", note: "Launch date" }],
        );

        // Woken by it, the agent names the other account: the reply still goes from the thread's.
        yield* wake({ eventId: events[0]!.eventId });
        const asked = yield* callTool(ACCOUNTS, "mail_reply", {
          threadId: inbound.threadId,
          body: "Friday works. I'll confirm the time tomorrow.",
        });
        assert.strictEqual(asked.note, ASKED);
        const card = cards.at(-1)!;
        assert.strictEqual(card.question, "Send this reply from Outlook?");
        assert.strictEqual(card.chatId, "cos-owner");
        assert.deepStrictEqual(
          [card.send?.account, card.send?.from, card.send?.to, card.send?.subject],
          [HELLO, HELLO, ["ravi@lumen.example"], "Re: Launch date"],
        );
        assert.deepInclude(card.send?.thread, { subject: "Launch date", replyingTo: CLIENT });
        assert.lengthOf(fake.sent(), 0);

        // A corrected reply on the same thread to the same person replaces the first card (H05).
        yield* callTool(ACCOUNTS, "mail_reply", {
          threadId: inbound.threadId,
          body: "Friday works. I'll confirm 11:00 tomorrow.",
        });
        const corrected = cards.at(-2)!;
        // The first card is replaced by the time the correction shows, so no tap lands between.
        assert.deepStrictEqual(corrected.asksWhenShown?.slice(-2), ["stale", "open"]);
        assert.strictEqual(cards.at(-1)!.widgetId, `closed:${card.widgetId}`);
        assert.include(yield* tap(card.widgetId, owner).pipe(Effect.flip), {
          reason: "widget_changed",
        });
        assert.lengthOf(fake.sent(), 0);
        assert.deepStrictEqual(yield* tap(corrected.widgetId, owner), {
          state: "sent",
          reason: null,
        });
        const again = yield* tap(corrected.widgetId, owner).pipe(Effect.flip);
        assert.strictEqual(again.reason, "widget_changed");
        const sent = fake.sent();
        assert.lengthOf(sent, 1);
        assert.deepInclude(sent[0], {
          account: HELLO,
          threadId: inbound.threadId,
          inReplyTo: inbound.messageId,
          subject: "Re: Launch date",
          to: ["ravi@lumen.example"],
        });
        assert.include(sent[0]!.body, "11:00");
      }),
    ),
  );

  it.effect(
    "sends an invoice from the account chosen, and lets the agent choose with what it reads",
    () =>
      setUp((fake, cards) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const connections = yield* KinConnections;
          yield* connect(fake, "google", ACCOUNTS);
          yield* connect(fake, "microsoft", HELLO);
          fake.deliver({
            to: ACCOUNTS,
            from: CLIENT,
            subject: "Billing contact",
            body: "Please send invoices here.",
            at: NOW - 86_400_000,
          });
          yield* wake({ person: owner });

          // What the agent decides with: each account, its From addresses and one note for several.
          const listing = yield* connections.tools(scope, {});
          assert.sameDeepMembers(
            (listing.connections ?? []).map((one) => [one.account, one.sendsAs]),
            [
              [ACCOUNTS, [ACCOUNTS, "billing@invented-co.example"]],
              [HELLO, [HELLO]],
            ],
          );
          assert.include(listing.note ?? "", "Connection mail on a mail search");
          const found = yield* callTool("mail", "mail_search", {
            query: "from:ravi@lumen.example",
          });
          assert.include(found.quoted ?? "", String.raw`\"account\":\"${ACCOUNTS}\"`);
          assert.include(found.quoted ?? "", "Billing contact");

          yield* callTool(ACCOUNTS, "mail_send", {
            to: ["ravi@lumen.example"],
            subject: "Invoice INV/26-27/001",
            body: "Hi Ravi,\n\nThe November invoice is attached.\n\nArjun",
            attachments: ["INV-1"],
          });
          const card = cards.at(-1)!;
          // Drafted after the search, which read both accounts: either may be named.
          assert.oneOf(card.question, [
            `Send this email from Gmail? Drafted after reading text from ${ACCOUNTS}, so check it before you confirm.`,
            `Send this email from Gmail? Drafted after reading text from ${HELLO}, so check it before you confirm.`,
          ]);
          assert.deepStrictEqual(
            [card.send?.account, card.send?.from, card.send?.to, card.send?.subject],
            [ACCOUNTS, ACCOUNTS, ["ravi@lumen.example"], "Invoice INV/26-27/001"],
          );
          assert.strictEqual(card.send?.attachments[0]?.name, "INV-26-27-001.pdf");
          assert.deepStrictEqual(yield* tap(card.widgetId, owner), { state: "sent", reason: null });
          assert.deepInclude(fake.sent()[0], {
            account: ACCOUNTS,
            to: ["ravi@lumen.example"],
            attachments: ["INV-26-27-001.pdf"],
          });
          assert.deepStrictEqual(
            yield* sql`SELECT state FROM kin_connection_asks WHERE entry_record_id = 'rec_inv'`,
            [{ state: "sent" }],
          );

          // Every account sends on a Confirm, and what went out reads back: who, which account,
          // which thread, which document, with the file as the mailbox holds it.
          const gmailSent = fake.sent()[0]!;
          const after = yield* connections.tools(scope, {});
          for (const one of after.connections ?? [])
            assert.includeMembers([...(one.withConfirm ?? [])], ["mail_send", "mail_reply"]);
          assert.deepInclude(after.recentlySent?.[0], {
            account: ACCOUNTS,
            from: ACCOUNTS,
            to: ["ravi@lumen.example"],
            threadId: gmailSent.threadId,
            reply: false,
            documents: ["Invoice INV/26-27/001 (INV-26-27-001.pdf)"],
          });
          const gmailThread = yield* callTool(ACCOUNTS, "mail_read_thread", {
            threadId: gmailSent.threadId,
          });
          assert.include(gmailThread.quoted ?? "", "INV-26-27-001.pdf");
          assert.include(gmailThread.quoted ?? "", "application/pdf");

          // From Outlook too, and its reminder later replies in that same thread.
          yield* callTool(HELLO, "mail_send", {
            to: ["ravi@lumen.example"],
            subject: "Invoice INV/26-27/001",
            body: "Hi Ravi,\n\nThe invoice again, from our other address.\n\nArjun",
            attachments: ["INV-1"],
          });
          assert.deepStrictEqual(yield* tap(cards.at(-1)!.widgetId, owner), {
            state: "sent",
            reason: null,
          });
          const outlookSent = fake.sent()[1]!;
          assert.deepInclude(outlookSent, { account: HELLO, attachments: ["INV-26-27-001.pdf"] });
          const outlookThread = yield* callTool(HELLO, "mail_read_thread", {
            threadId: outlookSent.threadId,
          });
          assert.include(outlookThread.quoted ?? "", "INV-26-27-001.pdf");
          const searched = yield* callTool(HELLO, "mail_search", { query: "INV/26-27/001" });
          assert.include(searched.quoted ?? "", outlookSent.threadId);
          const latest = (yield* connections.tools(scope, {})).recentlySent?.[0];
          assert.deepInclude(latest, { account: HELLO, threadId: outlookSent.threadId });
          yield* callTool(HELLO, "mail_reply", {
            threadId: latest!.threadId,
            body: "A gentle reminder that this invoice is now due.",
          });
          assert.deepStrictEqual(yield* tap(cards.at(-1)!.widgetId, owner), {
            state: "sent",
            reason: null,
          });
          assert.deepInclude(fake.sent()[2], { account: HELLO, threadId: outlookSent.threadId });
        }),
      ),
  );

  it.effect("a co-owner confirms in her own chat; a member can't", () =>
    setUp((fake, cards) =>
      Effect.gen(function* () {
        yield* connect(fake, "google", ACCOUNTS);
        yield* wake({ person: coOwner });
        yield* callTool(ACCOUNTS, "mail_send", {
          to: ["ravi@lumen.example"],
          subject: "Kickoff notes",
          body: "Notes attached below.",
        });
        const card = cards.at(-1)!;
        assert.strictEqual(card.chatId, `cos-${coOwner}`);
        const refused = yield* tap(card.widgetId, member).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "not_allowed");
        assert.lengthOf(fake.sent(), 0);
        assert.deepStrictEqual(yield* tap(card.widgetId, coOwner), { state: "sent", reason: null });
        assert.lengthOf(fake.sent(), 1);

        yield* wake({ person: member });
        const shared = yield* callTool(ACCOUNTS, "mail_send", {
          to: ["ravi@lumen.example"],
          subject: "Hi",
          body: "x",
        }).pipe(Effect.flip);
        assert.strictEqual(shared.message, SHARED_CONNECTIONS);
      }),
    ),
  );

  it.effect("a person's edit on a mail card sends exactly the edited mail, once", () =>
    setUp((fake, cards) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* connect(fake, "google", ACCOUNTS);
        yield* wake({ person: owner });
        const draft = {
          to: ["ravi@lumen.example"],
          subject: "Kickoff",
          body: "Hi Ravi,\nSee you Monday.\nArjun",
        };
        yield* callTool(ACCOUNTS, "mail_send", draft);
        const card = cards.at(-1)!;
        yield* stored(card);
        const asks = sql<{ state: string; decidedBy: string | null; payload: string }>`SELECT
            state, decided_by AS "decidedBy", payload_json AS payload
          FROM kin_connection_asks ORDER BY rowid`;

        // Only someone who may Confirm the card may send it edited.
        const notYours = yield* sendEdited(cards, card, member, { to: draft.to }).pipe(Effect.flip);
        assert.strictEqual(notYours.reason, "not_allowed");
        // The server checks the edit as it checked the draft; the card stays open.
        const bad = yield* sendEdited(cards, card, owner, { to: ["ravi at lumen"] }).pipe(
          Effect.flip,
        );
        assert.deepInclude(bad, {
          reason: "invalid_state",
          message: "ravi at lumen in To isn't a plain address such as ana@example.com.",
        });
        assert.deepStrictEqual(
          (yield* asks).map((one) => one.state),
          ["open"],
        );

        // Two devices send different edits at once: one wins, the other was answered.
        const edited = {
          to: ["ravi@lumen.example", "dev@lumen.example"],
          cc: ["meera@invented-co.example"],
          body: "Hi Ravi and Dev,\nSee you Monday at 10.\nArjun",
        };
        const [first, second] = yield* Effect.all(
          [
            sendEdited(cards, card, owner, edited).pipe(Effect.result),
            sendEdited(cards, card, owner, { to: draft.to, body: "Other words." }, "press-2").pipe(
              Effect.result,
            ),
          ],
          { concurrency: 2 },
        );
        const won = first._tag === "Success" ? first.success : undefined;
        assert.isDefined(won);
        assert.deepInclude(second._tag === "Failure" ? second.failure : {}, {
          reason: "widget_changed",
          message: "This was already answered.",
        });
        assert.deepStrictEqual(won!.outcomes, [{ state: "sent", reason: null }]);
        assert.strictEqual(won!.taps[0]!.widgetId, won!.widgetId);
        assert.strictEqual(cards.at(-1)!.widgetId, won!.widgetId);
        assert.isTrue(cards.some((one) => one.widgetId === `closed:${card.widgetId}`));
        const sent = fake.sent();
        assert.lengthOf(sent, 1);
        assert.deepInclude(sent[0], {
          to: edited.to,
          cc: edited.cc,
          subject: draft.subject,
          body: edited.body,
        });
        const [replaced, went] = yield* asks;
        assert.deepInclude(replaced, { state: "stale", decidedBy: owner });
        assert.deepInclude(went, { state: "sent", decidedBy: owner });
        assert.strictEqual(JSON.parse(went!.payload).body, edited.body);

        // A retry of the press that went answers as it did and sends nothing more.
        const retried = yield* sendEdited(cards, card, owner, edited);
        assert.strictEqual(retried.widgetId, won!.widgetId);
        assert.lengthOf(fake.sent(), 1);
        // The agent's repeat of its own draft is told what became of it, and draws no card.
        const shown = cards.length;
        const repeat = yield* callTool(ACCOUNTS, "mail_send", draft);
        assert.strictEqual(repeat.note, ASK_CLOSED.edited("Arjun"));
        assert.include(repeat.quoted ?? "", "See you Monday at 10.");
        assert.include(repeat.quoted ?? "", "dev@lumen.example");
        assert.lengthOf(cards, shown);
        assert.lengthOf(fake.sent(), 1);
      }),
    ),
  );

  it.effect("a saved edit is what the card shows and what its Confirm sends", () =>
    setUp((fake, cards) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const accounts = yield* connect(fake, "google", ACCOUNTS);
        yield* wake({ person: owner });
        const draft = {
          to: ["ravi@lumen.example"],
          subject: "Kickoff",
          body: "Hi Ravi,\nSee you Monday.\nArjun",
        };
        yield* callTool(ACCOUNTS, "mail_send", draft);
        const card = cards.at(-1)!;
        yield* stored(card);
        const shownOf = (widgetId: string) =>
          sql<{ revision: number; state: string }>`SELECT revision,
            state_json AS state FROM kin_widgets WHERE widget_id = ${widgetId}`.pipe(
            Effect.map(([row]) => ({ revision: row!.revision, send: JSON.parse(row!.state).send })),
          );
        const shown = shownOf(card.widgetId);
        const drafted = sql<{ payload: string }>`SELECT payload_json AS payload
          FROM kin_connection_asks WHERE widget_id = ${card.widgetId}`.pipe(
          Effect.map(([row]) => JSON.parse(row!.payload).body),
        );
        const mine = { ...draft, body: "Hi Ravi,\nSee you Monday at 10.\nArjun" };

        // Only someone who may Confirm the card may keep words on it.
        const notYours = yield* saveEdited(card, member, 1, mine).pipe(Effect.flip);
        assert.strictEqual(notYours.reason, "not_allowed");
        const bad = yield* saveEdited(card, owner, 1, { ...mine, to: ["ravi at lumen"] }).pipe(
          Effect.flip,
        );
        assert.strictEqual(bad.reason, "invalid_state");
        assert.strictEqual((yield* shown).revision, 1);

        // Saved, the card shows the person's words as theirs; the agent's draft is kept.
        assert.deepStrictEqual(yield* saveEdited(card, owner, 1, mine), { revision: 2 });
        assert.deepInclude((yield* shown).send, {
          body: mine.body,
          edited: { personId: owner, name: "Arjun" },
        });
        assert.strictEqual(yield* drafted, draft.body);
        // A save bound to a card that changed since is refused, and changes nothing.
        const late = yield* saveEdited(card, owner, 1, draft).pipe(Effect.flip);
        assert.strictEqual(late.reason, "widget_changed");
        // Discard edits puts the agent's draft back, unmarked.
        assert.deepStrictEqual(yield* saveEdited(card, owner, 2, null), { revision: 3 });
        const back = (yield* shown).send;
        assert.strictEqual(back.body, draft.body);
        assert.notProperty(back, "edited");

        // Confirm sends what the card showed, and the stored ask now holds exactly that.
        yield* saveEdited(card, owner, 3, mine);
        assert.deepStrictEqual(yield* tap(card.widgetId, owner), { state: "sent", reason: null });
        assert.lengthOf(fake.sent(), 1);
        assert.deepInclude(fake.sent()[0], { to: draft.to, body: mine.body });
        assert.strictEqual(yield* drafted, mine.body);
        // The agent's repeat of its own draft is told the person's words went, quoted.
        const repeat = yield* callTool(ACCOUNTS, "mail_send", draft);
        assert.strictEqual(repeat.note, ASK_CLOSED.edited("Arjun"));
        assert.include(repeat.quoted ?? "", "See you Monday at 10.");

        // Sending the agent's own words over a saved edit sends those words, not the saved ones.
        yield* callTool(ACCOUNTS, "mail_send", { ...draft, subject: "Kickoff, again" });
        const again = cards.at(-1)!;
        yield* stored(again);
        yield* saveEdited(again, owner, 1, { ...mine, subject: "Kickoff, again" });
        // Another From keeps the saved words on the card.
        const { rewrite } = yield* saveCards;
        yield* (yield* KinConnections).setSendFrom(
          people(owner),
          {
            orgId,
            widgetId: again.widgetId,
            revision: 2,
            choice: `${accounts} billing@invented-co.example`,
          },
          rewrite,
        );
        assert.deepInclude((yield* shownOf(again.widgetId)).send, {
          from: "billing@invented-co.example",
          body: mine.body,
          edited: { personId: owner, name: "Arjun" },
        });
        const theirs = { ...draft, subject: "Kickoff, again" };
        const typedBack = yield* sendEdited(cards, again, owner, theirs, "press-3", 3);
        assert.deepStrictEqual(typedBack.outcomes, [{ state: "sent", reason: null }]);
        assert.deepInclude(fake.sent()[1], { subject: "Kickoff, again", body: draft.body });
      }),
    ),
  );

  it.effect(
    "an edit keeps the outside mark, sends unchanged as a Confirm, and a moved sign-in or a chat read below owner level refuses it",
    () =>
      setUp((fake, cards) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* connect(fake, "google", ACCOUNTS);
          yield* wake({ person: owner });
          yield* callTool("mail", "mail_search", { query: "from:ravi@lumen.example" });
          const draft = { to: ["ravi@lumen.example"], subject: "Notes", body: "Notes below." };
          yield* callTool(ACCOUNTS, "mail_send", draft);
          const plain = cards.at(-1)!;
          yield* stored(plain);
          // An edit that changes nothing is the ordinary Confirm on the card itself.
          const same = yield* sendEdited(cards, plain, owner, draft);
          assert.strictEqual(same.widgetId, plain.widgetId);
          assert.deepStrictEqual(same.outcomes, [{ state: "sent", reason: null }]);
          assert.lengthOf(fake.sent(), 1);

          yield* callTool(ACCOUNTS, "mail_send", { ...draft, subject: "Notes, again" });
          const card = cards.at(-1)!;
          assert.include(card.question, "Drafted after reading");
          yield* stored(card);
          yield* sql`UPDATE kin_connections SET sign_in_gen = sign_in_gen + 1`;
          const moved = yield* sendEdited(cards, card, owner, {
            to: draft.to,
            body: "Notes below, edited.",
          });
          const shown = cards.at(-1)!;
          assert.strictEqual(shown.widgetId, moved.widgetId);
          assert.strictEqual(shown.question, card.question);
          assert.strictEqual(shown.send?.body, "Notes below, edited.");
          // Refused at its Confirm as any card whose account moved is, with nothing sent.
          assert.deepStrictEqual(moved.taps, [{ widgetId: moved.widgetId }]);
          assert.lengthOf(fake.sent(), 1);
          const [went] = yield* sql<{ state: string; reason: string; outside: string | null }>`
            SELECT state, reason, outside_from AS outside FROM kin_connection_asks
            WHERE widget_id = ${moved.widgetId}`;
          assert.strictEqual(went?.state, "stale");
          assert.include(went?.reason ?? "", "since this card was made, so nothing was sent.");
          assert.isNotNull(went?.outside);

          // A co-owner reads the chat when the card is drawn, and is a member by the edit: the
          // edit would show the new words to her and could never record its outcome.
          yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
              person_id, role, joined_at)
            VALUES ('cos-owner-asha', ${orgId}, 'cos-owner', 'person', ${coOwner}, 'member',
              ${stamp})`;
          yield* callTool(ACCOUNTS, "mail_send", { ...draft, subject: "Notes, third" });
          const group = cards.at(-1)!;
          yield* stored(group);
          yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = ${coOwner}`;
          const before = yield* sql<{ state: string; payload: string }>`SELECT state,
              payload_json AS payload
            FROM kin_connection_asks WHERE widget_id = ${group.widgetId}`;
          const drawn = cards.length;
          const demoted = yield* sendEdited(cards, group, owner, {
            to: draft.to,
            body: "Notes for the team.",
          }).pipe(Effect.flip);
          assert.deepInclude(demoted, {
            reason: "not_allowed",
            message:
              "This chat now includes someone who can't confirm mail, so nothing was sent. Ask for a new draft in your own chat.",
          });
          assert.lengthOf(cards, drawn);
          assert.deepStrictEqual(
            yield* sql`SELECT state, payload_json AS payload FROM kin_connection_asks
              WHERE widget_id = ${group.widgetId}`,
            before,
          );
          assert.lengthOf(
            yield* sql`SELECT 1 FROM kin_connection_asks WHERE payload_json LIKE '%for the team%'`,
            0,
          );
          assert.lengthOf(fake.sent(), 1);
        }),
      ),
  );

  it.effect("a deleted Outlook meeting is in the next read of what changed", () =>
    setUp((fake) =>
      Effect.gen(function* () {
        const connections = yield* KinConnections;
        const hello = yield* connect(fake, "microsoft", HELLO);
        const lunch = {
          account: HELLO,
          id: "ev-lunch",
          title: "Client lunch",
          start: NOW + 86_400_000,
          end: NOW + 90_000_000,
          updated: NOW,
        };
        fake.putEvent(lunch);
        const first = yield* connections.activity(orgId, hello);
        if (first._tag !== "mail") return assert.fail("not a mail account");
        assert.deepStrictEqual(
          first.calendar.map((one) => one.summary),
          ["Client lunch"],
        );
        // Graph names a deletion only in a later round of the same feed, so the read keeps its place.
        yield* connections.activitySeen(orgId, hello, first.until, first.cursor);
        fake.putEvent({ ...lunch, state: "deleted", updated: NOW + 1 });
        const next = yield* connections.activity(orgId, hello);
        if (next._tag !== "mail") return assert.fail("not a mail account");
        assert.deepStrictEqual(
          next.calendar.map((one) => [one.eventId, one.status]),
          [["ev-lunch", "cancelled"]],
        );
      }),
    ),
  );

  it.effect("a removed Outlook account's owed card still names Outlook", () =>
    setUp((fake, cards) =>
      Effect.gen(function* () {
        const connections = yield* KinConnections;
        const hello = yield* connect(fake, "microsoft", HELLO);
        const inbound = fake.deliver({
          to: HELLO,
          from: CLIENT,
          subject: "Invoice question",
          body: "Is GST included?",
          at: NOW - 60_000,
        });
        yield* wake({ person: owner });
        yield* callTool(HELLO, "mail_reply", { threadId: inbound.threadId, body: "Yes." });
        fake.setDown(HELLO, true);
        const broke = yield* tap(cards.at(-1)!.widgetId, owner);
        assert.strictEqual(broke !== undefined && "state" in broke && broke.state, "failed");
        yield* connections.remove(people(owner), { orgId, connectionId: hello });
        const later = (yield* Clock.currentTimeMillis) + 1;
        const [owed] = yield* connections.interruptedSends(orgId, later);
        if (owed?.fresh === undefined) return assert.fail("the failed mail is on no card");
        assert.strictEqual(owed.fresh.label, HELLO);
        const fresh = yield* connections.freshAsk(orgId, owed.fresh, NOW);
        assert.strictEqual(fresh?.card.question, "Send this reply from Outlook?");
      }),
    ),
  );

  it.effect("an expired account says so on the card, loses nothing, and sends after sign-in", () =>
    setUp((fake, cards) =>
      Effect.gen(function* () {
        const connections = yield* KinConnections;
        yield* connect(fake, "google", ACCOUNTS);
        const hello = yield* connect(fake, "microsoft", HELLO);
        const inbound = fake.deliver({
          to: HELLO,
          from: CLIENT,
          subject: "Invoice question",
          body: "Is GST included?",
          at: NOW - 60_000,
        });
        yield* wake({ person: owner });
        const reply = (body: string) =>
          callTool(HELLO, "mail_reply", { threadId: inbound.threadId, body }).pipe(
            Effect.map(() => cards.at(-1)!),
          );
        const signInAgain = Effect.gen(function* () {
          fake.setExpired(HELLO, false);
          const started = yield* connections.signInStart(people(owner), {
            orgId,
            connectionId: hello,
            returnTo: "web",
          });
          yield* connections.signInFinish(people(owner), {
            orgId,
            response: fake.approve(started.authorizationUrl, HELLO),
          });
        });

        // Found out before the tap: Confirm says so and the card stays open.
        const first = yield* reply("Yes, it is.");
        fake.setExpired(HELLO, true);
        yield* TestClock.adjust("2 hours");
        yield* poll(orgId, NOW, yield* outside);
        const held = yield* tap(first.widgetId, owner).pipe(Effect.flip);
        assert.include(held.message, `${HELLO} needs signing in again`);
        assert.include(held.message, "Nothing was sent");
        yield* signInAgain;
        assert.deepStrictEqual(yield* tap(first.widgetId, owner), { state: "sent", reason: null });

        // Found out while sending: not sent, and the same mail comes back on a fresh card.
        const second = yield* reply("Yes, GST is included.");
        fake.setExpired(HELLO, true);
        yield* TestClock.adjust("2 hours");
        const failed = yield* tap(second.widgetId, owner);
        if (failed === undefined || !("state" in failed) || failed.fresh === undefined)
          return assert.fail("no fresh card");
        assert.strictEqual(failed.state, "failed");
        assert.include(failed.reason ?? "", "needs signing in again");
        assert.lengthOf(fake.sent(), 1);
        yield* signInAgain;
        const fresh = yield* connections.freshAsk(orgId, failed.fresh, NOW);
        if (fresh === undefined) return assert.fail("no fresh card");
        assert.strictEqual(fresh.card.send.account, HELLO);
        yield* fresh.bind("w-fresh");
        assert.deepStrictEqual(yield* tap("w-fresh", owner), { state: "sent", reason: null });
        assert.lengthOf(fake.sent(), 2);
        assert.strictEqual(fake.sent()[1]!.threadId, inbound.threadId);

        // A 503 once the send left may have gone: never resent, and the mail comes back to check.
        const third = yield* reply("Yes, and the PDF is attached.");
        fake.setDown(HELLO, true);
        const broke = yield* tap(third.widgetId, owner);
        if (broke === undefined || !("state" in broke) || broke.fresh === undefined)
          return assert.fail("no fresh card after a failed send");
        assert.strictEqual(broke.state, "failed");
        assert.include(broke.reason ?? "", "This may or may not have gone.");
        assert.include(broke.reason ?? "", "the same mail below");
        assert.lengthOf(fake.sent(), 2);
        fake.setDown(HELLO, false);
        // Kin restarts before that card posts: at start the mail still comes back.
        const later = (yield* Clock.currentTimeMillis) + 1;
        const [owed] = yield* connections.interruptedSends(orgId, later);
        if (owed?.fresh === undefined) return assert.fail("the failed mail is on no card");
        assert.deepInclude(owed, { widgetId: third.widgetId, state: "failed" });
        const retry = yield* connections.freshAsk(orgId, owed.fresh, NOW);
        if (retry === undefined) return assert.fail("no fresh card");
        yield* retry.bind("w-retry");
        assert.lengthOf(yield* connections.interruptedSends(orgId, later), 0);
        assert.deepStrictEqual(yield* tap("w-retry", owner), { state: "sent", reason: null });
        assert.lengthOf(fake.sent(), 3);

        // Kin restarts between the Confirm and the send: at start the card fails, the mail is back.
        const fourth = yield* reply("Yes. Thanks for checking.");
        const sql = yield* SqlClient.SqlClient;
        const confirmed = yield* sql.withTransaction(
          connections.answerAsk({
            orgId,
            widgetId: fourth.widgetId,
            personId: owner,
            confirmed: true,
            via: "tap",
            now: NOW,
          }),
        );
        assert.strictEqual(confirmed?._tag, "send");
        const [cut] = yield* connections.interruptedSends(orgId, NOW + 1);
        if (cut?.fresh === undefined) return assert.fail("no fresh card after a restart");
        assert.deepInclude(cut, { widgetId: fourth.widgetId, state: "failed" });
        // The send was never claimed, so it is known not to have gone.
        assert.include(cut.reason ?? "", "Kin restarted before sending this, so nothing was sent.");
        assert.lengthOf(yield* connections.interruptedSends(orgId, NOW + 1), 0);
        const resumed = yield* connections.freshAsk(orgId, cut.fresh, NOW);
        if (resumed === undefined) return assert.fail("no fresh card");
        yield* resumed.bind("w-resumed");
        assert.deepStrictEqual(yield* tap("w-resumed", owner), { state: "sent", reason: null });
        assert.lengthOf(fake.sent(), 4);

        // The agent corrects itself while the first is sending, and that send fails: the
        // correction stands, and the outdated mail does not come back beside it.
        const draft = yield* reply("Yes, the total is 59,000.");
        const sending = yield* sql.withTransaction(
          connections.answerAsk({
            orgId,
            widgetId: draft.widgetId,
            personId: owner,
            confirmed: true,
            via: "tap",
            now: NOW,
          }),
        );
        if (sending?._tag !== "send") return assert.fail("not sending");
        const correction = yield* reply("Yes, the total is 59,000 including GST.");
        fake.setDown(HELLO, true);
        const lost = yield* connections.sendAsk(orgId, sending.askId);
        fake.setDown(HELLO, false);
        assert.strictEqual(lost.state, "failed");
        assert.isUndefined(lost.fresh);
        assert.include(lost.reason ?? "", "This may or may not have gone.");
        assert.deepStrictEqual(yield* tap(correction.widgetId, owner), {
          state: "sent",
          reason: null,
        });
        assert.lengthOf(fake.sent(), 5);
        assert.include(fake.sent()[4]!.body, "including GST");
      }),
    ),
  );
});
