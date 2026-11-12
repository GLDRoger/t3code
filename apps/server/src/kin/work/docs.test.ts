// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthKinChatScope,
  EnvironmentId,
  KinAgentId,
  type KinChatError,
  KinDocsRpcs,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { authorizeRpc } from "../../auth/RpcAuthorization.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { SHARED_TOOLS, sharedToolAllowed } from "../lead/SharedTools.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KinDocsToolkit } from "./mcp/docTools.ts";
import { sectionsOf } from "./docBody.ts";
import * as Docs from "./docs.ts";
import * as KinRecords from "./KinRecords.ts";
import * as LeadDocs from "./leadDocs.ts";
import * as OwnerDocs from "./ownerDocs.ts";
import { search } from "./search.ts";

// Invented org, people and docs only; nothing here reads a real database or memory.
const orgId = KinOrgId.make("org");
const elsewhere = KinOrgId.make("elsewhere");
const ownerId = KinPersonId.make("owner");
const mateId = KinPersonId.make("mate");
const lead = KinAgentId.make("lead");
const other = KinAgentId.make("other");
const at = "2026-11-12T00:00:00.000Z";
const owner = { _tag: "person" as const, orgId, personId: ownerId };

const scopeOf = (agent: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make(`${agent}-thread`),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
});
const identity = Layer.mock(KinIdentity)({
  owner,
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
const gate = Layer.mock(KinLevelGate)({});
const layer = Layer.mergeAll(KinRecords.layer, identity, gate).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at}), (${elsewhere}, 'Other Co', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at}), (${mateId}, ${orgId}, 'mate', 'Mate', ${at})`;
  for (const agent of [lead, other]) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES (${agent}, ${orgId}, ${`Lead ${agent}`}, 'lead', ${ownerId}, ${at})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES (${`${agent}-chat`}, ${orgId}, 'direct', ${`owner:${agent}`}, 1, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES (${`${agent}-chat-owner`}, ${orgId}, ${`${agent}-chat`}, 'person', ${ownerId}, 'owner', ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
      VALUES (${`${agent}-chat-lead`}, ${orgId}, ${`${agent}-chat`}, 'agent', ${agent}, 'member', ${at})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
        worker_projects_json, owner_chat_id)
      VALUES (${agent}, ${orgId}, ${`Lead ${agent}`}, 0, ${`${agent}-thread`}, '{}', '[]', ${`${agent}-chat`})`;
  }
});

