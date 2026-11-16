import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  KIN_SOCIAL_PACK_CARD,
  KIN_SOCIAL_WEEK_CARD,
  KinAgentId,
  KinChatError,
  KinPersonId,
  KinSocialPackCard,
  KinSocialWeekCard,
  KinWidgetId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Chat from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinConnectionSecrets } from "../connections/ConnectionSecrets.ts";
import { fixture, orgId, seed } from "../triggers/routines.testkit.ts";
import { type FakeZernio, makeFakeZernio, memoryStore } from "./FakeZernio.ts";
import { KinSocial, layer as socialLayer } from "./SocialService.ts";

// An invented agency on a local fake Zernio: nothing leaves the process, time is the TestClock.
const NOW = Date.parse("2026-11-16T09:00:00.000Z");
const DAY = 86_400_000;
const owner = KinPersonId.make(`owner-${orgId}`);
const lead = KinAgentId.make(`lead-${orgId}`);
const person = (personId: KinPersonId) => [{ _tag: "person" as const, orgId, personId }];
const asOwner = person(owner);
const decodeWeek = Schema.decodeUnknownSync(Schema.fromJsonString(KinSocialWeekCard));
const decodePack = Schema.decodeUnknownSync(Schema.fromJsonString(KinSocialPackCard));
const isKinError = Schema.is(KinChatError);
const PICTURE = "kin-00000000-0000-4000-8000-0000000000aa-png";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make("social-thread"),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
};

let clock = NOW;
const harness = () => {
  clock = NOW;
  const fake = makeFakeZernio(memoryStore(), () => clock);
  const keys = new Map<string, Redacted.Redacted<string>>();
  const secrets = Layer.mock(KinConnectionSecrets)({
    getSocialKey: (groupId) => Effect.succeed(Option.fromNullishOr(keys.get(groupId))),
    setSocialKey: (groupId, key) => Effect.sync(() => void keys.set(groupId, key)),
    removeSocialKey: (groupId) => Effect.sync(() => void keys.delete(groupId)),
  });
  const identity = Layer.mock(KinIdentity)({
    owner: { _tag: "person", orgId, personId: owner },
    isAgentThread: () => true,
    isLeadThread: () => true,
    resolveAgent: () =>
      Effect.succeed({
        _tag: "agent" as const,
        orgId,
        agentId: lead,
        ownerPersonId: owner,
        threadId: ThreadId.make("social-thread"),
      }),
  });
  const http = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        FetchHttpClient.Fetch,
        fake.handle(() => Promise.reject(new Error("Only the fake Zernio answers here."))),
      ),
    ),
  );
  const layer = socialLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(secrets, identity, http)),
    Layer.provideMerge(fixture()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-social-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  // The clock is set before the layer starts, so its scheduler loop never replays 56 years.
  const run = <A, E>(body: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    Effect.gen(function* () {
      yield* at(NOW);
      return yield* body.pipe(Effect.provide(layer));
    });
  return { fake, run };
};

/** The time on Kin's clock and the fake service's, together. */
const at = (ms: number) =>
  Effect.gen(function* () {
    clock = ms;
    yield* TestClock.setTime(ms);
  });

/** The seeded org, its Social lead mid-turn, two clients and a picture sent in the chat. */
const setUp = Effect.gen(function* () {
  yield* seed();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_leads SET domain = 'social', thread_id = 'social-thread'
    WHERE org_id = ${orgId} AND agent_id = ${lead}`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES ('mate', ${orgId}, 'mate', 'Meera', '2026-11-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
      status, event_ids)
    VALUES ('turn-1', ${orgId}, ${lead}, 'social-thread', 'test', ${NOW}, 'running', '[]')`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
    VALUES (${orgId}, 'clients', 'Clients', 'C', 0)`;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
      owner_id, created_by_kind, origin_key, created_at, updated_at, fields_json)
    VALUES (${orgId}, 'rec_lumen', 'clients', 'C-1', 'Lumen Studio', 'person', ${owner}, 'person',
        'c1', 0, 0, '{}'),
      (${orgId}, 'rec_north', 'clients', 'C-2', 'Northwind Bakery', 'person', ${owner}, 'person',
        'c2', 0, 0, '{}')`;
  // A picture the owner sent in his chat with Social.
  const { attachmentsDir } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(attachmentsDir, { recursive: true });
  yield* fs.writeFile(`${attachmentsDir}/${PICTURE}.png`, new Uint8Array(2048).fill(7));
  const attachments = JSON.stringify([
    { type: "image", id: PICTURE, name: "launch.png", mimeType: "image/png", sizeBytes: 2048 },
  ]);
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
      author_member_id, author_role, kind, body, mentions_json, status, created_at, attachments_json)
    VALUES ('pic-msg', ${orgId}, ${`chat-${orgId}`}, 1, 'human', ${owner}, ${`owner-member-${orgId}`},
      'owner', 'text', 'for the launch', '[]', 'posted', '2026-11-16T08:00:00.000Z', ${attachments})`;
  yield* sql`UPDATE kin_chats SET last_seq = 1 WHERE chat_id = ${`chat-${orgId}`}`;
  yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
    VALUES (${PICTURE}, ${orgId}, ${`chat-${orgId}`}, 'pic-msg')`;
});

