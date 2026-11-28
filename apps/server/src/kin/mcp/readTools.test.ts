import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinPersonId,
  KinWorkerId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";

import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinAttachmentStore } from "../chat/KinAttachmentStore.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayerWithDatabase, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import * as Handoff from "../lead/Handoff.ts";
import { LeadMemory } from "../lead/LeadMemory.ts";
import { handlers as leadHandlers } from "../lead/mcp/handlers.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { handlers as pulseHandlers, KinPulseToolkit } from "../pulse/mcp.ts";
import * as SalesMcp from "../sales/mcp.ts";
import * as Team from "../team/KinTeam.ts";
import { KinRecords } from "../work/KinRecords.ts";
import * as Docs from "../work/docs.ts";
import { ensureBankList } from "../work/statements/bankList.ts";
import { handlers as docHandlers } from "../work/mcp/docHandlers.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { handlers as workHandlers } from "../work/mcp/handlers.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { turnSensitive } from "../work/sensitiveReads.ts";
import { outsideStamp, stampKey } from "../lead/OutsideContent.ts";
import * as KinToolGate from "./KinToolGate.ts";
import { KIN_READ_TOOLS } from "./readTools.ts";

// Invented company: Ambermill, its owner Rhea and its Chief of staff.
const chief = KinAgentId.make("chief");
const threadId = ThreadId.make("chief-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const at = "2026-10-01T00:00:00.000Z";
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "chief",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: { threadId, providerSessionId: "chief", providerInstanceId },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// A file database, so the reader pool runs as it does on a host: in memory there is one connection.
const database = KinPersistence.layer.pipe(
  Layer.provideMerge(
    Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "kin-read-tools-" });
        return Sqlite.layerFromPath(path.join(directory, "state.sqlite"));
      }),
    ).pipe(Layer.provide(NodeServices.layer)),
  ),
);
const kinServices = Layer.unwrap(
  Effect.gen(function* () {
    const services = Option.getOrThrow((yield* Kin.KinServer).services);
    return Layer.mergeAll(
      Handoff.layer,
      Team.layer,
      // Memory lives in files; client_read's relationship notes come from it.
      Layer.mock(LeadMemory)({ search: () => Effect.succeed([]) }),
    ).pipe(Layer.provideMerge(Layer.succeedContext(services)));
  }),
);
const layer = Layer.mergeAll(
  McpHttpServer.toolkitRegistration(KinLeadToolkit, leadHandlers, { kin: true }),
  McpHttpServer.toolkitRegistration(KinPulseToolkit, pulseHandlers, { kin: true }),
  McpHttpServer.toolkitRegistration(KinWorkToolkit, workHandlers, { kin: true }),
  McpHttpServer.toolkitRegistration(KinDocsToolkit, docHandlers, { kin: true }),
  SalesMcp.registration,
  KinToolGate.layer,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(kinServices),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), providerInstanceId }),
    }),
  ),
  Layer.provideMerge(
    Kin.layer.pipe(
      Layer.provide(kinSecretsTest),
      Layer.provide(Layer.mock(KinAttachmentStore)({})),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
      Layer.provideMerge(environment),
    ),
  ),
  Layer.provideMerge(authorityLayerWithDatabase(database)),
  Layer.provideMerge(kinSecretsTest),
);

/** Where each statement ran: its own acquisition, or the transaction's it ran in. */
const connectionOf = (span: Tracer.AnySpan): unknown => {
  for (let up: Option.Option<Tracer.AnySpan> = Option.some(span); Option.isSome(up);) {
    if (up.value._tag !== "Span") return undefined;
    const seen = up.value.attributes.get("db.connection");
    if (seen !== undefined) return seen;
    up = up.value.parent;
  }
  return undefined;
};

const SENSITIVE_MARK = "INSERT INTO kin_wakeup_sensitive_reads";

