// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the fake renderer's content hash.
import * as NodeCrypto from "node:crypto";

import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  KinWorkerId,
  ProviderInstanceId,
  ThreadId,
  type WorkerReport,
} from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as OwnerDocs from "../work/ownerDocs.ts";
import * as OwnerMoney from "../work/ownerMoney.ts";
import { computeData } from "./compute.ts";
import * as DocJobs from "./DocJobs.ts";
import { gatherFacts, jobSensitive } from "./facts.ts";
import * as LeadDocuments from "./leadDocuments.ts";
import { assembleInputs, needsEntry, parseRecipe } from "./recipe.ts";
import * as Render from "./render.ts";
import { STARTER_FILES } from "./starter.ts";
import { KinToolchain } from "./toolchain.ts";
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
// Doc cards the agent's call showed in the chat, by the key of the doc each shows.
const shownCards: Array<string> = [];
// Kin's card for the owner, stored as the chat service stores a lead's question; no level gate here.
const gate = Layer.unwrap(
  Effect.map(SqlClient.SqlClient, (sql) =>
    Layer.mock(KinLevelGate)({
      showCard: (_agent, input) =>
        Effect.sync(() => {
          shownCards.push(String(Reflect.get(input.state as object, "key")));
        }).pipe(Effect.as({} as never)),
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
// Threads whose processes the fake scope can't confirm gone; every other thread's are.
const alive = new Set<string>();
const scopes = Layer.succeed(AgentScope, {
  ...AgentScope.defaultValue(),
  reap: (threadId: string) => Effect.succeed(!alive.has(threadId)),
});
/**
 * Typst stands aside here (`render.test.ts` runs it): a typst recipe "renders" as a PDF holding
 * its computed data, so a test reads the figures Kin worked out. Table recipes and storing are real.
 */
const rendered: Array<{ readonly request: Render.RenderRequest; readonly data: unknown }> = [];
const failing = { reason: undefined as string | undefined };
const renderer = Layer.effect(
  Render.KinDocRenderer,
  Effect.gen(function* () {
    const real = yield* Render.KinDocRenderer;
    return Render.KinDocRenderer.of({
      store: real.store,
      render: (request) => {
        if (failing.reason !== undefined)
          return Effect.succeed({ _tag: "failed", reason: failing.reason });
        if (request.recipe.kind === "table") return real.render(request);
        const computed = computeData(request.inputs, request.recipe.computed);
        if ("error" in computed) return Effect.succeed({ _tag: "failed", reason: computed.error });
        rendered.push({ request, data: computed.data });
        const bytes = new TextEncoder().encode(
          `%PDF-1.7\n% ${JSON.stringify(request.inputs)}\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n`,
        );
        return Effect.succeed({
          _tag: "made",
          files: request.recipe.outputs.map((name) => ({
            name,
            extension: "pdf",
            mimeType: "application/pdf",
            bytes,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
            pages: 1,
          })),
        });
      },
    });
  }),
).pipe(Layer.provide(Render.layer));
const toolchain = Layer.succeed(KinToolchain, {
  ensure: () =>
    Effect.fail(new KinChatError({ reason: "unavailable", message: "no Typst in these tests" })),
});
const layer = DocJobs.makeCollectorLayer({ sweepPage: 1 }).pipe(
  Layer.provideMerge(renderer),
  Layer.provideMerge(toolchain),
  Layer.provideMerge(scopes),
  Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
  Layer.provideMerge(Workspace.layer),
  Layer.provideMerge(Vcs.layer),
  Layer.provideMerge(chat),
  Layer.provideMerge(base),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-doc-jobs-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformCrypto.layer)),
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
  rendered.length = 0;
  shownCards.length = 0;
  failing.reason = undefined;
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
    records: [
      {
        list: "clients",
        title: "Invented Acme",
        placeOfSupply: "Maharashtra",
        address: "4 Invented Lane, Pune 411001",
      },
    ],
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

const invoice = (more: Partial<DocJobs.DocumentInput> = {}): DocJobs.DocumentInput => ({
  title: "Invoice INV-1",
  recipe: "invoice",
  entry: "INV-1",
  sourceEventId: "event-3",
  ...more,
});
const versionsOf = (key: string) =>
  Effect.gen(function* () {
    const doc = yield* Docs.docRow(orgId, { key });
    const history = yield* Docs.history(orgId, doc.recordId, { limit: 10 });
    return { doc, history };
  });
const latestData = () => rendered.at(-1)!.data as Record<string, any>;

/** A one-off job as `document` records it, with a worktree holding a PDF, a stray and a link. */
const docJob = (workerId: KinWorkerId, options: { readonly worker: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* Workspace.KinWorkspace;
    const prepared = yield* workspace.prepare(orgId, workerId, {
      "in/inputs.json": '{"brief":"An invented note"}',
    });
    yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id,
        model_json, provenance_json, status, started_at, ended_at, title, chat_id, context)
      VALUES (${workerId}, ${orgId}, ${lead}, 'wake-3', 'build', ${`kin-work:${workerId}`}, '{}',
        '{}', ${options.worker}, 0, ${options.worker === "running" ? null : 1}, 'Welcome note',
        'lead-chat', 'private')`;
    yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode, recipe,
        recipe_commit, entry_record_id, inputs_sha256, number, sensitive, doc_origin, worktree_path,
        branch, chat_id, audience, answered_message_id, answered_author_kind, answered_author_id,
        created_at)
      VALUES (${orgId}, ${workerId}, ${lead}, 'wake-3', 'document', NULL, ${prepared.base}, NULL,
        'inputs-a', NULL, 1, 'file:welcome', ${prepared.worktree}, ${prepared.branch},
        'lead-chat', 'owner_only', 'msg-3', 'person', ${ownerId}, 0)`;
    yield* fs.makeDirectory(`${prepared.worktree}/out`, { recursive: true });
    yield* fs.writeFileString(
      `${prepared.worktree}/out/note.pdf`,
      "%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n",
    );
    yield* fs.writeFileString(`${prepared.worktree}/out/extra.pdf`, "%PDF-1.7\n%%EOF\n");
    yield* fs.symlink("/etc/hosts", `${prepared.worktree}/out/linked.pdf`);
    return prepared;
  });
const owed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ workerId: string }>`SELECT worker_id AS "workerId" FROM kin_doc_jobs
    WHERE org_id = ${orgId} AND removed_at IS NULL ORDER BY worker_id`;
  return rows.map((row) => row.workerId);
});
const pdfReport: WorkerReport = {
  result: "done",
  summary: "Made it.",
  evidence: [{ kind: "file", ref: "out/note.pdf" }],
  openQuestions: [],
  memorySuggestions: [],
  misleadingMemory: [],
  parsed: true,
};
const threadOf = (workerId: KinWorkerId) => ThreadId.make(`kin-work:${workerId}`);

