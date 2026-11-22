import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
import { handlers as docHandlers } from "../work/mcp/docHandlers.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { handlers as workHandlers } from "../work/mcp/handlers.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { turnSensitive } from "../work/sensitiveReads.ts";
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
  McpHttpServer.toolkitRegistration(KinLeadToolkit, leadHandlers),
  McpHttpServer.toolkitRegistration(KinPulseToolkit, pulseHandlers),
  McpHttpServer.toolkitRegistration(KinWorkToolkit, workHandlers),
  McpHttpServer.toolkitRegistration(KinDocsToolkit, docHandlers),
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

const MARK = "INSERT INTO kin_wakeup_sensitive_reads";

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
      connectionOf(one.span) === "reader" || one.sql.startsWith(MARK) ? [] : [one.sql],
    ),
  };
});

it.effect("runs every listed agent read tool on a reader, and still marks what it showed", () =>
  Effect.gen(function* () {
    const services = Option.getOrThrow((yield* Kin.KinServer).services);
    const identity = Context.get(services, KinIdentity);
    const chats = Context.get(services, KinChatService);
    const sql = yield* SqlClient.SqlClient;
    yield* pairSession(AuthSessionId.make("owner"));
    const [owner] = yield* identity.resolve({
      sessionId: AuthSessionId.make("owner"),
      subject: "browser",
      method: "browser-session-cookie",
      scopes: AuthStandardClientScopes,
    });
    const { orgId } = owner!;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
        created_at)
      VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', ${owner!.personId}, ${at})`;
    yield* identity.registerAgentThread({ orgId, agentId: chief, threadId });
    const ownerChat = (yield* chats.createDirect(owner!, { orgId, agentId: chief })).chatId;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${chief}, ${orgId}, 'Chief of staff', 0, ${threadId}, '{}', '[]', ${ownerChat},
        'chief-of-staff')`;
    const message = yield* chats.send(owner!, {
      chatId: ownerChat,
      body: "Track the Grove work.",
      clientMessageId: "grove",
    });
    yield* startAgentWakeup({ orgId, agentId: chief, threadId, message });
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
    const asked = yield* chats.send(owner!, {
      chatId: ownerChat,
      body: "Where is the Grove work?",
      clientMessageId: "where",
    });
    const wakeupId = yield* startAgentWakeup({ orgId, agentId: chief, threadId, message: asked });
    assert.isFalse(yield* turnSensitive(orgId, wakeupId), "nothing sensitive read yet");

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
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
