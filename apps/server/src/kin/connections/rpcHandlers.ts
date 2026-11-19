import {
  KinChatError,
  KinConnectionRpcs,
  type KinGitHubStatus,
  type KinOrgId,
  KinWidgetId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { KinServer } from "../KinServer.ts";
import { KinConnections } from "./ConnectionsService.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { setGuards } from "../github/branchGuard.ts";
import { repoList, setRepo, watchSummary, withGuards } from "../github/githubWatchStore.ts";
import { setAppRepos, withAgentsAs } from "../github/appRepos.ts";
import { KinGitHubAppSetup } from "../github/appSetup.ts";
import { ghApiLayer, KinGitHubApi } from "../github/GitHubWatch.ts";
import { agentsView, KinGitHubApp } from "../github/KinGitHubApp.ts";
import { KinGitHubLogin } from "./GitHubLogin.ts";

const group = RpcGroup.make(...KinConnectionRpcs);
const isChatError = Schema.is(KinChatError);
const chatFailure = (error: unknown) =>
  isChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});

/** Thin transport: the session's people, then one owner-checked connections call. */
export const makeKinConnectionHandlers = Effect.fn("makeKinConnectionHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  // GitHub's login is saved as T3's own GitHub token too; Kin's layers don't carry the settings.
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const call = Effect.fn("KinConnections.rpc")(function* <A>(
    run: (
      connections: KinConnections["Service"],
      people: ReadonlyArray<PersonIdentity>,
      chat: KinChatService["Service"],
    ) => Effect.Effect<A, KinChatError>,
  ) {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return yield* run(
      Context.get(services, KinConnections),
      people,
      Context.get(services, KinChatService),
    );
  });
  const github = Effect.fn("KinGitHubLogin.rpc")(function* <A>(
    run: (
      login: KinGitHubLogin["Service"],
      people: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<A, KinChatError>,
  ) {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    const call = run(Context.get(services, KinGitHubLogin), people);
    return yield* Option.isSome(settings)
      ? call.pipe(Effect.provideService(ServerSettingsService, settings.value))
      : call;
  });
  /** What Kin watches on GitHub: after the owner check `status` makes, read from Kin's own rows. */
  const watching = Effect.fn("KinGitHubWatch.rpc")(function* <A>(
    orgId: KinOrgId,
    run: Effect.Effect<A, SqlError | KinChatError, SqlClient.SqlClient>,
  ) {
    yield* github((g, people) => g.status(people, { orgId }));
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    return yield* run.pipe(
      Effect.provideService(
        SqlClient.SqlClient,
        Context.get(kin.value.services.value, SqlClient.SqlClient),
      ),
      Effect.catchTags({
        SqlError: () =>
          Effect.fail(
            new KinChatError({
              reason: "unavailable",
              message: "Kin couldn't read its GitHub watch.",
            }),
          ),
      }),
    );
  });
  const withWatch = (status: KinGitHubStatus) =>
    status.account === null || Option.isNone(kin) || Option.isNone(kin.value.services)
      ? Effect.succeed(status)
      : Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => watchSummary(status.orgId, now)),
          Effect.provideService(
            SqlClient.SqlClient,
            Context.get(kin.value.services.value, SqlClient.SqlClient),
          ),
          Effect.map((watch) => (watch === undefined ? status : { ...status, watch })),
          Effect.orElseSucceed(() => status),
        );
  /** Who agents act as on GitHub: Kin's App where it is installed, else the owner. */
  const withAgents = (status: KinGitHubStatus) =>
    Option.isNone(kin) || Option.isNone(kin.value.services)
      ? Effect.succeed(status)
      : agentsView(Context.getOption(kin.value.services.value, KinGitHubApp), status.orgId).pipe(
          Effect.provideService(
            SqlClient.SqlClient,
            Context.get(kin.value.services.value, SqlClient.SqlClient),
          ),
          Effect.map((agents) => ({ ...status, agents })),
          Effect.orElseSucceed(() => status),
        );
  const appOf = () =>
    Option.isNone(kin) || Option.isNone(kin.value.services)
      ? Option.none<KinGitHubApp["Service"]>()
      : Context.getOption(kin.value.services.value, KinGitHubApp);
  const setupOf = () =>
    Option.isNone(kin) || Option.isNone(kin.value.services)
      ? Option.none<KinGitHubAppSetup["Service"]>()
      : Context.getOption(kin.value.services.value, KinGitHubAppSetup);
  return group.of({
    "kin.github.connect.status": (input) =>
      github((g, people) => g.status(people, input)).pipe(
        Effect.flatMap(withWatch),
        Effect.flatMap(withAgents),
      ),
    "kin.github.repos": (input) =>
      watching(
        input.orgId,
        Effect.gen(function* () {
          const repos = yield* withGuards(input.orgId, yield* repoList(input.orgId));
          const app = appOf();
          return {
            repos: Option.isNone(app) ? repos : withAgentsAs(repos, yield* app.value.state()),
          };
        }),
      ),
    "kin.github.app.create": Effect.fn("KinGitHubAppSetup.start.rpc")(function* (input) {
      const setup = setupOf();
      if (Option.isNone(setup) || Option.isNone(kin) || Option.isNone(kin.value.services))
        return yield* disabled;
      const people = yield* Context.get(kin.value.services.value, KinIdentity).resolve(session);
      return yield* setup.value.start(people, input.orgId);
    }),
    "kin.github.app.disconnect": Effect.fn("KinGitHubAppSetup.disconnect.rpc")(function* (input) {
      const setup = setupOf();
      if (Option.isNone(setup) || Option.isNone(kin) || Option.isNone(kin.value.services))
        return yield* disabled;
      const people = yield* Context.get(kin.value.services.value, KinIdentity).resolve(session);
      return yield* setup.value.disconnect(people, input.orgId);
    }),
    "kin.github.app.repos.set": Effect.fn("KinGitHubApp.setRepos.rpc")(function* (input) {
      const people = yield* github((g, found) =>
        g.status(found, { orgId: input.orgId }).pipe(Effect.as(found)),
      );
      const app = appOf();
      const person = people.find((entry) => entry.orgId === input.orgId);
      if (Option.isNone(kin) || Option.isNone(kin.value.services) || Option.isNone(app))
        return yield* disabled;
      if (person === undefined)
        return yield* new KinChatError({ reason: "not_allowed", message: "Only the owner can." });
      const services = kin.value.services.value;
      return yield* setAppRepos(app.value, person, input).pipe(
        Effect.provide(ghApiLayer),
        Effect.provideService(KinGitHubLogin, Context.get(services, KinGitHubLogin)),
        Effect.provideService(SqlClient.SqlClient, Context.get(services, SqlClient.SqlClient)),
        Effect.provideService(KinRefreshObserver, Context.get(services, KinRefreshObserver)),
        Effect.catchTags({
          SqlError: () =>
            Effect.fail(
              new KinChatError({
                reason: "unavailable",
                message: "Kin couldn't record the change to its GitHub App.",
              }),
            ),
        }),
      );
    }),
    "kin.github.guard.set": Effect.fn("KinBranchGuard.set.rpc")(function* (input) {
      const people = yield* github((g, found) =>
        g.status(found, { orgId: input.orgId }).pipe(Effect.as(found)),
      );
      const person = people.find((entry) => entry.orgId === input.orgId);
      if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
      if (person === undefined)
        return yield* new KinChatError({ reason: "not_allowed", message: "Only the owner can." });
      const services = kin.value.services.value;
      return yield* KinGitHubApi.use((api) => setGuards(api.call, person, input)).pipe(
        Effect.provide(ghApiLayer),
        Effect.provideService(KinGitHubLogin, Context.get(services, KinGitHubLogin)),
        Effect.provideService(SqlClient.SqlClient, Context.get(services, SqlClient.SqlClient)),
        Effect.provideService(KinRefreshObserver, Context.get(services, KinRefreshObserver)),
        Effect.catchTags({
          SqlError: () =>
            Effect.fail(
              new KinChatError({
                reason: "unavailable",
                message: "Kin couldn't record the change to the repos' protection.",
              }),
            ),
        }),
      );
    }),
    "kin.github.repos.set": (input) =>
      watching(
        input.orgId,
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => setRepo(input, now)),
          // The status's "Watching: N repos" line moved too, on every open screen.
          Effect.tap(() =>
            Option.isNone(kin) || Option.isNone(kin.value.services)
              ? Effect.void
              : Context.get(kin.value.services.value, KinRefreshObserver).touch(
                  input.orgId,
                  "connections",
                ),
          ),
          Effect.map((repos) => ({ repos })),
        ),
      ),
    "kin.github.connect.start": (input) => github((g, people) => g.start(people, input)),
    "kin.github.connect.cancel": (input) => github((g, people) => g.cancel(people, input)),
    "kin.github.disconnect": (input) => github((g, people) => g.disconnect(people, input)),
    "kin.connections.list": (input) => call((c, people) => c.list(people, input)),
    "kin.connections.get": (input) => call((c, people) => c.get(people, input)),
    "kin.connections.add": (input) => call((c, people) => c.add(people, input)),
    "kin.connections.setKey": (input) => call((c, people) => c.setKey(people, input)),
    "kin.connections.refreshTools": (input) => call((c, people) => c.refreshTools(people, input)),
    "kin.connections.setToolModes": (input) => call((c, people) => c.setToolModes(people, input)),
    "kin.connections.acceptToolChanges": (input) =>
      call((c, people) => c.acceptToolChanges(people, input)),
    "kin.connections.update": (input) => call((c, people) => c.update(people, input)),
    "kin.connections.setReach": (input) => call((c, people) => c.setReach(people, input)),
    "kin.connections.remove": (input) => call((c, people) => c.remove(people, input)),
    "kin.connections.calls": (input) => call((c, people) => c.calls(people, input)),
    "kin.connections.signInStart": (input) => call((c, people) => c.signInStart(people, input)),
    "kin.connections.signInFinish": (input) => call((c, people) => c.signInFinish(people, input)),
    "kin.connections.setSignInClient": (input) =>
      call((c, people) => c.setSignInClient(people, input)),
    "kin.connections.sendEdited": (input) =>
      call((c, people, chat) =>
        c.sendEdited(people, input, {
          close: (widgetId) =>
            chat
              .closeReplaced({ orgId: input.orgId, widgetId: KinWidgetId.make(widgetId) })
              .pipe(Effect.mapError(chatFailure)),
          post: (agent, card) =>
            chat
              .ask(agent, {
                ...card,
                options: [
                  { label: "Confirm", kind: "yes" },
                  { label: "Cancel", kind: "no" },
                ],
              })
              .pipe(Effect.mapError(chatFailure)),
          canTap: (person, widgetId) =>
            chat
              .canTap(person, { widgetId: KinWidgetId.make(widgetId) })
              .pipe(Effect.mapError(chatFailure)),
          act: (person, act) => chat.act(person, act).pipe(Effect.mapError(chatFailure)),
          rewrite: (card) =>
            chat
              .setSendCard({
                ...card,
                orgId: input.orgId,
                widgetId: KinWidgetId.make(card.widgetId),
              })
              .pipe(Effect.mapError(chatFailure)),
        }),
      ),
    "kin.connections.saveEdited": (input) =>
      call((c, people, chat) =>
        c.saveEdited(people, input, {
          canTap: (person, widgetId) =>
            chat
              .canTap(person, { widgetId: KinWidgetId.make(widgetId) })
              .pipe(Effect.mapError(chatFailure)),
          rewrite: (card) =>
            chat
              .setSendCard({
                orgId: input.orgId,
                widgetId: KinWidgetId.make(card.widgetId),
                revision: card.revision,
                detail: card.detail,
                send: card.send,
              })
              .pipe(Effect.mapError(chatFailure)),
        }),
      ),
    "kin.connections.setSendFrom": (input) =>
      call((c, people, chat) =>
        c.setSendFrom(people, input, (card) =>
          chat
            .setSendCard({
              orgId: input.orgId,
              widgetId: KinWidgetId.make(card.widgetId),
              revision: card.revision,
              detail: card.detail,
              send: card.send,
            })
            .pipe(Effect.mapError(chatFailure)),
        ),
      ),
  });
});