/** A worker's job writing the quote recipe, collected; `n` names the job and its description. */
const writeQuote = (n: number, sensitive = 0) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const workspace = yield* Workspace.KinWorkspace;
    const collector = yield* DocJobs.KinDocCollector;
    const workerId = KinWorkerId.make(`wk-quote-${n}`);
    const job = yield* workspace.prepare(orgId, workerId, {});
    const folder = `${job.worktree}/recipes/quote`;
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(
      `${folder}/RECIPE.md`,
      STARTER_FILES["recipes/report/RECIPE.md"]!.replace("name: report", "name: quote")
        .replace("title: Report", "title: Quote")
        .replace(/^description: .*$/m, `description: Quote ${n}.`)
        .replace("[report.pdf]", "[quote.pdf]"),
    );
    yield* fs.writeFileString(`${folder}/template.typ`, '#let d = json("/inputs.json")\n');
    yield* fs.writeFileString(
      `${folder}/sample.json`,
      STARTER_FILES["recipes/report/sample.json"]!,
    );
    yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind,
        thread_id, model_json, provenance_json, status, started_at, ended_at, title, chat_id,
        context)
      VALUES (${workerId}, ${orgId}, ${lead}, 'wake-3', 'build', ${threadOf(workerId)}, '{}',
        '{}', 'running', 0, NULL, 'Quote recipe', 'lead-chat', 'private')`;
    yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode, recipe,
        recipe_commit, entry_record_id, inputs_sha256, number, sensitive, doc_origin,
        worktree_path, branch, chat_id, audience, created_at)
      VALUES (${orgId}, ${workerId}, ${lead}, 'wake-3', 'recipe', 'quote', ${job.base}, NULL,
        'brief', NULL, ${sensitive}, 'recipe:quote', ${job.worktree}, ${job.branch}, 'lead-chat',
        'owner_only', 0)`;
    return yield* collector.collect({ orgId, workerId, threadId: threadOf(workerId) }, true, {
      ...pdfReport,
      evidence: [],
    });
  });

