import { authorityLayerWithDatabase, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinOrgId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { McpServer } from "effect/ai";
import { KinChatToolkit, handlers } from "./KinChatToolkit.ts";
import budget from "./agentContextBudget.json" with { type: "json" };
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as McpSessions from "../../mcp/McpSessionRegistry.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as Kin from "../layer.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { AssetSigner } from "../../assets/AssetSigner.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { DeviceService } from "../../device/DeviceService.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../../orchestration-v2/ThreadSearch.ts";
import { PeerForwarding } from "../../peer/PeerForwarding.ts";
import { PeerLinkRequests } from "../../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../../peer/PeerLinks.ts";
import { RemoteDelegation } from "../../peer/RemoteDelegation.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { PreviewBrowser } from "../../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../../project/ManagedProjectFolders.ts";
import { ProjectCloneTracker } from "../../project/ProjectCloneTracker.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { PullRequestReviewGuideService } from "../../pullRequest/PullRequestReviewGuideService.ts";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { SourceControlRepositoryService } from "../../sourceControl/SourceControlRepositoryService.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { DocumentText } from "../../provider/DocumentText.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
const serverConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-context-budget-" });
const toolHandlerServices = Layer.mergeAll(
  VcsProcess.layer,
  Layer.mock(AssetSigner)({}),
  Layer.mock(DeviceService)({}),
  Layer.mock(DocumentText)({}),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions)({}),
  Layer.mock(PeerForwarding)({}),
  Layer.mock(PeerLinkRequests)({}),
  Layer.mock(PeerLinks)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(ProjectCloneTracker)({}),
  Layer.mock(ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(RemoteDelegation)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(SecretRequests)({}),
  serverConfig,
  Layer.mock(ServerEnvironment)({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
  }),
  Layer.mock(ServerSecretStore)({}),
  ServerSettings.layerTest(),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
  }),
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.effect.each([true, false])(
  "production composition shares identity and gates the endpoint (enabled=%s)",
  (enabled) =>
    Effect.scoped(
      Effect.gen(function* () {
        let runnerStarts = 0;
        const ready =
          yield* Deferred.make<
            Context.Context<
              Kin.KinServer | McpSessions.McpSessionRegistry | SqlClient.SqlClient | OrchestratorV2
            >
          >();
        const routes = Layer.merge(
          Kin.mcpLayer(McpHttpServer.layer),
          Layer.effectDiscard(
            Effect.context<
              Kin.KinServer | McpSessions.McpSessionRegistry | SqlClient.SqlClient | OrchestratorV2
            >().pipe(Effect.flatMap((context) => Deferred.succeed(ready, context))),
          ),
        ).pipe(
          Layer.provideMerge(Kin.mcpRegistryLayer(McpSessions.layer)),
          Layer.provideMerge(
            authorityLayerWithDatabase(
              KinPersistence.layer.pipe(
                Layer.provideMerge(Sqlite.layerConfig.pipe(Layer.orDie)),
                Layer.provide(serverConfig),
                Layer.provide(NodeServices.layer),
              ),
            ),
          ),
          Layer.provide(toolHandlerServices),
          Layer.provide(
            Layer.mock(HttpServer.HttpServer)({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            }),
          ),
          Layer.provide(
            Layer.succeed(
              ServerActivation,
              Effect.sync(() => {
                runnerStarts++;
              }).pipe(Effect.andThen(Effect.never)),
            ),
          ),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                KIN_ENABLED: enabled,
                KIN_MEMORY_REPOSITORIES: JSON.stringify([
                  { orgId: KinOrgId.make("fixture"), repoUrl: "fixture" },
                ]),
              }),
            ),
          ),
        );
        const http = yield* HttpRouter.toHttpEffect(routes);
        assert.strictEqual(runnerStarts, enabled ? 1 : 0);
        const services = yield* Deferred.await(ready);
        const kin = Context.get(services, Kin.KinServer);
        const registry = Context.get(services, McpSessions.McpSessionRegistry);
        const threadId = ThreadId.make("lead-thread");
        const request = (
          path: string,
          token: string,
          method: string,
          params: unknown,
          session?: string,
        ) =>
          Effect.gen(function* () {
            const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
            yield* HttpEffect.toHandled(http, (_request, response) =>
              Deferred.succeed(sent, response),
            ).pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(`http://localhost${path}`, {
                    method: "POST",
                    headers: {
                      authorization: token,
                      "content-type": "application/json",
                      accept: "application/json, text/event-stream",
                      ...(session ? { "mcp-session-id": session } : {}),
                    },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
                  }),
                ),
              ),
              Effect.exit,
            );
            return yield* Deferred.await(sent);
          });
        const initialize = {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        };
        if (Option.isNone(kin.services)) {
          assert.isFalse(enabled);
          const issued = yield* registry.issue({
            threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
          });
          assert.strictEqual(issued.config.endpoint, "http://127.0.0.1:43123/mcp");
          assert.strictEqual(
            (yield* request(
              "/kin/mcp",
              issued.config.authorizationHeader,
              "initialize",
              initialize,
            )).status,
            404,
          );
          assert.strictEqual(
            (yield* request("/mcp", issued.config.authorizationHeader, "initialize", initialize))
              .status,
            200,
          );
          return;
        }
        assert.isTrue(enabled);
        const identity = Context.get(kin.services.value, KinIdentity);
        const chatService = Context.get(kin.services.value, KinChatService);
        const [person] = yield* identity.resolve({
          sessionId: AuthSessionId.make("owner"),
          subject: "browser",
          method: "browser-session-cookie",
          scopes: AuthStandardClientScopes,
        });
        assert.isDefined(person);
        const sql = Context.get(services, SqlClient.SqlClient);
        const agentId = KinAgentId.make("lead");
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES (${agentId}, ${person.orgId}, 'Lead', 'lead', ${person.personId}, '1970-01-01T00:00:00.000Z')`;
        yield* identity.registerAgentThread({ orgId: person.orgId, agentId, threadId });
        const chat = yield* chatService.createDirect(person, { orgId: person.orgId, agentId });
        const issued = yield* registry.issue({
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        });
        assert.strictEqual(issued.config.endpoint, "http://127.0.0.1:43123/kin/mcp");
        assert.strictEqual(
          (yield* request("/kin/mcp", issued.config.authorizationHeader, "initialize", initialize))
            .status,
          403,
        );
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
          VALUES (${agentId}, ${person.orgId}, 'Lead', 0, '{}', '[]', ${chat.chatId})`;
        yield* startAgentWakeup({ orgId: person.orgId, agentId, threadId }).pipe(
          Effect.provide(services),
        );
        const initialized = yield* request(
          "/kin/mcp",
          issued.config.authorizationHeader,
          "initialize",
          initialize,
        );
        assert.strictEqual(initialized.status, 200);
        const result = yield* request(
          "/kin/mcp",
          issued.config.authorizationHeader,
          "tools/call",
          {
            name: "kin_chat_post",
            arguments: {
              chatId: chat.chatId,
              body: "Production composition",
              intent: "evidence",
              clientMessageId: "composition",
            },
          },
          initialized.headers["mcp-session-id"],
        );
        assert.strictEqual(result.status, 200);
        const text = yield* Effect.promise(() => HttpServerResponse.toWeb(result).text());
        assert.include(text, "Production composition");
        assert.notInclude(text, '"isError":true');
        const caller = yield* registry.resolve(issued.config.authorizationHeader.slice(7));
        assert.isDefined(caller);
        const agent = yield* identity.resolveAgent(caller);
        const rows = yield* chatService.read(agent, { chatId: chat.chatId });
        assert.lengthOf(rows, 1);
        assert.strictEqual(rows[0]?.author._tag, "agent");
        yield* identity.endAgentThread({ orgId: person.orgId, threadId });
        assert.isUndefined(yield* registry.resolve(issued.config.authorizationHeader.slice(7)));
      }),
    ),
);

it.effect("measures the combined agent tool list separately from ordinary threads", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const tools = mcp.tools.map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const kinTools = tools.filter((tool) => Object.hasOwn(KinChatToolkit.tools, tool.name));
    assert.lengthOf(kinTools, 3);
    assert.deepStrictEqual(
      {
        mcpToolListJsonBytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
        kinToolListJsonBytes: Buffer.byteLength(JSON.stringify(kinTools), "utf8"),
      },
      budget,
    );
  }).pipe(
    Effect.provide(
      Layer.merge(
        McpHttpServer.layerTools,
        McpHttpServer.toolkitRegistration(KinChatToolkit, handlers),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(Kin.layer),
        Layer.provide(Sqlite.layerConfig),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: false }))),
        Layer.provide(toolHandlerServices),
        Layer.provide(Layer.mock(OrchestratorV2)({})),
      ),
    ),
  ),
);
