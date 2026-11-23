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
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { chatShared } from "../chat/sharing.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { sharedToolAllowed } from "../lead/SharedTools.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { countryFirstMessage, newCompanyProfileJson, setProfile } from "../work/companyProfile.ts";
import * as Docs from "../work/docs.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as LeadMoney from "../work/leadMoney.ts";
import * as LeadWork from "../work/leadWork.ts";
import { outlook } from "../work/moneyAnswers.ts";
import { moneySection, moneySummary } from "../work/moneyViews.ts";
import * as OwnerDocs from "../work/ownerDocs.ts";
import * as OwnerMoney from "../work/ownerMoney.ts";
import * as OwnerMoneyAnswers from "../work/ownerMoneyAnswers.ts";
import { UNISSUED_INVOICE } from "../work/recordRows.ts";
import * as OwnerWork from "../work/ownerWork.ts";
import * as Amounts from "./amounts.ts";
import { computeData } from "./compute.ts";
import * as AgentFiles from "./agentFiles.ts";
import { gatherFacts, jobSensitive } from "./facts.ts";
import * as LeadDocuments from "./leadDocuments.ts";
import { answerReceiptCard } from "./receiptProposals.ts";
import { assembleInputs, needsEntry, parseRecipe } from "./recipe.ts";
import { labelChange } from "./recipeLabels.ts";
import { checkReferences } from "./references.ts";
import * as Render from "./render.ts";
import { STARTER_FILES } from "./starter.ts";
import { sheetCells } from "./tables.ts";
import { KinToolchain } from "./toolchain.ts";
import * as Workspace from "./workspace.ts";
import { KIN_OWNER_LEVEL } from "../work/teamView.ts";

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
// Notices Kin posted, by chat.
const notices: Array<{ readonly chatId: string; readonly body: string }> = [];
const chat = Layer.unwrap(
  Effect.map(SqlClient.SqlClient, (sql) =>
    Layer.mock(KinChatService)({
      notice: (input) =>
        Effect.gen(function* () {
          if (input.audience === "owner" && (yield* chatShared(sql, input)))
            return yield* new KinChatError({ reason: "not_allowed", message: "shared" });
          notices.push({ chatId: input.chatId, body: input.body });
          yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
              author_member_id, author_role, kind, body, mentions_json, status, created_at)
            VALUES (${input.messageId}, ${input.orgId}, ${input.chatId}, ${9000 + notices.length},
              'system', NULL, 'member', 'system', ${input.body}, '[]', 'posted', ${at})`;
          return {} as never;
        }).pipe(Effect.catchTags({ SqlError: Effect.die })),
    }),
  ),
);
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
      ask: (agent, input, bind) =>
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
          if (bind !== undefined) yield* bind({ widgetId } as never);
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
      drawable: real.drawable,
      sheet: real.sheet,
      render: (request) => {
        if (failing.reason !== undefined)
          return Effect.succeed({ _tag: "failed", reason: failing.reason });
        if (request.recipe.kind === "table") return real.render(request);
        const computed = computeData(request.inputs, request.recipe.computed, request.tax);
        if ("error" in computed) return Effect.succeed({ _tag: "failed", reason: computed.error });
        rendered.push({ request, data: computed.data });
        const bytes = new TextEncoder().encode(
          `%PDF-1.7\n% ${JSON.stringify(request.inputs)}\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n`,
        );
        const page = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        return Effect.succeed({
          _tag: "made",
          ...(request.page === true
            ? {
                page: {
                  name: "page-1.png",
                  extension: "png",
                  mimeType: "image/png",
                  bytes: page,
                  sha256: NodeCrypto.createHash("sha256").update(page).digest("hex"),
                  pages: null,
                },
              }
            : {}),
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
  present: () => Effect.undefined,
  fonts: () => Effect.undefined,
});
const layer = renderer.pipe(
  Layer.provideMerge(toolchain),
  Layer.provideMerge(Workspace.layer),
  Layer.provideMerge(Vcs.layer),
  Layer.provideMerge(chat),
  Layer.provideMerge(base),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-documents-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformCrypto.layer)),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcs = yield* Vcs.VcsProcess;
    yield* vcs.run({
      operation: "KinDocJobsTest.git",
      command: "git",
      cwd,
      args: ["-c", "user.name=Owner", "-c", "user.email=owner@example.com", ...args],
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  });

/**
 * The owner's message `n` in the lead's direct chat, as an event of `wakeupId` stored at
 * `receivedAt`; with `tap`, their tap on a card instead.
 */
const said = (n: number, body: string, wakeupId: string, receivedAt: number, tap = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tag = tap ? "widget.action" : "chat.message";
    yield* sql`UPDATE kin_chats SET last_seq = ${n} WHERE chat_id = 'lead-chat'`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
      VALUES (${`msg-${n}`}, ${orgId}, 'lead-chat', ${n}, 'human', ${ownerId}, 'lead-chat-owner',
        'owner', ${tap ? "widget_action" : "text"}, ${body}, '[]', 'posted', ${at})`;
    const event = {
      _tag: tag,
      ...(tap ? { actionId: "choose" } : {}),
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
      VALUES (${`event-${n}`}, ${orgId}, ${lead}, ${tag}, 'P0', ${JSON.stringify(event)},
        ${receivedAt}, 0, 'claimed', ${wakeupId})`;
    return `event-${n}`;
  });

/** A turn the owner woke with a message in the lead's direct chat. */
const turn = (n: number, body: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids, audience)
      VALUES (${`wake-${n}`}, ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
        ${JSON.stringify([`event-${n}`])}, 'owner_only')`;
    return yield* said(n, body, `wake-${n}`, 0);
  });

/** The owner's next word in the running turn, at this moment: a message, or with `tap` a tap. */
const inRunningTurn = (body: string, tap = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [running] = yield* sql<{ wakeupId: string; n: number }>`SELECT w.wakeup_id AS "wakeupId",
        (SELECT last_seq + 1 FROM kin_chats WHERE chat_id = 'lead-chat') AS n
      FROM kin_wakeups w WHERE w.status = 'running'`;
    return yield* said(running!.n, body, running!.wakeupId, yield* Clock.currentTimeMillis, tap);
  });
/** The owner says more in the running turn after acting on the screen, so the agent may change it. */
const askedAgain = (body: string) => Effect.andThen(TestClock.adjust(1_000), inRunningTurn(body));

/** The owner's lead in India's zone, an invoices list, a client in another state, one invoice. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  rendered.length = 0;
  shownCards.length = 0;
  notices.length = 0;
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
  yield* LeadMoney.define(scope, { sourceEventId: asked, template: "invoices" });
  yield* turn(2, "Yes");
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

const invoice = (more: Partial<LeadDocuments.DocumentInput> = {}): LeadDocuments.DocumentInput => ({
  title: "Invoice INV-1",
  recipe: "invoice",
  entry: "INV-1",
  sourceEventId: "event-3",
  ...more,
});
const versionsOf = (key: string) =>
  Effect.gen(function* () {
    const doc = yield* Docs.docRow(orgId, { key }, KIN_OWNER_LEVEL);
    const history = yield* Docs.history(orgId, doc.recordId, { limit: 10 });
    return { doc, history };
  });
const latestData = () => rendered.at(-1)!.data as Record<string, any>;

/** writeRecipe as the agent calls it, in the turn `sourceEventId` names. */
const writeRecipe = (recipe: string, more: Partial<LeadDocuments.DocumentInput> = {}) =>
  AgentFiles.writeRecipe(scope, {
    title: `${recipe} recipe`,
    recipe,
    writeRecipe: true,
    sourceEventId: "event-3",
    ...more,
  });

/** The agent writes the quote recipe in the folder Kin gives it, from the report recipe. */
const editQuote = (
  folder: string,
  n: number,
  own: {
    readonly description?: string;
    readonly template?: string;
    /** RECIPE.md and sample.json as given, in place of the report recipe's renamed. */
    readonly recipe?: string;
    readonly sample?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const recipe = `${folder}/recipes/quote`;
    yield* fs.makeDirectory(recipe, { recursive: true });
    yield* fs.writeFileString(
      `${recipe}/RECIPE.md`,
      own.recipe ??
        STARTER_FILES["recipes/report/RECIPE.md"]!.replace("name: report", "name: quote")
          .replace("title: Report", "title: Quote")
          .replace(/^description: .*$/m, `description: ${own.description ?? `Quote ${n}.`}`)
          .replace("[report.pdf]", "[quote.pdf]"),
    );
    yield* fs.writeFileString(
      `${recipe}/template.typ`,
      own.template ?? '#let d = json("/inputs.json")\n',
    );
    yield* fs.writeFileString(
      `${recipe}/sample.json`,
      own.sample ?? STARTER_FILES["recipes/report/sample.json"]!,
    );
  });

/** The agent writes the quote recipe and asks Kin to keep it; its draft is labelled `sensitive`. */
const writeQuote = (n: number, sensitive = 0, own: Parameters<typeof editQuote>[2] = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const started = yield* writeRecipe("quote");
    yield* sql`UPDATE kin_doc_jobs SET sensitive = ${sensitive}
      WHERE mode = 'recipe' AND recipe = 'quote' AND collected_at IS NULL`;
    yield* editQuote(started.folder!, n, own);
    return yield* writeRecipe("quote");
  });

describe("recipe documents", () => {
  it.effect("are made in the call from the recipe's declared inputs, read from stored rows", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const made = yield* LeadDocuments.make(scope, invoice());
      assert.deepStrictEqual(made, {
        recipe: "invoice",
        number: null,
        draft: true,
        documents: [{ key: "D-1", title: "Invoice INV-1", version: 1 }],
        sensitive: true,
        next: 'Filed, with its card in the chat. Call it "Invoice INV-1" in your reply, never by its key.',
        record: { key: "INV-1", state: UNISSUED_INVOICE, total: "₹1,000.01" },
      });
      // What the agent says of it is the record, and what the company details lack, the first time.
      yield* sql`UPDATE kin_company_profile SET profile_json = json_set(profile_json,
          '$.gstin', NULL, '$.bank.accountNumber', NULL, '$.bank.upi', NULL)
        WHERE org_id = ${orgId}`;
      assert.deepStrictEqual((yield* LeadDocuments.onRecord(orgId, "INV-1"))?.missing, [
        "tax number (GSTIN)",
        "bank details",
      ]);
      yield* sql`UPDATE kin_company_profile SET profile_json = json_set(profile_json,
          '$.gstin', '29AAAAA1111A1Z5', '$.bank.accountNumber', '000111222333')
        WHERE org_id = ${orgId}`;
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
      assert.match(
        broken.message,
        /^Nothing was made\. The invoice recipe didn't render because .*totl/,
      );
      failing.reason = undefined;
      const jobs = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_doc_jobs
        WHERE org_id = ${orgId}`;
      assert.strictEqual(jobs[0]!.n, 1);
      // A client's tax number prints only for a company registered for the tax; the client keeps it.
      yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.gstin', '27BBBBB2222B1Z5')
        WHERE org_id = ${orgId} AND key = 'C-1'`;
      const profileRev = Effect.map(
        sql<{ rev: number }>`SELECT rev FROM kin_company_profile WHERE org_id = ${orgId}`,
        ([row]) => row!.rev,
      );
      const standing = (n: number) =>
        Effect.gen(function* () {
          yield* LeadDocuments.make(scope, invoice({ title: `Invoice INV-1 standing ${n}` }));
          const { request, data } = rendered.at(-1)!;
          const tax = (data as Record<string, any>).tax;
          return [request.inputs.clientGstin, tax.notCharged, tax.taxes.length, tax.placeOfSupply];
        });
      assert.deepStrictEqual(yield* standing(1), [
        "27BBBBB2222B1Z5",
        undefined,
        1,
        "Maharashtra (27)",
      ]);
      yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: yield* profileRev,
        taxRegistered: false,
      });
      assert.deepStrictEqual(yield* standing(2), [
        null,
        "GST not charged: the supplier is not registered under GST.",
        0,
        null,
      ]);
      // The agent is told once, and no longer asked to collect a GSTIN the company doesn't have.
      const note =
        "The company is not registered for GST: its invoices charge no GST and never show a client's GSTIN. Don't ask for or collect clients' GSTINs for invoices.";
      const told = yield* LeadDocuments.onRecord(orgId, "INV-1");
      assert.deepStrictEqual([told?.missing, told?.taxNote], [undefined, note]);
      assert.strictEqual((yield* LeadMoney.money(scope, {})).taxNote, note);
      assert.strictEqual((yield* LeadWork.get(scope, { key: "INV-1" })).taxNote, note);
      // Saying nothing with no GSTIN still prints no client's GSTIN, and no line either.
      yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: yield* profileRev,
        taxRegistered: null,
      });
      assert.deepStrictEqual((yield* standing(3)).slice(0, 3), [null, undefined, 0]);
      // A GSTIN typed again is registered again, and clears the word that it isn't.
      yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: yield* profileRev,
        taxRegistered: false,
      });
      const again = yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: yield* profileRev,
        gstin: "29AAAAA1111A1Z5",
      });
      assert.deepStrictEqual([again.gstin, again.taxRegistered], ["29AAAAA1111A1Z5", undefined]);
      assert.strictEqual((yield* standing(4))[0], "27BBBBB2222B1Z5");
      // Every document tool is refused in a turn someone besides the owner reads.
      const turnRef = { orgId, agentId: lead, wakeupId: "wake-3" };
      for (const tool of ["kin_document", "kin_recipes", "kin_issue", "kin_recipe_undo"])
        assert.isFalse(yield* sharedToolAllowed(turnRef, tool, { recipe: "report" }), tool);
      // So is filing a file the agent made, a screenshot included: a teammate's chat gets no doc.
      assert.isFalse(
        yield* sharedToolAllowed(turnRef, "kin_document", { file: "/srv/scratch/run/shot.png" }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "are listed to the agent with only the inputs it gives, and one recipe's read adds the rest once",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const listed = yield* LeadDocuments.recipes(scope, {});
        const invoiceRow = listed.recipes.find((one) => one.name === "invoice");
        const listedInput = (name: string) =>
          invoiceRow?.agentInputs.find((one) => one.name === name);
        assert.match(
          listedInput("gstRate")?.description ?? "",
          /18 unless the owner said otherwise/,
        );
        assert.deepStrictEqual(listedInput("lines")?.columns, [
          "description",
          "sac",
          "quantity",
          "unit",
          "rate",
        ]);
        for (const row of listed.recipes) {
          assert.notProperty(row, "storedInputs", row.name);
          assert.notProperty(row, "computed", row.name);
        }
        const read = yield* LeadDocuments.recipes(scope, { recipe: "invoice" });
        assert.deepStrictEqual(
          read.recipes.map((one) => one.name),
          ["invoice"],
        );
        const [one] = read.recipes;
        assert.deepStrictEqual(one?.agentInputs, invoiceRow?.agentInputs);
        const stored = one?.storedInputs ?? [];
        assert.isNotEmpty(stored);
        assert.isTrue(stored.every((input) => input.from !== "agent"));
        assert.isNotEmpty(one?.computed ?? []);
        assert.isNotEmpty(one?.outputs ?? []);
        const unknown = yield* LeadDocuments.recipes(scope, { recipe: "nothing" }).pipe(
          Effect.flip,
        );
        assert.match(unknown.message, /No recipe is called nothing/);
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
      // Issued with no due date, it is due the playbook's 15 payment days after its issue day.
      const dated = (yield* (yield* KinRecords.KinRecords).get(orgId, "INV-1"))!;
      assert.strictEqual(dated.dueAt! - dated.dateAt!, 15 * 86_400_000);
      failing.reason = undefined;
      const issued = yield* OwnerMoney.issue(people, { orgId, key: KinRecordKey.make("INV-1") });
      assert.deepStrictEqual(
        [issued.number, issued.issued, issued.documents, issued.problems],
        ["INV/26-27/001", false, [{ key: "D-1", title: "Invoice INV/26-27/001", version: 2 }], []],
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
      // Sonnet 5.5 distrusted issued false and checked again: the answer says what happened.
      assert.strictEqual(
        again.next,
        "Already issued as INV/26-27/001. Its documents already carry the number; there is nothing more to make.",
      );
      assert.strictEqual(
        first.next,
        "Issued as INV/26-27/001. Its documents couldn't be made: see problems.",
      );
      // F24: a void isn't final for the agent either: undone, it is owed again with its number.
      const voidIt = yield* askedAgain("Void INV-1, then put it back");
      const issueAs = (more: Partial<typeof LeadDocuments.IssueInput.Type>) =>
        LeadDocuments.issue(scope, {
          entry: KinRecordKey.make("INV-1"),
          sourceEventId: voidIt,
          ...more,
        });
      assert.strictEqual((yield* issueAs({ void: true })).state, "dropped");
      const back = yield* issueAs({ unvoid: true });
      assert.deepStrictEqual([back.state, back.number], ["waiting", "INV/26-27/001"]);
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
          "November pack · sales-register-2026-11.csv",
          "November pack · receipts-2026-11.csv",
          "November pack · tds-2026-11.csv",
          "November pack · expenses-2026-11.csv",
          "November pack · unpaid-expenses-2026-11.csv",
          "November pack · bank-2026-11.csv",
        ],
      );
      const config = yield* ServerConfig;
      const csvOf = (key: string) =>
        Effect.gen(function* () {
          const doc = (yield* versionsOf(key)).doc;
          const file = Docs.toVersion((yield* Docs.versionOf(orgId, doc.recordId))!).file!;
          return yield* (yield* FileSystem.FileSystem).readFileString(
            `${config.attachmentsDir}/${file.attachmentId}.csv`,
          );
        });
      const text = yield* csvOf(pack.documents[1]!.key);
      // Place of supply is the client's; taxable value is the total less the tax issued with it.
      assert.match(
        text,
        /^INV\/26-27\/001,\d{4}-\d{2}-\d{2},Invented Acme,,Maharashtra,847\.47,152\.54,1000\.01,INR,Issued,INV-1\r$/m,
      );
      // A title that starts with its own number, as an import writes one, shows the number once.
      yield* (yield* KinRecords.KinRecords).update(
        orgId,
        { actor: { _tag: "system" }, via: "import" },
        "INV-1",
        { title: "INV/26-27/001 · October retainer" },
      );
      yield* LeadDocuments.make(scope, invoice({ title: "Invoice INV-1 again" }));
      assert.strictEqual(rendered.at(-1)!.request.inputs.title, "October retainer");
      // TDS the client withheld settles it beside the money that came in, on its own line.
      const records = yield* KinRecords.KinRecords;
      const system = { actor: { _tag: "system" as const }, via: "import" as const };
      for (const [minor, withheld] of [
        [10_000, true],
        [90_001, false],
      ] as const)
        yield* records.pay(orgId, system, "INV-1", {
          amount: { minor, currency: "INR" },
          paidOn: "2026-11-12",
          originKey: `settle:${minor}`,
          withheld,
        });
      yield* LeadDocuments.make(scope, invoice({ title: "Invoice INV-1 settled" }));
      assert.deepStrictEqual(
        [
          (latestData().paidLines as ReadonlyArray<Record<string, unknown>>).map((one) => one.kind),
          latestData().balance.text,
        ],
        [["tds", "received"], "₹0.00"],
      );
      yield* records.update(orgId, system, "INV-1", {
        fields: { tax: { minor: 152_54, currency: "INR" } },
      });
      yield* records.update(orgId, system, "C-1", { fields: { gstin: "27AAAAA1111A1Z5" } });
      // The month's pack shows the TDS on its own sheet and only the money received as receipts.
      const settled = yield* LeadDocuments.make(scope, {
        title: "November pack settled",
        recipe: "accountant-pack",
        inputs: { month: "2026-11" },
        sourceEventId: "event-3",
      });
      const [receipts, tds] = [
        yield* csvOf(settled.documents[2]!.key),
        yield* csvOf(settled.documents[3]!.key),
      ];
      assert.include(receipts, ",900.01,INR");
      assert.notInclude(receipts, ",100.00,INR");
      assert.include(tds, "2026-11-12,INV/26-27/001,");
      assert.include(tds, ",100.00,INR");
      // Taxable value is the total less the tax as recorded, to the paisa.
      assert.include(
        yield* csvOf(settled.documents[1]!.key),
        ",Invented Acme,27AAAAA1111A1Z5,Maharashtra,847.47,152.54,1000.01,INR,Paid,INV-1\r\n",
      );
      // A company that isn't registered for the tax shows no client's GSTIN in the register either.
      const { rev } = (yield* (yield* SqlClient.SqlClient)<{ rev: number }>`SELECT rev
        FROM kin_company_profile WHERE org_id = ${orgId}`)[0]!;
      yield* OwnerMoney.setCompanyProfile(people, { orgId, rev, taxRegistered: false });
      const unregistered = yield* LeadDocuments.make(scope, {
        title: "November pack, not registered",
        recipe: "accountant-pack",
        inputs: { month: "2026-11" },
        sourceEventId: "event-3",
      });
      assert.include(
        yield* csvOf(unregistered.documents[1]!.key),
        ",Invented Acme,,Maharashtra,847.47,152.54,1000.01,INR,Paid,INV-1\r\n",
      );
      yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: rev + 1,
        gstin: "29AAAAA1111A1Z5",
      });

      // F51: expenses confirmed, undone and confirmed again: the file, the totals a chart is drawn
      // from and Money all count the live copy once.
      const track = yield* turn(10, "Track expenses");
      const proposed = yield* LeadMoney.define(scope, {
        sourceEventId: track,
        template: "expenses",
      });
      const yes = yield* turn(11, "Yes, and the CloudNest bill");
      yield* LeadMoney.define(scope, { sourceEventId: yes, proposal: proposed.proposal! });
      const spent = { list: "expenses", amount: "13,468.85", date: "2026-11-03" };
      yield* LeadWork.create(scope, {
        sourceEventId: yes,
        records: [{ ...spent, title: "Hosting" }],
      });
      yield* records.update(orgId, system, "EXP-1", { state: "dropped" });
      yield* LeadWork.create(scope, {
        sourceEventId: yes,
        records: [{ ...spent, title: "Hosting again" }],
      });
      const month = yield* LeadDocuments.make(scope, {
        title: "November pack again",
        recipe: "accountant-pack",
        inputs: { month: "2026-11" },
        sourceEventId: yes,
      });
      const expensesCsv = Docs.toVersion(
        (yield* Docs.versionOf(orgId, (yield* versionsOf(month.documents[4]!.key)).doc.recordId))!,
      ).file!;
      const expenses = yield* (yield* FileSystem.FileSystem).readFileString(
        `${config.attachmentsDir}/${expensesCsv.attachmentId}.csv`,
      );
      assert.notInclude(expenses, "EXP-1");
      assert.include(expenses, "EXP-2");
      const listed = yield* LeadWork.query(scope, { list: "expenses", groupBy: "month" });
      const money = yield* moneySummary(
        orgId,
        Date.parse("2026-11-12T06:00:00.000Z"),
        KIN_OWNER_LEVEL,
      );
      assert.deepStrictEqual(
        [listed.totals, listed.groups?.[0]?.totals, money.spent.thisMonth.total],
        [["₹13,468.85"], ["₹13,468.85"], [{ minor: 1_346_885, currency: "INR" }]],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("are issued with the total their own document comes to, never with none", () =>
    Effect.gen(function* () {
      const work = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      yield* LeadWork.create(scope, {
        sourceEventId: work,
        records: [
          {
            list: "invoices",
            title: "Website build",
            client: "Invented Acme",
            state: "open",
            due: "2026-11-05",
          },
        ],
      });
      const issueIt = (entry: string) =>
        LeadDocuments.issue(scope, { entry: KinRecordKey.make(entry), sourceEventId: work });
      // No amount and no document to work one out from: nothing is issued, no number taken.
      const bare = yield* issueIt("INV-2").pipe(Effect.flip);
      assert.match(bare.message, /^INV-2 has no amount/);
      const next = yield* OwnerMoney.nextNumber(people, { orgId, key: KinRecordKey.make("INV-2") });
      assert.strictEqual(next.number, "INV/26-27/001");
      // F14: drafted from its lines alone, it is issued with the total its PDF shows, tax split.
      yield* LeadDocuments.make(
        scope,
        invoice({
          entry: "INV-2",
          title: "Invoice INV-2",
          inputs: {
            lines: [{ description: "Design", sac: "998391", quantity: "2", rate: "₹1,00,000" }],
          },
        }),
      );
      const issued = yield* issueIt("INV-2");
      const row = (yield* records.get(orgId, "INV-2"))!;
      assert.deepStrictEqual(
        [issued.number, row.amountMinor, row.currency, JSON.parse(row.fieldsJson).tax],
        ["INV/26-27/001", 23_600_000, "INR", { minor: 3_600_000, currency: "INR" }],
      );
      assert.deepStrictEqual(
        [latestData().number, latestData().tax.total.text],
        ["INV/26-27/001", "₹2,36,000.00"],
      );
      // F47: Money, and the figures the morning brief reads, see it owed and overdue.
      const now = Date.parse("2026-11-12T06:00:00.000Z");
      const section = moneySection(
        yield* moneySummary(orgId, now, KIN_OWNER_LEVEL),
        "Asia/Kolkata",
      );
      assert.deepStrictEqual(
        [section?.owedToUs, section?.overdue, section?.byClient[0]?.daysOverdue],
        ["₹2,36,000.00", "₹2,36,000.00", 7],
      );

      // The issued document's own figures are kept beside its job, as it was rendered.
      assert.deepStrictEqual(
        yield* sql`SELECT number, total_minor AS total, tax_minor AS tax, currency,
            taxes_json AS taxes FROM kin_doc_job_figures WHERE org_id = ${orgId}`,
        [
          {
            number: "INV/26-27/001",
            total: 23_600_000,
            tax: 3_600_000,
            currency: "INR",
            taxes: '[{"amount":{"currency":"INR","minor":3600000},"name":"IGST","rate":"18"}]',
          },
        ],
      );

      // Review 45: an invoice issued before issuing wrote amounts is never given one at start, even
      // where its document still works out (₹1,000 + ₹180 GST reads ₹1,000 once the GSTIN is gone).
      // The owner is told of each, once, with what Kin believes, and sets it in a turn of his own.
      const system = { actor: { _tag: "system" as const }, via: "import" as const };
      const legacy = (key: string, seq: number) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO kin_issued_numbers (org_id, register_id, series, seq, number,
              record_id, issued_at, issued_by_kind, issued_by_id)
            SELECT org_id, 'invoices', 'INV|26-27', ${seq}, ${`INV/26-27/00${seq}`}, record_id, 0,
              'agent', ${lead}
            FROM kin_records WHERE org_id = ${orgId} AND key = ${key}`;
          yield* sql`UPDATE kin_records SET state = 'waiting', amount_minor = NULL,
              currency = NULL, fields_json = json_remove(fields_json, '$.tax')
            WHERE org_id = ${orgId} AND key = ${key}`;
        });
      yield* LeadWork.create(scope, {
        sourceEventId: work,
        records: [{ list: "invoices", title: "Retainer", client: "Invented Acme", state: "open" }],
      });
      yield* LeadDocuments.make(
        scope,
        invoice({
          entry: "INV-3",
          title: "Invoice INV-3",
          inputs: { lines: [{ description: "Retainer", quantity: "1", rate: "₹1,000" }] },
        }),
      );
      assert.strictEqual(latestData().tax.total.text, "₹1,180.00");
      yield* legacy("INV-3", 7);
      yield* sql`UPDATE kin_records SET amount_minor = NULL, currency = NULL,
          fields_json = json_remove(fields_json, '$.tax')
        WHERE org_id = ${orgId} AND key = 'INV-2'`;
      yield* records.create(orgId, system, {
        list: "invoices",
        title: "Imported retainer",
        originKey: "import:old-books:9",
        owner: { _tag: "agent", agentId: lead },
        state: "open",
      });
      yield* legacy("INV-4", 8);
      yield* OwnerMoney.setCompanyProfile(people, { orgId, rev: 1, gstin: null });
      const amounts = sql<{ key: string; minor: number | null }>`SELECT key,
          amount_minor AS minor FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'invoices' ORDER BY key`;
      const before = yield* amounts;
      // Two to a page, so three are read in two pages.
      const first = yield* Amounts.reportIssuedWithoutAmount(orgId, 2);
      assert.deepStrictEqual(
        [first.reported.toSorted(), first.kept, yield* amounts],
        [["INV-2", "INV-3", "INV-4"], [], before],
      );
      const told = (number: string, key: string, believed: string) =>
        `${number} (${key}) was issued with no amount, so it isn't counted in what you're owed. ${believed}`;
      assert.deepStrictEqual(
        notices.map((one) => [one.chatId, one.body]).toSorted(),
        [
          told(
            "INV/26-27/001",
            "INV-2",
            "Its issued document shows ₹2,36,000.00: confirm that, or tell your agent the right amount, and it records it.",
          ),
          told(
            "INV/26-27/007",
            "INV-3",
            "Its document comes to ₹1,000.00 with today's details, which may not be what it showed when it was issued: confirm that, or tell your agent the right amount, and it records it.",
          ),
          told(
            "INV/26-27/008",
            "INV-4",
            "Kin can't tell its amount from a document: tell your agent its amount, and it records it.",
          ),
        ].map((body) => ["lead-chat", body]),
      );
      // Each is told once; one found later is told even so.
      assert.deepStrictEqual(yield* Amounts.reportIssuedWithoutAmount(orgId), {
        reported: [],
        kept: [],
      });
      yield* LeadWork.create(scope, {
        sourceEventId: work,
        records: [{ list: "invoices", title: "Later", client: "Invented Acme", state: "open" }],
      });
      yield* legacy("INV-5", 9);
      // With no owner-only chat to take it, it waits for the next start rather than being dropped.
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES ('teammate', ${orgId}, 'teammate', 'Teammate', ${at}, 'member')`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at, left_at)
        VALUES ('lead-chat-teammate', ${orgId}, 'lead-chat', 'person', 'teammate', 'member', ${at}, ${at})`;
      yield* sql`UPDATE kin_chats SET shared_at = ${at} WHERE chat_id = 'lead-chat'`;
      assert.deepStrictEqual(yield* Amounts.reportIssuedWithoutAmount(orgId), {
        reported: [],
        kept: ["INV-5"],
      });
      assert.lengthOf(notices, 3);
      yield* sql`UPDATE kin_chats SET shared_at = NULL WHERE chat_id = 'lead-chat'`;
      assert.deepStrictEqual(yield* Amounts.reportIssuedWithoutAmount(orgId), {
        reported: ["INV-5"],
        kept: [],
      });
      assert.deepStrictEqual(yield* amounts, [...before, { key: "INV-5", minor: null }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("give a draft the amount and tax its lines come to, owed by nobody until issued", () =>
    Effect.gen(function* () {
      const work = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const now = Date.parse("2026-11-12T06:00:00.000Z");
      const figures = (key: string) =>
        Effect.map(records.get(orgId, key), (row) => [
          row!.amountMinor,
          row!.currency,
          JSON.parse(row!.fieldsJson).tax?.minor ?? null,
        ]);
      // A moment apart, as made again later: the latest of a doc's renders is what it shows.
      const make = (entry: string, inputs: Record<string, unknown>) =>
        Effect.andThen(
          TestClock.adjust(1_000),
          LeadDocuments.make(scope, invoice({ entry, title: `Invoice ${entry}`, inputs })),
        );
      const line = (rate: string, quantity = "1") => [{ description: "Design", quantity, rate }];
      yield* LeadWork.create(scope, {
        sourceEventId: work,
        records: [
          { list: "clients", title: "Invented Local", placeOfSupply: "Karnataka" },
          { list: "clients", title: "Invented Abroad", placeOfSupply: "United Kingdom" },
        ],
      });
      yield* LeadWork.create(scope, {
        sourceEventId: work,
        records: [
          { list: "invoices", title: "Across states", client: "Invented Acme", state: "open" },
          { list: "invoices", title: "Same state", client: "Invented Local", state: "open" },
          { list: "invoices", title: "Export", client: "Invented Abroad", state: "open" },
          { list: "invoices", title: "Typed", client: "Invented Acme", amount: "5,900" },
        ],
      });
      // Its document's total and tax, the moment it is made: one tax line, two, or none.
      yield* make("INV-2", { lines: line("₹25,000") });
      yield* make("INV-3", { lines: line("₹10,000", "2") });
      yield* make("INV-4", { lines: line("₹1,000"), exportUnderLut: true });
      assert.deepStrictEqual(
        [yield* figures("INV-2"), yield* figures("INV-3"), yield* figures("INV-4")],
        [
          [2_950_000, "INR", 450_000],
          [2_360_000, "INR", 360_000],
          [100_000, "INR", 0],
        ],
      );
      // New lines price it again, and its history says what moved.
      yield* make("INV-2", { lines: line("₹30,000") });
      assert.deepStrictEqual(yield* figures("INV-2"), [3_540_000, "INR", 540_000]);
      const history = (yield* records.detail((yield* records.get(orgId, "INV-2"))!)).changes;
      assert.deepStrictEqual(
        history.flatMap((change) => change.fields.filter((one) => one.field === "amount")),
        [
          { field: "amount", from: "₹29,500.00", to: "₹35,400.00" },
          { field: "amount", from: null, to: "₹29,500.00" },
        ],
      );
      // A typed amount stays as typed: billed as it is, or refused against lines it isn't.
      assert.deepStrictEqual(yield* figures("INV-1"), [100_001, "INR", null]);
      yield* make("INV-1", { billTo: "9 Invented Road, Pune" });
      assert.deepStrictEqual(yield* figures("INV-1"), [100_001, "INR", null]);
      assert.match(
        (yield* make("INV-5", { lines: line("₹1,000") }).pipe(Effect.flip)).message,
        /the lines come to ₹1,180\.00 with tax, but the entry is recorded at ₹5,900\.00/,
      );
      assert.deepStrictEqual(yield* figures("INV-5"), [590_000, "INR", null]);
      // Lines that come to what was typed give it its tax, and from then on price it.
      yield* make("INV-5", { lines: line("₹5,000") });
      assert.deepStrictEqual(yield* figures("INV-5"), [590_000, "INR", 90_000]);
      yield* make("INV-5", { lines: line("₹6,000") });
      assert.deepStrictEqual(yield* figures("INV-5"), [708_000, "INR", 108_000]);
      // A tax a person types stays theirs, as a typed amount does: their own PDF, coming to the
      // same total, doesn't put its tax back over it.
      const person = { actor: { _tag: "person", personId: ownerId }, via: "owner" } as const;
      yield* records.update(orgId, person, "INV-5", {
        fields: { tax: { minor: 100_000, currency: "INR" } },
      });
      const held = (yield* records.get(orgId, "INV-5"))!;
      assert.isFalse(yield* Amounts.pricedByDocuments(orgId, held));
      yield* Amounts.priceDraft(orgId, person, "INV-5", false);
      assert.deepStrictEqual(yield* figures("INV-5"), [708_000, "INR", 100_000]);

      // A suggestion takes its document's amount too, and counts in nothing until a person keeps it.
      const suggested = yield* records.create(
        orgId,
        { actor: { _tag: "agent", agentId: lead }, via: "lead" },
        {
          list: "invoices",
          title: "Suggested",
          originKey: "suggested-invoice",
          owner: { _tag: "agent", agentId: lead },
          confirmed: false,
          partyId: (yield* records.get(orgId, "INV-2"))!.partyId,
        },
      );
      yield* make(suggested.row.key, { lines: line("₹2,000") });
      const kept = (yield* records.get(orgId, suggested.row.key))!;
      assert.deepStrictEqual([kept.amountMinor, kept.confirmed], [236_000, 0]);
      // An agent reads the same amount and tax, still a suggestion.
      const read = yield* LeadWork.get(scope, { key: kept.key });
      assert.deepStrictEqual(
        [read.amount, read.fields, read.stateLabel, read.suggested],
        [
          "₹2,360.00",
          { tax: "₹360.00" },
          "Draft, suggested: waits for the owner or a co-owner to keep it",
          true,
        ],
      );
      // Drafts and a suggestion, priced, are owed by nobody: in no Money or outlook figure.
      const summary = yield* moneySummary(orgId, now, KIN_OWNER_LEVEL);
      assert.deepStrictEqual([summary.owed.total, summary.owed.overdue], [[], []]);
      const ahead = yield* outlook(orgId, now);
      assert.deepStrictEqual(ahead.incoming, []);

      // A draft from before drafts took their document's figures gets them at start, once.
      yield* sql`UPDATE kin_records SET amount_minor = NULL, currency = NULL,
          fields_json = json_remove(fields_json, '$.tax')
        WHERE org_id = ${orgId} AND key IN ('INV-3', 'INV-4')`;
      assert.strictEqual(yield* Amounts.fillDraftAmounts(1), 2);
      assert.deepStrictEqual(
        [yield* figures("INV-3"), yield* figures("INV-4")],
        [
          [2_360_000, "INR", 360_000],
          [100_000, "INR", 0],
        ],
      );
      assert.strictEqual(yield* Amounts.fillDraftAmounts(), 0);

      // Issued, its figures stay what they were issued with, whatever its document says later.
      yield* LeadDocuments.issue(scope, { entry: KinRecordKey.make("INV-2"), sourceEventId: work });
      const issued = yield* figures("INV-2");
      assert.deepStrictEqual(issued, [3_540_000, "INR", 540_000]);
      yield* make("INV-2", { lines: line("₹40,000") }).pipe(Effect.ignore);
      yield* sql`UPDATE kin_records SET amount_minor = NULL WHERE org_id = ${orgId} AND key = 'INV-2'`;
      assert.strictEqual(yield* Amounts.fillDraftAmounts(), 0);
      yield* sql`UPDATE kin_records SET amount_minor = 3540000 WHERE org_id = ${orgId} AND key = 'INV-2'`;
      assert.deepStrictEqual(yield* figures("INV-2"), issued);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("are issued only with the amount the document asks for, and only when it says it", () =>
    Effect.gen(function* () {
      const work = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const issueIt = (entry: string) =>
        LeadDocuments.issue(scope, { entry: KinRecordKey.make(entry), sourceEventId: work });
      const next = (key: string) =>
        OwnerMoney.nextNumber(people, { orgId, key: KinRecordKey.make(key) });
      // Review 45: the owner's own invoice recipe works out its total from its lines alone.
      const root = yield* (yield* Workspace.KinWorkspace).root(orgId);
      const own = (markdown: string) =>
        Effect.gen(function* () {
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${root}/recipes/invoice/RECIPE.md`,
            markdown,
          );
          yield* git(root, "commit", "-qam", "The owner's invoice", "-m", `Kin-Person: ${ownerId}`);
        });
      const starter = STARTER_FILES["recipes/invoice/RECIPE.md"]!;
      yield* own(starter.replace("      total: total\n", ""));
      // INV-1 is recorded at ₹1,000.01; its document now prints ₹2,360.00.
      yield* LeadDocuments.make(
        scope,
        invoice({ inputs: { lines: [{ description: "Design", quantity: "2", rate: "₹1,000" }] } }),
      );
      assert.strictEqual(latestData().tax.total.text, "₹2,360.00");
      const differs = yield* issueIt("INV-1").pipe(Effect.flip);
      assert.strictEqual(
        differs.message,
        "INV-1 is recorded at ₹1,000.01, but its document comes to ₹2,360.00. Correct whichever is wrong, the entry's amount or the document's lines or recipe, then issue it. Nothing was issued.",
      );
      assert.strictEqual((yield* next("INV-1")).number, "INV/26-27/001");
      // An owner's recipe from before recipes said which figure is the amount can't issue.
      yield* own(starter.replace("      total: total\n", "").replace(/^amount: .*\n/m, ""));
      assert.match(
        (yield* issueIt("INV-1").pipe(Effect.flip)).message,
        /^INV-1 wasn't issued: The invoice recipe doesn't say which of its figures is the amount its document asks for, so Kin can't issue with it\. Change the recipe \(writeRecipe\) to declare it/,
      );
      // Whatever a list says about amounts, an issued entry carries one.
      yield* sql`UPDATE kin_registers
        SET definition_json = json_set(definition_json, '$.amount', json('false'))
        WHERE org_id = ${orgId} AND register_id = 'invoices'`;
      assert.match(
        (yield* issueIt("INV-1").pipe(Effect.flip)).message,
        /keeps no amounts, and an issued entry always carries its amount/,
      );
      assert.strictEqual((yield* next("INV-1")).number, "INV/26-27/001");
      assert.strictEqual((yield* records.get(orgId, "INV-1"))!.state, "open");
      // A line's SAC or HSN is a code, as the company's is.
      for (const sac of ["99 83", "x".repeat(60_000)])
        assert.match(
          (yield* LeadDocuments.make(
            scope,
            invoice({ inputs: { lines: [{ description: "Design", sac, rate: "₹1,000" }] } }),
          ).pipe(Effect.flip)).message,
          /lines \(sac: a SAC or HSN code, 4 to 8 digits\)/,
        );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("quote in a series of their own, and invoice a quote with its lines", () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const asked = yield* turn(10, "Track quotes");
      yield* LeadMoney.define(scope, { sourceEventId: asked, template: "quotes" });
      const yes = yield* turn(11, "Yes. Quote Invented Acme for the design work, valid a month");
      yield* LeadWork.create(scope, {
        sourceEventId: yes,
        records: [
          { list: "quotes", title: "Design work", client: "Invented Acme", due: "2026-12-12" },
        ],
      });
      const lines = [{ description: "Design", sac: "998391", quantity: "2", rate: "₹1,00,000" }];
      const quote = yield* LeadDocuments.make(scope, {
        title: "Quotation QT-1",
        recipe: "quotation",
        entry: "QT-1",
        inputs: { lines, terms: "Half on acceptance" },
        sourceEventId: yes,
      });
      assert.deepStrictEqual(
        [quote.draft, latestData().tax.total.text, latestData().validText],
        [true, "₹2,36,000.00", "12 Dec 2026"],
      );
      // A draft quote carries what its document comes to, and is issued with exactly that.
      const priced = Effect.map(records.get(orgId, "QT-1"), (row) => [
        row!.amountMinor,
        row!.currency,
        JSON.parse(row!.fieldsJson).tax,
      ]);
      const draftQuote = yield* priced;
      assert.deepStrictEqual(draftQuote, [
        23_600_000,
        "INR",
        { minor: 3_600_000, currency: "INR" },
      ]);
      const issued = yield* LeadDocuments.issue(scope, {
        entry: KinRecordKey.make("QT-1"),
        sourceEventId: yes,
      });
      const quoted = (yield* records.get(orgId, "QT-1"))!;
      assert.deepStrictEqual(
        [issued.number, quoted.state, quoted.amountMinor, latestData().number],
        // Numbered, a quote is still a draft: it reads Sent only once it went out.
        ["QT/26-27/001", "open", 23_600_000, "QT/26-27/001"],
      );
      assert.deepStrictEqual(yield* priced, draftQuote);
      // A quote is no money owed.
      const money = yield* moneySummary(
        orgId,
        Date.parse("2026-11-12T06:00:00.000Z"),
        KIN_OWNER_LEVEL,
      );
      assert.deepStrictEqual(money.owed.total, []);
      // Review 45: its lines and client come from the quote exactly, never alongside it.
      for (const inputs of [
        { lines: [{ description: "More", rate: "₹1" }] },
        { billTo: "Elsewhere" },
      ])
        assert.match(
          (yield* LeadDocuments.make(scope, {
            title: "Invoice for QT-1",
            recipe: "invoice",
            from: KinRecordKey.make("QT-1"),
            inputs,
            sourceEventId: yes,
          }).pipe(Effect.flip)).message,
          /^from copies QT-1's lines and client exactly, so (lines|billTo) can't be given with it\./,
        );
      assert.isUndefined(yield* records.get(orgId, "INV-2"));
      // Invoiced once: a draft for the same client with the quote's lines; again, the same one.
      const invoiceIt = LeadDocuments.make(scope, {
        title: "Invoice for QT-1",
        recipe: "invoice",
        from: KinRecordKey.make("QT-1"),
        sourceEventId: yes,
      });
      const made = yield* invoiceIt;
      assert.deepStrictEqual(
        [made.entry, made.draft, latestData().tax.total.text, latestData().items[0].sac],
        ["INV-2", true, "₹2,36,000.00", "998391"],
      );
      assert.deepStrictEqual((yield* invoiceIt).entry, "INV-2");
      // The quote names its invoice back, once, so it can say it was invoiced.
      const quoteLinks = (yield* records.detail((yield* records.get(orgId, "QT-1"))!)).links;
      assert.deepStrictEqual(
        quoteLinks.flatMap((link) => (link.record?.key === "INV-2" ? [link.relation] : [])),
        ["relates"],
      );
      const drafted = (yield* records.get(orgId, "INV-2"))!;
      assert.deepStrictEqual(
        [drafted.state, drafted.partyId, drafted.title],
        ["open", quoted.partyId, "Design work"],
      );
      // The client's own terms name their days, so those set the due date.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.terms', 'Net 30')
        WHERE record_id = ${quoted.partyId}`;
      const billed = yield* LeadDocuments.issue(scope, {
        entry: KinRecordKey.make("INV-2"),
        sourceEventId: yes,
      });
      const due = (yield* records.get(orgId, "INV-2"))!;
      assert.strictEqual(due.dueAt! - due.dateAt!, 30 * 86_400_000);
      assert.deepStrictEqual(
        [billed.number, (yield* records.get(orgId, "INV-2"))!.amountMinor],
        ["INV/26-27/001", 23_600_000],
      );
      // The owner's Mark sent: the quote reads Sent with the number it has, or the next one;
      // pressed again, nothing more and no second number.
      yield* LeadWork.create(scope, {
        sourceEventId: yes,
        records: [{ list: "quotes", title: "Support", client: "Invented Acme", amount: "5,000" }],
      });
      const marked = [];
      for (const key of ["QT-1", "QT-2", "QT-1", "QT-2"]) {
        const done = yield* OwnerMoney.issue(people, { orgId, key: KinRecordKey.make(key) });
        marked.push([key, done.number, done.state, (yield* records.get(orgId, key))!.state]);
      }
      assert.deepStrictEqual(marked, [
        ["QT-1", "QT/26-27/001", "waiting", "waiting"],
        ["QT-2", "QT/26-27/002", "waiting", "waiting"],
        ["QT-1", "QT/26-27/001", "waiting", "waiting"],
        ["QT-2", "QT/26-27/002", "waiting", "waiting"],
      ]);
      const [numbers] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM kin_issued_numbers
        WHERE org_id = ${orgId} AND register_id = 'quotes'`;
      assert.strictEqual(numbers!.n, 2);
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
        yield* Docs.docRow(orgId, { key: "D-1" }, KIN_OWNER_LEVEL).pipe(
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
      // Each list's default is marked; the owner picks another, only one made for a list.
      const defaults = () =>
        Effect.map(OwnerDocs.recipes(people, { orgId }), (all) =>
          all.recipes.filter((one) => one.default === true).map((one) => one.name),
        );
      assert.deepStrictEqual(yield* defaults(), ["invoice", "quotation", "receipt"]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_recipe_defaults (org_id, list, recipe, set_by_person_id, set_at)
        VALUES (${orgId}, 'invoices', 'gone', ${ownerId}, 0)`;
      assert.deepStrictEqual(
        yield* defaults(),
        ["invoice", "quotation", "receipt"],
        "a gone recipe is no default",
      );
      assert.match(
        (yield* Effect.flip(OwnerDocs.setDefaultRecipe(people, { orgId, recipe: "report" })))
          .message,
        /isn't made for a list's entries/,
      );
      assert.include(
        yield* Effect.flip(OwnerDocs.setDefaultRecipe(someone, { orgId, recipe: "invoice" })),
        { reason: "not_allowed" },
      );
      assert.deepStrictEqual(
        yield* OwnerDocs.setDefaultRecipe(people, { orgId, recipe: "invoice" }),
        { list: "invoices", recipe: "invoice" },
      );
      assert.deepStrictEqual(
        yield* sql`SELECT recipe FROM kin_recipe_defaults WHERE org_id = ${orgId}`,
        [{ recipe: "invoice" }],
      );
      // A preview neither takes an id nor finds what one filed.
      const again = yield* OwnerDocs.render(people, { ...asked, preview: true });
      assert.deepStrictEqual(
        again.preview?.map((one) => one.name),
        ["invoice.pdf"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("are typed by hand as a draft, priced by their lines, and read so by an agent", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const [acme] = yield* sql<{ key: string; recordId: string }>`SELECT key,
          record_id AS "recordId" FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'clients' AND title = 'Invented Acme'`;
      const asked = {
        orgId,
        client: KinRecordKey.make(acme!.key),
        title: "November design",
        lines: [
          { description: "Design", sac: null, quantity: "2", rate: "₹10,000.00" },
          { description: "Review", sac: "998391", quantity: "1", rate: "₹5,000.00" },
        ],
        gstRate: "12",
        dueOn: "2026-12-12",
        notes: "Typed by hand",
        amountConfirmed: false,
        clientRequestId: "form-1",
      };
      // The renderer is down: the draft stands with the reason, and the same request finishes it.
      failing.reason = "the renderer stopped";
      const first = yield* OwnerMoneyAnswers.newInvoice(people, asked);
      assert.deepStrictEqual(
        [first.invoice, first.documents, first.problems.length],
        ["INV-2", [], 1],
      );
      failing.reason = undefined;
      const made = yield* OwnerMoneyAnswers.newInvoice(people, asked);
      assert.deepStrictEqual(
        [made.invoice, made.documents.length, made.problems],
        ["INV-2", 1, []],
      );
      const row = (yield* records.get(orgId, "INV-2"))!;
      assert.deepStrictEqual(
        [
          row.state,
          row.partyId,
          row.title,
          row.notes,
          row.amountMinor,
          JSON.parse(row.fieldsJson).tax,
        ],
        [
          "open",
          acme!.recordId,
          "November design",
          "Typed by hand",
          2_800_000,
          { minor: 300_000, currency: "INR" },
        ],
      );
      assert.strictEqual(row.dueAt, Date.parse("2026-12-12T18:29:59.999Z"));
      assert.deepStrictEqual(latestData().items[1].sac, "998391");
      // Never numbered, never owed: Issue takes over from its page.
      const summary = yield* moneySummary(
        orgId,
        Date.parse("2026-11-12T06:00:00.000Z"),
        KIN_OWNER_LEVEL,
      );
      assert.deepStrictEqual(summary.owed.total, []);
      // An agent's reads list it as the draft it is.
      const read = yield* LeadWork.get(scope, { key: "INV-2" });
      const listed = yield* LeadWork.query(scope, { list: "invoices" });
      assert.deepStrictEqual(
        [
          read.stateLabel,
          read.amount,
          listed.records.find((one) => one.key === "INV-2")?.stateLabel,
        ],
        ["Draft", "₹28,000.00", "Draft"],
      );
      // The same request id with other details makes nothing; someone outside the owner level, none.
      const someone = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("someone") }];
      for (const [who, input] of [
        [people, { ...asked, title: "Another" }],
        [someone, { ...asked, clientRequestId: "form-2" }],
      ] as const)
        assert.include(yield* OwnerMoneyAnswers.newInvoice(who, input).pipe(Effect.flip), {
          reason: "not_allowed",
        });
      // A client that isn't one is unknown, and nothing is saved.
      assert.include(
        yield* OwnerMoneyAnswers.newInvoice(people, {
          ...asked,
          client: KinRecordKey.make("INV-1"),
          clientRequestId: "form-3",
        }).pipe(Effect.flip),
        { reason: "not_found" },
      );
      assert.isUndefined(yield* records.get(orgId, "INV-3"));
      // Lines far above every invoice are asked about once, saving nothing; confirmed, they save.
      const far = {
        ...asked,
        lines: [{ description: "Design", sac: null, quantity: "1", rate: "₹5,00,00,000.00" }],
        clientRequestId: "form-4",
      };
      const slip = yield* OwnerMoneyAnswers.newInvoice(people, far).pipe(Effect.flip);
      assert.deepStrictEqual(slip.farAbove?.list, "Invoices");
      assert.isUndefined(yield* records.get(orgId, "INV-3"));
      const kept = yield* OwnerMoneyAnswers.newInvoice(people, { ...far, amountConfirmed: true });
      assert.strictEqual(kept.invoice, "INV-3");
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

      // The agent's own words are plain, even after its turn read something sensitive (H04).
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
      assert.isUndefined(marked.sensitive);
      assert.strictEqual((yield* versionsOf(marked.documents[0]!.key)).doc.sensitive, 0);
      // A doc made a PDF lays out the doc's own text, never retyped, and keeps its label (F38).
      const prd = yield* Docs.create(
        orgId,
        { actor: { _tag: "system" }, via: "import" },
        {},
        {
          title: "Invented PRD",
          body: "# Goals\n\nShip the **beta**.\n",
          owner: { _tag: "agent", agentId: lead },
          summary: "Created",
          sensitive: true,
          originKey: "test:prd",
        },
      );
      const asPdf = yield* LeadDocuments.make(scope, {
        title: "Invented PRD",
        recipe: "report",
        doc: prd.row.key,
        sourceEventId: quiet,
      });
      assert.deepStrictEqual(
        [latestData().title, latestData().blocks.map((block: { kind: string }) => block.kind)],
        ["Invented PRD", ["heading", "paragraph"]],
      );
      assert.isTrue(asPdf.sensitive);
      const notText = yield* Effect.flip(
        LeadDocuments.make(scope, {
          title: "Again",
          recipe: "report",
          doc: asPdf.documents[0]!.key,
          sourceEventId: quiet,
        }),
      );
      assert.match(notText.message, /is a file, not text/);
      // A money recipe the agent writes is private by its kind; another starts plain.
      yield* writeRecipe("quote", { sourceEventId: quiet });
      yield* writeRecipe("note", { sourceEventId: quiet });
      const drafts = yield* sql<{ recipe: string; sensitive: number }>`SELECT recipe, sensitive
        FROM kin_doc_jobs WHERE mode = 'recipe' ORDER BY recipe`;
      assert.deepStrictEqual(
        drafts.map((one) => [one.recipe, one.sensitive]),
        [
          ["note", 0],
          ["quote", 1],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );
});

type ReceiptAsk = Omit<typeof LeadDocuments.ReceiptInput.Type, "sourceEventId">;
/** The owner's tap on Kin's yes/no card, as the chat service runs it: the receipt, then the card. */
const answerCard = (clientMessageId: string, kind: "yes" | "no") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const widgetId = `choice:card-${clientMessageId}`;
    yield* sql.withTransaction(
      answerReceiptCard({
        orgId,
        widgetId,
        personId: ownerId,
        confirmed: kind === "yes",
        via: "tap",
        now: Date.parse(at),
      }),
    );
    const [card] = yield* sql<{ state: string }>`SELECT state_json AS state FROM kin_widgets
      WHERE widget_id = ${widgetId}`;
    const state = JSON.parse(card!.state) as {
      options: Array<{ optionId: string; kind?: string }>;
    };
    const option = state.options.find((one) => one.kind === kind)!;
    const answer = {
      optionId: option.optionId,
      personId: ownerId,
      via: "tap",
      emoji: null,
      answeredAt: at,
    };
    yield* sql`UPDATE kin_widgets SET state_json = ${JSON.stringify({ ...state, answer })},
        revision = revision + 1 WHERE widget_id = ${widgetId}`;
  });
/**
 * The agent's receipt as the owner asked for it; one that records money waits for the owner's
 * Confirm on its card, tapped here, and the agent's call with its proposal reads what it made.
 */
const agentReceipt = (asked: string, input: ReceiptAsk) =>
  Effect.gen(function* () {
    const first = yield* LeadDocuments.receipt(scope, { sourceEventId: asked, ...input });
    if (first.status === "made") return first;
    yield* answerCard(`kin-receipt:${first.proposal}`, "yes");
    // The tap wakes the agent, as `KinChatService.act` posts it once its writes are made.
    yield* inRunningTurn("Confirm", true);
    const made = yield* LeadDocuments.receipt(scope, {
      sourceEventId: asked,
      proposal: first.proposal,
    });
    if (made.status !== "made") return assert.fail(`expected a receipt, got ${made.status}`);
    return made;
  });

describe("the accountant's pack", () => {
  it.effect("totals what Money totals for the month: paid apart from unpaid, void in neither", () =>
    Effect.gen(function* () {
      yield* seed;
      const asked = yield* turn(4, "Track expenses");
      const proposed = yield* LeadMoney.define(scope, {
        sourceEventId: asked,
        template: "expenses",
      });
      const work = yield* turn(5, "Yes");
      yield* LeadMoney.define(scope, { sourceEventId: work, proposal: proposed.proposal! });
      const records = yield* KinRecords.KinRecords;
      const system = { actor: { _tag: "system" as const }, via: "import" as const };
      const owner = { _tag: "person" as const, personId: ownerId };
      const day = (iso: string) => Date.parse(`${iso}T12:00:00.000Z`);
      for (const [key, state, category, minor, dateAt] of [
        ["taxi", "done", "travel", 100_00, day("2026-11-03")],
        ["refund", "done", "travel", -500, day("2026-11-04")],
        ["hosting", "done", "software", 50_50, day("2026-11-04")],
        ["rent", "open", "rent", 400_00, day("2026-11-05")],
        ["void", "dropped", "travel", 999_00, day("2026-11-06")],
        ["october", "done", "travel", 7_00, day("2026-10-30")],
        ["undated", "done", "software", 1_25, undefined],
      ] as const)
        yield* records.create(orgId, system, {
          list: "expenses",
          title: `Invented ${key}`,
          owner,
          state,
          category,
          amount: { minor, currency: "INR" },
          ...(dateAt === undefined ? {} : { dateAt }),
          originKey: key,
        });
      // Money in on a live invoice counts; on one since voided it doesn't.
      yield* LeadWork.create(scope, {
        sourceEventId: work,
        records: [
          { list: "invoices", title: "Invented void", client: "Invented Acme", amount: "70" },
        ],
      });
      for (const [key, minor] of [
        ["INV-1", 300_00],
        ["INV-2", 70_00],
      ] as const)
        yield* records.pay(orgId, system, key, {
          amount: { minor, currency: "INR" },
          paidOn: "2026-11-07",
          originKey: `pay:${key}`,
        });
      yield* records.update(orgId, system, "INV-2", { state: "dropped" });

      const recipe = parseRecipe(STARTER_FILES["recipes/accountant-pack/RECIPE.md"]!);
      if ("reason" in recipe) return assert.fail(recipe.reason);
      const given = { month: "2026-11" };
      const gathered = yield* gatherFacts(orgId, recipe, undefined, given);
      const assembled = assembleInputs(recipe, given, gathered.facts, gathered.currency);
      if ("error" in assembled) return assert.fail(assembled.error.message);
      const totals = (sheet: string) => {
        const decl = recipe.sheets.find((one) => one.name === sheet)!;
        const rows = assembled.inputs[decl.input];
        const at = decl.columns.findIndex((one) => one.field === "amount");
        return sheetCells(Array.isArray(rows) ? (rows as never) : [], decl)
          .filter((row) => "text" in row[0]! && row[0].text.startsWith("Total"))
          .map((row) => [
            (row[0] as { text: string }).text,
            (row[at] as { number: string }).number,
          ]);
      };
      const money = yield* moneySummary(
        orgId,
        Date.parse("2026-11-12T06:00:00.000Z"),
        KIN_OWNER_LEVEL,
      );
      assert.deepStrictEqual(money.spent.thisMonth.total, [{ minor: 146_75, currency: "INR" }]);
      assert.deepStrictEqual(totals("Expenses"), [
        ["Total software", "51.75"],
        ["Total travel", "95.00"],
      ]);
      const expenseSheet = recipe.sheets.find((one) => one.name === "Expenses")!;
      const expenseRows = assembled.inputs[expenseSheet.input];
      const cells = sheetCells(
        Array.isArray(expenseRows) ? (expenseRows as never) : [],
        expenseSheet,
      );
      const amountColumn = expenseSheet.columns.findIndex((one) => one.field === "amount");
      assert.isTrue(
        cells.some(
          (row) =>
            row.some((cell) => "text" in cell && cell.text === "Invented refund") &&
            row[amountColumn] !== undefined &&
            "number" in row[amountColumn] &&
            row[amountColumn].number === "-5.00",
        ),
      );
      assert.deepStrictEqual(totals("Unpaid expenses"), [["Total", "400.00"]]);
      assert.deepStrictEqual(money.received.thisMonth, [{ minor: 300_00, currency: "INR" }]);
      assert.deepStrictEqual(totals("Receipts"), [["Total", "300.00"]]);
      // The voided invoice is listed in the sales register and left out of its total.
      assert.deepStrictEqual(totals("Sales register"), [["Total", "0.00"]]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("receipts", () => {
  it.effect(
    "stand on money received: an entry an agent made is recorded as received as it is numbered, and TDS gets none",
    () =>
      Effect.gen(function* () {
        const asked = yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const records = yield* KinRecords.KinRecords;
        const agent = { actor: { _tag: "agent" as const, agentId: lead }, via: "lead" as const };
        const receipt = (input: ReceiptAsk) => agentReceipt(asked, input);
        const received = (now = Date.parse("2026-11-12T06:00:00.000Z")) =>
          moneySummary(orgId, now, KIN_OWNER_LEVEL).pipe(
            Effect.map((summary) => summary.received.thisMonth),
          );
        // Any first receipt makes the list; an advance stands on its own payment from the start.
        const advance = yield* receipt({ advance: { amount: "500", receivedOn: "2026-11-05" } });
        assert.deepStrictEqual(yield* received(), [{ minor: 50_000, currency: "INR" }]);
        // An agent's own receipts entry, with no payment anywhere, numbered: recorded as received.
        const { row } = yield* records.create(orgId, agent, {
          list: "receipts",
          originKey: "agent:receipt:big",
          title: "Received from a client",
          owner: { _tag: "agent", agentId: lead },
          state: "open",
          amount: { minor: 99_999_900, currency: "INR" },
          dateAt: Date.parse("2026-11-06T18:29:59.999Z"),
          dateAllDay: true,
        });
        const numbered = yield* receipt({ entry: KinRecordKey.make(row.key) });
        assert.isNotNull(numbered.number);
        const payments = yield* sql<{ minor: number; paidOn: string; voidedAt: number | null }>`
          SELECT amount_minor AS minor, paid_on AS "paidOn", voided_at AS "voidedAt"
          FROM kin_record_payments WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
        assert.deepStrictEqual(payments, [
          { minor: 99_999_900, paidOn: "2026-11-06", voidedAt: null },
        ]);
        assert.deepStrictEqual(rendered.at(-1)!.request.inputs.amount, {
          minor: 99_999_900,
          currency: "INR",
        });
        assert.deepStrictEqual(yield* received(), [{ minor: 100_049_900, currency: "INR" }]);
        const activity = yield* OwnerWork.get(people, { orgId, key: KinRecordKey.make(row.key) });
        assert.isTrue(
          activity.changes.some((change) =>
            change.fields.some(
              (one) => one.field === "payment" && one.to === "₹9,99,999.00 on 2026-11-06",
            ),
          ),
        );
        // Asked again, the same receipt on the same payment; void, it counts for nothing.
        yield* receipt({ entry: KinRecordKey.make(row.key) });
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_record_payments WHERE record_id = ${row.recordId}`,
          1,
        );
        yield* LeadDocuments.issue(scope, {
          entry: KinRecordKey.make(row.key),
          void: true,
          sourceEventId: asked,
        });
        assert.deepStrictEqual(yield* received(), [{ minor: 50_000, currency: "INR" }]);
        // An entry with no amount can't stand on money, so it gets no number.
        const { row: empty } = yield* records.create(orgId, agent, {
          list: "receipts",
          originKey: "agent:receipt:empty",
          title: "Received",
          owner: { _tag: "agent", agentId: lead },
          state: "open",
        });
        const refused = yield* receipt({ entry: KinRecordKey.make(empty.key) }).pipe(Effect.flip);
        assert.match(refused.message, /no amount or day received/);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_issued_numbers WHERE record_id = ${empty.recordId}`,
          0,
        );
        // An advance's own payment is no invoice's to make a receipt for.
        const own = yield* sql<{ paymentId: string }>`SELECT p.payment_id AS "paymentId"
          FROM kin_record_payments p JOIN kin_records r ON r.record_id = p.record_id
          WHERE r.key = ${advance.receipt}`;
        const twice = yield* receipt({ payment: own[0]!.paymentId }).pipe(Effect.flip);
        assert.match(twice.message, /it is its own receipt/);
        // TDS a client deducted is no money received: no receipt for it.
        const tds = yield* records.pay(orgId, agent, "INV-1", {
          amount: { minor: 10_000, currency: "INR" },
          paidOn: "2026-11-10",
          withheld: true,
          originKey: "tds:1",
        });
        const withheld = yield* receipt({ payment: tds.paymentId }).pipe(Effect.flip);
        assert.match(withheld.message, /TDS the client deducted, not money received/);
        // Nor does a month's payments table list it as received; the advance it does, as Money does.
        yield* records.pay(orgId, agent, "INV-1", {
          amount: { minor: 20_000, currency: "INR" },
          paidOn: "2026-11-10",
          originKey: "paid:1",
        });
        const recipe = parseRecipe(
          "---\nname: probe\ntitle: Probe\ndescription: probe\nsensitive: true\noutputs: [a.pdf]\ninputs:\n  m: {type: month}\n  a: {type: table, from: payments, period: m, columns: {invoice: text, amount: money}}\n---\nGo.\n",
        );
        if ("reason" in recipe) return assert.fail(recipe.reason);
        const gathered = yield* gatherFacts(orgId, recipe, undefined, { m: "2026-11" });
        const table = assembleInputs(recipe, { m: "2026-11" }, gathered.facts, gathered.currency);
        if ("error" in table) return assert.fail(table.error.message);
        assert.deepStrictEqual(
          (table.inputs.a as ReadonlyArray<{ amount: unknown }>).map((one) => one.amount),
          [
            { minor: 50_000, currency: "INR" },
            { minor: 20_000, currency: "INR" },
          ],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "record money an agent asks for only on the owner's Confirm, and never stand on money taken back",
    () =>
      Effect.gen(function* () {
        const asked = yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const records = yield* KinRecords.KinRecords;
        const call = (input: ReceiptAsk) =>
          LeadDocuments.receipt(scope, { sourceEventId: asked, ...input });
        const proposed = (input: ReceiptAsk) =>
          call(input).pipe(
            Effect.map((result) =>
              result.status === "proposed" ? result : assert.fail("expected a proposal"),
            ),
          );
        const live = sql<{ minor: number }>`SELECT amount_minor AS minor FROM kin_record_payments
          WHERE voided_at IS NULL ORDER BY payment_id`;
        const numbered = sql`SELECT 1 FROM kin_issued_numbers n JOIN kin_records r
          ON r.record_id = n.record_id WHERE r.register_id = 'receipts'`;
        const [client] = yield* sql<{ key: string }>`SELECT key FROM kin_records
          WHERE org_id = ${orgId} AND register_id = 'clients'`;
        const ask = {
          advance: {
            client: KinRecordKey.make(client!.key),
            amount: "500",
            receivedOn: "2026-11-05",
          },
          towards: "Website redesign",
          mode: "upi",
        };
        const advance = yield* proposed(ask);
        // Nothing is recorded or numbered; the owner's card shows who, how much, when and how.
        assert.lengthOf(yield* live, 0);
        assert.lengthOf(yield* numbered, 0);
        const [card] = yield* sql<{ state: string }>`SELECT state_json AS state FROM kin_widgets
          WHERE widget_id = ${`choice:card-kin-receipt:${advance.proposal}`}`;
        const detail = String(JSON.parse(card!.state).detail);
        for (const line of [
          "Client: Invented Acme",
          "Amount: ₹500.00",
          "Received on: Thu, 5 Nov 2026",
          "Set against: no invoice",
          "Agent's note: towards Website redesign, by upi",
        ])
          assert.include(detail, line);
        // The same ask is the same card; changed, it is another. Unanswered, it makes nothing.
        assert.strictEqual((yield* proposed(ask)).proposal, advance.proposal);
        const more = yield* proposed({ ...ask, advance: { ...ask.advance, amount: "5,000" } });
        assert.notStrictEqual(more.proposal, advance.proposal);
        const waiting = yield* Effect.flip(call({ proposal: advance.proposal }));
        assert.match(waiting.message, /hasn't tapped Confirm/);
        // A card that closed unanswered (its invoice was voided) is not reported as waiting.
        const shut = yield* proposed({ ...ask, advance: { ...ask.advance, amount: "7" } });
        yield* sql`UPDATE kin_widgets SET closed_at = 1
          WHERE widget_id = ${`choice:card-kin-receipt:${shut.proposal}`}`;
        assert.match(
          (yield* Effect.flip(call({ proposal: shut.proposal }))).message,
          /closed before the owner answered/,
        );
        // Cancel ends a proposal.
        yield* answerCard(`kin-receipt:${more.proposal}`, "no");
        assert.match((yield* Effect.flip(call({ proposal: more.proposal }))).message, /said no/);
        // A second card for the same money, worded differently, waits beside the first.
        const twin = yield* proposed({ ...ask, towards: "the redesign's advance" });
        // Money off leaves the same still-unanswered card for when Money is back.
        yield* sql`INSERT INTO kin_company_shell (org_id, shell_json, rev, set_by, set_at)
          VALUES (${orgId}, '[{"id":"money","on":false}]', 1, ${ownerId}, 0)`;
        const off = yield* Effect.flip(answerCard(`kin-receipt:${advance.proposal}`, "yes"));
        assert.include(off.message, "Money is turned off for this company");
        assert.deepStrictEqual(yield* live, []);
        yield* sql`UPDATE kin_company_shell SET shell_json = '[]', rev = 2 WHERE org_id = ${orgId}`;
        // The owner's tap records exactly what its card showed, once; the agent reads it after.
        yield* answerCard(`kin-receipt:${advance.proposal}`, "yes");
        assert.deepStrictEqual(yield* live, [{ minor: 50_000 }]);
        const twice = yield* Effect.flip(answerCard(`kin-receipt:${advance.proposal}`, "yes"));
        assert.include(twice.message, "already answered");
        // The twin's Confirm records nothing: the same advance is on the books since it was drawn.
        const dup = yield* Effect.flip(answerCard(`kin-receipt:${twin.proposal}`, "yes"));
        assert.match(dup.message, /figures changed since this card was made/);
        assert.deepStrictEqual(yield* live, [{ minor: 50_000 }]);
        // A card drawn now says so, so a real second payment is confirmed knowingly.
        const knowing = yield* proposed({ ...ask, reference: "second transfer" });
        const [knowingCard] = yield* sql<{ state: string }>`SELECT state_json AS state
          FROM kin_widgets WHERE widget_id = ${`choice:card-kin-receipt:${knowing.proposal}`}`;
        assert.include(
          String(JSON.parse(knowingCard!.state).detail),
          "Already recorded: ₹500.00 from Invented Acme on Thu, 5 Nov 2026",
        );
        yield* answerCard(`kin-receipt:${knowing.proposal}`, "no");
        const made = yield* call({ proposal: advance.proposal });
        const again = yield* call({ proposal: advance.proposal });
        assert.deepStrictEqual(
          [
            made.status,
            again.status === "made" && made.status === "made" && again.receipt === made.receipt,
          ],
          ["made", true],
        );
        assert.deepStrictEqual(yield* live, [{ minor: 50_000 }]);
        // An agent's own receipts entry, standing on no payment, waits for Confirm too.
        const { row } = yield* records.create(
          orgId,
          { actor: { _tag: "agent", agentId: lead }, via: "lead" },
          {
            list: "receipts",
            originKey: "agent:receipt:made-up",
            title: "Received",
            owner: { _tag: "agent", agentId: lead },
            state: "open",
            amount: { minor: 99_999_900, currency: "INR" },
            dateAt: Date.parse("2026-11-06T18:29:59.999Z"),
            dateAllDay: true,
          },
        );
        const entry = yield* proposed({ entry: KinRecordKey.make(row.key) });
        assert.deepStrictEqual(yield* live, [{ minor: 50_000 }]);
        // Changed since its card was shown, it records nothing: not the card's figure, nor the new.
        yield* records.update(
          orgId,
          { actor: { _tag: "agent", agentId: lead }, via: "lead" },
          row.key,
          { amount: { minor: 500_000, currency: "INR" } },
        );
        const stale = yield* Effect.flip(answerCard(`kin-receipt:${entry.proposal}`, "yes"));
        assert.match(stale.message, /figures changed since this card was made/);
        assert.deepStrictEqual(yield* live, [{ minor: 50_000 }]);
        // Set against an invoice, the card shows what that invoice has already received.
        yield* records.pay(orgId, { actor: { _tag: "system" }, via: "import" }, "INV-1", {
          amount: { minor: 400_00, currency: "INR" },
          paidOn: "2026-11-01",
          originKey: "test:part-paid",
        });
        const towardsInvoice = yield* proposed({ ...ask, against: KinRecordKey.make("INV-1") });
        const [againstCard] = yield* sql<{ state: string }>`SELECT state_json AS state
          FROM kin_widgets WHERE widget_id = ${`choice:card-kin-receipt:${towardsInvoice.proposal}`}`;
        assert.include(
          String(JSON.parse(againstCard!.state).detail),
          "Already received on it: ₹400.00 of ₹1,000.01",
        );
        yield* answerCard(`kin-receipt:${towardsInvoice.proposal}`, "no");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("wait for a new company's country before reading an amount they are given", () =>
    Effect.gen(function* () {
      const asked = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      // As a company created now starts: its country not chosen (`chat/KinIdentity.test.ts`).
      yield* sql`UPDATE kin_company_profile SET profile_json = ${yield* newCompanyProfileJson}
        WHERE org_id = ${orgId}`;
      const [client] = yield* sql<{ key: string }>`SELECT key FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'clients'`;
      const advance = () =>
        LeadDocuments.receipt(scope, {
          sourceEventId: asked,
          advance: {
            client: KinRecordKey.make(client!.key),
            amount: "500",
            receivedOn: "2026-11-05",
          },
        });
      const probe = parseRecipe(
        "---\nname: probe\ntitle: Probe\ndescription: probe\nsensitive: true\noutputs: [a.pdf]\ninputs:\n  fee: {type: money}\n  lines: {type: table, columns: {item: text, price: money}}\n---\nGo.\n",
      );
      if ("reason" in probe) return assert.fail(probe.reason);
      const given = { fee: "500", lines: [{ item: "Invented kit", price: "40" }] };
      const gathered = (inputs: Record<string, unknown>) =>
        gatherFacts(orgId, probe, undefined, inputs);
      const refusal = countryFirstMessage("Owner");
      // An advance goes on a client already kept: nothing was saved.
      assert.strictEqual(
        (yield* Effect.flip(advance())).message,
        countryFirstMessage("Owner", { saved: true }),
      );
      assert.strictEqual((yield* Effect.flip(gathered({ fee: "500" }))).message, refusal);
      assert.strictEqual((yield* Effect.flip(gathered({ lines: given.lines }))).message, refusal);
      // Nothing was proposed or put to the owner; a document with no amount given is made.
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_receipt_proposals`, 0);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM kin_widgets WHERE widget_id LIKE '%kin-receipt%'`,
        0,
      );
      yield* gathered({});
      // Nor is a table with a money column and no amount in it: text only, a blank price, no rows.
      yield* gathered({ lines: [{ item: "Invented kit" }, { item: "Invented box", price: null }] });
      yield* gathered({ lines: [] });

      yield* setProfile(orgId, { _tag: "person", personId: ownerId }, { country: "GB" }, undefined);
      const proposed = yield* advance();
      assert.strictEqual(proposed.status, "proposed");
      const [request] = yield* sql<{ json: string }>`SELECT request_json AS json
        FROM kin_receipt_proposals`;
      assert.deepStrictEqual(JSON.parse(request!.json).advance.amount, {
        minor: 50_000,
        currency: "GBP",
      });
      const facts = yield* gathered(given);
      const assembled = assembleInputs(probe, given, facts.facts, facts.currency);
      if ("error" in assembled) return assert.fail(assembled.error.message);
      assert.deepStrictEqual(
        [
          assembled.inputs.fee,
          (assembled.inputs.lines as ReadonlyArray<{ price: unknown }>)[0]?.price,
        ],
        [
          { minor: 50_000, currency: "GBP" },
          { minor: 4_000, currency: "GBP" },
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never number a receipt again into money once its payment is taken back", () =>
    Effect.gen(function* () {
      const asked = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const system = { actor: { _tag: "system" as const }, via: "import" as const };
      const call = (input: ReceiptAsk) =>
        LeadDocuments.receipt(scope, { sourceEventId: asked, ...input });
      const live = sql<{ minor: number }>`SELECT amount_minor AS minor FROM kin_record_payments
        WHERE voided_at IS NULL ORDER BY payment_id`;

      // A payment already recorded on an invoice is the agent's to make a receipt for.
      const paid = yield* records.pay(orgId, system, "INV-1", {
        amount: { minor: 20_000, currency: "INR" },
        paidOn: "2026-11-10",
        originKey: "paid:taken-back",
      });
      const forPaid = yield* call({ payment: paid.paymentId });
      if (!("receipt" in forPaid)) return assert.fail("expected a receipt");
      // Taken back, its receipt is void, and no one numbers it again into money received.
      yield* records.voidPayment(orgId, system, "INV-1", paid.paymentId);
      const before = (yield* live).length;
      const byAgent = yield* Effect.flip(call({ entry: KinRecordKey.make(forPaid.receipt) }));
      const byOwner = yield* Effect.flip(
        OwnerMoney.makeReceipt(people, {
          orgId,
          key: KinRecordKey.make(forPaid.receipt),
          clientRequestId: "tap-taken-back",
        }),
      );
      // Nor is it set against an invoice into a payment again.
      const against = yield* Effect.flip(
        call({ entry: KinRecordKey.make(forPaid.receipt), against: KinRecordKey.make("INV-1") }),
      );
      for (const refused of [byAgent, byOwner, against])
        assert.match(refused.message, /taken back/);
      assert.lengthOf(yield* live, before);
      const listed = (yield* OwnerMoney.receipts(people, { orgId })).receipts.find(
        (one) => one.key === forPaid.receipt,
      )!;
      assert.strictEqual(listed.state, "dropped");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "are numbered in their own series once each, keeping a number the old system gave",
    () =>
      Effect.gen(function* () {
        const asked = yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const records = yield* KinRecords.KinRecords;
        const system = { actor: { _tag: "system" as const }, via: "import" as const };
        const receipt = (input: ReceiptAsk) => agentReceipt(asked, input);
        // An advance the old system gave a receipt for, recorded on the invoice by an import,
        // its number in the payment's note as the import writes it.
        const imported = yield* records.pay(orgId, system, "INV-1", {
          amount: { minor: 40_000, currency: "INR" },
          paidOn: "2026-10-01",
          note: "Advance received; receipt note QST-RN/2026-27/007",
          originKey: "import:payment:1",
        });
        const adopted = yield* receipt({ payment: imported.paymentId });
        assert.deepStrictEqual(
          [adopted.number, adopted.problems, adopted.documents.length],
          ["QST-RN/2026-27/007", [], 1],
        );
        // Kin's next is past the highest the old system gave, in the same series.
        const later = yield* records.pay(orgId, system, "INV-1", {
          amount: { minor: 60_001, currency: "INR" },
          paidOn: "2026-11-12",
          originKey: "payment:2",
        });
        const next = yield* receipt({
          payment: later.paymentId,
          mode: "upi",
          reference: "Invented UTR 123",
        });
        assert.strictEqual(next.number, "QST-RN/26-27/008");
        const { request, data } = rendered.at(-1)!;
        assert.deepStrictEqual(
          [
            request.recipe.name,
            request.inputs.number,
            request.inputs.client,
            request.inputs.towards,
            request.inputs.mode,
            (data as Record<string, any>).words,
          ],
          [
            "receipt",
            "QST-RN/26-27/008",
            "Invented Acme",
            "Invoice INV-1",
            "upi",
            "Rupees Six Hundred and One Paise Only",
          ],
        );
        // Asked again, by the agent or the owner, it is the same receipt, number and file.
        const renders = rendered.length;
        const again = yield* receipt({ payment: later.paymentId });
        const owners = yield* OwnerMoney.makeReceipt(people, {
          orgId,
          paymentId: later.paymentId,
          clientRequestId: "tap-1",
        });
        assert.deepStrictEqual(
          [again.receipt, again.number, again.documents, owners.receipt.number],
          [next.receipt, next.number, next.documents, next.number],
        );
        assert.strictEqual(rendered.length, renders, "nothing rendered again");

        // An advance before any invoice, set against one later, once.
        const [client] = yield* sql<{ key: string }>`SELECT key FROM kin_records
          WHERE org_id = ${orgId} AND register_id = 'clients'`;
        const advance = yield* receipt({
          advance: {
            client: KinRecordKey.make(client!.key),
            amount: "500",
            receivedOn: "2026-11-05",
          },
          towards: "Website redesign",
        });
        assert.strictEqual(advance.number, "QST-RN/26-27/009");
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            {
              list: "invoices",
              title: "Website redesign",
              client: "Invented Acme",
              amount: "2,000",
              state: "open",
            },
          ],
        });
        const against = {
          entry: KinRecordKey.make(advance.receipt),
          against: KinRecordKey.make("INV-2"),
        };
        assert.strictEqual((yield* receipt(against)).number, advance.number);
        yield* receipt(against);
        const elsewhere = yield* receipt({ ...against, against: KinRecordKey.make("INV-1") }).pipe(
          Effect.flip,
        );
        assert.match(elsewhere.message, /already set against INV-2/);
        // The invoice shows the advance and what is left; one paid on its day isn't an advance.
        yield* LeadDocuments.make(scope, invoice({ entry: "INV-2", title: "Invoice INV-2" }));
        assert.deepStrictEqual(
          [rendered.at(-1)!.request.inputs.paid, latestData().balance.text],
          [
            [
              {
                receipt: "QST-RN/26-27/009",
                amount: { minor: 50_000, currency: "INR" },
                paidOn: "2026-11-05",
                kind: "advance",
              },
            ],
            "₹1,500.00",
          ],
        );
        // Every payment settles it, not only the advance: nothing is left on INV-1.
        yield* LeadDocuments.make(scope, invoice({ title: "Invoice INV-1 again" }));
        assert.deepStrictEqual(
          [
            (latestData().paidLines as ReadonlyArray<Record<string, unknown>>).map((one) => [
              one.kind,
              one.receipt,
              one.paidText,
            ]),
            latestData().balance.text,
          ],
          [
            [
              ["advance", "QST-RN/2026-27/007", "1 Oct 2026"],
              ["received", "QST-RN/26-27/008", "12 Nov 2026"],
            ],
            "₹0.00",
          ],
        );

        // What a screen lists: newest first, who from, towards, the invoice and the PDF.
        const listed = yield* OwnerMoney.receipts(people, { orgId });
        assert.deepStrictEqual(
          listed.receipts.map((one) => [
            one.number,
            one.receivedOn,
            one.receivedFrom?.title,
            one.towards,
            one.invoice,
            one.advance,
            one.document !== null,
          ]),
          [
            [
              "QST-RN/26-27/008",
              "2026-11-12",
              "Invented Acme",
              "Invoice INV-1",
              "INV-1",
              false,
              true,
            ],
            [
              "QST-RN/26-27/009",
              "2026-11-05",
              "Invented Acme",
              "Website redesign",
              "INV-2",
              true,
              true,
            ],
            [
              "QST-RN/2026-27/007",
              "2026-10-01",
              "Invented Acme",
              "Invoice INV-1",
              "INV-1",
              false,
              true,
            ],
          ],
        );
        // A payment noted with the invoice's own number gets a receipt number of its own.
        const issued = yield* LeadDocuments.issue(scope, {
          entry: KinRecordKey.make("INV-2"),
          sourceEventId: asked,
        });
        const balance = yield* records.pay(orgId, system, "INV-2", {
          amount: { minor: 150_000, currency: "INR" },
          paidOn: "2026-11-12",
          note: issued.number!,
          originKey: "payment:3",
        });
        assert.strictEqual(
          (yield* receipt({ payment: balance.paymentId })).number,
          "QST-RN/26-27/010",
        );
        // And each payment on the invoice carries its receipt.
        const detail = yield* OwnerWork.get(people, { orgId, key: KinRecordKey.make("INV-1") });
        assert.deepStrictEqual(
          detail.payments?.map((one) => one.receipt?.number),
          ["QST-RN/26-27/008", "QST-RN/2026-27/007"],
        );

        // Ways back: a voided receipt keeps its number and the payment gets a new one; an
        // advance whose payment was taken back stays void, set against an invoice or not.
        yield* LeadDocuments.issue(scope, {
          entry: KinRecordKey.make(next.receipt),
          void: true,
          sourceEventId: asked,
        });
        const remade = yield* receipt({ payment: later.paymentId });
        assert.deepStrictEqual(
          [remade.receipt !== next.receipt, remade.number],
          [true, "QST-RN/26-27/011"],
        );
        // The void one stays void, by the owner's Undo void or an edit: two would count it twice.
        const backs = [
          Effect.flip(
            OwnerMoney.unvoidEntry(people, { orgId, key: KinRecordKey.make(next.receipt) }),
          ),
          Effect.flip(records.update(orgId, system, next.receipt, { state: "open" })),
        ] as const;
        for (const back of backs)
          assert.match((yield* back).message, /void receipt, and stays void/);
        const held = (yield* OwnerMoney.receipts(people, { orgId })).receipts.find(
          (one) => one.key === advance.receipt,
        )!.paymentId!;
        yield* records.voidPayment(orgId, system, "INV-2", held);
        const refused = yield* Effect.flip(receipt(against));
        assert.match(refused.message, /taken back, so it is void/);
        assert.strictEqual(
          (yield* OwnerMoney.receipts(people, { orgId })).receipts.find(
            (one) => one.key === advance.receipt,
          )!.state,
          "dropped",
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "take their payment, invoice, number and amount only from what Kin recorded, and only imported notes' numbers",
    () =>
      Effect.gen(function* () {
        const asked = yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const records = yield* KinRecords.KinRecords;
        const system = { actor: { _tag: "system" as const }, via: "import" as const };
        const owner = {
          actor: { _tag: "person" as const, personId: ownerId },
          via: "owner" as const,
        };
        const receipt = (input: ReceiptAsk) => agentReceipt(asked, input);
        const invoiceFor = (title: string, amount: string, client?: string) =>
          LeadWork.create(scope, {
            sourceEventId: asked,
            records: [
              {
                list: "invoices",
                title,
                amount,
                state: "open",
                ...(client === undefined ? {} : { client }),
              },
            ],
          }).pipe(Effect.map((made) => made.records[0]!.key));
        const pay = (
          writer: typeof owner | typeof system,
          key: string,
          minor: number,
          originKey: string,
          note?: string,
        ) =>
          records.pay(orgId, writer, key, {
            amount: { minor, currency: "INR" },
            paidOn: "2026-10-01",
            originKey,
            ...(note === undefined ? {} : { note }),
          });
        const retainer = yield* invoiceFor("Retainer", "50,000", "Invented Acme");
        // The old system's receipt for an advance, as the import writes it; and one it noted
        // with a number Kin could never issue after.
        const imported = yield* pay(
          system,
          retainer,
          1_000_000,
          "import:oldbooks:payment:adv",
          "Advance received; receipt note QST-RN/2026-27/001",
        );
        const long = yield* pay(
          system,
          retainer,
          100,
          "import:oldbooks:payment:long",
          "Old ref QST-RN/26-27/999999999",
        );
        // Notes typed in Kin: a long number taken back at once, and a client's PO number.
        const blocking = yield* pay(
          owner,
          "INV-1",
          100,
          "owner:blocking",
          "ref QST-RN/26-27/999999999",
        );
        yield* records.voidPayment(orgId, owner, "INV-1", blocking.paymentId);
        const po = yield* pay(
          owner,
          "INV-1",
          100,
          "owner:po",
          "Cheque 004512 against client PO/2026-27/118",
        );
        const shownFor = (paymentId: string) =>
          OwnerWork.get(people, { orgId, key: KinRecordKey.make("INV-1") }).pipe(
            Effect.map(
              (detail) => detail.payments?.find((one) => one.paymentId === paymentId)?.receipt,
            ),
          );
        assert.isNull(yield* shownFor(po.paymentId));
        const fromPo = yield* receipt({ payment: po.paymentId });
        assert.deepStrictEqual([fromPo.number, fromPo.problems], ["QST-RN/26-27/002", []]);
        assert.strictEqual(
          (yield* receipt({ payment: imported.paymentId })).number,
          "QST-RN/2026-27/001",
        );
        const fromLong = yield* receipt({ payment: long.paymentId });
        assert.deepStrictEqual(
          [fromLong.number, fromLong.problems.length],
          ["QST-RN/26-27/003", 1],
        );

        // No one else ties a receipt to a payment or an invoice, or numbers one.
        const tiny = yield* pay(owner, "INV-1", 100, "owner:tiny");
        const forged = yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            {
              list: "receipts",
              title: "Received in full",
              amount: "9,99,999",
              fields: { payment: tiny.paymentId, invoice: "INV-1" },
            },
          ],
        }).pipe(Effect.flip);
        assert.match(forged.message, /Kin writes a receipt's payment, invoice and number/);
        const plain = yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [{ list: "receipts", title: "Received in full", amount: "9,99,999" }],
        });
        const plainKey = plain.records[0]!.key;
        for (const patch of [
          { fields: { payment: tiny.paymentId } },
          { fields: { invoice: "INV-1" } },
          { fields: { number: "QST-RN/26-27/050" } },
        ])
          assert.match(
            (yield* records.update(orgId, owner, plainKey, patch).pipe(Effect.flip)).message,
            /Kin writes a receipt's payment/,
          );
        // A row tied by hand before this rule isn't the payment's receipt either.
        yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.payment',
            ${tiny.paymentId}) WHERE org_id = ${orgId} AND key = ${plainKey}`;
        const forTiny = yield* receipt({ payment: tiny.paymentId });
        assert.notStrictEqual(forTiny.receipt, plainKey);
        assert.deepStrictEqual(rendered.at(-1)!.request.inputs.amount, {
          minor: 100,
          currency: "INR",
        });
        // An issued receipt's amount stays what was received, and prints as its payment's.
        const edit = yield* LeadWork.update(scope, {
          key: KinRecordKey.make(forTiny.receipt),
          sourceEventId: asked,
          amount: "9,99,999",
        }).pipe(Effect.flip);
        assert.match(edit.message, /amount stays what was received/);
        const byOwner = yield* records
          .update(orgId, owner, forTiny.receipt, {
            amount: { minor: 99_999_900, currency: "INR" },
          })
          .pipe(Effect.flip);
        assert.match(byOwner.message, /amount stays what was received/);
        yield* sql`UPDATE kin_records SET amount_minor = 99999900
          WHERE org_id = ${orgId} AND key = ${forTiny.receipt}`;
        // Its document would print its payment's amount, so with the entry saying otherwise it
        // isn't made at all: a document never shows a total its entry doesn't.
        const again = yield* LeadDocuments.make(scope, {
          title: "Receipt again",
          recipe: "receipt",
          entry: forTiny.receipt,
          sourceEventId: asked,
        }).pipe(Effect.flip);
        assert.match(again.message, /comes to ₹1\.00, but RCT-\d+ is recorded at ₹9,99,999\.00/);
        assert.deepStrictEqual(rendered.at(-1)!.request.inputs.amount, {
          minor: 100,
          currency: "INR",
        });

        // An advance goes only to an invoice of its own client, never past what it still owes.
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [{ list: "clients", title: "Invented Beta" }],
        });
        const [acme] = yield* sql<{ key: string }>`SELECT key FROM kin_records
          WHERE org_id = ${orgId} AND register_id = 'clients' AND title = 'Invented Acme'`;
        const forBeta = yield* invoiceFor("Beta work", "300", "Invented Beta");
        const unbilled = yield* invoiceFor("No client yet", "1,000");
        const small = yield* invoiceFor("Small job", "300", "Invented Acme");
        const nobody = yield* receipt({ advance: { amount: "200", receivedOn: "2026-11-05" } });
        const advance = yield* receipt({
          advance: {
            client: KinRecordKey.make(acme!.key),
            amount: "500",
            receivedOn: "2026-11-05",
          },
        });
        const setAgainst = (entry: string, against: string) =>
          receipt({ entry: KinRecordKey.make(entry), against: KinRecordKey.make(against) }).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        assert.match(yield* setAgainst(nobody.receipt, unbilled), /names no client/);
        assert.match(yield* setAgainst(advance.receipt, forBeta), /another client/);
        assert.match(yield* setAgainst(advance.receipt, unbilled), /another client/);
        // Nor to an invoice nobody has kept: it owes nothing yet.
        const guessed = yield* invoiceFor("Guessed job", "1,000", "Invented Acme");
        yield* sql`UPDATE kin_records SET confirmed = 0 WHERE org_id = ${orgId} AND key = ${guessed}`;
        assert.match(
          yield* setAgainst(advance.receipt, guessed),
          new RegExp(`${guessed} is .*suggestion`),
        );
        // Nor from a receipt nobody has kept: its advance is evidence, not money received.
        yield* sql`UPDATE kin_records SET confirmed = 0
          WHERE org_id = ${orgId} AND key = ${advance.receipt}`;
        assert.match(
          yield* setAgainst(advance.receipt, retainer),
          new RegExp(`${advance.receipt} is .*suggestion`),
        );
        yield* sql`UPDATE kin_records SET confirmed = 1
          WHERE org_id = ${orgId} AND key = ${advance.receipt}`;
        assert.match(
          yield* setAgainst(advance.receipt, small),
          /has ₹300\.00 left to pay, less than the ₹500\.00 advance/,
        );
        yield* receipt({
          entry: KinRecordKey.make(advance.receipt),
          against: KinRecordKey.make(retainer),
        });
        // Set against, it is a payment on the invoice like any other, linked by id.
        const onRetainer = yield* OwnerWork.get(people, {
          orgId,
          key: KinRecordKey.make(retainer),
        });
        const setPayment = onRetainer.payments!.find((one) => one.paidOn === "2026-11-05")!;
        assert.deepStrictEqual(
          [setPayment.amount.minor, setPayment.receipt?.number],
          [50_000, advance.number],
        );
        const linked = yield* sql<{ key: string }>`SELECT t.key FROM kin_record_links l
          JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
          JOIN kin_records t ON t.org_id = l.org_id AND t.record_id = l.target
          WHERE l.org_id = ${orgId} AND r.key = ${advance.receipt} AND l.kind = 'record'
            AND t.register_id = 'invoices'`;
        assert.deepStrictEqual(linked, [{ key: retainer }]);

        // A void receipt's number never shows against its advance; the one made after it does.
        const advances = () =>
          LeadDocuments.make(
            scope,
            invoice({ entry: retainer, title: `Invoice ${retainer} ${rendered.length}` }),
          ).pipe(
            Effect.map(() =>
              (
                rendered.at(-1)!.request.inputs.paid as ReadonlyArray<{
                  receipt: string | null;
                  paidOn: string;
                }>
              ).find((one) => one.paidOn === "2026-11-05"),
            ),
          );
        yield* LeadDocuments.issue(scope, {
          entry: KinRecordKey.make(advance.receipt),
          void: true,
          sourceEventId: asked,
        });
        assert.isNull((yield* advances())!.receipt);
        const remade = yield* receipt({ payment: setPayment.paymentId });
        assert.notStrictEqual(remade.number, advance.number);
        assert.strictEqual((yield* advances())!.receipt, remade.number);
      }).pipe(Effect.provide(layer)),
  );
});

describe("files the agent makes", () => {
  it.effect("are filed as they are, linked to their entry, with their card in the chat", () =>
    Effect.gen(function* () {
      yield* seed;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "kin-agent-file-" });
      const pdf = `${dir}/Welcome note.pdf`;
      yield* fs.writeFileString(pdf, "%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n");
      const note = {
        title: "Welcome note",
        file: pdf,
        entry: KinRecordKey.make("INV-1"),
        sourceEventId: "event-3",
      };
      const made = yield* AgentFiles.fileDocument(scope, note);
      assert.deepStrictEqual(
        [made.recipe, made.documents, made.sensitive],
        [null, [{ key: "D-1", title: "Welcome note", version: 1 }], true],
      );
      assert.sameMembers(shownCards, ["D-1"]);
      const { doc, history } = yield* versionsOf("D-1");
      const version = Docs.toVersion((yield* Docs.versionOf(orgId, doc.recordId))!);
      assert.deepStrictEqual(
        [version.file?.name, version.file?.mimeType, version.file?.pages, doc.sensitive],
        ["Welcome note.pdf", "application/pdf", 1, 1],
      );
      assert.strictEqual(version.provenance.answered?.messageId, "msg-3");
      assert.match(
        yield* fs.readFileString(`${config.attachmentsDir}/${version.file!.attachmentId}.pdf`),
        /^%PDF-1\.7/,
      );
      assert.lengthOf(history, 1);
      // Asking again files nothing new.
      yield* AgentFiles.fileDocument(scope, note);
      assert.lengthOf((yield* versionsOf("D-1")).history, 1);
      // A link, the wrong bytes, a path from nowhere and a web page are refused; nothing is filed.
      yield* fs.symlink(pdf, `${dir}/linked.pdf`);
      yield* fs.writeFileString(`${dir}/fake.pdf`, "not a PDF");
      yield* fs.writeFileString(`${dir}/page.html`, "<p>hi</p>");
      for (const [file, reason] of [
        [`${dir}/linked.pdf`, /it's a link/],
        [`${dir}/fake.pdf`, /its bytes aren't a PDF file/],
        ["notes.pdf", /give its full path/],
        [`${dir}/page.html`, /HTML page isn't kept/],
        [`${dir}/missing.pdf`, /isn't there/],
      ] as const) {
        const refused = yield* AgentFiles.fileDocument(scope, {
          ...note,
          title: "Another",
          file,
        }).pipe(Effect.flip);
        assert.match(refused.message, reason);
        assert.match(refused.message, /^Nothing was filed/);
      }
      const bare = yield* AgentFiles.fileDocument(scope, {
        title: "No file",
        sourceEventId: "event-3",
      }).pipe(Effect.flip);
      assert.match(bare.message, /give its full path in file/);
      assert.sameMembers([...new Set(shownCards)], ["D-1"]);
      // A screenshot a delegated run left in its Scratch folder is filed as an image with its card.
      const shots = `${config.baseDir}/scratch/review-run/shots`;
      yield* fs.makeDirectory(shots, { recursive: true });
      const png = `${shots}/phone-390-save-alert.png`;
      yield* fs.writeFile(png, Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0));
      const shot = yield* AgentFiles.fileDocument(scope, {
        title: "Save alert on a phone",
        file: png,
        sourceEventId: "event-3",
      });
      const [shotDoc] = shot.documents;
      assert.include(shownCards, shotDoc!.key);
      const shotFile = Docs.toVersion(
        (yield* Docs.versionOf(orgId, (yield* versionsOf(shotDoc!.key)).doc.recordId))!,
      ).file;
      assert.deepStrictEqual(
        [shotFile?.name, shotFile?.mimeType],
        ["phone-390-save-alert.png", "image/png"],
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keep a recipe the agent wrote only once its sample renders", () =>
    Effect.gen(function* () {
      yield* seed;
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* Workspace.KinWorkspace;
      const started = yield* writeRecipe("quote");
      assert.isDefined(started.folder);
      assert.match(started.next!, /recipes\/invoice\/ shows computed fields/);
      // Asked again with nothing changed, it says so and keeps the same folder.
      const idle = yield* writeRecipe("quote");
      assert.deepStrictEqual(
        [idle.folder, idle.next?.startsWith("Nothing in recipes/quote/ has changed yet.")],
        [started.folder, true],
      );
      yield* editQuote(started.folder!, 1);
      failing.reason = "quote.pdf: template.typ:2:1: error: unknown variable: blcks";
      const refused = yield* writeRecipe("quote").pipe(Effect.flip);
      assert.match(
        refused.message,
        /didn't keep the quote recipe: its sample didn't render because .*blcks/,
      );
      assert.isUndefined((yield* workspace.recipes(orgId)).find((one) => one.name === "quote"));
      failing.reason = undefined;
      const kept = yield* writeRecipe("quote");
      assert.match(kept.next!, /rendered the quote recipe's sample and committed it/);
      assert.isDefined((yield* workspace.recipes(orgId)).find((one) => one.name === "quote"));
      assert.isFalse(yield* fs.exists(started.folder!), "the folder goes once it is kept");
      // The owner sees the sample in the chat: its PDF and its first page.
      assert.lengthOf(kept.documents, 2);
      assert.includeMembers(
        shownCards,
        kept.documents.map((one) => one.key),
      );
      // Review 45: a numbered recipe that doesn't say which figure its document asks for goes back.
      const unpriced = STARTER_FILES["recipes/invoice/RECIPE.md"]!.replace(
        "name: invoice",
        "name: quote",
      )
        .replace(/^amount: .*\n/m, "")
        .replace("[invoice.pdf]", "[quote.pdf]");
      const back = yield* writeQuote(3, 0, {
        recipe: unpriced,
        // The seed's company has the starter sample's invented GSTIN and account.
        sample: STARTER_FILES["recipes/invoice/sample.json"]!.replace(
          "29AAAAA1111A1Z5",
          "29CCCCC3333C1Z5",
        ).replace("000111222333", "999888777666"),
        template: STARTER_FILES["recipes/invoice/template.typ"]!,
      }).pipe(Effect.flip);
      assert.match(back.message, /it is numbered, so its front matter declares amount/);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("copy the look of the owner's file into a recipe, never the file or its data", () =>
    Effect.gen(function* () {
      yield* seed;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      const workspace = yield* Workspace.KinWorkspace;
      // The owner's old invoice, invented, sent in the chat the turn answers in.
      const referenceId = "kin-chat-00000000-0000-4000-8000-0000000000aa-pdf";
      const pdf = "%PDF-1.7\n% an invented reference invoice\n%%EOF\n";
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(`${config.attachmentsDir}/${referenceId}.pdf`, pdf);
      const asked = yield* turn(4, "Make our invoices look like this");
      const sent = [
        {
          type: "file",
          id: referenceId,
          name: "Old invoice 12.pdf",
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
        },
      ];
      yield* sql`UPDATE kin_messages SET attachments_json = ${JSON.stringify(sent)}
        WHERE message_id = 'msg-4'`;
      yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
        VALUES (${referenceId}, ${orgId}, 'lead-chat', 'msg-4')`;
      const elsewhere = yield* checkReferences(orgId, "other-chat", [referenceId]).pipe(
        Effect.flip,
      );
      assert.match(elsewhere.message, /not a file in this chat/);
      const letterhead = (more: Partial<LeadDocuments.DocumentInput> = {}) =>
        writeRecipe("letterhead", { sourceEventId: asked, ...more });
      const started = yield* letterhead({ references: [referenceId] });
      assert.match(started.next!, /References: the owner sent a file .*Old invoice 12\.pdf/);
      const folder = `${started.folder!}/recipes/letterhead`;
      const copied = `${started.folder!}/in/references/Old invoice 12.pdf`;
      assert.strictEqual(yield* fs.readFileString(copied), pdf);
      assert.strictEqual(Number((yield* fs.stat(copied)).mode) & 0o222, 0, "read-only");
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(
        `${folder}/RECIPE.md`,
        STARTER_FILES["recipes/report/RECIPE.md"]!.replace(
          "name: report",
          "name: letterhead",
        ).replace("[report.pdf]", "[letterhead.pdf]"),
      );
      yield* fs.writeFileString(`${folder}/template.typ`, '#let d = json("/inputs.json")\n');
      yield* fs.writeFileString(
        `${folder}/sample.json`,
        STARTER_FILES["recipes/report/sample.json"]!,
      );
      // An image the agent drew for the template, which the owner sees before clearing a label.
      yield* fs.writeFile(
        `${folder}/stamp.png`,
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      // A copy of the reference in the recipe is never kept.
      yield* fs.writeFileString(`${folder}/old.pdf`, pdf);
      const copy = yield* letterhead().pipe(Effect.flip);
      assert.match(copy.message, /old\.pdf is a copy of the owner's reference Old invoice 12\.pdf/);
      // Then Typst's own error.
      yield* fs.remove(`${folder}/old.pdf`);
      failing.reason = "letterhead.pdf: template.typ:1:1: error: unknown variable: oops";
      const broken = yield* letterhead().pipe(Effect.flip);
      assert.match(broken.message, /its sample didn't render because .*unknown variable: oops/);
      // Rendered, its first page goes back once to set beside the references.
      failing.reason = undefined;
      const look = yield* letterhead();
      assert.match(look.next!, /in\/rendered\/page-1\.png/);
      assert.isTrue(yield* fs.exists(`${started.folder!}/in/rendered/page-1.png`));
      assert.isUndefined(
        (yield* workspace.recipes(orgId)).find((one) => one.name === "letterhead"),
      );
      const kept = yield* letterhead();
      assert.match(kept.next!, /committed it/);
      assert.match(kept.next!, /kin_recipe_undo with recipe letterhead/);
      // The owner sees the new look in the chat: the sample's PDF and its first page.
      assert.lengthOf(kept.documents, 2);
      assert.includeMembers(
        shownCards,
        kept.documents.map((one) => one.key),
      );
      const listed = yield* OwnerDocs.recipes(people, { orgId });
      const made = listed.recipes.find((one) => one.name === "letterhead");
      assert.deepStrictEqual([made?.labelled, made?.files], [true, ["stamp.png"]]);
      assert.isFalse(yield* fs.exists(started.folder!));
      // An undo that removed the new recipe says so, and so does the redo, so neither reads as failed.
      const undo = () =>
        LeadDocuments.undoRecipe(scope, { recipe: "letterhead", sourceEventId: asked });
      const undone = yield* undo();
      assert.isTrue(undone.removed);
      assert.match(undone.next, /^Undone: .*the recipe is gone now/);
      const redone = yield* undo();
      assert.isFalse(redone.removed);
      assert.match(redone.next, /^Undone: the letterhead recipe is back as it was/);

      // A sample holding the company's real details is refused, however often it is asked.
      const memo = (yield* writeRecipe("memo", { sourceEventId: asked })).folder!;
      yield* fs.makeDirectory(`${memo}/recipes/memo`, { recursive: true });
      yield* fs.writeFileString(
        `${memo}/recipes/memo/RECIPE.md`,
        STARTER_FILES["recipes/report/RECIPE.md"]!.replace("name: report", "name: memo").replace(
          "[report.pdf]",
          "[memo.pdf]",
        ),
      );
      yield* fs.writeFileString(
        `${memo}/recipes/memo/template.typ`,
        '#let d = json("/inputs.json")\n',
      );
      yield* fs.writeFileString(
        `${memo}/recipes/memo/sample.json`,
        JSON.stringify({ title: "For Invented Acme", body: "Invented words." }),
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const leaky = yield* writeRecipe("memo", { sourceEventId: asked }).pipe(Effect.flip);
        assert.match(leaky.message, /sample\.json holds the company's or a client's real details/);
      }
      assert.isUndefined((yield* workspace.recipes(orgId)).find((one) => one.name === "memo"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "label every document made from a recipe a sensitive draft wrote, until the owner clears it",
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
        const listed = (name = "quote") =>
          Effect.map(OwnerDocs.recipes(people, { orgId }), (all) =>
            all.recipes.find((one) => one.name === name),
          );
        const labelled = (name = "quote") =>
          Effect.map(listed(name), (one) => one?.labelled === true);
        const clear = Effect.gen(function* () {
          const commit = (yield* listed())!.commit;
          return yield* OwnerDocs.labelRecipe(people, {
            orgId,
            recipe: "quote",
            commit,
            sensitive: false,
          });
        });
        assert.match((yield* writeQuote(1, 1)).next!, /committed it/);
        assert.deepStrictEqual(
          [yield* quote(), yield* quote(true), yield* labelled()],
          [true, true, true],
        );
        // A plain job's change built on it keeps the label.
        assert.match((yield* writeQuote(2)).next!, /committed it/);
        assert.isTrue(yield* quote());
        const seen = (yield* listed())!.commit;
        yield* clear;
        assert.deepStrictEqual([yield* quote(), yield* labelled()], [false, false]);
        // Undo brings back the first revision with its own label; redo brings back the cleared one.
        yield* OwnerDocs.undoRecipe(people, { orgId, recipe: "quote" });
        assert.isTrue(yield* quote());
        yield* OwnerDocs.undoRecipe(people, { orgId, recipe: "quote" });
        assert.isFalse(yield* quote());
        const someone = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("someone") }];
        const refused = yield* OwnerDocs.labelRecipe(someone, {
          orgId,
          recipe: "quote",
          commit: seen,
          sensitive: false,
        }).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "not_allowed");

        // A crash between a commit and its label leaves no row: the revision reads sensitive.
        const sql = yield* SqlClient.SqlClient;
        const unlabel = Effect.gen(function* () {
          const commit = (yield* listed())!.commit;
          yield* sql`DELETE FROM kin_recipe_labels WHERE commit_sha = ${commit}`;
        });
        // A plain change built on the cleared revision, its label lost.
        assert.match((yield* writeQuote(3)).next!, /committed it/);
        assert.isFalse(yield* labelled());
        yield* unlabel;
        assert.isTrue(yield* labelled());
        yield* clear;
        // Two plain changes from the same revision: another agent's lands first, and this
        // draft's is merged with it.
        const draft = (yield* writeRecipe("quote")).folder!;
        yield* sql`UPDATE kin_doc_jobs SET sensitive = 0
          WHERE mode = 'recipe' AND recipe = 'quote' AND collected_at IS NULL`;
        yield* editQuote(draft, 5, {
          description: "Quote 3.",
          template: '#let d = json("/inputs.json")\n#d.title\n',
        });
        const workspace = yield* Workspace.KinWorkspace;
        const other = KinWorkerId.make("rw-other-agent");
        yield* editQuote((yield* workspace.prepare(orgId, other, {})).worktree, 4);
        const landed = yield* workspace.applyRecipeChange(orgId, {
          workerId: other,
          recipe: "quote",
          agentId: KinAgentId.make("other-agent"),
          verify: () => Effect.undefined,
        });
        assert.strictEqual(landed._tag, "committed");
        if (landed._tag === "committed") yield* labelChange(orgId, "quote", landed, false);
        yield* workspace.discard(orgId, other);
        const merged = (yield* writeRecipe("quote")).next!;
        assert.match(merged, /committed it/);
        // The recipe is now the merge of the two, not the second job's own commit.
        const merge = (yield* listed())!.commit;
        assert.notInclude(merged, merge.slice(0, 12));
        assert.isFalse(yield* labelled());
        yield* unlabel;
        assert.isTrue(yield* labelled());
        yield* clear;
        // The owner's undo of it.
        yield* OwnerDocs.undoRecipe(people, { orgId, recipe: "quote" });
        assert.notStrictEqual((yield* listed())!.commit, merge);
        assert.isFalse(yield* labelled());
        yield* unlabel;
        assert.isTrue(yield* labelled());
        // Clearing what the owner no longer sees is refused, and changes nothing.
        const stale = yield* OwnerDocs.labelRecipe(people, {
          orgId,
          recipe: "quote",
          commit: merge,
          sensitive: false,
        }).pipe(Effect.flip);
        assert.deepInclude(stale, { reason: "invalid_state" });
        assert.match(stale.message, /changed after you looked/);
        assert.isTrue(yield* labelled());
        yield* clear;
        assert.isFalse(yield* labelled());
        // The owner can mark it private again, and what it makes is private from then on.
        yield* OwnerDocs.labelRecipe(people, {
          orgId,
          recipe: "quote",
          commit: (yield* listed())!.commit,
          sensitive: true,
        });
        assert.deepStrictEqual([yield* labelled(), yield* quote()], [true, true]);
        yield* clear;
        assert.deepStrictEqual([yield* labelled(), yield* quote()], [false, false]);
        // The starter recipes, and revisions from before Kin recorded where main was, have no
        // row and read as the job that wrote them did.
        assert.isFalse(yield* labelled("report"));
        yield* sql`DELETE FROM kin_recipe_label_baselines`;
        yield* unlabel;
        assert.isFalse(yield* labelled());
        assert.match((yield* writeQuote(6)).next!, /committed it/);
        yield* OwnerDocs.undoRecipe(people, { orgId, recipe: "quote" });
        assert.isFalse(yield* labelled());
      }).pipe(Effect.provide(layer)),
  );
});
