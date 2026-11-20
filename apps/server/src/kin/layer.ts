import { TaskCardIndex } from "./widgets/taskCard.ts";
import { KinChatRepository } from "./chat/KinChatRepository.ts";
import type * as SqlClient from "effect/sql/SqlClient";
import * as TaskCardUpdater from "./chat/TaskCardUpdater.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as KinEnabled from "./KinEnabled.ts";
import * as HostPolicy from "./hostPolicy.ts";
import { checkPublicUrl } from "./publicAddress.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Option from "effect/Option";
import * as KinChat from "./chat/layer.ts";
import * as KinAttachmentStore from "./chat/KinAttachmentStore.ts";
import * as KinApprovals from "./approvals/layer.ts";
import * as RetiredActions from "./approvals/retiredActions.ts";
import * as KeySeal from "./approvals/KeySeal.ts";
import * as ApprovalCards from "./chat/approvalCards.ts";
import * as ExecutionNotices from "./chat/executionNotices.ts";
import * as KinPush from "./push/layer.ts";
import * as LevelControl from "./levels/LevelControl.ts";
import * as MemoryChanges from "./memory/MemoryChanges.ts";
import * as KinImport from "./work/KinImport.ts";
import * as KinRecords from "./work/KinRecords.ts";
import { KinChatHub } from "./chat/KinChatHub.ts";
import { KinChatService } from "./chat/KinChatService.ts";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../config.ts";
import { answerChoice, refusedChoice, resumeInterruptedSends } from "./work/cardAnswers.ts";
import { requireRefreshObserver } from "./chat/KinRefreshHub.ts";
import { KinIdentity, KinNewCompanyCountryUnset } from "./chat/KinIdentity.ts";
import { seedPlaybooks } from "./work/playbookSeeds.ts";
import { seedCharacters } from "./lead/characters.ts";
import { closeSubject } from "./open/closeSubject.ts";

import { KinServer, type Services } from "./KinServer.ts";
export { KinServer } from "./KinServer.ts";
import type * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as KinMcp from "./mcp/layer.ts";
import * as KinTasksKeyMcp from "./tasksKey/mcp.ts";
import * as Render from "./gendocs/render.ts";
import * as Toolchain from "./gendocs/toolchain.ts";
import * as GhTool from "./connections/ghTool.ts";
import * as GitHubLogin from "./connections/GitHubLogin.ts";
import { devAppStandIn } from "./github/devAppStandIn.ts";
import * as KinGitHubApp from "./github/KinGitHubApp.ts";
import * as KinGitHubAppKey from "./github/appKey.ts";
import * as KinGitHubAppSetup from "./github/appSetup.ts";
import * as Keychain from "./github/Keychain.ts";
import * as AgentSession from "./lead/AgentSession.ts";
import * as Workspace from "./gendocs/workspace.ts";
import * as Vcs from "../vcs/VcsProcess.ts";
import * as ProcessRunner from "../processRunner.ts";
import { FetchHttpClient } from "effect/http";
import * as Connections from "./connections/ConnectionsService.ts";
import * as ConnectionSecrets from "./connections/ConnectionSecrets.ts";
import * as DevFakeMail from "./connections/DevFakeMail.ts";
import * as DevClock from "./DevClock.ts";
import * as McpGateway from "./connections/McpGateway.ts";
import * as DevFakeSocial from "./social/DevFakeSocial.ts";