/** A running turn of `lead`, woken by the owner's (or the teammate's) message in its chat. */
const turn = Effect.fn("KinDocsTest.turn")(function* (
  from: "owner" | "mate" = "owner",
  audience: "owner_only" | "shared" = "owner_only",
) {
  const sql = yield* SqlClient.SqlClient;
  const author = from === "owner" ? ownerId : mateId;
  const member = from === "owner" ? "lead-chat-owner" : "lead-chat-mate";
  if (from === "mate")
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('lead-chat-mate', ${orgId}, 'lead-chat', 'person', ${mateId}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
      author_member_id, author_role, kind, body, mentions_json, status, created_at)
    VALUES ('ask', ${orgId}, 'lead-chat', 1, 'human', ${author}, ${member},
      ${from === "owner" ? "owner" : "member"}, 'text', 'Write up the invented launch plan', '[]',
      'posted', ${at})`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status,
      event_ids, audience)
    VALUES ('wake', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '["ask-event"]', ${audience})`;
  const event = {
    _tag: "chat.message",
    orgId,
    agentId: lead,
    eventId: "ask-event",
    receivedAt: at,
    dedupeKey: null,
    provenance: { _tag: "human", personId: author, memberId: member },
    chatId: "lead-chat",
    messageId: "ask",
  };
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
      queued_at, state, wakeup_id)
    VALUES ('ask-event', ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0,
      'claimed', 'wake')`;
});

const agentWriter = (agentId: KinAgentId): KinRecords.Writer => ({
  actor: { _tag: "agent", agentId },
  via: "lead",
  askedBy: ownerId,
});
const plan = [
  "# Invented launch plan",
  "",
  "Intro for the invented launch.",
  "",
  "## Pricing",
  "",
  "Starter costs 10 invented credits.",
  "",
  "## Timeline",
  "",
  "Launch on the 10th.",
  "",
].join("\n");
const newDoc = Effect.fn("KinDocsTest.newDoc")(function* (
  body: string = plan,
  extra: Partial<Parameters<typeof Docs.create>[3]> = {},
) {
  return yield* Docs.create(
    orgId,
    agentWriter(lead),
    {},
    {
      title: "Invented launch plan",
      body,
      owner: { _tag: "agent", agentId: lead },
      summary: "Created",
      originKey: `test:${extra.title ?? "plan"}:${body.length}`,
      ...extra,
    },
  );
});
const section = (body: string, id: string) => sectionsOf(body).find((part) => part.id === id)!;

it.effect(
  "two agents editing different sections both land; the same section, the second is refused with its text now",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const created = yield* newDoc();
      const { key } = created.row;
      const read = created.version.body;
      const [pricing, timeline] = yield* Effect.all(
        [
          Docs.edit(
            orgId,
            agentWriter(lead),
            {},
            { key },
            {
              operations: [
                {
                  op: "replace_section",
                  section: "pricing",
                  hash: section(read, "pricing").hash,
                  text: "Starter costs 12 invented credits.",
                },
              ],
              summary: "Raised the starter price",
              originKey: "lead-pricing",
            },
          ),
          Docs.edit(
            orgId,
            agentWriter(other),
            {},
            { key },
            {
              operations: [
                {
                  op: "replace_section",
                  section: "timeline",
                  hash: section(read, "timeline").hash,
                  text: "Launch on the 14th.",
                },
              ],
              summary: "Moved the launch to the 14th",
              originKey: "other-timeline",
            },
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(
        [pricing.version.version, timeline.version.version].toSorted(),
        [2, 3],
      );
      const latest = yield* Docs.versionOf(orgId, created.row.recordId);
      assert.include(latest!.body, "12 invented credits");
      assert.include(latest!.body, "Launch on the 14th.");
      assert.include(latest!.body, "## Pricing");

      // Both read version 3; the first lands and the second, naming the same hash, is handed it.
      const now = latest!.body;
      const edit = (agentId: KinAgentId, text: string) =>
        Docs.edit(
          orgId,
          agentWriter(agentId),
          {},
          { key },
          {
            operations: [
              {
                op: "replace_section",
                section: "pricing",
                hash: section(now, "pricing").hash,
                text,
              },
            ],
            summary: "Changed the price",
            originKey: `${agentId}:${text}`,
          },
        );
      yield* edit(lead, "Starter costs 15 invented credits.");
      const refused: KinChatError = yield* Effect.flip(edit(other, "Starter is free."));
      assert.strictEqual(refused.reason, "conflict");
      assert.include(refused.message, "15 invented credits");
      assert.include(
        refused.message,
        section((yield* Docs.versionOf(orgId, created.row.recordId))!.body, "pricing").hash,
      );
      assert.strictEqual((yield* Docs.versionOf(orgId, created.row.recordId))!.version, 4);

      // The same call again is a retry: the version it made, and nothing new.
      const again = yield* edit(lead, "Starter costs 15 invented credits.");
      assert.isFalse(again.created);
      assert.strictEqual(again.version.version, 4);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "the rewrite guard refuses a one-line change sent as a rewrite and names its section",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const long = [
        "# Invented runbook",
        ...Array.from(
          { length: 30 },
          (_, index) =>
            `## Step ${index + 1}\n\nDo invented step ${index + 1} carefully and check it twice.`,
        ),
      ].join("\n\n");
      const created = yield* newDoc(long);
      const { key } = created.row;
      const rewrite = (body: string, baseVersion = created.version.version) =>
        Docs.rewrite(
          orgId,
          agentWriter(lead),
          {},
          { key },
          {
            body,
            baseVersion,
            summary: "Rewrote it",
            originKey: `rewrite:${body.length}:${baseVersion}:${body.slice(-20)}`,
          },
        );
      const refused: KinChatError = yield* Effect.flip(
        rewrite(long.replace("invented step 7 carefully", "invented step 7 slowly")),
      );
      assert.strictEqual(refused.reason, "invalid_state");
      assert.include(refused.message, "step-7");
      assert.include(refused.message, "doc_edit");
      assert.strictEqual((yield* Docs.versionOf(orgId, created.row.recordId))!.version, 1);

      // A rewrite from an old version is refused the same way an old hash is.
      const fresh = `# Invented runbook\n\n${Array.from({ length: 30 }, (_, index) => `Line ${index}`).join("\n")}`;
      assert.strictEqual((yield* rewrite(fresh)).version.version, 2);
      assert.strictEqual((yield* Effect.flip(rewrite(`${fresh}\nMore`, 1))).reason, "conflict");

      // A short doc may be rewritten for one line.
      const short = yield* newDoc("Invented note.\n\nSecond line.", { title: "Invented note" });
      const changed = yield* Docs.rewrite(
        orgId,
        agentWriter(lead),
        {},
        { key: short.row.key },
        {
          body: "Invented note.\n\nSecond line, fixed.",
          baseVersion: 1,
          summary: "Fixed a line",
          originKey: "short",
        },
      );
      assert.strictEqual(changed.version.version, 2);
    }).pipe(Effect.provide(layer)),
);

