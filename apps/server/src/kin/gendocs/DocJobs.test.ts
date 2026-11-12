// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinWorkerId,
  ProviderInstanceId,
  ThreadId,
  type WorkerReport,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { sharedToolAllowed } from "../lead/SharedTools.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Docs from "../work/docs.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as LeadMoney from "../work/leadMoney.ts";
import * as LeadWork from "../work/leadWork.ts";
import * as OwnerMoney from "../work/ownerMoney.ts";
import * as DocJobs from "./DocJobs.ts";
import * as Numbers from "./numbering.ts";
import * as Workspace from "./workspace.ts";

// Invented org, company, client, GSTINs and amounts only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const lead = KinAgentId.make("lead");
const at = "2026-11-11T00:00:00.000Z";
const people = [{ _tag: "person" as const, orgId, personId: ownerId }];
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make("lead-thread"),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
};
const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: lead,
      ownerPersonId: ownerId,
      threadId: ThreadId.make("lead-thread"),
    }),
});
const cards: Array<{
  readonly documents: ReadonlyArray<{ readonly key: string }>;
  readonly lastError: string | null;
}> = [];
const chat = Layer.mock(KinChatService)({
  setTaskCardDocuments: (input) =>
    Effect.sync(() => {
      cards.push({ documents: input.documents, lastError: input.lastError });
    }).pipe(Effect.as({} as never)),
});
// Kin's card for the owner, stored as the chat service stores a lead's question; no level gate here.
const gate = Layer.unwrap(
  Effect.map(SqlClient.SqlClient, (sql) =>
    Layer.mock(KinLevelGate)({
      ask: (agent, input) =>
        Effect.gen(function* () {
          const messageId = `card-${input.clientMessageId}`;
          const widgetId = `choice:${messageId}`;
          const [{ seq }] = (yield* sql<{ seq: number }>`SELECT 1000 + COUNT(*) AS seq
            FROM kin_widgets`) as [{ seq: number }];
          const state = {
            question: input.question,
            detail: input.detail ?? null,
            options: input.options.map((option, index) => ({
              optionId: `option-${index + 1}`,
              ...option,
            })),
            answer: null,
          };
          yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
              author_agent_id, author_owner_person_id, author_thread_id, author_member_id,
              author_role, kind, body, mentions_json, status, created_at, client_message_id)
            VALUES (${messageId}, ${agent.orgId}, ${input.chatId}, ${seq}, 'agent', ${agent.agentId},
              ${ownerId}, 'lead-thread', 'lead-chat-lead', 'member', 'text', '', '[]', 'posted',
              ${at}, ${`send:${input.clientMessageId}`})
            ON CONFLICT DO NOTHING`;
          yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class,
              type, revision, state_json, awaiting_json, updated_at)
            VALUES (${widgetId}, ${agent.orgId}, ${input.chatId}, ${messageId}, 'native', 'choice', 1,
              ${JSON.stringify(state)}, ${JSON.stringify([ownerId])}, ${at})
            ON CONFLICT DO NOTHING`;
          return { widgetId } as never;
        }).pipe(Effect.orDie),
    }),
  ),
);
const base = Layer.mergeAll(KinRecords.layer, identity, gate).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);
const layer = DocJobs.collectorLayer.pipe(
  Layer.provideMerge(Workspace.layer),
  Layer.provideMerge(Vcs.layer),
  Layer.provideMerge(chat),
  Layer.provideMerge(base),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-doc-jobs-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/** A turn the owner woke with a message in the lead's direct chat. */
const turn = (n: number, body: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
    yield* sql`UPDATE kin_chats SET last_seq = ${n} WHERE chat_id = 'lead-chat'`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
      VALUES (${`msg-${n}`}, ${orgId}, 'lead-chat', ${n}, 'human', ${ownerId}, 'lead-chat-owner',
        'owner', 'text', ${body}, '[]', 'posted', ${at})`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids, audience)
      VALUES (${`wake-${n}`}, ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
        ${JSON.stringify([`event-${n}`])}, 'owner_only')`;
    const event = {
      _tag: "chat.message",
      orgId,
      agentId: lead,
      eventId: `event-${n}`,
      receivedAt: at,
      dedupeKey: null,
      provenance: { _tag: "human", personId: ownerId, memberId: "lead-chat-owner" },
      chatId: "lead-chat",
      messageId: `msg-${n}`,
    };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
        received_at, queued_at, state, wakeup_id)
      VALUES (${`event-${n}`}, ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)},
        0, 0, 'claimed', ${`wake-${n}`})`;
    return `event-${n}`;
  });

/** The owner's lead in India's zone, an invoices list, a client in another state, one invoice. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(Date.parse("2026-11-12T06:00:00.000Z"));
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at) VALUES (${lead}, ${orgId}, 'Lead lead', 'lead', ${ownerId}, ${at}, NULL)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('lead-chat', ${orgId}, 'direct', 'owner:lead', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('lead-chat-owner', ${orgId}, 'lead-chat', 'person', ${ownerId}, 'owner', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('lead-chat-lead', ${orgId}, 'lead-chat', 'agent', ${lead}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id)
    VALUES (${lead}, ${orgId}, 'Lead lead', 0, 'lead-thread', '{}', '[]', 'lead-chat')`;
  const asked = yield* turn(1, "Track invoices");
  const proposed = yield* LeadMoney.define(scope, { sourceEventId: asked, template: "invoices" });
  const yes = yield* turn(2, "Yes");
  yield* LeadMoney.define(scope, { sourceEventId: yes, proposal: proposed.proposal! });
  yield* OwnerMoney.setCompanyProfile(people, {
    orgId,
    rev: 0,
    legalName: "Sample Studio Private Limited",
    gstin: "29AAAAA1111A1Z5",
    placeOfSupply: "Karnataka",
    bank: { accountNumber: "000111222333", ifsc: "ABCD0123456" },
  });
  const work = yield* turn(3, "Invoice Invented Acme for October");
  yield* LeadWork.create(scope, {
    sourceEventId: work,
    records: [{ list: "clients", title: "Invented Acme", placeOfSupply: "Maharashtra" }],
  });
  yield* LeadWork.create(scope, {
    sourceEventId: work,
    records: [
      {
        list: "invoices",
        title: "October retainer",
        client: "Invented Acme",
        amount: "1,000.01",
        state: "open",
      },
    ],
  });
  return work;
});

