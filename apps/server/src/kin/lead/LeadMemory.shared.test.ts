// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  KinAgentId,
  KinMemoryItemId,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Memory from "../memory/Memory.ts";
import type { MemoryItem } from "../memory/MemoryCache.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import { authorise, fingerprint } from "../memory/sensitivity.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Lead from "./LeadMemory.ts";

// Shared turns against a memory whose snapshots the test controls, so an interleaving is exact.
const orgId = KinOrgId.make("fixture-org");
const ownerId = KinPersonId.make("fixture-owner");
const at = "2026-11-08T00:00:00.000Z";
const leads = { a: "lead-a", b: "lead-b", o: "lead-o" } as const;
const scopeOf = (lead: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make(`${lead}-thread`),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
});

const head = (id: string, fields: Partial<MemoryItemHead> = {}): MemoryItemHead => ({
  id: KinMemoryItemId.make(id),
  kind: "claim",
  title: `Invented ${id}`,
  status: "open",
  due: null,
  recorded_at: at,
  valid_from: at,
  invalid_at: null,
  superseded_by: null,
  review_by: null,
  source: "kin:chat:owner-chat:message:owner-message",
  said_by: "fixture-owner",
  trust: "owner",
  links: [],
  sensitive: false,
  orgId,
  path: `claims/${id}.md`,
  ...fields,
});
// Read by the mocks below; `setup` resets it at the top of every test.
const state: {
  items: ReadonlyArray<MemoryItem>;
  /** Runs once, right after the next load of items with their bodies. */
  afterLoad: (() => void) | undefined;
  stage: (wakeupId: string) => Effect.Effect<void>;
} = { items: [], afterLoad: undefined, stage: () => Effect.void };
const loaded = () => {
  const items = state.items;
  const after = state.afterLoad;
  state.afterLoad = undefined;
  after?.();
  return items;
};
const pick = (id: string, admit?: (item: MemoryItem) => boolean) =>
  Effect.gen(function* () {
    const matches = loaded().filter((item) => item.head.id === id && (admit?.(item) ?? true));
    if (matches[0] === undefined) return yield* new Memory.MemoryNotFound({ orgId, id });
    if (matches.length > 1) return yield* new Memory.MemoryDuplicateId({ orgId, id });
    return matches[0];
  });
const memory = Layer.mock(Memory.Memory)({
  items: () => Effect.sync(loaded),
  query: () => Effect.sync(() => state.items.map((item) => ({ ...item.head, duplicate: false }))),
  readItem: (_org, id, _view, admit) => pick(id, admit),
  readItemQuietly: (_org, id) => pick(id),
});
const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person", orgId, personId: ownerId },
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: (scope) =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: KinAgentId.make(scope.thread!.threadId.replace(/-thread$/, "")),
      ownerPersonId: ownerId,
      threadId: scope.thread!.threadId,
    }),
});
const writer = Layer.mock(Writer.MemoryWriter)({
  stage: (_org, wakeupId) => Effect.suspend(() => state.stage(wakeupId)),
});
const decodeWrite = Schema.decodeUnknownEffect(Lead.WriteInput);
const layer = Lead.layer.pipe(
  Layer.provide(memory),
  Layer.provide(identity),
  Layer.provide(writer),
  Layer.provide(Layer.mock(Writer.MemoryWriterAuthority)({})),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory)),
);

