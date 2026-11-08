import { KinChatError, KinGithubWebhookRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as SqlClient from "effect/sql/SqlClient";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import * as GithubWebhooks from "./githubWebhooks.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";

const group = RpcGroup.make(...KinGithubWebhookRpcs);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});

// Owner-only setup surface. The secret arrives on the owner's session and stays in-process.
export const makeKinWebhookHandlers = Effect.fn("makeKinWebhookHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const services = Option.flatMap(kin, (server) => server.services);
  // Optional so handler tests that build only Kin chat services still compile and run.
  const runtime = Option.all({
    sql: yield* Effect.serviceOption(SqlClient.SqlClient),
    tasks: yield* Effect.serviceOption(ScheduledTaskService.ScheduledTaskService),
    launcher: yield* Effect.serviceOption(ThreadLaunchService.ThreadLaunchService),
    threads: yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService),
    projects: yield* Effect.serviceOption(ProjectService.ProjectService),
    random: yield* Effect.serviceOption(SecureRandom.SecureRandom),
  });
  // Built once per session; the host-wide lock comes from Kin's shared services.
  const webhooks =
    Option.isSome(services) && Option.isSome(runtime)
      ? Option.some(
          yield* GithubWebhooks.make.pipe(
            Effect.provide(KinTriggerStore.layer),
            Effect.provideContext(
              Context.make(SqlClient.SqlClient, runtime.value.sql).pipe(
                Context.add(ScheduledTaskService.ScheduledTaskService, runtime.value.tasks),
                Context.add(ThreadLaunchService.ThreadLaunchService, runtime.value.launcher),
                Context.add(ThreadManagementService.ThreadManagementService, runtime.value.threads),
                Context.add(ProjectService.ProjectService, runtime.value.projects),
                Context.add(SecureRandom.SecureRandom, runtime.value.random),
                Context.add(KinChatService, Context.get(services.value, KinChatService)),
                Context.add(
                  GithubWebhooks.KinGithubWebhookLock,
                  Context.get(services.value, GithubWebhooks.KinGithubWebhookLock),
                ),
              ),
            ),
          ),
        )
      : Option.none();
  const service = Effect.gen(function* () {
    if (Option.isNone(services)) return yield* disabled;
    if (Option.isNone(webhooks)) return yield* unavailable;
    const people = yield* Context.get(services.value, KinIdentity).resolve(session);
    return { webhooks: webhooks.value, people };
  });
  const run = <A>(
    body: (
      webhooks: GithubWebhooks.KinGithubWebhooks["Service"],
      people: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<A, KinChatError>,
  ) =>
    service.pipe(
      Effect.flatMap(({ webhooks, people }) => body(webhooks, people)),
      Effect.catchDefect((cause) =>
        Effect.logWarning("Kin webhook RPC defect.", cause).pipe(
          Effect.andThen(Effect.fail(unavailable)),
        ),
      ),
    );
  return group.of({
    "kin.webhooks.github.setup": (input) =>
      run((webhooks, people) => webhooks.setup(people, input)),
    "kin.webhooks.github.setSecret": (input) =>
      run((webhooks, people) => webhooks.setSecret(people, input)),
    "kin.webhooks.github.rotate": (input) =>
      run((webhooks, people) => webhooks.rotate(people, input)),
    "kin.webhooks.github.remove": (input) =>
      run((webhooks, people) => webhooks.remove(people, input).pipe(Effect.as({}))),
  });
});