const connectGroup = (
  fake: FakeZernio,
  input: { readonly kind: "own" | "client"; readonly clientId?: string },
  profile: Parameters<FakeZernio["addProfile"]>[0],
) =>
  Effect.gen(function* () {
    const social = yield* KinSocial;
    const made = fake.addProfile(profile);
    const check = yield* social.check(asOwner, {
      orgId,
      kind: input.kind,
      clientId: input.clientId,
      key: Redacted.make(made.key),
    });
    const view = yield* social.connect(asOwner, { orgId, checkId: check.checkId });
    return { made, check, view };
  });

const OWN = {
  name: "Invented Co",
  accounts: [
    { platform: "instagram", username: "inventedco", displayName: "Invented Co" },
    { platform: "linkedin", username: "invented-co", displayName: "Invented Co" },
    { platform: "twitter", username: "inventedco", displayName: "Invented Co" },
  ],
};
const LUMEN = {
  name: "Lumen Studio",
  accounts: [{ platform: "instagram", username: "lumen.studio", displayName: "Lumen Studio" }],
};

const weekCard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ widgetId: string; revision: number; state: string }>`SELECT
      widget_id AS "widgetId", revision, state_json AS state FROM kin_widgets
    WHERE org_id = ${orgId} AND type = ${KIN_SOCIAL_WEEK_CARD} ORDER BY rowid`;
  return rows.map((row) => ({ ...row, card: decodeWeek(row.state) }));
});

const tap = (
  card: { readonly widgetId: string; readonly revision: number },
  actionId: string,
  value: unknown,
  who: KinPersonId = owner,
) =>
  Effect.gen(function* () {
    const chat = yield* Chat.KinChatService;
    return yield* chat.act(
      { _tag: "person", orgId, personId: who },
      {
        widgetId: KinWidgetId.make(card.widgetId),
        revision: card.revision,
        actionId,
        value,
        clientActionId: `${actionId}-${card.revision}`,
      },
    );
  });

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.flip,
    Effect.map((error) => (isKinError(error) ? error.message : String(error))),
  );

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