/** Leads a and b answer a teammate in a group; lead o answers a routine in its owner's chat. */
const setup = Effect.gen(function* () {
  state.items = [];
  state.afterLoad = undefined;
  state.stage = () => Effect.void;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Fixture', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES
    (${ownerId}, ${orgId}, 'fixture-owner', 'Owner', ${at}),
    ('fixture-member', ${orgId}, 'fixture-member', 'Member', ${at})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at, direct_key) VALUES
    ('group-chat', ${orgId}, 'team_group', 0, ${at}, NULL),
    ('owner-chat', ${orgId}, 'direct', 0, ${at}, 'owner-direct')`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at) VALUES
    ('member-in-group', ${orgId}, 'group-chat', 'person', 'fixture-member', 'member', ${at}),
    ('owner-in-group', ${orgId}, 'group-chat', 'person', ${ownerId}, 'owner', ${at}),
    ('owner-in-direct', ${orgId}, 'owner-chat', 'person', ${ownerId}, 'owner', ${at})`;
  for (const [index, lead] of Object.values(leads).entries()) {
    const shared = lead !== leads.o;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${lead}, ${orgId}, ${lead}, 'lead', ${ownerId}, ${at})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, thread_id, models_json, worker_projects_json, owner_chat_id)
      VALUES (${lead}, ${orgId}, ${lead}, 'L1', 0, ${`${lead}-thread`}, '{}', '[]', 'owner-chat')`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids, audience)
      VALUES (${`wake-${lead}`}, ${orgId}, ${lead}, ${`${lead}-thread`}, ${`run-${lead}`}, 'fixture', 0, 'running',
        ${JSON.stringify([`event-${lead}`])}, ${shared ? "shared" : "owner_only"})`;
    const event = shared
      ? {
          _tag: "chat.message",
          chatId: "group-chat",
          messageId: `message-${lead}`,
          provenance: { _tag: "human", personId: "fixture-member", memberId: "member-in-group" },
        }
      : { _tag: "routine", routine: "morning_brief", provenance: { _tag: "system" } };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
      VALUES (${`event-${lead}`}, ${orgId}, ${lead}, ${event._tag}, 'P0',
        ${JSON.stringify({ ...event, orgId, agentId: lead, eventId: `event-${lead}`, receivedAt: at, dedupeKey: null })},
        0, 0, 'claimed', ${`wake-${lead}`})`;
    if (shared)
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
          author_member_id, author_role, kind, body, mentions_json, status, created_at)
        VALUES (${`message-${lead}`}, ${orgId}, 'group-chat', ${index + 1}, 'human', 'fixture-member',
          'member-in-group', 'member', 'text', 'Invented teammate note', '[]', 'posted', ${at})`;
  }
});
const body = "Invented team body.\n";
// The team may know this note; its other front matter holds words a teammate must never see.
const teamNote: MemoryItem = {
  head: head("team-note", {
    owner: "Invented-private-owner-zq",
    source: "kin:chat:private-chat:message:private-zq",
  }),
  body,
};
const authorised = (item: MemoryItem) =>
  authorise(orgId, item.head.id, fingerprint(item), "owner_setting");

// Review of 9de4e8d197: a dream's private words in `owner`, which the fingerprint skipped,
// reached a shared memory_read along with the item's path and source.
it.effect("a shared read returns only the item's shared projection", () =>
  Effect.gen(function* () {
    yield* setup;
    state.items = [teamNote];
    yield* authorised(teamNote);
    const read = yield* (yield* Lead.LeadMemory).read(scopeOf(leads.a), {
      id: KinMemoryItemId.make("team-note"),
    });
    assert.deepStrictEqual(read, {
      item: {
        id: KinMemoryItemId.make("team-note"),
        kind: "claim",
        title: "Invented team-note",
        links: [],
        body,
      },
      reviewOverdue: false,
      misleading: false,
    });
    for (const hidden of ["private", "claims/team-note.md", "fixture-owner"])
      assert.notInclude(JSON.stringify(read), hidden);
    const found = yield* (yield* Lead.LeadMemory).search(scopeOf(leads.a), {});
    assert.deepStrictEqual(found, [
      {
        id: KinMemoryItemId.make("team-note"),
        kind: "claim",
        title: "Invented team-note",
        links: [],
        duplicate: false,
      },
    ]);
  }).pipe(Effect.provide(layer)),
);