it.effect("a restore is a new version that brings the old text back, and is undoable", () =>
  Effect.gen(function* () {
    yield* seed;
    const created = yield* newDoc();
    const { key, recordId } = created.row;
    yield* Docs.edit(
      orgId,
      agentWriter(lead),
      {},
      { key },
      {
        operations: [
          { op: "replace_phrase", find: "Launch on the 10th.", replace: "Launch on the 20th." },
          { op: "retitle", title: "Invented launch plan v2" },
        ],
        summary: "Moved the launch",
        originKey: "move",
      },
    );
    const people = [owner];
    const restored = yield* OwnerDocs.restore(people, { orgId, key, version: 1, latest: 2 });
    assert.strictEqual(restored.body, plan);
    assert.strictEqual(restored.title, "Invented launch plan");
    assert.include(restored.version, { version: 3, kind: "restored", restoredFrom: 1 });
    assert.deepStrictEqual(restored.version.provenance.by, { _tag: "person", personId: ownerId });
    // Undo the undo: version 2 comes back as 4, and history keeps all four.
    const redone = yield* OwnerDocs.restore(people, { orgId, key, version: 2, latest: 3 });
    assert.include(redone.body, "Launch on the 20th.");
    assert.strictEqual(redone.title, "Invented launch plan v2");
    // A restore from a stale view is refused; the same restore again returns what it made.
    assert.strictEqual(
      (yield* Effect.flip(OwnerDocs.restore(people, { orgId, key, version: 1, latest: 3 }))).reason,
      "conflict",
    );
    assert.strictEqual(
      (yield* OwnerDocs.restore(people, { orgId, key, version: 2, latest: 3 })).version.version,
      4,
    );
    const history = yield* OwnerDocs.history(people, { orgId, key });
    assert.deepStrictEqual(
      history.versions.map((version) => [version.version, version.kind]),
      [
        [4, "restored"],
        [3, "restored"],
        [2, "edited"],
        [1, "created"],
      ],
    );
    const diff = yield* OwnerDocs.diff(people, { orgId, key, from: 1, to: 2 });
    assert.isTrue(
      diff.patch.startsWith(
        `diff --git a/${key}.md b/${key}.md\n--- a/${key}.md\n+++ b/${key}.md\n@@ `,
      ),
    );
    assert.include(diff.patch, "-Launch on the 10th.\n+Launch on the 20th.");
    assert.deepStrictEqual(
      [diff.additions, diff.deletions, diff.changedSections],
      [1, 1, ["timeline"]],
    );
    // Only the owner reads or restores.
    assert.strictEqual(
      (yield* Effect.flip(
        OwnerDocs.get([{ _tag: "person", orgId, personId: mateId }], { orgId, key }),
      )).reason,
      "not_allowed",
    );
    assert.strictEqual((yield* Docs.versionOf(orgId, recordId))!.version, 4);
  }).pipe(Effect.provide(layer)),
);