it.effect("connects groups only with a key limited to one profile, owner-level only", () => {
  const { fake, run } = harness();
  return run(
    Effect.gen(function* () {
      yield* setUp;
      const social = yield* KinSocial;
      const whole = fake.addProfile({ ...OWN, wholeWorkspace: true });
      assert.match(
        yield* failure(
          social.check(asOwner, { orgId, kind: "own", key: Redacted.make(whole.key) }),
        ),
        /whole Zernio workspace/,
      );
      assert.match(
        yield* failure(
          social.check(person(KinPersonId.make("mate")), {
            orgId,
            kind: "own",
            key: Redacted.make(whole.key),
          }),
        ),
        /owner/,
      );
      assert.match(
        yield* failure(
          social.check(asOwner, { orgId, kind: "own", key: Redacted.make("sk_wrong") }),
        ),
        /./,
      );
      const own = yield* connectGroup(fake, { kind: "own" }, OWN);
      assert.deepEqual(
        own.check.accounts.map((one) => [one.platform, one.name]),
        [
          ["instagram", "Invented Co"],
          ["linkedin", "Invented Co"],
          ["twitter", "Invented Co"],
        ],
      );
      const lumen = yield* connectGroup(fake, { kind: "client", clientId: "rec_lumen" }, LUMEN);
      assert.deepEqual(
        lumen.view.groups.map((group) => [group.kind, group.label, group.accounts.length]),
        [
          ["own", "Our own", 3],
          ["client", "Lumen Studio", 1],
        ],
      );
      assert.deepEqual(
        lumen.view.clients.map((one) => one.label),
        ["Northwind Bakery"],
      );
      // The same profile can't be a second group.
      assert.match(
        yield* failure(
          social.check(asOwner, {
            orgId,
            kind: "client",
            clientId: "rec_north",
            key: Redacted.make(lumen.made.key),
          }),
        ),
        /already connected as Lumen Studio/,
      );
      const group = lumen.view.groups.find((one) => one.kind === "client")!;
      const link = yield* social.link(asOwner, {
        orgId,
        groupId: group.groupId,
        platform: "tiktok",
      });
      assert.match(link.note, /Send this to Lumen Studio yourself/);
      assert.isTrue(link.url.startsWith("https://"));
      // A dead key shows on its row, with how to fix it.
      fake.expireKey(lumen.made.key);
      const after = yield* social.refresh(asOwner, { orgId, groupId: group.groupId });
      assert.isNotNull(after.groups.find((one) => one.groupId === group.groupId)?.problem);
    }),
  );
});