const enabled = <E, R>(seal: Layer.Layer<KeySeal.KinKeySeal, E, R>) =>
  Layer.effect(
    KinServer,
    Effect.gen(function* () {
      const services = yield* Effect.context<Services>();
      yield* requireRefreshObserver(services);
      const chat = yield* KinChatService;
      yield* (yield* KinRecords.KinRecords).attachClosing((subject) =>
        closeSubject(subject, chat).pipe(Effect.provide(services)),
      );
      const { owner } = yield* KinIdentity;
      yield* HostPolicy.check();
      yield* checkPublicUrl();
      // A failed seed leaves Kin running; the next start tries the missing ones again.
      yield* seedPlaybooks(owner.orgId, owner.personId).pipe(
        Effect.provide(services),
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin default playbooks not written", Cause.pretty(cause)),
        ),
      );
      yield* seedCharacters(owner.orgId).pipe(
        Effect.provide(services),
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin default characters not written", Cause.pretty(cause)),
        ),
      );
      yield* DevFakeMail.connectFakeAccounts(owner).pipe(Effect.provide(services));
      const hub = yield* KinChatHub;
      const scope = yield* Effect.scope;
      const files = yield* Effect.context<FileSystem.FileSystem | ServerConfig>();
      // Receipt and statement cards' answers carry out their work here, in the tap's transaction.
      yield* chat.attachChoiceAnswers(
        (input) => answerChoice(input, scope).pipe(Effect.provide(services), Effect.provide(files)),
        (input) =>
          refusedChoice(input).pipe(
            Effect.provide(services),
            Effect.catchCause((cause) =>
              Effect.logWarning("Kin couldn't show a card's sent-mail check", Cause.pretty(cause)),
            ),
          ),
      );
      yield* resumeInterruptedSends(owner.orgId, yield* Clock.currentTimeMillis).pipe(
        Effect.provide(services),
        Effect.provide(files),
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin couldn't settle sends cut off by a restart", Cause.pretty(cause)),
        ),
        Effect.forkIn(scope),
      );
      const updaterServices = yield* Effect.context<
        KinChatRepository | TaskCardIndex | KinChatHub | SqlClient.SqlClient
      >();
      return {
        taskCardUpdater: TaskCardUpdater.layer.pipe(
          Layer.provide(Layer.succeedContext(updaterServices)),
        ),
        services: Option.some(services),
        subscribeForViewer: Option.some(hub.subscribeForViewer),
      };
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        // On top of level control and approvals: the executor takes approvals from their
        // pending actions instance.
        KinApprovals.executorLayer.pipe(
          Layer.provide(ExecutionNotices.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              KinPush.layer,
              LevelControl.layer,
              MemoryChanges.layer,
              KinImport.layer.pipe(Layer.provideMerge(KinRecords.layer)),
              Render.layer.pipe(
                Layer.provideMerge(Workspace.layer),
                Layer.provide(
                  Toolchain.layer.pipe(
                    Layer.provide(ProcessRunner.layer),
                    Layer.provide(FetchHttpClient.layer),
                  ),
                ),
                Layer.provide(Vcs.layer),
              ),
              ApprovalCards.layer,
              RetiredActions.layer,
            ).pipe(
              Layer.provideMerge(
                KinApprovals.layer.pipe(Layer.provide(ExecutionNotices.keyNoticesLayer)),
              ),
            ),
          ),
        ),
        // Every request to a connection goes through the egress guard.
        Connections.layer.pipe(
          Layer.provide(ConnectionSecrets.layer),
          Layer.provide(McpGateway.layer),
          Layer.provide(DevFakeMail.egress),
          // Kin's GitHub App: the identity agents' shells and Kin's own GitHub writes use.
          Layer.provideMerge(
            KinGitHubAppSetup.layer.pipe(
              Layer.provideMerge(KinGitHubApp.layer),
              Layer.provide(KinGitHubApp.KinGitHubAppConfig.layer),
              Layer.provide(KinGitHubAppKey.layer.pipe(Layer.provide(ServerSecretStore.layer))),
              Layer.provide(
                Layer.unwrap(
                  Config.String("KIN_DEV_FAKE_GITHUB").pipe(
                    Config.withDefault(""),
                    Effect.map((fake) =>
                      fake === ""
                        ? Layer.merge(Keychain.layer, FetchHttpClient.layer)
                        : devAppStandIn(fake),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            AgentSession.sessionPolicyLayer.pipe(
              Layer.provideMerge(
                GitHubLogin.layer.pipe(
                  Layer.provide(
                    GhTool.layer.pipe(
                      Layer.provide(ProcessRunner.layer),
                      Layer.provide(FetchHttpClient.layer),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ).pipe(
        Layer.provideMerge(KinChat.layer),
        // Social's posting service sits on top: it reads cards, chats and the document renderer.
        (core) =>
          DevFakeSocial.layer.pipe(
            Layer.provide(ConnectionSecrets.layer),
            Layer.provideMerge(core),
          ),
      ),
    ),
    // Everything Kin builds above reads the time from here: a play-test's moved clock in dev.
    Layer.provide(DevClock.layer),
    // Inside `enabled`: built only with Kin on, and a secret store failure disables Kin, not the server.
    Layer.provide(seal),
    // The server's own instance: layers are shared by reference.
    Layer.provide(ManagedPolicy.layer),
  );
const disabled = Layer.succeed(KinServer, {
  taskCardUpdater: Layer.empty,
  services: Option.none(),
  subscribeForViewer: Option.none(),
});

const runtime = <E, R>(seal: Layer.Layer<KeySeal.KinKeySeal, E, R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* KinEnabled.KinEnabled;
      return config.enabled
        ? enabled(seal).pipe(
            Layer.catchCause((cause) =>
              Layer.effect(
                KinServer,
                config.reportFailure(cause).pipe(
                  Effect.as({
                    taskCardUpdater: Layer.empty,
                    services: Option.none(),
                    subscribeForViewer: Option.none(),
                  }),
                ),
              ),
            ),
          )
        : disabled;
    }),
  ).pipe(
    Layer.provide(KinEnabled.layer),
    Layer.catchCause((cause) =>
      Layer.effect(
        KinServer,
        Effect.logError("Kin disabled: invalid configuration.", Cause.pretty(cause)).pipe(
          Effect.as({
            taskCardUpdater: Layer.empty,
            services: Option.none(),
            subscribeForViewer: Option.none(),
          }),
        ),
      ),
    ),
  );

const middleware = HttpRouter.middleware<{ provides: KinServer }>()(
  Effect.gen(function* () {
    const kin = yield* KinServer;
    return (effect) => Effect.provideService(effect, KinServer, kin);
  }),
).layer;

/** Tests pass `KeySeal.layerTest()` so they can seal the key rows they write. */
export const layerWithSeal = <E, R>(seal: Layer.Layer<KeySeal.KinKeySeal, E, R>) =>
  middleware.pipe(Layer.provideMerge(runtime(seal)));

export const layer = layerWithSeal(KeySeal.layer);

const taskCardUpdater = Layer.unwrap(
  Effect.gen(function* () {
    const kin = yield* KinServer;
    return Option.isSome(kin.services)
      ? kin.taskCardUpdater.pipe(
          Layer.catchCause(() =>
            Layer.effectDiscard(Effect.logWarning("Kin task card updater disabled.")),
          ),
        )
      : Layer.empty;
  }),
);

export const mcpLayer = (base: Parameters<typeof KinMcp.transport>[0]) =>
  Layer.mergeAll(KinMcp.transport(base), KinTasksKeyMcp.layer, taskCardUpdater);

export const mcpRegistryLayer = <E, R>(
  base: Layer.Layer<McpSessionRegistry.McpSessionRegistry, E, R>,
) =>
  KinMcp.registry(base).pipe(
    Layer.provideMerge(layer),
    // Only the running server creates companies whose country starts not chosen; tests keep India's.
    Layer.provide(Layer.succeed(KinNewCompanyCountryUnset, true)),
    // The chat service takes this optionally, so the running server names it here.
    Layer.provide(KinAttachmentStore.layer),
    Layer.provide(SqlitePersistence.layerConfig),
  );