it.effect("a version's provenance comes from stored rows, never from what the agent sent", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn();
    const forged = {
      sourceEventId: "ask-event",
      title: "Invented launch plan",
      body: plan,
      summary: "Wrote the plan",
      // None of these is a tool parameter; a model sending them changes nothing.
      provenance: { by: { _tag: "person", personId: mateId }, audience: "shared" },
      by: { _tag: "person", personId: mateId },
      wakeupId: "forged-wake",
      chatId: "other-chat",
      answered: { messageId: "forged", author: { _tag: "person", personId: mateId } },
      audience: "shared",
    } as typeof LeadDocs.CreateInput.Type;
    const made = yield* LeadDocs.create(scopeOf(lead), forged);
    const row = yield* Docs.docRow(orgId, { key: made.key });
    const version = Docs.toVersion((yield* Docs.versionOf(orgId, row.recordId))!);
    assert.deepStrictEqual(version.provenance, {
      by: { _tag: "agent", agentId: lead },
      via: "lead",
      wakeupId: "wake",
      chatId: "lead-chat",
      answered: { messageId: "ask", author: { _tag: "person", personId: ownerId } },
      audience: "owner_only",
    });
    assert.strictEqual(version.summary, "Wrote the plan");
    // The event must be this turn's own.
    assert.strictEqual(
      (yield* Effect.flip(
        LeadDocs.create(scopeOf(lead), { ...forged, sourceEventId: "elsewhere" }),
      )).reason,
      "invalid_state",
    );
    // Its outline, with the hashes an edit names, comes back with it.
    assert.deepStrictEqual(
      made.outline.map((entry) => entry.id),
      ["invented-launch-plan", "pricing", "timeline"],
    );
    const read = yield* LeadDocs.read(scopeOf(lead), { key: made.key, sections: ["pricing"] });
    assert.deepStrictEqual(
      read.sections?.map((part) => part.text),
      ["## Pricing\n\nStarter costs 10 invented credits.\n"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "every doc tool is refused in a turn others read, and a chat-only session gets no RPC",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const created = yield* newDoc();
      yield* turn("mate", "shared");
      const shared = { orgId, agentId: lead, wakeupId: "wake" };
      const tools = Object.keys(KinDocsToolkit.tools);
      assert.lengthOf(tools, 9);
      for (const tool of tools) {
        assert.strictEqual(SHARED_TOOLS[tool as keyof typeof SHARED_TOOLS], "refused", tool);
        assert.isFalse(yield* sharedToolAllowed(shared, tool, {}), tool);
      }
      // The writes check again inside, so a turn that turned shared mid-call writes nothing.
      const edited: KinChatError = yield* Effect.flip(
        LeadDocs.edit(scopeOf(lead), {
          key: created.row.key,
          sourceEventId: "ask-event",
          summary: "Changed it",
          operations: [{ op: "append", text: "More." }],
        }),
      );
      assert.strictEqual(edited.reason, "not_allowed");
      assert.strictEqual((yield* Docs.versionOf(orgId, created.row.recordId))!.version, 1);
      for (const rpc of KinDocsRpcs)
        assert.isTrue(
          (yield* Effect.exit(authorizeRpc([AuthKinChatScope], rpc._tag, { orgId })))._tag ===
            "Failure",
          rpc._tag,
        );
    }).pipe(Effect.provide(layer)),
);