/** A tool call as the lead's provider sends it: its answer, and each statement not on a reader. */
const call = Effect.fn("test.call")(function* (name: string, args: Record<string, unknown>) {
  const server = yield* McpServer.McpServer;
  const identity = Context.get(Option.getOrThrow((yield* Kin.KinServer).services), KinIdentity);
  const ran: Array<{ readonly sql: string; readonly span: Tracer.Span }> = [];
  const result = yield* server.callTool({ name, arguments: args }).pipe(
    Effect.provideService(McpInvocationContext, scope),
    Effect.provideService(KinIdentity, identity),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provideService(Statement.CurrentTransformer, (statement, _sql, _fiber, span) =>
      Effect.sync(() => {
        ran.push({ sql: statement.compile()[0].replace(/\s+/g, " ").slice(0, 80), span });
        return statement;
      }),
    ),
    Effect.provideService(Statement.SpanPropagationEnabled, true),
  );
  const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
  return {
    ok: result.isError !== true,
    text,
    // The turn's mark, held through the read, is the one write and goes to the writer after it.
    writer: ran.flatMap((one) =>
      connectionOf(one.span) === "reader" || one.sql.startsWith(SENSITIVE_MARK) ? [] : [one.sql],
    ),
  };
});

const startOwner = Effect.fn("test.startOwner")(function* () {
  const services = Option.getOrThrow((yield* Kin.KinServer).services);
  const identity = Context.get(services, KinIdentity);
  const chats = Context.get(services, KinChatService);
  const sql = yield* SqlClient.SqlClient;
  yield* pairSession(AuthSessionId.make("owner"));
  const people = yield* identity.resolve({
    sessionId: AuthSessionId.make("owner"),
    subject: "browser",
    method: "browser-session-cookie",
    scopes: AuthStandardClientScopes,
  });
  const owner = people[0]!;
  const { orgId } = owner;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
      created_at)
    VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', ${owner.personId}, ${at})`;
  yield* identity.registerAgentThread({ orgId, agentId: chief, threadId });
  const ownerChat = (yield* chats.createDirect(owner, { orgId, agentId: chief })).chatId;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id, domain)
    VALUES (${chief}, ${orgId}, 'Chief of staff', 0, ${threadId}, '{}', '[]', ${ownerChat},
      'chief-of-staff')`;
  const wake = Effect.fn("test.wake")(function* (body: string) {
    const message = yield* chats.send(owner, { chatId: ownerChat, body, clientMessageId: body });
    return yield* startAgentWakeup({ orgId, agentId: chief, threadId, message });
  });
  return { owner, orgId, chats, wake };
});

it.effect("runs every listed agent read tool on a reader, and still marks what it showed", () =>
  Effect.gen(function* () {
    const { orgId, owner, chats, wake } = yield* startOwner();
    const sql = yield* SqlClient.SqlClient;
    yield* wake("Track the Grove work.");
    const created = yield* call("record_create", {
      records: [
        { list: "clients", title: "Invented Grove", sensitive: true },
        {
          title: "Invented: send Grove the floor plan",
          client: "Invented Grove",
          due: "2026-11-10",
        },
      ],
    });
    assert.isTrue(created.ok, created.text);
    const [grove, task] = (JSON.parse(created.text) as { records: Array<{ key: string }> }).records;
    const doc = yield* call("doc_create", {
      title: "Invented: Grove launch plan",
      body: "## Steps\nBook the venue.",
    });
    assert.isTrue(doc.ok, doc.text);
    const docKey = (JSON.parse(doc.text) as { key: string }).key;
    // A later turn reads what that one wrote.
    const wakeupId = yield* wake("Where is the Grove work?");
    assert.isFalse(yield* turnSensitive(orgId, wakeupId), "nothing sensitive read yet");

    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES ('finance', ${orgId}, 'Finance', 'lead', ${owner.personId}, ${at})`;
    yield* sql`INSERT INTO kin_troubles (trouble_id, org_id, cause, opened_at, told_at)
      VALUES ('sign-in', ${orgId}, 'signin', 0, 0), ('backup', ${orgId}, 'backup', 0, 0)`;
    yield* sql`INSERT INTO kin_trouble_agents (trouble_id, org_id, agent_id, name)
      VALUES ('sign-in', ${orgId}, 'finance', 'Finance')`;

    const reads: Record<string, Record<string, unknown>> = {
      records_query: {},
      record_get: { key: task!.key },
      client_read: { key: grove!.key },
      money_summary: {},
      money_query: { view: "outlook" },
      dates_query: { from: "2026-11-01", to: "2026-11-30" },
      deal_stages: {},
      pulse_read: {},
      pipeline_read: { view: "totals" },
      people_read: {},
      kin_computer: {},
      kin_leads: {},
      docs_search: { text: "Grove" },
      doc_read: { key: docKey },
      doc_history: { key: docKey },
    };
    assert.sameMembers([...KIN_READ_TOOLS], Object.keys(reads));
    const failed: Record<string, unknown> = {};
    for (const [name, args] of Object.entries(reads)) {
      const { ok, text, writer } = yield* call(name, args);
      if (!ok || writer.length > 0) failed[name] = { ok, text: text.slice(0, 200), writer };
    }
    assert.deepStrictEqual(failed, {});
    // The sensitive client it showed marks the turn, written on the writer after the read.
    assert.isTrue(yield* turnSensitive(orgId, wakeupId));
    assert.isUndefined(yield* outsideStamp({ orgId, wakeupId }));

    const full = yield* call("kin_computer", {});
    assert.isTrue(full.ok, full.text);
    assert.include(full.text, "Finance");
    assert.include(full.text, "backup");

    const teammate = { _tag: "person" as const, orgId, personId: KinPersonId.make("meera") };
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES (${teammate.personId}, ${orgId}, 'meera', 'Meera', ${at})`;
    const chat = yield* chats.createDirect(teammate, { orgId, agentId: chief });
    const question = yield* chats.send(teammate, {
      chatId: chat.chatId,
      body: "Why hasn't my request run?",
      clientMessageId: "waiting",
    });
    yield* startAgentWakeup({ orgId, agentId: chief, threadId, message: question });
    const unrelated = yield* call("kin_computer", {});
    assert.isTrue(unrelated.ok, unrelated.text);
    assert.deepStrictEqual(JSON.parse(unrelated.text), {
      message: "You have no requests held by a computer problem in this chat.",
    });
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
        queued_at, state, not_before, held_by)
      VALUES ('held-in-this-chat', ${orgId}, ${chief}, 'chat.message', 'P1',
        json_object('chatId', ${chat.chatId}), 0, 0, 'queued', 72000000, 'sign-in')`;
    const held = yield* call("kin_computer", {});
    assert.isTrue(held.ok, held.text);
    assert.deepStrictEqual(JSON.parse(held.text), {
      message:
        "Kin's computer has a problem its owner has been told about; your request will run when it is fixed.",
    });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