const input = (
  recipe: string,
  more: Partial<DocJobs.DocumentInput> = {},
): DocJobs.DocumentInput => ({
  title: "Invoice INV-1",
  recipe,
  sourceEventId: "event-3",
  ...more,
});
const shell = { available: true } as const;

describe("document jobs", () => {
  it.effect("give the worker only the recipe's declared inputs, read from stored rows", () =>
    Effect.gen(function* () {
      yield* seed;
      const draft = yield* DocJobs.planJob(
        orgId,
        input("invoice", { entry: "INV-1", inputs: { billTo: "1 Sample Road, Pune" } }),
        shell,
      );
      const declared = draft.recipe!.inputs.map((one) => one.name);
      assert.deepStrictEqual(Object.keys(draft.inputs), declared);
      assert.deepStrictEqual(
        [draft.inputs.total, draft.inputs.client, draft.inputs.clientPlace, draft.inputs.supplier],
        [
          { minor: 100_001, currency: "INR" },
          "Invented Acme",
          "Maharashtra",
          "Sample Studio Private Limited",
        ],
      );
      assert.deepStrictEqual(
        [draft.number, draft.draft, draft.inputs.draft, draft.sensitive],
        [null, true, true, true],
      );
      // An amount Kin stores is never the agent's to give, and an undeclared name isn't either.
      for (const inputs of [{ total: "₹5" }, { discount: "10" }]) {
        const refused = yield* DocJobs.planJob(
          orgId,
          input("invoice", { entry: "INV-1", inputs }),
          shell,
        ).pipe(Effect.flip);
        assert.match(refused.message, /doesn't take (total|discount) from you/);
      }
      // Issued, the same plan carries its number and is no draft.
      const writer = {
        actor: { _tag: "person" as const, personId: ownerId },
        via: "owner" as const,
      };
      yield* Numbers.issue(orgId, writer, "INV-1");
      const issued = yield* DocJobs.planJob(orgId, input("invoice", { entry: "INV-1" }), shell);
      assert.deepStrictEqual([issued.number, issued.draft], ["INV/26-27/001", false]);
      // A table holds only its declared columns.
      const pack = yield* DocJobs.planJob(
        orgId,
        input("accountant-pack", { inputs: { month: "2026-11" } }),
        shell,
      );
      const rows = pack.inputs.invoices as ReadonlyArray<Record<string, unknown>>;
      assert.deepStrictEqual(
        rows.map((row) => Object.keys(row).sort()),
        [["amount", "client", "date", "key", "number", "state", "tax"]],
      );
      assert.deepStrictEqual([rows[0]!.number, rows[0]!.state], ["INV/26-27/001", "Issued"]);
      // A recipe runs commands, so a host whose workers have no shell refuses it before it starts.
      const noShell = yield* DocJobs.planJob(orgId, input("report", { inputs: { title: "Q3" } }), {
        available: false,
        reason: "this host is darwin",
      }).pipe(Effect.flip);
      assert.match(noShell.message, /no shell \(this host is darwin\)/);
      // Every new tool is refused in a turn someone besides the owner reads.
      const turnRef = { orgId, agentId: lead, wakeupId: "wake-3" };
      for (const tool of ["kin_document", "kin_recipes", "kin_issue"])
        assert.isFalse(yield* sharedToolAllowed(turnRef, tool, { recipe: "report" }), tool);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "file only the named files under out/, with provenance from the job's row, never the report",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const workspace = yield* Workspace.KinWorkspace;
        const collector = yield* DocJobs.KinDocCollector;
        const [entry] = yield* sql<{
          recordId: string;
        }>`SELECT record_id AS "recordId" FROM kin_records
        WHERE org_id = ${orgId} AND key = 'INV-1'`;
        const job = (workerId: KinWorkerId) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id,
              model_json, provenance_json, status, started_at, title, chat_id, context)
            VALUES (${workerId}, ${orgId}, ${lead}, 'wake-3', 'build', ${`kin-work:${workerId}`}, '{}',
              '{}', 'running', 0, 'Invoice INV-1', 'lead-chat', 'private')`;
            yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode, recipe,
              recipe_commit, entry_record_id, inputs_sha256, number, sensitive, doc_origin, worktree_path,
              branch, chat_id, audience, answered_message_id, answered_author_kind, answered_author_id,
              created_at)
            VALUES (${orgId}, ${workerId}, ${lead}, 'wake-3', 'document', 'invoice', 'commit-a',
              ${entry!.recordId}, 'inputs-a', NULL, 1, ${`recipe:invoice:${entry!.recordId}`}, '', '',
              'lead-chat', 'owner_only', 'msg-3', 'person', ${ownerId}, 0)`;
            const prepared = yield* workspace.prepare(orgId, workerId, {});
            yield* fs.makeDirectory(`${prepared.worktree}/out`, { recursive: true });
            yield* fs.writeFileString(
              `${prepared.worktree}/out/invoice.pdf`,
              "%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n",
            );
            yield* fs.writeFileString(`${prepared.worktree}/out/extra.pdf`, "%PDF-1.7\n%%EOF\n");
            yield* fs.symlink("/etc/hosts", `${prepared.worktree}/out/linked.pdf`);
            return prepared;
          });
        const report: WorkerReport = {
          result: "done",
          // The worker claims a number, a recipe and a file Kin never filed; none of it is used.
          summary: "Made INV/99-00/999 with recipe evil at commit deadbeef.",
          evidence: [
            { kind: "file", ref: "out/invoice.pdf", note: "number INV/99-00/999" },
            { kind: "file", ref: "out/linked.pdf" },
            { kind: "file", ref: "out/extra.pdf" },
            { kind: "file", ref: "../../etc/passwd" },
          ],
          openQuestions: [],
          memorySuggestions: [],
          misleadingMemory: [],
          parsed: true,
        };
        const first = KinWorkerId.make("wk-first");
        const prepared = yield* job(first);
        const worker = { orgId, workerId: first, threadId: ThreadId.make(`kin-work:${first}`) };
        const result = yield* collector.collect(worker, true, report);
        assert.deepStrictEqual(
          result?.evidence.map((item) => [item.kind, item.ref]),
          [["link", "D-1"]],
        );
        assert.match(result!.summary, /^Kin filed the file as D-1\./);
        assert.strictEqual(result!.openQuestions.length, 3);
        assert.isFalse(yield* fs.exists(prepared.worktree), "the worktree goes with its inputs");
        const doc = yield* Docs.docRow(orgId, { key: "D-1" });
        const version = Docs.toVersion((yield* Docs.versionOf(orgId, doc.recordId))!);
        assert.deepStrictEqual(
          {
            name: version.file?.name,
            recipe: version.file?.recipe,
            inputsHash: version.file?.inputsHash,
            workerId: version.file?.workerId,
            number: version.file?.number,
            draft: version.file?.draft,
            answered: version.provenance.answered?.messageId,
            sensitive: doc.sensitive,
          },
          {
            name: "invoice.pdf",
            recipe: { name: "invoice", commit: "commit-a" },
            inputsHash: "inputs-a",
            workerId: first,
            number: null,
            draft: true,
            answered: "msg-3",
            sensitive: 1,
          },
        );
        const stored = yield* fs.readFileString(
          `${config.attachmentsDir}/${version.file!.attachmentId}.pdf`,
        );
        assert.match(stored, /^%PDF-1\.7/);
        assert.deepStrictEqual(
          cards.at(-1)?.documents.map((one) => one.key),
          ["D-1"],
        );
        // Collecting again changes nothing; a file doc's text isn't edited.
        yield* collector.collect(worker, true, report);
        assert.lengthOf(yield* Docs.history(orgId, doc.recordId, { limit: 10 }), 1);
        const writer = { actor: { _tag: "agent" as const, agentId: lead }, via: "lead" as const };
        const edit = yield* Docs.rewrite(
          orgId,
          writer,
          {},
          { key: "D-1" },
          {
            body: "text",
            baseVersion: 1,
            summary: "x",
            originKey: "edit-1",
          },
        ).pipe(Effect.flip);
        assert.match(edit.message, /generated file/);
        // The same recipe and entry again is the next version of the same doc.
        const second = KinWorkerId.make("wk-second");
        yield* job(second);
        yield* collector.collect(
          { ...worker, workerId: second, threadId: ThreadId.make(`kin-work:${second}`) },
          true,
          report,
        );
        const versions = yield* Docs.history(orgId, doc.recordId, { limit: 10 });
        assert.deepStrictEqual(
          versions.map((one) => one.version),
          [2, 1],
        );
        // A run that didn't finish files nothing, and the card says why.
        const third = KinWorkerId.make("wk-third");
        yield* job(third);
        const stopped = yield* collector.collect(
          { ...worker, workerId: third, threadId: ThreadId.make(`kin-work:${third}`) },
          false,
          report,
        );
        assert.strictEqual(stopped?.result, "blocked");
        assert.match(cards.at(-1)?.lastError ?? "", /didn't finish/);
      }).pipe(Effect.provide(layer)),
  );
});