describe("recipe documents", () => {
  it.effect("are made in the call from the recipe's declared inputs, read from stored rows", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const made = yield* LeadDocuments.make(scope, invoice());
      assert.deepStrictEqual(made, {
        workerId: null,
        threadLink: null,
        recipe: "invoice",
        number: null,
        draft: true,
        documents: [{ key: "D-1", title: "Invoice INV-1", version: 1 }],
        sensitive: true,
      });
      assert.deepStrictEqual(shownCards, ["D-1"], "its doc card is in the chat");
      const { request, data } = rendered.at(-1)!;
      assert.deepStrictEqual(
        Object.keys(request.inputs),
        request.recipe.inputs.map((one) => one.name),
      );
      const figures = data as Record<string, any>;
      assert.deepStrictEqual(
        [
          request.inputs.total,
          request.inputs.client,
          request.inputs.clientAddress,
          request.inputs.supplier,
          request.inputs.draft,
          request.day,
        ],
        [
          { minor: 100_001, currency: "INR" },
          "Invented Acme",
          "4 Invented Lane, Pune 411001",
          "Sample Studio Private Limited",
          true,
          "2026-11-12",
        ],
      );
      // Karnataka to Maharashtra is inter-state: IGST, worked out by Kin, never by the template.
      assert.deepStrictEqual(
        [
          figures.tax.taxes.map((one: any) => [one.name, one.rate, one.amount.text]),
          figures.tax.total.text,
          figures.billedAt,
        ],
        [[["IGST", "18", "₹152.54"]], "₹1,000.01", "4 Invented Lane, Pune 411001"],
      );
      const { doc, history } = yield* versionsOf("D-1");
      const version = Docs.toVersion((yield* Docs.versionOf(orgId, doc.recordId))!);
      const [commit] = yield* sql<{ commit: string }>`SELECT recipe_commit AS "commit"
        FROM kin_doc_jobs WHERE org_id = ${orgId} ORDER BY created_at LIMIT 1`;
      assert.deepStrictEqual(
        {
          versions: history.length,
          name: version.file?.name,
          recipe: version.file?.recipe,
          rd: version.file?.workerId.startsWith("rd-"),
          number: version.file?.number,
          draft: version.file?.draft,
          answered: version.provenance.answered?.messageId,
          sensitive: doc.sensitive,
        },
        {
          versions: 1,
          name: "invoice.pdf",
          recipe: { name: "invoice", commit: commit!.commit },
          rd: true,
          number: null,
          draft: true,
          answered: "msg-3",
          sensitive: 1,
        },
      );
      // The same call again is the same job: nothing new is rendered or filed.
      const renders = rendered.length;
      assert.deepStrictEqual(
        (yield* LeadDocuments.make(scope, invoice())).documents,
        made.documents,
      );
      assert.deepStrictEqual(
        [rendered.length, (yield* versionsOf("D-1")).history.length],
        [renders, 1],
      );
      // An amount Kin stores is never the agent's to give, and an undeclared name isn't either.
      for (const inputs of [{ total: "₹5" }, { discount: "10" }]) {
        const refused = yield* LeadDocuments.make(scope, invoice({ inputs })).pipe(Effect.flip);
        assert.match(refused.message, /doesn't take (total|discount) from you/);
      }
      // A template that fails files nothing, and the agent gets Typst's words.
      failing.reason = "invoice.pdf: template.typ:3:2: error: unknown variable: totl";
      const broken = yield* LeadDocuments.make(scope, invoice({ title: "Invoice again" })).pipe(
        Effect.flip,
      );
      assert.match(broken.message, /^Nothing was made\. The invoice recipe didn't render: .*totl/);
      failing.reason = undefined;
      const jobs = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_doc_jobs
        WHERE org_id = ${orgId}`;
      assert.strictEqual(jobs[0]!.n, 1);
      // Every document tool is refused in a turn someone besides the owner reads.
      const turnRef = { orgId, agentId: lead, wakeupId: "wake-3" };
      for (const tool of ["kin_document", "kin_recipes", "kin_issue", "kin_recipe_undo"])
        assert.isFalse(yield* sharedToolAllowed(turnRef, tool, { recipe: "report" }), tool);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("are made again in place when the entry is issued, carrying its number", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* LeadDocuments.make(scope, invoice({ inputs: { billTo: "9 Invented Road, Pune" } }));
      // The number is issued even when its document fails to render; asking again makes it then.
      failing.reason = "invoice.pdf: an invented render failure";
      const first = yield* LeadDocuments.issue(scope, {
        entry: KinRecordKey.make("INV-1"),
        sourceEventId: "event-3",
      });
      assert.deepStrictEqual(
        [first.number, first.issued, first.documents.length, first.problems.length],
        ["INV/26-27/001", true, 0, 1],
      );
      failing.reason = undefined;
      const issued = yield* OwnerMoney.issue(people, { orgId, key: KinRecordKey.make("INV-1") });
      assert.deepStrictEqual(
        [issued.number, issued.issued, issued.documents, issued.problems],
        ["INV/26-27/001", false, [{ key: "D-1", title: "Invoice INV-1", version: 2 }], []],
      );
      const data = latestData();
      // Made with what was asked last time, now with its number and no longer a draft.
      assert.deepStrictEqual(
        [data.number, data.draft, data.billedAt],
        ["INV/26-27/001", false, "9 Invented Road, Pune"],
      );
      const { doc, history } = yield* versionsOf("D-1");
      const version = Docs.toVersion((yield* Docs.versionOf(orgId, doc.recordId))!);
      assert.deepStrictEqual(
        [history.map((one) => one.version), version.file?.number, version.file?.draft],
        [[2, 1], "INV/26-27/001", false],
      );
      // Issuing again changes nothing and makes nothing.
      const again = yield* LeadDocuments.issue(scope, {
        entry: KinRecordKey.make("INV-1"),
        sourceEventId: "event-3",
      });
      assert.deepStrictEqual([again.issued, again.documents], [false, []]);
      // The accountant's pack lists it by its number, from Kin's own exporter.
      const pack = yield* LeadDocuments.make(scope, {
        title: "November pack",
        recipe: "accountant-pack",
        inputs: { month: "2026-11" },
        sourceEventId: "event-3",
      });
      assert.deepStrictEqual(
        pack.documents.map((one) => one.title),
        [
          "November pack · accounts-2026-11.xlsx",
          "November pack · invoices-2026-11.csv",
          "November pack · payments-2026-11.csv",
          "November pack · expenses-2026-11.csv",
        ],
      );
      const csv = (yield* versionsOf(pack.documents[1]!.key)).doc;
      const file = Docs.toVersion((yield* Docs.versionOf(orgId, csv.recordId))!).file!;
      const config = yield* ServerConfig;
      const text = yield* (yield* FileSystem.FileSystem).readFileString(
        `${config.attachmentsDir}/${file.attachmentId}.csv`,
      );
      assert.match(text, /INV\/26-27\/001,INV-1,/);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("are made for the owner from the client too, and only for the owner", () =>
    Effect.gen(function* () {
      yield* seed;
      const asked = {
        orgId,
        recipe: "invoice",
        entry: KinRecordKey.make("INV-1"),
        clientRequestId: "make-1",
      };
      const someone = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("someone") }];
      const refused = yield* OwnerDocs.render(someone, asked).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "not_allowed");
      const preview = yield* OwnerDocs.render(people, { ...asked, preview: true });
      assert.deepStrictEqual(
        [preview.documents, preview.preview?.map((one) => one.name), preview.draft],
        [[], ["invoice.pdf"], true],
      );
      assert.isFalse(
        yield* Docs.docRow(orgId, { key: "D-1" }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      );
      const made = yield* OwnerDocs.render(people, asked);
      assert.deepStrictEqual(
        [made.documents.map((one) => [one.key, one.version]), made.preview, made.sensitive],
        [[["D-1", 1]], null, true],
      );
      assert.deepStrictEqual(shownCards, [], "no agent turn, so no chat card");
      // The same request again is the same document; the same id for another request is refused.
      assert.deepStrictEqual((yield* OwnerDocs.render(people, asked)).documents, made.documents);
      const reused = yield* OwnerDocs.render(people, { ...asked, title: "Another" }).pipe(
        Effect.flip,
      );
      assert.strictEqual(reused.reason, "not_allowed");
      // A preview neither takes an id nor finds what one filed.
      const again = yield* OwnerDocs.render(people, { ...asked, preview: true });
      assert.deepStrictEqual(
        again.preview?.map((one) => one.name),
        ["invoice.pdf"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("derive sensitivity from where inputs come from and from what the turn has read", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_records
          SET fields_json = json_set(fields_json, '$.gstin', '27AAAAA1111A1Z5')
          WHERE org_id = ${orgId} AND title = 'Invented Acme'`;
      const entry = yield* (yield* KinRecords.KinRecords).get(orgId, KinRecordKey.make("INV-1"));
      const sensitivity = (inputs: string, given: Record<string, unknown> = {}) =>
        Effect.gen(function* () {
          const recipe = parseRecipe(
            `---\nname: probe\ntitle: Probe\ndescription: probe\nsensitive: false\noutputs: [a.pdf]\ninputs:\n${inputs}\n---\nGo.\n`,
          );
          if ("reason" in recipe) return assert.fail(recipe.reason);
          const gathered = yield* gatherFacts(
            orgId,
            recipe,
            needsEntry(recipe) ? entry : undefined,
            given,
          );
          const assembled = assembleInputs(recipe, given, gathered.facts, gathered.currency);
          if ("error" in assembled) return assert.fail(assembled.error.message);
          return jobSensitive(recipe, assembled.inputs, gathered);
        });
      const cases: ReadonlyArray<readonly [string, string, Record<string, unknown>, boolean]> = [
        ["bank details", "  a: {type: text, from: company.bank.accountNumber}", {}, true],
        ["a company tax id", "  a: {type: text, from: company.gstin}", {}, true],
        ["the company's name", "  a: {type: text, from: company.legalName}", {}, false],
        ["the date", "  a: {type: date, from: system.today}", {}, false],
        ["an entry of a sensitive list", "  a: {type: text, from: entry.title}", {}, true],
        ["the client's tax id", "  a: {type: text, from: client.gstin}", {}, true],
        ["the client's address", "  a: {type: text, from: client.address}", {}, false],
        ["the agent's words", "  a: {type: text}", { a: "hello" }, false],
        ["an amount the agent gives", "  a: {type: money}", { a: "₹5" }, true],
        [
          "rows of a plain list",
          "  m: {type: month}\n  a: {type: table, from: rows.work, period: m, columns: {key: text}}",
          { m: "2026-11" },
          false,
        ],
        [
          "rows of a sensitive list",
          "  m: {type: month}\n  a: {type: table, from: rows.invoices, period: m, columns: {key: text}}",
          { m: "2026-11" },
          true,
        ],
        [
          "payments",
          "  m: {type: month}\n  a: {type: table, from: payments, period: m, columns: {invoice: text}}",
          { m: "2026-11" },
          true,
        ],
      ];
      for (const [what, inputs, given, expected] of cases)
        assert.strictEqual(yield* sensitivity(inputs, given), expected, what);

      // The agent's own words are plain, until its turn has read something sensitive.
      const quiet = yield* turn(4, "Write up the plan");
      const report = (title: string) =>
        LeadDocuments.make(scope, {
          title,
          recipe: "report",
          inputs: { title, body: "Revenue was as the owner said." },
          sourceEventId: quiet,
        });
      assert.isUndefined((yield* report("Plan")).sensitive);
      yield* sql`INSERT INTO kin_wakeup_sensitive_reads (org_id, wakeup_id, read_at)
          VALUES (${orgId}, 'wake-4', 0)`;
      const marked = yield* report("Plan after reading");
      assert.isTrue(marked.sensitive);
      assert.strictEqual((yield* versionsOf(marked.documents[0]!.key)).doc.sensitive, 1);
      // So are a worker's brief and a recipe it writes, labelled as the job is admitted.
      const brief = yield* DocJobs.planJob(orgId, {
        title: "Note",
        brief: "A short note.",
        sourceEventId: quiet,
      });
      const writing = yield* DocJobs.planJob(orgId, {
        title: "Quote",
        recipe: "quote",
        writeRecipe: true,
        brief: "A quote.",
        sourceEventId: quiet,
      });
      for (const plan of [brief, writing])
        assert.deepStrictEqual(
          [
            plan.sensitive,
            yield* DocJobs.workerJobSensitive(orgId, "wake-4", plan),
            yield* DocJobs.workerJobSensitive(orgId, "wake-1", plan),
          ],
          [false, true, false],
          plan.mode,
        );
      // A recipe's document is never a worker's job any more.
      const asWorker = yield* DocJobs.planJob(orgId, invoice()).pipe(Effect.flip);
      assert.match(asWorker.message, /Kin makes a recipe's document itself/);
    }).pipe(Effect.provide(layer)),
  );
});

describe("worker document jobs", () => {
  it.effect(
    "file only the named files under out/, with provenance from the job's row, never the report",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const fs = yield* FileSystem.FileSystem;
        const sql = yield* SqlClient.SqlClient;
        const config = yield* ServerConfig;
        const collector = yield* DocJobs.KinDocCollector;
        const report: WorkerReport = {
          result: "done",
          // The worker claims a number and a recipe Kin never gave; none of it is used.
          summary: "Made INV/99-00/999 with recipe evil at commit deadbeef.",
          evidence: [
            { kind: "file", ref: "out/note.pdf", note: "number INV/99-00/999" },
            { kind: "file", ref: "out/linked.pdf" },
            { kind: "file", ref: "../../etc/passwd" },
          ],
          openQuestions: [],
          memorySuggestions: [],
          misleadingMemory: [],
          parsed: true,
        };
        const first = KinWorkerId.make("wk-first");
        const prepared = yield* docJob(first, { worker: "running" });
        const worker = { orgId, workerId: first, threadId: threadOf(first) };
        const result = yield* collector.collect(worker, true, report);
        assert.deepStrictEqual(
          result?.evidence.map((item) => [item.kind, item.ref]),
          [["link", "D-1"]],
        );
        assert.match(result!.summary, /^Kin filed the file as D-1\./);
        assert.deepStrictEqual(result!.openQuestions, [
          "../../etc/passwd wasn't saved: it isn't a plain file name in out/.",
          "linked.pdf wasn't saved: it's a link.",
        ]);
        assert.isFalse(yield* fs.exists(prepared.worktree), "the worktree goes with its inputs");
        const { doc } = yield* versionsOf("D-1");
        const version = Docs.toVersion((yield* Docs.versionOf(orgId, doc.recordId))!);
        assert.deepStrictEqual(
          {
            name: version.file?.name,
            recipe: version.file?.recipe,
            inputsHash: version.file?.inputsHash,
            workerId: version.file?.workerId,
            number: version.file?.number,
            answered: version.provenance.answered?.messageId,
            sensitive: doc.sensitive,
          },
          {
            name: "note.pdf",
            recipe: null,
            inputsHash: "inputs-a",
            workerId: first,
            number: null,
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
        assert.lengthOf((yield* versionsOf("D-1")).history, 1);
        const writer = { actor: { _tag: "agent" as const, agentId: lead }, via: "lead" as const };
        const edit = yield* Docs.rewrite(
          orgId,
          writer,
          {},
          { key: "D-1" },
          { body: "text", baseVersion: 1, summary: "x", originKey: "edit-1" },
        ).pipe(Effect.flip);
        assert.match(edit.message, /generated file/);
        // A different outcome for the same job never replaces the stored one.
        const [row] = yield* sql<{ outcomeJson: string }>`SELECT outcome_json AS "outcomeJson"
          FROM kin_doc_jobs WHERE worker_id = ${first}`;
        const differing = yield* DocJobs.recordOutcome(orgId, first, '{"summary":"other"}').pipe(
          Effect.flip,
        );
        assert.strictEqual(differing.reason, "not_allowed");
        // A run that didn't finish files nothing, and the card says why.
        const third = KinWorkerId.make("wk-third");
        yield* docJob(third, { worker: "running" });
        const stopped = yield* collector.collect(
          { ...worker, workerId: third, threadId: threadOf(third) },
          false,
          report,
        );
        assert.strictEqual(stopped?.result, "blocked");
        assert.match(cards.at(-1)?.lastError ?? "", /didn't finish/);
        assert.strictEqual(
          yield* DocJobs.recordOutcome(orgId, first, row!.outcomeJson),
          row!.outcomeJson,
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("keep a recipe a worker wrote only once its sample renders", () =>
    Effect.gen(function* () {
      yield* seed;
      const workspace = yield* Workspace.KinWorkspace;
      const write = (n: number) => writeQuote(n);
      failing.reason = "quote.pdf: template.typ:2:1: error: unknown variable: blcks";
      const refused = yield* write(1);
      assert.match(
        refused!.summary,
        /didn't keep the quote recipe: its sample didn't render.*blcks/,
      );
      assert.isUndefined((yield* workspace.recipes(orgId)).find((one) => one.name === "quote"));
      failing.reason = undefined;
      const kept = yield* write(2);
      assert.match(kept!.summary, /rendered the quote recipe's sample and committed it/);
      assert.isDefined((yield* workspace.recipes(orgId)).find((one) => one.name === "quote"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "label every document made from a recipe a sensitive job wrote, until the owner clears it",
    () =>
      Effect.gen(function* () {
        yield* seed;
        let n = 0;
        const quote = (preview = false) =>
          OwnerDocs.render(people, {
            orgId,
            recipe: "quote",
            inputs: { title: "Quote", body: "Invented plain words." },
            clientRequestId: `quote-${(n += 1)}`,
            preview,
          }).pipe(Effect.map((made) => made.sensitive));
        const labelled = () =>
          Effect.map(
            OwnerDocs.recipes(people, { orgId }),
            (listed) => listed.recipes.find((one) => one.name === "quote")?.labelled === true,
          );
        assert.match((yield* writeQuote(1, 1))!.summary, /committed it/);
        assert.deepStrictEqual(
          [yield* quote(), yield* quote(true), yield* labelled()],
          [true, true, true],
        );
        // A plain job's change built on it keeps the label.
        assert.match((yield* writeQuote(2))!.summary, /committed it/);
        assert.isTrue(yield* quote());
        yield* OwnerDocs.clearRecipeLabel(people, { orgId, recipe: "quote" });
        assert.deepStrictEqual([yield* quote(), yield* labelled()], [false, false]);
        // Undo brings back the first revision with its own label; redo brings back the cleared one.
        yield* OwnerDocs.undoRecipe(people, { orgId, recipe: "quote" });
        assert.isTrue(yield* quote());
        yield* OwnerDocs.undoRecipe(people, { orgId, recipe: "quote" });
        assert.isFalse(yield* quote());
        const someone = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("someone") }];
        const refused = yield* OwnerDocs.clearRecipeLabel(someone, { orgId, recipe: "quote" }).pipe(
          Effect.flip,
        );
        assert.strictEqual(refused.reason, "not_allowed");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("remove a job's worktree and inputs whatever ended it, and say so on its row", () =>
    Effect.gen(function* () {
      yield* seed;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const collector = yield* DocJobs.KinDocCollector;
      // An outcome stored before a crash still owes the worktree; collecting again removes it.
      const stranded = KinWorkerId.make("wk-stranded");
      const left = yield* docJob(stranded, { worker: "running" });
      yield* sql`UPDATE kin_doc_jobs SET collected_at = 1,
          outcome_json = '{"summary":"Kin filed no file from this job.","documents":[],"problems":[]}'
        WHERE worker_id = ${stranded}`;
      const again = yield* collector.collect(
        { orgId, workerId: stranded, threadId: threadOf(stranded) },
        true,
        pdfReport,
      );
      assert.match(again!.summary, /^Kin filed no file/);
      assert.isFalse(yield* fs.exists(left.worktree));
      // A run that ended without collection (abandoned, crashed, failed to launch) goes at startup,
      // across pages of the sweep; a running one stays.
      const failed = KinWorkerId.make("wk-failed");
      const failedToo = KinWorkerId.make("wk-failed-too");
      const running = KinWorkerId.make("wk-running");
      const failedTree = yield* docJob(failed, { worker: "failed" });
      const failedTooTree = yield* docJob(failedToo, { worker: "failed" });
      const runningTree = yield* docJob(running, { worker: "running" });
      assert.deepStrictEqual(yield* owed, [failed, failedToo, running]);
      yield* collector.sweep;
      assert.deepStrictEqual(yield* owed, [running]);
      assert.isFalse(yield* fs.exists(failedTree.worktree));
      assert.isFalse(yield* fs.exists(failedTooTree.worktree));
      assert.isTrue(yield* fs.exists(`${runningTree.worktree}/in/inputs.json`));
      // Cleanup takes the inputs first, and never follows a link planted in their place.
      yield* fs.remove(`${runningTree.worktree}/in`, { recursive: true });
      const outside = `${runningTree.worktree}.outside`;
      yield* fs.makeDirectory(`${outside}/in`, { recursive: true });
      yield* fs.writeFileString(`${outside}/inputs.json`, "not the job's");
      yield* fs.writeFileString(`${outside}/in/inputs.json`, "not the job's either");
      yield* fs.symlink(outside, `${runningTree.worktree}/in`);
      yield* collector.cleanup(orgId, running);
      assert.deepStrictEqual(yield* owed, []);
      assert.strictEqual(yield* fs.readFileString(`${outside}/inputs.json`), "not the job's");
      // Nor a worktree that is itself a link to a folder elsewhere: nothing there is removed.
      const linked = KinWorkerId.make("wk-linked");
      const linkedTree = yield* docJob(linked, { worker: "failed" });
      yield* fs.remove(linkedTree.worktree, { recursive: true });
      yield* fs.symlink(outside, linkedTree.worktree);
      yield* collector.cleanup(orgId, linked);
      assert.strictEqual(
        yield* fs.readFileString(`${outside}/in/inputs.json`),
        "not the job's either",
      );
      assert.deepStrictEqual(yield* owed, [linked], "still owed: Kin removed nothing");
      yield* fs.remove(linkedTree.worktree);
      yield* fs.remove(outside, { recursive: true });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("take nothing back until the worker's processes are confirmed gone", () =>
    Effect.gen(function* () {
      yield* seed;
      const fs = yield* FileSystem.FileSystem;
      const collector = yield* DocJobs.KinDocCollector;
      const workerId = KinWorkerId.make("wk-alive");
      const prepared = yield* docJob(workerId, { worker: "running" });
      alive.add(threadOf(workerId));
      const refused = yield* collector.collect(
        { orgId, workerId, threadId: threadOf(workerId) },
        true,
        pdfReport,
      );
      assert.strictEqual(refused?.result, "blocked");
      assert.match(refused!.summary, /couldn't confirm the worker had stopped/);
      assert.deepStrictEqual(refused?.evidence, []);
      assert.isFalse(yield* fs.exists(prepared.worktree));
    }).pipe(Effect.provide(layer)),
  );
});