// Review of 9de4e8d197: the shared read checked one snapshot and returned the next.
it.effect("a shared read returns the very item it checked, not a newer one", () =>
  Effect.gen(function* () {
    yield* setup;
    state.items = [teamNote];
    yield* authorised(teamNote);
    // The pin advances to a rewording the owner never let the team know, right after the turn
    // loads what it checks.
    state.afterLoad = () => {
      state.items = [{ ...teamNote, body: "Invented-private-reworded-zq\n" }];
    };
    const read = yield* (yield* Lead.LeadMemory)
      .read(scopeOf(leads.a), { id: KinMemoryItemId.make("team-note") })
      .pipe(Effect.result);
    assert.notInclude(JSON.stringify(read), "Invented-private-reworded-zq");
    // At the new pin, the rewording reads as not found.
    const after = yield* (yield* Lead.LeadMemory)
      .read(scopeOf(leads.a), { id: KinMemoryItemId.make("team-note") })
      .pipe(Effect.flip);
    assert.strictEqual(after.reason, "not_found");
  }).pipe(Effect.provide(layer)),
);

// Review of 9de4e8d197: a sensitive file sharing a readable item's id made the shared read fail.
it.effect(
  "a hidden duplicate changes nothing a shared turn sees, and still fails the owner's",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const hidden = {
        head: head("team-note", { path: "claims/team-note-private.md", sensitive: true }),
        body: "Invented-private-duplicate-zq\n",
      };
      state.items = [teamNote, hidden];
      yield* authorised(teamNote);
      const service = yield* Lead.LeadMemory;
      const found = yield* service.search(scopeOf(leads.a), {});
      assert.deepStrictEqual(
        found.map((item) => [item.id, item.duplicate]),
        [["team-note", false]],
      );
      const read = yield* service.read(scopeOf(leads.a), { id: KinMemoryItemId.make("team-note") });
      assert.strictEqual("item" in read ? read.item.body : undefined, body);
      assert.notInclude(JSON.stringify(read), "duplicate");
      const owners = yield* service
        .read(scopeOf(leads.o), { id: KinMemoryItemId.make("team-note") })
        .pipe(Effect.flip);
      assert.strictEqual(owners.reason, "unavailable");
    }).pipe(Effect.provide(layer)),
);

// Review of 9de4e8d197: the cap is per person but the lock per lead, so two leads both took
// the twentieth place.
it.effect("two leads can't both take a teammate's last write of the day", () =>
  Effect.gen(function* () {
    yield* setup;
    const sql = yield* SqlClient.SqlClient;
    for (let index = 0; index < 19; index++)
      yield* sql`INSERT INTO kin_memory_shared_writes (org_id, wakeup_id, item_id, person_id, bytes, written_at)
        VALUES (${orgId}, 'earlier-wakeup', ${`earlier-${index}`}, 'fixture-member', 10, 0)`;
    const write = (lead: string, id: string) =>
      decodeWrite({
        op: "create",
        sourceEventId: `event-${lead}`,
        item: {
          id,
          kind: "claim",
          title: `Invented ${id}`,
          body: "Invented: the launch moved a week",
          status: "open",
          due: null,
          recorded_at: at,
          valid_from: at,
          invalid_at: null,
          superseded_by: null,
          source: "forged",
          said_by: "forged",
          trust: "owner",
          links: [],
          sensitive: false,
        },
      }).pipe(
        Effect.flatMap((input) => Lead.LeadMemory.use((lm) => lm.write(scopeOf(lead), input))),
      );
    const staging = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    state.stage = (wakeupId) =>
      wakeupId === `wake-${leads.a}`
        ? Deferred.succeed(staging, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void;
    // Lead a has admitted its write and is staging it when lead b's arrives.
    const first = yield* Effect.forkChild(write(leads.a, "a-claim"));
    yield* Deferred.await(staging);
    const second = yield* write(leads.b, "b-claim").pipe(Effect.flip);
    yield* Deferred.succeed(release, undefined);
    assert.deepStrictEqual(yield* Fiber.join(first), { itemId: "a-claim" });
    assert.include(second.message, "as much as can be saved from one person's messages today");
    const [used] = yield* sql<{ writes: number }>`SELECT COUNT(*) AS writes
      FROM kin_memory_shared_writes WHERE org_id = ${orgId} AND person_id = 'fixture-member'`;
    assert.strictEqual(used?.writes, 20);
  }).pipe(Effect.provide(layer)),
);