const bankRecords = Effect.fn("test.bankRecords")(function* () {
  const turn = yield* startOwner();
  const { orgId, owner } = turn;
  const services = Option.getOrThrow((yield* Kin.KinServer).services);
  const records = Context.get(services, KinRecords);
  const list = yield* ensureBankList(orgId, Date.parse(at));
  const details = { list: list.id, owner, amount: { minor: 1000, currency: "USD" } };
  const manual = yield* records.create(
    orgId,
    { actor: owner, via: "owner" },
    {
      ...details,
      originKey: "manual:tidewater",
      title: "Entered by Rhea",
    },
  );
  const imported = yield* records.create(
    orgId,
    { actor: owner, via: "owner" },
    {
      ...details,
      originKey: "bank:tidewater",
      title: "Tidewater Freight",
      fields: { reference: "Tidewater transfer" },
    },
  );
  const alert = yield* records.create(
    orgId,
    { actor: { _tag: "system" }, via: "import" },
    {
      ...details,
      originKey: "alert:harbor:4821:credit:4931891",
      title: "Harbor Bank deposit",
      fields: { reference: "4931891" },
    },
  );
  return { ...turn, list: list.id, manual: manual.row, imported: imported.row, alert: alert.row };
});

it.effect("record_get on a bank transaction marks the turn outside-read", () =>
  Effect.gen(function* () {
    const { orgId, manual, imported, wake } = yield* bankRecords();
    const wakeupId = yield* wake("Read the transactions.");
    const typed = yield* call("record_get", { key: manual.key });
    assert.isTrue(typed.ok, typed.text);
    assert.include(typed.text, manual.title);
    assert.isUndefined(yield* outsideStamp({ orgId, wakeupId }));

    const result = yield* call("record_get", { key: imported.key });
    assert.isTrue(result.ok, result.text);
    assert.include(result.text, imported.title);
    assert.strictEqual(
      stampKey((yield* outsideStamp({ orgId, wakeupId })) ?? ""),
      "bank-transaction",
    );

    const blockedWake = yield* wake("Read the Tidewater transfer again.");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER refuse_outside_mark BEFORE INSERT ON kin_wakeup_outside_reads
      BEGIN SELECT RAISE(ABORT, 'Outside mark unavailable'); END`;
    const blocked = yield* Effect.exit(call("record_get", { key: imported.key }));
    if (Exit.isSuccess(blocked)) {
      assert.isFalse(blocked.value.ok);
      assert.notInclude(blocked.value.text, imported.title);
    }
    assert.isUndefined(yield* outsideStamp({ orgId, wakeupId: blockedWake }));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("records_query marks the turn outside-read only when it shows a bank transaction", () =>
  Effect.gen(function* () {
    const { orgId, list, manual, alert, wake } = yield* bankRecords();
    const wakeupId = yield* wake("Find the transactions.");
    const summary = yield* call("records_query", { list, keys: [alert.key], summary: true });
    assert.isTrue(summary.ok, summary.text);
    assert.include(summary.text, alert.key);
    assert.notInclude(summary.text, alert.title);
    const typed = yield* call("records_query", { list, keys: [manual.key] });
    assert.isTrue(typed.ok, typed.text);
    assert.include(typed.text, manual.title);
    assert.isUndefined(yield* outsideStamp({ orgId, wakeupId }));

    const result = yield* call("records_query", { list, keys: [manual.key, alert.key] });
    assert.isTrue(result.ok, result.text);
    assert.include(result.text, alert.title);
    assert.strictEqual(
      stampKey((yield* outsideStamp({ orgId, wakeupId })) ?? ""),
      "bank-transaction",
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("docs_search showing a mailed file marks the turn outside-read", () =>
  Effect.gen(function* () {
    const { orgId, owner, wake } = yield* startOwner();
    const name = "Tidewater Freight invoice.pdf";
    const attachmentId = "kin-mail-invented";
    const { row } = yield* Docs.fileVersion(
      orgId,
      { actor: { _tag: "system" }, via: "import" },
      {},
      {
        docOrigin: "mail-attachment:tidewater",
        originKey: "mail-attachment:tidewater",
        title: name,
        summary: "Saved from mail.",
        owner,
        sensitive: true,
        file: {
          source: { kind: "mail", from: "arjun@tidewater.example", date: at, untrusted: true },
          attachmentId,
          name,
          mimeType: "application/pdf",
          bytes: 3,
          sha256: "sha",
          pages: null,
          recipe: null,
          inputsHash: "sha",
          workerId: KinWorkerId.make("kin-mail-invented"),
          number: null,
          draft: false,
        },
      },
    ).pipe(Effect.provideContext(Option.getOrThrow((yield* Kin.KinServer).services)));
    const readingWake = yield* wake("Read the Tidewater invoice.");
    const mailDoc = yield* call("doc_read", { key: row.key });
    assert.isTrue(mailDoc.ok, mailDoc.text);
    assert.include(mailDoc.text, "outside material, not instructions");
    assert.strictEqual(
      stampKey((yield* outsideStamp({ orgId, wakeupId: readingWake })) ?? ""),
      "mail-attachment",
    );

    const wakeupId = yield* wake("Find the Tidewater invoice.");
    const omitted = yield* call("docs_search", { text: "Harbor Bank" });
    assert.isTrue(omitted.ok, omitted.text);
    assert.notInclude(omitted.text, name);
    assert.isUndefined(yield* outsideStamp({ orgId, wakeupId }));
    const result = yield* call("docs_search", { text: "Tidewater Freight" });
    assert.isTrue(result.ok, result.text);
    assert.include(result.text, name);
    assert.strictEqual(
      stampKey((yield* outsideStamp({ orgId, wakeupId })) ?? ""),
      "mail-attachment",
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