it.effect("an agent restores a doc only when the owner asked, in a turn only the owner reads", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn();
    const made = yield* LeadDocs.create(scopeOf(lead), {
      sourceEventId: "ask-event",
      title: "Invented launch plan",
      body: plan,
    });
    yield* LeadDocs.edit(scopeOf(lead), {
      key: made.key,
      sourceEventId: "ask-event",
      summary: "Moved the launch",
      operations: [{ op: "replace_phrase", find: "the 10th", replace: "the 12th" }],
    });
    const restored = yield* LeadDocs.restore(scopeOf(lead), {
      key: made.key,
      sourceEventId: "ask-event",
      version: 1,
      latest: 2,
    });
    assert.strictEqual(restored.version, 3);
    // A wake-up with no human behind it, such as a reminder, restores nothing.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_events SET json = json_set(json, '$.provenance', json('{"_tag":"system"}')),
      tag = 'routine' WHERE event_id = 'ask-event'`;
    assert.strictEqual(
      (yield* Effect.flip(
        LeadDocs.restore(scopeOf(lead), {
          key: made.key,
          sourceEventId: "ask-event",
          version: 2,
          latest: 3,
        }),
      )).reason,
      "not_allowed",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("another org's doc, by key or id, looks like no doc at all", () =>
  Effect.gen(function* () {
    yield* seed;
    const created = yield* newDoc();
    const { key, recordId } = created.row;
    for (const ref of [{ key }, { recordId }])
      assert.strictEqual((yield* Effect.flip(Docs.docRow(elsewhere, ref))).reason, "not_found");
    const edit: KinChatError = yield* Effect.flip(
      Docs.edit(
        elsewhere,
        agentWriter(lead),
        {},
        { key },
        {
          operations: [{ op: "append", text: "Leaked?" }],
          summary: "Tried",
          originKey: "cross-org",
        },
      ),
    );
    assert.strictEqual(edit.reason, "not_found");
    assert.isUndefined(yield* Docs.versionOf(elsewhere, recordId));
    assert.lengthOf(
      (yield* search(elsewhere, { text: "pricing", limit: 10, viewer: "owner" })).hits,
      0,
    );
    // A Work entry is not a doc either.
    const records = yield* KinRecords.KinRecords;
    const entry = yield* records.create(orgId, agentWriter(lead), {
      originKey: "entry",
      title: "Invented entry",
      owner: { _tag: "agent", agentId: lead },
    });
    assert.strictEqual(
      (yield* Effect.flip(Docs.docRow(orgId, { key: entry.row.key }))).reason,
      "not_found",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("one search finds entries and docs, and the team view hides what labels hide", () =>
  Effect.gen(function* () {
    yield* seed;
    const records = yield* KinRecords.KinRecords;
    const writer = agentWriter(lead);
    const me = { _tag: "agent" as const, agentId: lead };
    yield* newDoc();
    yield* newDoc("Invented pricing bands for each role.", {
      title: "Invented pay bands",
      sensitive: true,
    });
    const client = yield* records.create(orgId, writer, {
      list: "clients",
      originKey: "client",
      title: "Invented Acme",
      owner: me,
      category: "client",
      fields: { terms: "Invented pricing: net 30" },
    });
    const secret = yield* records.create(orgId, writer, {
      list: "clients",
      originKey: "secret-client",
      title: "Invented Hush",
      owner: me,
      category: "client",
      sensitive: true,
    });
    yield* records.create(orgId, writer, {
      originKey: "hush-work",
      title: "Invented pricing review",
      owner: me,
      partyId: secret.row.recordId,
    });
    const found = (viewer: "owner" | "team") =>
      search(orgId, { text: "pricing", limit: 20, viewer }).pipe(
        Effect.map(({ hits, indexed }) => ({
          indexed,
          hits: hits.map((hit) => [hit.title, hit.kind, hit.sensitive, hit.section?.id ?? null]),
        })),
      );
    const all = yield* found("owner");
    assert.isTrue(all.indexed);
    assert.sameDeepMembers(all.hits, [
      ["Invented launch plan", "docs", false, "pricing"],
      ["Invented pay bands", "docs", true, null],
      ["Invented Acme", "clients", true, null],
      ["Invented pricing review", "work", true, null],
    ]);
    assert.deepStrictEqual((yield* found("team")).hits, [
      ["Invented launch plan", "docs", false, "pricing"],
    ]);
    // A label set later hides at once: labels are read at query time, not indexed.
    yield* records.update(
      orgId,
      { actor: { _tag: "person", personId: ownerId }, via: "owner" },
      client.row.key,
      {
        notes: "Invented pricing call on Monday",
      },
    );
    assert.deepStrictEqual((yield* found("team")).hits.map(([title]) => title).toSorted(), [
      "Invented Acme",
      "Invented launch plan",
    ]);
    // Without FTS5 the scan keeps the same rules.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE kin_search`;
    const scanned = yield* found("team");
    assert.isFalse(scanned.indexed);
    assert.deepStrictEqual(scanned.hits.map(([title]) => title).toSorted(), [
      "Invented Acme",
      "Invented launch plan",
    ]);
    assert.lengthOf((yield* found("owner")).hits, 4);
  }).pipe(Effect.provide(layer)),
);