it.effect(
  "drafts, one Confirm, Undo, posting, a failure and its retry, at most once across restarts",
  () => {
    const { fake, run } = harness();
    return run(
      Effect.gen(function* () {
        yield* setUp;
        const social = yield* KinSocial;
        const sql = yield* SqlClient.SqlClient;
        const own = yield* connectGroup(fake, { kind: "own" }, OWN);
        yield* connectGroup(fake, { kind: "client", clientId: "rec_lumen" }, LUMEN);
        const [ig, li, x] = fake.accountsOf(own.made.profileId);
        const lumenIg = fake.load().accounts.find((one) => one.username === "lumen.studio")!;
        fake.addPast([
          {
            accountId: ig!.accountId,
            platform: "instagram",
            content: "Behind the scenes 🎬",
            publishedAt: iso(NOW - 3 * DAY),
            mediaType: "reel",
            likes: 120,
            comments: 14,
            saves: 30,
            shares: 9,
            reach: 2400,
          },
          {
            accountId: li!.accountId,
            platform: "linkedin",
            content: "We hired!",
            publishedAt: iso(NOW - 2 * DAY),
            mediaType: "text",
            likes: 40,
            comments: 3,
            saves: 0,
            shares: 2,
            reach: 900,
          },
        ]);

        // Social reads last week once; a second read is the cached one.
        const read = (yield* social.read(scope, { group: "our own" })) as {
          groups: ReadonlyArray<{ posts: ReadonlyArray<{ caption: string }>; cost?: string }>;
        };
        assert.equal(read.groups[0]!.posts[0]!.caption, "Behind the scenes 🎬");
        assert.match(read.groups[0]!.cost ?? "", /X/);
        yield* social.read(scope, { group: "our own" });
        assert.lengthOf(
          fake.load().calls.filter((call) => call === "GET /analytics"),
          1,
        );

        // A draft can't name another group's account, and Instagram needs a picture.
        assert.match(
          yield* failure(
            social.draft(scope, {
              group: "our own",
              account: lumenIg.accountId,
              caption: "Wrong place",
              at: iso(NOW + DAY),
            }),
          ),
          /can't go to another group's account/,
        );
        assert.match(
          yield* failure(
            social.draft(scope, {
              group: "our own",
              account: "instagram",
              caption: "No picture",
              at: iso(NOW + DAY),
            }),
          ),
          /picture|image|video/i,
        );
        const drafts = [
          { account: ig!.accountId, caption: "Launch day 🚀", media: PICTURE, day: 1 },
          { account: li!.accountId, caption: "What we learned this year", day: 2 },
          { account: x!.accountId, caption: "Ship it 🛳️", day: 3 },
          { account: ig!.accountId, caption: "Team lunch 🍜", media: PICTURE, day: 4 },
          { account: li!.accountId, caption: "Hiring a designer", day: 5 },
        ];
        const ids: Array<string> = [];
        for (const one of drafts) {
          const made = (yield* social.draft(scope, {
            group: "our own",
            account: one.account,
            caption: one.caption,
            media: one.media,
            at: iso(NOW + one.day * DAY),
          })) as { postId: string };
          ids.push(made.postId);
        }
        yield* social.draft(scope, {
          group: "Lumen Studio",
          account: "instagram",
          caption: "New lamps ✨",
          media: PICTURE,
          at: iso(NOW + DAY),
        });
        yield* social.week(scope, { group: "our own" });
        yield* social.week(scope, { group: "Lumen Studio" });
        const [ownCard, lumenCard] = yield* weekCard;
        assert.lengthOf(ownCard!.card.posts, 5);
        assert.isNull(ownCard!.card.client);
        assert.deepEqual(
          lumenCard!.card.posts.map((post) => post.account.name),
          ["Lumen Studio"],
        );
        assert.isFalse(lumenCard!.card.client?.ok);
        // Nothing reaches the service before Confirm.
        assert.lengthOf(fake.load().posts, 0);

        // Only the owner's side taps; a member's tap is refused.
        assert.match(
          yield* failure(tap(ownCard!, "remove", ids[4], KinPersonId.make("mate"))),
          /./,
        );
        yield* tap(ownCard!, "remove", ids[4]);
        let [card] = yield* weekCard;
        assert.equal(card!.card.posts.find((post) => post.postId === ids[4])?.state, "removed");
        // A Confirm signs exactly what the card shows.
        assert.match(yield* failure(tap(card!, "confirm", ownCard!.card.digest)), /changed/);
        yield* tap(card!, "confirm", card!.card.digest);
        yield* social.runDue;
        [card] = yield* weekCard;
        assert.deepEqual(
          card!.card.posts.map((post) => post.state),
          ["scheduled", "scheduled", "scheduled", "scheduled", "removed"],
        );
        assert.lengthOf(fake.load().posts, 4);
        assert.isTrue(fake.load().posts.every((post) => post.idempotencyKey !== null));
        // The removed post was never sent.
        assert.isFalse(fake.load().posts.some((post) => post.content === "Hiring a designer"));

        // A restart after the call but before Kin saved the answer doesn't post twice.
        yield* sql`UPDATE kin_social_posts SET state = 'scheduling', service_post_id = NULL
        WHERE post_id = ${ids[1]!}`;
        yield* social.runDue;
        assert.lengthOf(fake.load().posts, 4);

        // Undo before it goes out cancels it at the service.
        [card] = yield* weekCard;
        yield* tap(card!, "undo", ids[2]);
        yield* social.runDue;
        [card] = yield* weekCard;
        assert.equal(card!.card.posts.find((post) => post.postId === ids[2])?.state, "cancelled");
        assert.lengthOf(fake.load().posts, 3);

        // Three go out; one fails on the platform, says why, and Retry posts it.
        fake.failNext(li!.accountId, "LinkedIn refused the post: duplicate content.");
        yield* at(NOW + 5 * DAY);
        yield* social.runDue;
        [card] = yield* weekCard;
        const states = new Map(card!.card.posts.map((post) => [post.postId, post]));
        assert.equal(states.get(ids[0]!)?.state, "posted");
        assert.match(states.get(ids[0]!)?.url ?? "", /^https:\/\/social\.example\//);
        assert.equal(states.get(ids[3]!)?.state, "posted");
        assert.equal(states.get(ids[1]!)?.state, "failed");
        assert.match(states.get(ids[1]!)?.reason ?? "", /duplicate content/);
        yield* tap(card!, "retry", ids[1]);
        yield* social.runDue;
        [card] = yield* weekCard;
        assert.equal(card!.card.posts.find((post) => post.postId === ids[1])?.state, "posted");
        assert.lengthOf(fake.load().posts, 3);

        // The client's card: his switch for the client's OK, and nothing mixed with ours.
        const [, lumen] = yield* weekCard;
        yield* tap(lumen!, "client_ok", true);
        const [, noted] = yield* weekCard;
        assert.isTrue(noted!.card.client?.ok);
      }),
    );
  },
);

it.effect("refuses Social's tools to any other agent and confirms only safe times", () => {
  const { fake, run } = harness();
  return run(
    Effect.gen(function* () {
      yield* setUp;
      const social = yield* KinSocial;
      const sql = yield* SqlClient.SqlClient;
      yield* connectGroup(fake, { kind: "own" }, OWN);
      yield* social.draft(scope, {
        group: "our own",
        account: "linkedin",
        caption: "Soon",
        at: iso(NOW + 20 * 60_000),
      });
      yield* social.week(scope, { group: "our own" });
      // Twenty minutes later the post is too close to schedule safely: Confirm refuses it.
      yield* at(NOW + 15 * 60_000);
      const [card] = yield* weekCard;
      assert.match(yield* failure(tap(card!, "confirm", card!.card.digest)), /too soon/);
      yield* sql`UPDATE kin_leads SET domain = 'finance' WHERE agent_id = ${lead}`;
      assert.match(yield* failure(social.read(scope, {})), /remit is social media/);
    }),
  );
});

it.effect("makes a ready-to-post pack with nothing connected", () => {
  const { run } = harness();
  return run(
    Effect.gen(function* () {
      yield* setUp;
      const social = yield* KinSocial;
      const sql = yield* SqlClient.SqlClient;
      const read = (yield* social.read(scope, {})) as { notConnected?: string };
      assert.match(read.notConnected ?? "", /social_pack/);
      yield* social.pack(scope, {
        where: "WhatsApp channel",
        why: "Kin can't post to WhatsApp channels",
        caption: "Diwali hours 🪔",
        media: PICTURE,
        at: iso(NOW + DAY),
        reminderId: "rem-1",
      });
      const [row] = yield* sql<{ revision: number; widgetId: string; state: string }>`SELECT
        widget_id AS "widgetId", revision, state_json AS state FROM kin_widgets
      WHERE org_id = ${orgId} AND type = ${KIN_SOCIAL_PACK_CARD}`;
      const pack = decodePack(row!.state);
      assert.equal(pack.caption, "Diwali hours 🪔");
      assert.equal(pack.media?.attachmentId, PICTURE);
      yield* tap(row!, "posted", null);
      const [after] = yield* sql<{ state: string }>`SELECT state_json AS state FROM kin_widgets
      WHERE org_id = ${orgId} AND type = ${KIN_SOCIAL_PACK_CARD}`;
      assert.isNotNull(decodePack(after!.state).posted);
    }),
  );
});
