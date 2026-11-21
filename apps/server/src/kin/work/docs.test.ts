// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  KinAgentId,
  type KinChatError,
  KinChatId,
  KinDocsRpcs,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWidgetId,
  ProviderInstanceId,
  ThreadId,
  kinRpcAccess,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinAttachmentStore } from "../chat/KinAttachmentStore.ts";
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
import {
  findOfferings,
  OFFERINGS_ORIGIN,
  offeringsIndex,
  offeringsPromptIndex,
} from "./offerings.ts";
import * as OwnerDocs from "./ownerDocs.ts";
import { playbookIndex, playbookThreshold } from "./playbooks.ts";
import { PLAYBOOK_SEEDS, seedPlaybooks } from "./playbookSeeds.ts";
import { characters, parseCharacter, seedCharacters, setCharacter } from "../lead/characters.ts";
import { search } from "./search.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "./teamView.ts";

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
const docWidget = (chatId: KinChatId, state: unknown) => ({
  orgId,
  chatId,
  state,
  widgetId: KinWidgetId.make("doc:fixture"),
  messageId: KinMessageId.make("fixture"),
  widgetClass: "native" as const,
  type: "doc",
  revision: 1,
  source: null,
  feed: null,
  awaiting: [],
  pinnedAt: null,
  closedAt: null,
  updatedAt: at,
});
const gate = Layer.mock(KinLevelGate)({
  showCard: (_, input) => Effect.succeed(docWidget(input.chatId, input.state)),
});
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
const reasonOf = (error: object) => ("reason" in error ? error.reason : undefined);
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
      assert.strictEqual(reasonOf(yield* Effect.flip(rewrite(`${fresh}\nMore`, 1))), "conflict");

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
      reasonOf(
        yield* Effect.flip(OwnerDocs.restore(people, { orgId, key, version: 1, latest: 3 })),
      ),
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
      reasonOf(
        yield* Effect.flip(
          OwnerDocs.get([{ _tag: "person", orgId, personId: mateId }], { orgId, key }),
        ),
      ),
      "not_allowed",
    );
    assert.strictEqual((yield* Docs.versionOf(orgId, recordId))!.version, 4);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { lane: "reply", shows: true },
  { lane: "check-in", shows: true },
  { lane: "background", shows: false },
] as const)(
  "a doc the turn wrote shows as a card in the reply chat unless told not to ($lane)",
  ({ lane, shows }) =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn();
      const sql = yield* SqlClient.SqlClient;
      if (lane !== "reply") {
        const event =
          lane === "check-in"
            ? {
                type: "pulse",
                checkIn: {
                  scheduleId: "checkin-morning",
                  title: "Morning",
                  what: "Review.",
                  slot: "now",
                },
              }
            : { type: "routine" };
        yield* sql`UPDATE kin_events SET tag = ${event.type}, json = ${JSON.stringify(event)} WHERE event_id = 'ask-event'`;
      }
      const cards: Array<{ chatId: KinChatId; state: unknown }> = [];
      const service = yield* KinLevelGate;
      const create = (title: string, card?: false) =>
        LeadDocs.create(scopeOf(lead), {
          title,
          body: plan,
          sourceEventId: "ask-event",
          ...(card === undefined ? {} : { card }),
        }).pipe(
          Effect.provideService(KinLevelGate, {
            ...service,
            showCard: (agent, input) =>
              Effect.sync(() => {
                cards.push({ chatId: input.chatId, state: input.state });
              }).pipe(Effect.andThen(service.showCard(agent, input))),
          }),
        );
      const made = yield* create("Lumen kickoff brief");
      yield* create("Lumen private notes", false);
      assert.lengthOf(cards, shows ? 1 : 0);
      if (shows) {
        assert.strictEqual(cards[0]?.chatId, "lead-chat");
        assert.deepInclude(cards[0]?.state as object, {
          key: made.key,
          title: made.title,
          version: 1,
        });
      }
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
    const row = yield* Docs.docRow(orgId, { key: made.key }, KIN_OWNER_LEVEL);
    const version = Docs.toVersion((yield* Docs.versionOf(orgId, row.recordId))!);
    assert.deepStrictEqual(version.provenance, {
      by: { _tag: "agent", agentId: lead },
      via: "lead",
      wakeupId: "wake",
      chatId: KinChatId.make("lead-chat"),
      answered: {
        messageId: KinMessageId.make("ask"),
        author: { _tag: "person", personId: ownerId },
      },
      audience: "owner_only",
    });
    assert.strictEqual(version.summary, "Wrote the plan");
    // The event must be this turn's own.
    assert.strictEqual(
      reasonOf(
        yield* Effect.flip(
          LeadDocs.create(scopeOf(lead), { ...forged, sourceEventId: "elsewhere" }),
        ),
      ),
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

it.effect("a turn others read reaches only docs they all see, and restores none", () =>
  Effect.gen(function* () {
    yield* seed;
    const created = yield* newDoc();
    yield* turn("mate", "shared");
    const shared = { orgId, agentId: lead, wakeupId: "wake" };
    const tools = Object.keys(KinDocsToolkit.tools);
    assert.lengthOf(tools, 9);
    for (const tool of tools) {
      const restore = tool === "doc_restore";
      assert.strictEqual(
        SHARED_TOOLS[tool as keyof typeof SHARED_TOOLS],
        restore ? "refused" : "view",
        tool,
      );
      assert.strictEqual(yield* sharedToolAllowed(shared, tool, {}), !restore, tool);
    }
    // A doc a teammate may not see is no doc at all to read, and a write to it writes nothing.
    assert.strictEqual(
      reasonOf(yield* Effect.flip(LeadDocs.read(scopeOf(lead), { key: created.row.key }))),
      "not_found",
    );
    const edited = yield* Effect.flip(
      LeadDocs.edit(scopeOf(lead), {
        key: created.row.key,
        sourceEventId: "ask-event",
        summary: "Changed it",
        operations: [{ op: "append", text: "More." }],
      }),
    );
    assert.strictEqual(reasonOf(edited), "not_found");
    assert.include(String(edited), `No doc ${created.row.key}`);
    assert.strictEqual((yield* Docs.versionOf(orgId, created.row.recordId))!.version, 1);
    // A member reaches the doc reads, where the service shows them only their docs.
    const reads = ["kin.docs.list", "kin.docs.get", "kin.docs.history", "kin.docs.diff"];
    for (const rpc of KinDocsRpcs)
      assert.strictEqual(
        kinRpcAccess(rpc._tag) === "person",
        [...reads, "kin.docs.subscribe", "kin.search"].includes(rpc._tag),
        rpc._tag,
      );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "an agent restores a doc in any turn only the owner reads, never in one others read",
  () =>
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
      const restore = (version: number, latest: number) =>
        LeadDocs.restore(scopeOf(lead), {
          key: made.key,
          sourceEventId: "ask-event",
          version,
          latest,
        });
      assert.strictEqual((yield* restore(1, 2)).version, 3);
      // A restore is a new version, as undoable as a rewrite, so no human need have asked for it.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_events SET json = json_set(json, '$.provenance', json('{"_tag":"system"}')),
      tag = 'routine' WHERE event_id = 'ask-event'`;
      assert.strictEqual((yield* restore(2, 3)).version, 4);
      yield* sql`UPDATE kin_wakeups SET audience = 'shared' WHERE wakeup_id = 'wake'`;
      assert.strictEqual(reasonOf(yield* Effect.flip(restore(1, 4))), "not_allowed");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a refused edit of a sensitive doc hands back its text and marks the turn as a read",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const made = yield* newDoc(plan, { sensitive: true });
      const open = yield* newDoc(plan, { title: "Invented open plan" });
      yield* turn();
      const marked = sql`SELECT 1 FROM kin_wakeup_sensitive_reads WHERE org_id = ${orgId}
      AND wakeup_id = 'wake'`;
      const edit = (key: string, operation: (typeof LeadDocs.EditInput.Type.operations)[number]) =>
        Effect.flip(
          LeadDocs.edit(scopeOf(lead), {
            key,
            sourceEventId: "ask-event",
            summary: "Changed pricing",
            operations: [operation],
          }),
        );
      // A doc no one labelled: its refusal is no sensitive read.
      yield* edit(open.row.key, {
        op: "replace_section",
        section: "pricing",
        hash: "x",
        text: "New",
      });
      assert.lengthOf(yield* marked, 0);
      // Its text now, to redo the edit against, and the read it is, rolled-back edit or not.
      const conflict = yield* edit(made.row.key, {
        op: "replace_section",
        section: "pricing",
        hash: "wrong",
        text: "New pricing",
      });
      assert.include(conflict.message, "Starter costs 10 invented credits.");
      assert.lengthOf(yield* marked, 1);
      yield* sql`DELETE FROM kin_wakeup_sensitive_reads`;
      // Section names and phrase counts are the doc's too.
      const missing = yield* edit(made.row.key, { op: "insert_after", section: "nope", text: "x" });
      assert.include(missing.message, "pricing");
      assert.lengthOf(yield* marked, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a doc is private by its own label or a money kind, never by what the turn read; the project's people read the rest",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn();
      const sql = yield* SqlClient.SqlClient;
      const label = (key: string) =>
        Docs.docRow(orgId, { key }, KIN_OWNER_LEVEL).pipe(Effect.map((row) => row.sensitive));
      // The turn has read a price: the PRD it writes and edits stays readable by the team (H04).
      yield* sql`INSERT INTO kin_wakeup_sensitive_reads (org_id, wakeup_id, read_at)
        VALUES (${orgId}, 'wake', 0)`;
      const prd = yield* LeadDocs.create(scopeOf(lead), {
        sourceEventId: "ask-event",
        title: "Invented PRD",
        kind: "prd",
        body: plan,
      });
      yield* LeadDocs.edit(scopeOf(lead), {
        key: prd.key,
        sourceEventId: "ask-event",
        summary: "Moved the launch",
        operations: [{ op: "replace_phrase", find: "the 10th", replace: "the 12th" }],
      });
      yield* LeadDocs.rewrite(scopeOf(lead), {
        key: prd.key,
        sourceEventId: "ask-event",
        baseVersion: 2,
        body: plan.replace("Intro for the invented launch.", "A new invented intro."),
        summary: "Rewrote the intro",
      });
      assert.isUndefined(prd.sensitive);
      assert.strictEqual(yield* label(prd.key), 0);
      // A quote or proposal is private by its kind; anything the agent labels, by its label.
      const quote = yield* LeadDocs.create(scopeOf(lead), {
        sourceEventId: "ask-event",
        title: "Invented quote",
        kind: "quote",
        body: "Invented: 10 credits",
      });
      const made = yield* LeadDocs.create(scopeOf(lead), {
        sourceEventId: "ask-event",
        title: "Invented private note",
        body: "Invented confidential detail",
        sensitive: true,
      });
      assert.deepStrictEqual([yield* label(quote.key), yield* label(made.key)], [1, 1]);

      // Filed under a project, the PRD is read by whoever holds work in it, without the Docs
      // place; the private note filed there too is not.
      const records = yield* KinRecords.KinRecords;
      const project = yield* records.create(orgId, agentWriter(lead), {
        list: "projects",
        title: "Invented app",
        owner: { _tag: "agent", agentId: lead },
        originKey: "test:project",
      });
      const task = yield* records.create(orgId, agentWriter(lead), {
        title: "Invented login",
        owner: { _tag: "person", personId: mateId },
        projectId: project.row.recordId,
        originKey: "test:task",
      });
      yield* sql`UPDATE kin_records SET project_id = ${project.row.recordId}
        WHERE key IN (${prd.key}, ${made.key})`;
      const seen = (key: string) =>
        Docs.docRow(orgId, { key }, viewerOfPeople([mateId])).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      assert.deepStrictEqual(
        [yield* seen(prd.key), yield* seen(made.key), yield* seen(quote.key)],
        [true, false, false],
      );
      // A doc written for the project, by its name or for its tasks, is filed under it; one that
      // names no project stays unfiled.
      const forIt = (title: string, links?: ReadonlyArray<string>) =>
        LeadDocs.create(scopeOf(lead), {
          sourceEventId: "ask-event",
          title,
          body: "Invented scope.",
          ...(links === undefined ? {} : { links }),
        });
      const filed = [
        yield* forIt("Invented app: brief"),
        yield* forIt("Invented login notes", [task.row.key]),
        yield* forIt("Invented ideas"),
      ];
      assert.deepStrictEqual(
        filed.map((doc) => doc.unfiled === undefined),
        [true, true, false],
      );
      assert.deepStrictEqual(
        yield* sql<{ key: string }>`SELECT key FROM kin_records
          WHERE project_id = ${project.row.recordId} AND register_id = 'docs' ORDER BY key`,
        [prd.key, made.key, filed[0]!.key, filed[1]!.key].toSorted().map((key) => ({ key })),
      );
      yield* sql`UPDATE kin_records SET owner_kind = 'agent', owner_id = ${lead}
        WHERE key = ${task.row.key}`;
      assert.isFalse(yield* seen(prd.key));

      // The owner lowers a label, and a later agent write leaves his call.
      assert.isFalse(
        (yield* OwnerDocs.label([owner], { orgId, key: quote.key, sensitive: false })).sensitive,
      );
      yield* LeadDocs.edit(scopeOf(lead), {
        key: quote.key,
        sourceEventId: "ask-event",
        summary: "Added a note",
        operations: [{ op: "append", text: "Invented detail." }],
      });
      assert.strictEqual(yield* label(quote.key), 0);
      // Only the owner: anyone else is refused, and the label stays.
      assert.strictEqual(
        reasonOf(
          yield* Effect.flip(
            OwnerDocs.label([{ _tag: "person", orgId, personId: mateId }], {
              orgId,
              key: made.key,
              sensitive: false,
            }),
          ),
        ),
        "not_allowed",
      );
      assert.strictEqual(yield* label(made.key), 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("another org's doc, by key or id, looks like no doc at all", () =>
  Effect.gen(function* () {
    yield* seed;
    const created = yield* newDoc();
    const { key, recordId } = created.row;
    for (const ref of [{ key }, { recordId }])
      assert.strictEqual(
        reasonOf(yield* Effect.flip(Docs.docRow(elsewhere, ref, KIN_OWNER_LEVEL))),
        "not_found",
      );
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
      (yield* search(elsewhere, {
        text: "pricing",
        limit: 10,
        viewer: "owner",
        scope: KIN_OWNER_LEVEL,
      })).hits,
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
      reasonOf(yield* Effect.flip(Docs.docRow(orgId, { key: entry.row.key }, KIN_OWNER_LEVEL))),
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
    // A task is private by its own label, never its client's.
    yield* records.create(orgId, writer, {
      originKey: "hush-work",
      title: "Invented pricing review",
      owner: me,
      partyId: secret.row.recordId,
      sensitive: true,
    });
    const found = (viewer: "owner" | "team") =>
      search(orgId, { text: "pricing", limit: 20, viewer, scope: KIN_OWNER_LEVEL }).pipe(
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
    // Who is on a project is ids, not words: no search finds them or shows them in a snippet.
    yield* records.create(orgId, writer, {
      list: "projects",
      originKey: "booking-project",
      title: "Invented booking project",
      owner: me,
      fields: { members: ["person:invented-member-id"] },
    });
    const onIt = yield* search(orgId, {
      text: "booking project",
      limit: 5,
      viewer: "owner",
      scope: KIN_OWNER_LEVEL,
    });
    assert.notInclude(JSON.stringify(onIt.hits), "invented-member-id");
    assert.lengthOf(
      (yield* search(orgId, { text: "member", limit: 5, viewer: "owner", scope: KIN_OWNER_LEVEL }))
        .hits,
      0,
    );
    // K064: when no entry has every word, a widened search finds those with some, and says so.
    const widened = (widen?: true) =>
      search(orgId, {
        text: "booking zebra",
        limit: 5,
        viewer: "owner",
        scope: KIN_OWNER_LEVEL,
        ...(widen === undefined ? {} : { widen }),
      }).pipe(Effect.map(({ hits, widened }) => [widened, hits.map((hit) => hit.title)]));
    assert.deepStrictEqual(yield* widened(), [false, []]);
    assert.deepStrictEqual(yield* widened(true), [true, ["Invented booking project"]]);
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
    assert.deepStrictEqual(yield* widened(true), [true, ["Invented booking project"]]);
  }).pipe(Effect.provide(layer)),
);

it.effect("the Docs list filters by words in a title or the latest text, on the host", () =>
  Effect.gen(function* () {
    yield* seed;
    const made = yield* newDoc();
    yield* newDoc("Invented hiring notes for the spring.", { title: "Invented hiring plan" });
    const titles = (text: string) =>
      OwnerDocs.list([owner], { orgId, text, limit: 1 }).pipe(
        Effect.map((page) => [page.docs.map((doc) => doc.title), page.total] as const),
      );
    // Both match and only one fits the page: the count is of every match, not of loaded rows.
    assert.deepStrictEqual(yield* titles("INVENTED"), [["Invented launch plan"], 2]);
    assert.deepStrictEqual(yield* titles("spring"), [["Invented hiring plan"], 1]);
    assert.deepStrictEqual(yield* titles("  starter costs "), [["Invented launch plan"], 1]);
    // Words only an older version had no longer find it.
    yield* Docs.edit(
      orgId,
      agentWriter(lead),
      {},
      { key: made.row.key },
      {
        operations: [
          {
            op: "replace_section",
            section: "pricing",
            hash: section(plan, "pricing").hash,
            text: "Nothing decided.",
          },
        ],
        summary: "Cleared the price",
        originKey: "clear-pricing",
      },
    );
    assert.deepStrictEqual(yield* titles("starter costs"), [[], 0]);
    assert.deepStrictEqual(yield* titles("100%_"), [[], 0]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a doc has a kind and one home, filed by its agent or the owner, and the list filters by both",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const client = yield* records.create(orgId, agentWriter(lead), {
        list: "clients",
        originKey: "client",
        title: "Invented Acme",
        owner: { _tag: "agent", agentId: lead },
        category: "client",
      });
      const playbook = yield* newDoc("How we chase invented invoices.", {
        title: "Invented chasing playbook",
        kind: "playbook",
        company: true,
      });
      const loose = yield* newDoc("Loose invented notes.", { title: "Invented loose notes" });
      yield* newDoc("An invented quarter.", { title: "Invented report", kind: "report" });
      const listed = (input: Partial<Parameters<typeof OwnerDocs.list>[1]>) =>
        OwnerDocs.list([owner], { orgId, ...input }).pipe(
          Effect.map((page) => page.docs.map((doc) => [doc.title, doc.kind, doc.company ?? false])),
        );
      assert.deepStrictEqual(yield* listed({ home: "company" }), [
        ["Invented chasing playbook", "playbook", true],
      ]);
      assert.deepStrictEqual(yield* listed({ kind: "other" }), [
        ["Invented loose notes", "other", false],
      ]);
      assert.deepStrictEqual(
        (yield* listed({ home: "unfiled" })).map(([title]) => title).toSorted(),
        ["Invented loose notes", "Invented report"],
      );
      // The owner files it under a client: it leaves Unfiled, keeps no company mark, takes a kind.
      const filed = yield* OwnerDocs.file([owner], {
        orgId,
        key: loose.row.key,
        rev: loose.row.rev,
        kind: "notes",
        party: client.row.key,
      });
      assert.deepStrictEqual(
        [filed.kind, filed.party?.key, filed.company],
        ["notes", client.row.key, undefined],
      );
      // A stale revision is refused; the company home clears the client.
      const stale = yield* OwnerDocs.file([owner], {
        orgId,
        key: loose.row.key,
        rev: loose.row.rev,
        company: true,
      }).pipe(Effect.flip);
      assert.strictEqual(reasonOf(stale), "conflict");
      const moved = yield* OwnerDocs.file([owner], {
        orgId,
        key: loose.row.key,
        rev: filed.rev,
        company: true,
      });
      assert.deepStrictEqual([moved.party, moved.company], [undefined, true]);
      // An agent's move to a client takes the company mark off the playbook.
      yield* Docs.move(
        orgId,
        agentWriter(lead),
        { key: playbook.row.key },
        { partyId: client.row.recordId },
      );
      assert.deepStrictEqual(
        (yield* listed({ home: "company" })).map(([title]) => title),
        ["Invented loose notes"],
      );
      // Only the owner files docs.
      const mate = { _tag: "person" as const, orgId, personId: mateId };
      const refused = yield* OwnerDocs.file([mate], {
        orgId,
        key: loose.row.key,
        rev: moved.rev,
        kind: "spec",
      }).pipe(Effect.flip);
      assert.notStrictEqual(reasonOf(refused), undefined);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a doc keeps the images, charts and visuals its markdown shows, only from where its writer could see them",
  () => {
    const pages: Array<string> = [];
    const store = Layer.mock(KinAttachmentStore)({
      storePage: (html) =>
        Effect.sync(() => {
          pages.push(html);
          return `kin-chat-page-${pages.length}-html`;
        }),
    });
    return Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
        author_member_id, author_role, kind, body, mentions_json, status, created_at, attachments_json)
      VALUES ('photo', ${orgId}, 'lead-chat', 2, 'human', ${ownerId}, 'lead-chat-owner', 'owner', 'text',
        'Our invented logo', '[]', 'posted', ${at},
        '[{"id":"kin-chat-logo-png","type":"image","name":"logo.png","mimeType":"image/png","sizeBytes":10}]')`;
      yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
      VALUES ('kin-chat-logo-png', ${orgId}, 'lead-chat', 'photo')`;
      const inChat = { ...agentWriter(lead), chatId: KinChatId.make("lead-chat") };
      const chart = JSON.stringify({
        chart: "bar",
        title: "Invented signups",
        unit: { kind: "count" },
        labels: ["W1", "W2"],
        series: [{ name: "Signups", values: [3, 5] }],
      });
      const page = '<h1>Invented funnel</h1><img src="kin-file:kin-chat-logo-png">';
      const body = [
        "# Invented report",
        "",
        "![Our logo](kin-file:kin-chat-logo-png)",
        "",
        "```kin_chart",
        chart,
        "```",
        "",
        "```kin_visual Invented funnel",
        page,
        "```",
        "",
      ].join("\n");
      const create = (text: string, writer: KinRecords.Writer, origin: string) =>
        Docs.create(
          orgId,
          writer,
          {},
          {
            title: "Invented report",
            body: text,
            owner: { _tag: "agent", agentId: lead },
            summary: "Created",
            originKey: origin,
          },
        );
      for (const [text, writer, says] of [
        [body, agentWriter(lead), "kin-file:kin-chat-logo-png is not a file in this chat"],
        [body.replace('"bar"', '"pie_ish"'), inChat, "A kin_chart block must hold"],
        [
          body.replace("kin_visual Invented funnel", "kin_visual"),
          inChat,
          "A kin_visual block: A visual needs a title",
        ],
      ] as const) {
        const refused = yield* Effect.flip(create(text, writer, `refused:${says}`));
        assert.strictEqual(reasonOf(refused), "invalid_state");
        assert.include(refused.message, says);
      }
      assert.deepStrictEqual(pages, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM kin_doc_files`, []);

      const created = yield* create(body, inChat, "made");
      const { key } = created.row;
      const detail = yield* OwnerDocs.get([owner], { orgId, key });
      assert.deepStrictEqual(
        detail.embeds?.map((embed) => embed._tag),
        ["chart", "visual"],
      );
      assert.deepInclude(detail.embeds![0]!, { _tag: "chart" });
      assert.deepStrictEqual(detail.embeds![1], {
        _tag: "visual",
        title: "Invented funnel",
        attachmentId: "kin-chat-page-1-html",
        height: 360,
      });
      assert.deepStrictEqual(pages, [page]);
      const files = sql`SELECT attachment_id AS id, mime_type AS mime, page_sha256 IS NOT NULL AS page
      FROM kin_doc_files WHERE record_id = ${created.row.recordId} ORDER BY attachment_id`;
      assert.deepStrictEqual(yield* files, [
        { id: "kin-chat-logo-png", mime: "image/png", page: 0 },
        { id: "kin-chat-page-1-html", mime: "text/html", page: 1 },
      ]);
      // A later version, even from a turn with no chat, keeps the doc's own files and its page once.
      yield* Docs.edit(
        orgId,
        agentWriter(lead),
        {},
        { key },
        {
          operations: [{ op: "append", text: "More invented notes." }],
          summary: "Added notes",
          originKey: "append",
        },
      );
      assert.deepStrictEqual(pages, [page]);
      assert.lengthOf(yield* files, 2);
      // Another doc may show that file, but only for a writer who can read the doc it is from.
      yield* sql`INSERT INTO kin_doc_files (org_id, record_id, attachment_id, mime_type, page_sha256, created_at)
        VALUES (${orgId}, 'not-a-doc', 'kin-chat-stray-png', 'image/png', NULL, ${at})`;
      const reuse = (writer: KinRecords.Writer, id: string, origin: string) =>
        create(`# Invented reuse\n\n![Logo](kin-file:${id})`, writer, origin);
      const mate: KinRecords.Writer = { actor: { _tag: "person", personId: mateId }, via: "owner" };
      for (const [writer, id] of [
        [mate, "kin-chat-logo-png"],
        [agentWriter(lead), "kin-chat-stray-png"],
      ] as const) {
        const refused = yield* Effect.flip(reuse(writer, id, `reuse:${id}:${writer.actor._tag}`));
        assert.include(
          refused.message,
          `kin-file:${id} is not a file in this chat or in another doc`,
        );
      }
      yield* reuse(agentWriter(lead), "kin-chat-logo-png", "reuse:lead");
    }).pipe(Effect.provide(Layer.merge(store, layer)));
  },
);

it.effect(
  "a playbook's kin block is checked on every write, read by the threshold, and seeded once",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const writer = agentWriter(lead);
      const block = (lines: string) =>
        `# Invented chasing\n\nChase politely.\n\n\`\`\`kin\n${lines}\n\`\`\`\n`;
      const refusal = <A, R>(effect: Effect.Effect<A, KinChatError, R>) =>
        Effect.flip(effect).pipe(Effect.map((error) => error.message));
      const chase = () =>
        playbookThreshold(orgId, "chase_invoice_after_days").pipe(
          Effect.map(({ value, from }) => [value, from._tag === "playbook" ? from.key : "default"]),
        );

      assert.deepStrictEqual(yield* chase(), [10, "default"]);
      assert.include(
        yield* refusal(
          newDoc(block("chase_invoice_after_days: 500"), { title: "Too long", kind: "playbook" }),
        ),
        "chase invoice after days must be 1 to 120 days; nothing was changed",
      );
      assert.include(
        yield* refusal(newDoc(block("chase_after: 5"), { title: "Unknown", kind: "playbook" })),
        "chase_after isn't a playbook setting",
      );
      const docs = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'docs'`;
      assert.strictEqual(docs[0]?.count, 0);

      const money = yield* newDoc(block("chase_invoice_after_days: 10"), {
        title: "Invented chasing money",
        kind: "playbook",
        company: true,
      });
      const key = money.row.key;
      const edit = (find: string, replace: string, originKey: string) =>
        Docs.edit(
          orgId,
          writer,
          {},
          { key },
          {
            operations: [{ op: "replace_phrase", find, replace }],
            summary: "Chase sooner",
            originKey,
          },
        );
      yield* edit("after_days: 10", "after_days: 7", "seven");
      assert.deepStrictEqual(yield* chase(), [7, key]);
      assert.include(
        yield* refusal(edit("after_days: 7", "after_days: 0", "zero")),
        "must be 1 to 120 days",
      );
      assert.strictEqual((yield* Docs.versionOf(orgId, money.row.recordId))!.version, 2);
      assert.deepStrictEqual(yield* chase(), [7, key]);

      // A second playbook can't set the same key; a client's own playbook may, for that client.
      assert.include(
        yield* refusal(
          newDoc(block("chase_invoice_after_days: 3"), { title: "Dup", kind: "playbook" }),
        ),
        `already set in ${key}`,
      );
      const records = yield* KinRecords.KinRecords;
      const client = yield* records.create(orgId, writer, {
        list: "clients",
        originKey: "client",
        title: "Invented Lumen",
        owner: { _tag: "agent", agentId: lead },
        category: "client",
      });
      yield* newDoc(block("chase_invoice_after_days: 20"), {
        title: "Invented Lumen pays late",
        kind: "playbook",
        partyId: client.row.recordId,
      });
      assert.strictEqual(
        (yield* playbookThreshold(orgId, "chase_invoice_after_days", client.row.recordId)).value,
        20,
      );
      assert.include(
        yield* refusal(
          newDoc(block("overloaded_load: 3"), {
            title: "Lumen load",
            kind: "playbook",
            partyId: client.row.recordId,
          }),
        ),
        "belongs in a company playbook",
      );

      // Restoring, or filing a doc as a playbook, checks it the same way.
      const notes = yield* newDoc(block("chase_invoice_after_days: 4"), { title: "Old notes" });
      assert.include(
        yield* refusal(Docs.move(orgId, writer, { key: notes.row.key }, { kind: "playbook" })),
        `already set in ${key}`,
      );
      yield* edit("chase_invoice_after_days: 7", "", "drop");
      yield* newDoc(block("chase_invoice_after_days: 12"), {
        title: "Takes over",
        kind: "playbook",
      });
      assert.include(
        yield* refusal(
          Docs.restore(orgId, writer, {}, { key }, { version: 2, latest: 3, originKey: "back" }),
        ),
        "already set in",
      );
      assert.strictEqual((yield* chase())[0], 12);

      // The default set lands once, and an archived seed stays archived.
      const boss = KinPersonId.make("boss");
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${boss}, ${elsewhere}, 'boss', 'Boss', ${at})`;
      assert.strictEqual(yield* seedPlaybooks(elsewhere, boss), PLAYBOOK_SEEDS.length);
      const index = yield* playbookIndex(elsewhere);
      assert.strictEqual(index.length, PLAYBOOK_SEEDS.length);
      assert.match(index[0]!, /^D-\d+ Taking on a client: Someone new wants work from us/);
      yield* sql`UPDATE kin_records SET state = 'dropped' WHERE org_id = ${elsewhere}
        AND title = 'Chasing money'`;
      assert.strictEqual(yield* seedPlaybooks(elsewhere, boss), 0);
      assert.strictEqual((yield* playbookIndex(elsewhere)).length, PLAYBOOK_SEEDS.length - 1);
      assert.strictEqual(
        (yield* playbookThreshold(elsewhere, "chase_invoice_after_days")).from._tag,
        "default",
      );
      assert.strictEqual((yield* playbookThreshold(elsewhere, "overloaded_load")).value, 8);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "every live agent gets a character only owner-level people read, and a host set keeps its history",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_leads SET domain = 'finance' WHERE agent_id = ${lead}`;
      yield* sql`UPDATE kin_leads SET domain = 'invented-seat' WHERE agent_id = ${other}`;
      assert.strictEqual(yield* seedCharacters(orgId), 2);
      assert.strictEqual(yield* seedCharacters(orgId), 0);
      const [mine, theirs] = yield* characters(orgId);
      // The finance default for the finance seat; a starter, from its charter, for the other.
      assert.include(mine!.body, "Money is real when it is in the bank");
      assert.include(theirs!.body, "This is a starter character.");
      assert.strictEqual(
        parseCharacter(mine!.body).colleagues?.startsWith("Cynical and exact"),
        true,
      );
      assert.notInclude(parseCharacter(mine!.body).voice, "## Examples");
      // A teammate can't find it, by key or by search; the owner's level can.
      const hidden = yield* Effect.flip(
        Docs.docRow(orgId, { key: mine!.key }, viewerOfPeople([mateId])),
      );
      assert.strictEqual(hidden.reason, "not_found");
      assert.strictEqual(
        (yield* Docs.docRow(orgId, { key: mine!.key }, KIN_OWNER_LEVEL)).key,
        mine!.key,
      );
      // The owner's own text from the host is a new version; the old one stays in its history.
      const own = "# Finance\n\nTo colleagues: Invented line.\n\nInvented voice.\n";
      assert.strictEqual((yield* setCharacter(orgId, lead, own)).outcome, "set");
      assert.strictEqual((yield* setCharacter(orgId, lead, own)).outcome, "unchanged");
      const record = yield* Docs.docRow(orgId, { key: mine!.key }, KIN_OWNER_LEVEL);
      assert.deepStrictEqual(
        (yield* Docs.history(orgId, record.recordId, { limit: 5 })).map((one) => one.version),
        [2, 1],
      );
      assert.include((yield* characters(orgId))[0]!.body, "Invented voice.");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a doc's chat of origin opens for those in it; owner, co-owner or member outside it reads only its agent",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const coOwnerId = KinPersonId.make("co-owner");
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
        VALUES (${coOwnerId}, ${orgId}, 'co', 'Co', 'co_owner', ${at})`;
      yield* sql`UPDATE kin_people SET sees_docs = 1 WHERE person_id = ${mateId}`;
      const chatId = KinChatId.make("lead-chat");
      const { row } = yield* newDoc(plan, {
        source: { chatId, messageId: KinMessageId.make("ask") },
      });
      // Shared with the team, as the play-test's brief was.
      yield* sql`UPDATE kin_records SET team_shared = 1 WHERE record_id = ${row.recordId}`;
      const origin = (personId: KinPersonId) =>
        OwnerDocs.get([{ _tag: "person", orgId, personId }], { orgId, key: row.key }).pipe(
          Effect.map(({ links }) => links.filter((link) => link.kind === "message")),
        );
      const opens = { chatId, label: null, target: "ask" };
      const closed = { chatId: null, label: null, closedChat: { agent: "Lead lead" } };
      assert.deepInclude((yield* origin(ownerId))[0]!, opens);
      assert.notProperty((yield* origin(ownerId))[0]!, "closedChat");
      assert.deepInclude((yield* origin(coOwnerId))[0]!, closed);
      assert.deepInclude((yield* origin(mateId))[0]!, closed);
      // Once in the chat, the member follows the link as the owner does.
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('lead-chat-mate', ${orgId}, ${chatId}, 'person', ${mateId}, 'member', ${at})`;
      assert.deepInclude((yield* origin(mateId))[0]!, opens);
      // The owner who left it reads it closed too.
      yield* sql`UPDATE kin_chat_members SET left_at = ${at} WHERE member_id = 'lead-chat-owner'`;
      assert.deepInclude((yield* origin(ownerId))[0]!, closed);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "playbooks are the team's to read, until the owner marks one private: then it is hidden from them",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_people SET sees_docs = 1 WHERE person_id = ${mateId}`;
      assert.strictEqual(yield* seedPlaybooks(orgId, ownerId), PLAYBOOK_SEEDS.length);
      const mate = { _tag: "person" as const, orgId, personId: mateId };
      const listed = (yield* OwnerDocs.list([mate], { orgId })).docs;
      assert.lengthOf(listed, PLAYBOOK_SEEDS.length);
      const chasing = listed.find((doc) => doc.title === "Chasing money")!;
      const other = listed.find((doc) => doc.key !== chasing.key)!;
      const found = (text: string) =>
        OwnerDocs.search([mate], { orgId, text }).pipe(
          Effect.map(({ hits }) => hits.map((hit) => hit.key)),
        );
      assert.include(yield* found("chasing"), chasing.key);

      yield* OwnerDocs.label([owner], { orgId, key: chasing.key, sensitive: true });
      assert.notInclude(
        (yield* OwnerDocs.list([mate], { orgId })).docs.map((doc) => doc.key),
        chasing.key,
      );
      assert.strictEqual(
        reasonOf(yield* Effect.flip(OwnerDocs.get([mate], { orgId, key: chasing.key }))),
        "not_found",
      );
      assert.notInclude(yield* found("chasing"), chasing.key);
      // An agent working for them reads the rest and never the private one.
      yield* turn("mate", "shared");
      assert.strictEqual(
        reasonOf(yield* Effect.flip(LeadDocs.read(scopeOf(lead), { key: chasing.key }))),
        "not_found",
      );
      assert.strictEqual((yield* LeadDocs.read(scopeOf(lead), { key: other.key })).key, other.key);
      assert.strictEqual(
        (yield* OwnerDocs.get([owner], { orgId, key: chasing.key })).key,
        chasing.key,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "What we sell is found by its origin key and made once, kept by the sales agent; archived, it leaves the pinned read until started again",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_leads SET domain = 'chief-of-staff' WHERE agent_id = ${lead}`;
      yield* sql`UPDATE kin_leads SET domain = 'sales' WHERE agent_id = ${other}`;
      const mate = { _tag: "person" as const, orgId, personId: mateId };
      const pinned = () => OwnerDocs.list([owner], { orgId, whatWeSell: true });
      assert.isUndefined(yield* findOfferings(orgId));
      assert.lengthOf((yield* pinned()).docs, 0);

      const start = OwnerDocs.startWhatWeSell([owner], { orgId });
      const [first, second] = yield* Effect.all([start, start], { concurrency: 2 });
      assert.strictEqual(first.key, second.key);
      const [made] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_records
        WHERE org_id = ${orgId} AND origin_key = ${OFFERINGS_ORIGIN}`;
      assert.strictEqual(made!.count, 1);
      assert.strictEqual(first.latest.version, 1);
      assert.deepStrictEqual(first.owner, { _tag: "agent", agentId: other });
      assert.strictEqual(first.company, true);
      assert.strictEqual(first.kind, "other");
      assert.isFalse(first.sensitive);
      assert.deepStrictEqual(offeringsIndex(first.body), [
        "Who is a good customer for us",
        "Our first offering",
      ]);
      assert.strictEqual(first.whatWeSell, true);
      assert.deepStrictEqual(
        (yield* pinned()).docs.map((doc) => [doc.key, doc.whatWeSell]),
        [[first.key, true]],
      );
      // Only the owner level starts it.
      assert.strictEqual(
        reasonOf(yield* Effect.flip(OwnerDocs.startWhatWeSell([mate], { orgId }))),
        "not_allowed",
      );

      // Archived, it is no longer pinned; started again, the same doc comes back as it was left.
      yield* Docs.move(orgId, agentWriter(other), { key: first.key }, { archived: true });
      assert.lengthOf((yield* pinned()).docs, 0);
      const again = yield* OwnerDocs.startWhatWeSell([owner], { orgId });
      assert.strictEqual(again.key, first.key);
      assert.isFalse(again.archived);
      assert.strictEqual(again.latest.version, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "an agent's doc_create with whatWeSell starts the one What we sell, then gives its key; a teammate's turn can't",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* turn();
      // An ordinary doc titled like it is left as it is; the flagged call makes the real one.
      const plain = yield* LeadDocs.create(scopeOf(lead), {
        sourceEventId: "ask-event",
        title: "What we sell",
        body: "## Old list\nLedgerline.",
        company: true,
      });
      const body =
        "# What we sell\n\n## Who is a good customer for us\nInvented warehouses.\n\n## Ledgerline stock counts\nCounts stock for 380 a warehouse.\n";
      const start = (text: string) =>
        LeadDocs.create(scopeOf(lead), {
          sourceEventId: "ask-event",
          title: "Our offerings",
          body: text,
          sensitive: true,
          whatWeSell: true,
        });
      const made = yield* start(body);
      assert.notStrictEqual(made.key, plain.key);
      assert.deepInclude(made, {
        title: "What we sell",
        version: 1,
        changed: true,
        kind: "other",
        company: true,
      });
      assert.isUndefined(made.sensitive);
      assert.notProperty(made, "note");
      assert.strictEqual((yield* findOfferings(orgId))?.key, made.key);
      const pinned = () => OwnerDocs.list([owner], { orgId, whatWeSell: true });
      assert.deepStrictEqual(
        (yield* pinned()).docs.map((doc) => [doc.key, doc.whatWeSell]),
        [[made.key, true]],
      );
      const index = yield* offeringsPromptIndex(orgId, KIN_OWNER_LEVEL);
      assert.deepStrictEqual(index._tag === "index" ? index.index.sections : index._tag, [
        "Who is a good customer for us",
        "Ledgerline stock counts",
      ]);
      assert.strictEqual(
        (yield* Docs.docRow(orgId, { key: plain.key }, KIN_OWNER_LEVEL)).title,
        "What we sell",
      );

      // Called again, it writes nothing and names the one there is.
      const again = yield* start("## Something else");
      assert.deepInclude(again, { key: made.key, version: 1, changed: false });
      assert.include("note" in again ? again.note : "", made.key);
      const [versions] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
        FROM kin_doc_versions v JOIN kin_records r ON r.org_id = v.org_id AND r.record_id = v.record_id
        WHERE r.org_id = ${orgId} AND r.origin_key = ${OFFERINGS_ORIGIN}`;
      assert.strictEqual(versions!.count, 1);

      // Archived, it comes back as the card's start brings it back.
      yield* Docs.move(orgId, agentWriter(lead), { key: made.key }, { archived: true });
      const back = yield* start(body);
      assert.deepInclude(back, { key: made.key, version: 1 });
      assert.notStrictEqual((yield* findOfferings(orgId))?.state, "dropped");
      assert.lengthOf((yield* pinned()).docs, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("a teammate's shared turn can't start What we sell, and nothing is written", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_people SET sees_docs = 1 WHERE person_id = ${mateId}`;
    yield* turn("mate", "shared");
    const refused = yield* Effect.flip(
      LeadDocs.create(scopeOf(lead), {
        sourceEventId: "ask-event",
        title: "What we sell",
        body: "## Ledgerline\nInvented.",
        whatWeSell: true,
      }),
    );
    assert.strictEqual(reasonOf(refused), "not_allowed");
    assert.strictEqual(
      "message" in refused ? refused.message : "",
      "Only the owner or a co-owner starts What we sell, in a chat only they are in. Nothing was written.",
    );
    assert.isUndefined(yield* findOfferings(orgId));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a proposal refused for a teammate in their own chat says to draft it for the owner; in a group it doesn't",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('s-mate', ${orgId}, ${mateId}, 0)`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('mate-chat', ${orgId}, 'direct', ${`${mateId}:${lead}`}, 1, ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('mate-chat-mate', ${orgId}, 'mate-chat', 'person', ${mateId}, 'owner', ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
        VALUES ('mate-chat-lead', ${orgId}, 'mate-chat', 'agent', ${lead}, 'member', ${at})`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
          author_member_id, author_role, kind, body, mentions_json, status, created_at)
        VALUES ('ask', ${orgId}, 'mate-chat', 1, 'human', ${mateId}, 'mate-chat-mate', 'owner', 'text',
          'Draft the invented proposal for Acme', '[]', 'posted', ${at})`;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status,
          event_ids, audience)
        VALUES ('wake', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '["ask-event"]', 'shared')`;
      const event = {
        _tag: "chat.message",
        orgId,
        agentId: lead,
        eventId: "ask-event",
        receivedAt: at,
        dedupeKey: null,
        provenance: { _tag: "human", personId: mateId, memberId: "mate-chat-mate" },
        chatId: "mate-chat",
        messageId: "ask",
      };
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
          queued_at, state, wakeup_id)
        VALUES ('ask-event', ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0,
          'claimed', 'wake')`;
      const propose = Effect.flip(
        LeadDocs.create(scopeOf(lead), {
          sourceEventId: "ask-event",
          title: "Invented proposal for Acme",
          kind: "proposal",
          body: "## Scope\n\nInvented scope.\n\n## Price\n\nLeft for the owner.",
        }),
      );
      const refused = yield* propose;
      assert.strictEqual(reasonOf(refused), "not_allowed");
      assert.strictEqual(
        "message" in refused ? refused.message : "",
        "Only the owner or a co-owner changes that. Nothing was written. Draft it for Owner instead: put the draft in kin_ask_person to Owner as its detail, with draft naming its kind and the client or deal key, leaving blank what only Owner decides, such as a price, with the options Approve (kind yes) and Changes first. Then tell Mate in one line that it is with Owner to approve, with the draft under that line.",
      );
      const docs = sql`SELECT 1 FROM kin_records WHERE org_id = ${orgId} AND register_id = 'docs'`;
      assert.lengthOf(yield* docs, 0);
      // A chat others share asks nobody outside it, so its refusal names no card.
      yield* sql`UPDATE kin_chats SET kind = 'team_group', direct_key = NULL WHERE chat_id = 'mate-chat'`;
      const inGroup = yield* propose;
      assert.strictEqual(
        "message" in inGroup ? inGroup.message : "",
        "Only the owner or a co-owner changes that.",
      );
      assert.lengthOf(yield* docs, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("a teammate with Docs reads What we sell, and their turn's agent can't change it", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_people SET sees_docs = 1 WHERE person_id = ${mateId}`;
    const doc = yield* OwnerDocs.startWhatWeSell([owner], { orgId });
    const mate = { _tag: "person" as const, orgId, personId: mateId };
    assert.deepStrictEqual(
      (yield* OwnerDocs.list([mate], { orgId, whatWeSell: true })).docs.map((row) => row.key),
      [doc.key],
    );
    yield* turn("mate", "shared");
    assert.strictEqual((yield* LeadDocs.read(scopeOf(lead), { key: doc.key })).key, doc.key);
    const edited = yield* Effect.flip(
      LeadDocs.edit(scopeOf(lead), {
        key: doc.key,
        sourceEventId: "ask-event",
        summary: "Added a worry",
        operations: [{ op: "append", text: "They worry about invented downtime." }],
      }),
    );
    assert.strictEqual(reasonOf(edited), "not_allowed");
    assert.strictEqual((yield* Docs.versionOf(orgId, doc.recordId))!.version, 1);
  }).pipe(Effect.provide(layer)),
);
