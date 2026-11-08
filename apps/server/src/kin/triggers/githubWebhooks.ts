import {
  CommandId,
  KIN_GITHUB_APP_SOURCE,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinWebhookSourceId,
  ScheduledTaskError,
  ScheduledTaskUpsertInput,
  type KinGithubWebhookOrgInput,
  type KinGithubWebhookSecretInput,
  type KinGithubWebhookSetup,
  type KinGithubWebhookSetupInput,
  type KinOrgId,
  type ModelSelection,
  type ProjectId,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";

export const KIN_SINK_PROMPT =
  "Kin trigger. If you are reading this, Kin's trigger sink is not installed. Do nothing and stop.";
export const CONNECT_NOTICE = "GitHub events need T3 Connect on the Kin host";
const sourceId = KinWebhookSourceId.make(KIN_GITHUB_APP_SOURCE);

// The sender filter must match the App's own events, which GitHub always signs as `<slug>[bot]`.
const GitHubBotLogin = Schema.String.check(
  Schema.makeFilter(
    (value: string) => /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\[bot\]$/.test(value),
    { expected: "a GitHub App bot login" },
  ),
);
// Same key APPR-8's KinGitHubScope reads; switch to that service once it lands.
const BotLogin = Config.schema(GitHubBotLogin, "KIN_GITHUB_BOT_LOGIN");

// Gated until APPR-9: the App's private key and the action executor don't exist yet.
const appHookConfigureReady = false;
const APP_HOOK_TIMEOUT = "30 seconds";
/** Test seam for the release gate; production always reads `appHookConfigureReady`. */
export const AppHookConfigureGate = Context.Reference<boolean>(
  "t3/kin/triggers/githubWebhooks/AppHookConfigureGate",
  { defaultValue: () => appHookConfigureReady },
);

/** Executor action kind `github.app_hook.configure`; the secret stays redacted and in-process. */
export interface AppHookConfigure {
  readonly kind: "github.app_hook.configure";
  readonly orgId: KinOrgId;
  readonly sourceId: KinWebhookSourceId;
  readonly url: string;
  readonly secret?: Redacted.Redacted<string>;
}

export class GithubAppHookRefused extends Schema.TaggedError<GithubAppHookRefused>()(
  "GithubAppHookRefused",
  { reason: Schema.Literals(["gated", "unavailable", "failed", "timeout"]) },
) {}

/** `PATCH /app/hook/config`, signed with the App's JWT. APPR-9's executor provides it. */
export class GithubAppHookClient extends Context.Service<
  GithubAppHookClient,
  {
    readonly patchHookConfig: (body: {
      readonly url: string;
      readonly content_type: "json";
      readonly insecure_ssl: "0";
      readonly secret?: Redacted.Redacted<string>;
    }) => Effect.Effect<void, GithubAppHookRefused>;
  }
>()("t3/kin/triggers/githubWebhooks/GithubAppHookClient") {}

export const configureAppHook = Effect.fn("KinGithubWebhooks.configureAppHook")(function* (
  action: AppHookConfigure,
) {
  if (!(yield* AppHookConfigureGate)) return yield* new GithubAppHookRefused({ reason: "gated" });
  const client = yield* Effect.serviceOption(GithubAppHookClient);
  if (Option.isNone(client)) return yield* new GithubAppHookRefused({ reason: "unavailable" });
  // Callers hold the host-wide webhook lock across this call.
  yield* client.value
    .patchHookConfig({
      url: action.url,
      content_type: "json",
      insecure_ssl: "0",
      ...(action.secret === undefined ? {} : { secret: action.secret }),
    })
    .pipe(
      Effect.timeoutOrElse({
        duration: APP_HOOK_TIMEOUT,
        orElse: () => Effect.fail(new GithubAppHookRefused({ reason: "timeout" })),
      }),
    );
});

const decodeUpsert = Schema.decodeEffect(ScheduledTaskUpsertInput);
const isChatError = Schema.is(KinChatError);
const isTaskError = Schema.is(ScheduledTaskError);
const isSourceConflict = Schema.is(KinTriggerStore.KinWebhookSourceConflict);
const notFound = new KinChatError({ reason: "not_found", message: "Kin record not found." });
const appSourceTaken = new KinChatError({
  reason: "conflict",
  message: "Another Kin org on this host already receives the GitHub App's events.",
});
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

// Upstream messages are user-facing and carry no secret; causes are not logged.
const mapError = (cause: unknown) => {
  if (isChatError(cause)) return Effect.succeed(cause);
  if (isTaskError(cause)) return Effect.succeed(invalid(cause.message));
  if (isSourceConflict(cause))
    return Effect.succeed(
      cause.reason === "app_source_taken"
        ? appSourceTaken
        : invalid(
            cause.reason === "task_active"
              ? "A GitHub delivery is still running. Try again."
              : "The GitHub source conflicts with existing Kin records.",
          ),
    );
  return Effect.logError("Kin GitHub webhook operation failed", cause).pipe(
    Effect.as(new KinChatError({ reason: "unavailable", message: "Kin is unavailable." })),
  );
};

export class KinGithubWebhooks extends Context.Service<
  KinGithubWebhooks,
  {
    readonly setup: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinGithubWebhookSetupInput,
    ) => Effect.Effect<KinGithubWebhookSetup, KinChatError>;
    readonly setSecret: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinGithubWebhookSecretInput,
    ) => Effect.Effect<KinGithubWebhookSetup, KinChatError>;
    readonly rotate: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinGithubWebhookOrgInput,
    ) => Effect.Effect<KinGithubWebhookSetup, KinChatError>;
    /** Deletes the upstream task too; the archived inbox thread is kept for a later setup. */
    readonly remove: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinGithubWebhookOrgInput,
    ) => Effect.Effect<void, KinChatError>;
  }
>()("t3/kin/triggers/githubWebhooks/KinGithubWebhooks") {}

/** One permit per host: setup's cross-org check and every source change run one at a time. */
export class KinGithubWebhookLock extends Context.Service<
  KinGithubWebhookLock,
  Semaphore.Semaphore
>()("t3/kin/triggers/githubWebhooks/KinGithubWebhookLock") {}

export const lockLayer = Layer.effect(KinGithubWebhookLock, Semaphore.make(1));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* ScheduledTaskService.ScheduledTaskService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const chat = yield* KinChatService;
  const store = yield* KinTriggerStore.KinTriggerStore;
  const exclusive = (yield* KinGithubWebhookLock).withPermits(1);

  const requireOwner = Effect.fn("KinGithubWebhooks.requireOwner")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const person = people.find((p) => p.orgId === orgId);
    if (person === undefined) return yield* notFound;
    // Same rule as KinBudget.set: the lead's owner, or the bootstrap owner before any lead.
    const owner =
      yield* sql`SELECT 1 FROM kin_people p WHERE p.org_id = ${orgId} AND p.person_id = ${person.personId}
      AND ((p.org_id = 'kin-default' AND p.person_id = 'kin-default-owner'
        AND NOT EXISTS (SELECT 1 FROM kin_leads WHERE org_id = p.org_id)) OR EXISTS (
        SELECT 1 FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE l.org_id = p.org_id AND a.owner_person_id = p.person_id))`.pipe(
        Effect.mapError(toPersistenceSqlError("KinGithubWebhooks.requireOwner")),
      );
    if (owner.length === 0)
      return yield* new KinChatError({ reason: "not_allowed", message: "Only the owner can." });
  });

  const newSecret = random
    .randomBytes(32)
    .pipe(Effect.map((bytes) => Redacted.make(Buffer.from(bytes).toString("hex"))));

  const findTask = (id: ScheduledTaskId) =>
    tasks.list().pipe(Effect.map(({ tasks }) => tasks.find((task) => task.id === id)));

  const upsert = (input: {
    readonly orgId: KinOrgId;
    readonly target: { readonly id: ScheduledTaskId } | { readonly commandId: CommandId };
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection;
    readonly botLogin: string;
    /** Undefined keeps the stored secret, so the bound hash stays valid. */
    readonly secret: Redacted.Redacted<string> | undefined;
    readonly enabled: boolean;
  }) =>
    decodeUpsert({
      ...("id" in input.target
        ? { id: input.target.id, requireExisting: true }
        : { commandId: input.target.commandId }),
      title: `Kin · GitHub App · ${input.orgId}`,
      prompt: KIN_SINK_PROMPT,
      enabled: input.enabled,
      projectId: input.projectId,
      threadId: null,
      threadMode: "new_thread",
      workspaceStrategy: { type: "root" },
      modelSelection: input.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      createdBy: "system",
      creationSource: "server",
      schedule: {
        type: "webhook",
        signature: {
          header: "x-hub-signature-256",
          encoding: "hex",
          prefix: "sha256=",
          ...(input.secret === undefined ? {} : { secret: Redacted.value(input.secret) }),
        },
        maxDeliveryAgeMinutes: null,
        dedupe: KinTriggerStore.GITHUB_DEDUPE,
        filters: [
          { path: "headers.x-github-event", op: "in", value: KinTriggerStore.GITHUB_EVENTS },
          { path: "body.sender.login", op: "notEquals", value: input.botLogin },
        ],
      },
    }).pipe(
      // The decode issue would carry the secret, so it never reaches mapError's log.
      Effect.mapError(() => invalid("The GitHub source could not be saved.")),
      Effect.flatMap(tasks.upsert),
    );

  const needsConnect = Effect.fn("KinGithubWebhooks.needsConnect")(function* (orgId: KinOrgId) {
    const [lead] = yield* sql<{ readonly chatId: string }>`
      SELECT l.owner_chat_id AS "chatId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`.pipe(
      Effect.mapError(toPersistenceSqlError("KinGithubWebhooks.needsConnect")),
    );
    if (lead !== undefined)
      yield* chat.notice({
        orgId,
        chatId: KinChatId.make(lead.chatId),
        messageId: KinMessageId.make(`kin-github-connect:${orgId}`),
        body: CONNECT_NOTICE,
      });
    return { status: "needs_connect" } as const;
  });

  const offer = Effect.fn("KinGithubWebhooks.offer")(function* (
    orgId: KinOrgId,
    url: string,
    secret: Redacted.Redacted<string> | undefined,
  ) {
    return yield* configureAppHook({
      kind: "github.app_hook.configure",
      orgId,
      sourceId,
      url,
      ...(secret === undefined ? {} : { secret }),
    }).pipe(
      Effect.as(true),
      Effect.catchTags({
        GithubAppHookRefused: (refused) =>
          Effect.logInfo("Kin GitHub App hook left to the owner", { reason: refused.reason }).pipe(
            Effect.as(false),
          ),
      }),
    );
  });

  const inboxThread = Effect.fn("KinGithubWebhooks.inboxThread")(function* (
    orgId: KinOrgId,
    projectId: ProjectId,
    modelSelection: ModelSelection,
  ) {
    // Launch receipts make this commandId return the same thread on every setup.
    const launched = yield* launcher.launch({
      commandId: CommandId.make(`kin:webhook-inbox:${orgId}:${projectId}`),
      projectId,
      title: "Kin · GitHub inbox",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspaceStrategy: { type: "root" },
      createdBy: "system",
      creationSource: "server",
    });
    if (launched.projection.thread.archivedAt === null)
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`kin:webhook-inbox-archive:${orgId}:${projectId}`),
        threadId: launched.threadId,
      });
    return launched.threadId;
  });

  const create = Effect.fn("KinGithubWebhooks.create")(function* (
    input: KinGithubWebhookSetupInput,
    botLogin: string,
  ) {
    const project = yield* projects.getById(input.projectId);
    if (Option.isNone(project)) return yield* notFound;
    const modelSelection = project.value.defaultModelSelection;
    if (modelSelection === null) return yield* invalid("The project has no default model.");
    const secret = yield* newSecret;
    const { task } = yield* upsert({
      orgId: input.orgId,
      target: { commandId: KinTriggerStore.githubAppCommandId(input.orgId) },
      projectId: input.projectId,
      modelSelection,
      botLogin,
      secret,
      enabled: false,
    });
    const url = task.webhook?.url ?? null;
    if (url === null) {
      yield* tasks.delete({ id: task.id });
      return yield* needsConnect(input.orgId);
    }
    yield* Effect.gen(function* () {
      yield* store.registerSource({
        id: sourceId,
        orgId: input.orgId,
        repo: KIN_GITHUB_APP_SOURCE,
        scheduledTaskId: task.id,
        inboxThreadId: yield* inboxThread(input.orgId, input.projectId, modelSelection),
        githubHookId: null,
        botLogin,
        status: "active",
      });
      yield* store.bindSecret(input.orgId, sourceId, secret);
    }).pipe(
      Effect.tapError(() =>
        Effect.andThen(
          Effect.ignore(store.unregisterSource(input.orgId, sourceId)),
          Effect.ignore(tasks.delete({ id: task.id })),
        ),
      ),
    );
    // Enabled only once registered, so no delivery can reach a real launch.
    yield* tasks.setEnabled({ id: task.id, enabled: true });
    return {
      status: (yield* offer(input.orgId, url, secret)) ? "configured" : "needs_secret",
      sourceId,
      url,
    } as const;
  });

  const owned = Effect.fn("KinGithubWebhooks.owned")(function* (orgId: KinOrgId) {
    const source = yield* store.getSource(orgId, sourceId);
    if (source === undefined) return yield* notFound;
    const task = yield* findTask(source.scheduledTaskId);
    if (task === undefined) return yield* notFound;
    return { source, task };
  });

  return KinGithubWebhooks.of({
    setup: Effect.fn("KinGithubWebhooks.setup")(
      function* (people, input) {
        yield* requireOwner(people, input.orgId);
        const botLogin = yield* BotLogin.pipe(
          Effect.mapError(() =>
            invalid("Set KIN_GITHUB_BOT_LOGIN to the GitHub App's bot login, ending in [bot]."),
          ),
        );
        const source = yield* store.getSource(input.orgId, sourceId);
        if (
          source === undefined &&
          (yield* KinTriggerStore.appSourceHeldElsewhere(sql, input.orgId).pipe(
            Effect.mapError(toPersistenceSqlError("KinGithubWebhooks.setup")),
          ))
        )
          return yield* appSourceTaken;
        const task = source === undefined ? undefined : yield* findTask(source.scheduledTaskId);
        if (source !== undefined && task === undefined)
          yield* store.unregisterSource(input.orgId, sourceId);
        if (source === undefined || task === undefined) return yield* create(input, botLogin);
        if (task.projectId !== input.projectId)
          return yield* invalid("GitHub events already go to another project.");
        const url = task.webhook?.url ?? null;
        if (url === null) return yield* needsConnect(input.orgId);
        // Restores Kin's shape (say, a newer event list) before enabling, so a tampered task never
        // runs; an unsigned task has no secret to keep, so only a re-key or setSecret repairs it.
        if (task.schedule.type === "webhook" && task.schedule.signature !== null)
          yield* upsert({
            orgId: input.orgId,
            target: { id: task.id },
            projectId: task.projectId,
            modelSelection: task.modelSelection,
            botLogin: source.botLogin,
            secret: undefined,
            enabled: true,
          });
        else if (!task.enabled) yield* tasks.setEnabled({ id: task.id, enabled: true });
        // Re-keys only when GitHub took the new secret; otherwise the owner's secret stays.
        const secret = yield* newSecret;
        if (!(yield* offer(input.orgId, url, secret)))
          return { status: "needs_secret", sourceId, url } as const;
        // Between the upsert and the bind, the old hash refuses deliveries: it fails closed.
        yield* upsert({
          orgId: input.orgId,
          target: { id: task.id },
          projectId: task.projectId,
          modelSelection: task.modelSelection,
          botLogin: source.botLogin,
          secret,
          enabled: true,
        });
        yield* store.bindSecret(input.orgId, sourceId, secret);
        return { status: "configured", sourceId, url } as const;
      },
      exclusive,
      Effect.catch((cause) => Effect.flatMap(mapError(cause), Effect.fail)),
    ),
    setSecret: Effect.fn("KinGithubWebhooks.setSecret")(
      function* (people, input) {
        yield* requireOwner(people, input.orgId);
        const { source, task } = yield* owned(input.orgId);
        const { task: saved } = yield* upsert({
          orgId: input.orgId,
          target: { id: task.id },
          projectId: task.projectId,
          modelSelection: task.modelSelection,
          botLogin: source.botLogin,
          secret: input.secret,
          enabled: task.enabled,
        });
        yield* store.bindSecret(input.orgId, sourceId, input.secret);
        const url = saved.webhook?.url ?? null;
        if (url === null) return yield* needsConnect(input.orgId);
        return { status: "configured", sourceId, url } as const;
      },
      exclusive,
      Effect.catch((cause) => Effect.flatMap(mapError(cause), Effect.fail)),
    ),
    rotate: Effect.fn("KinGithubWebhooks.rotate")(
      function* (people, input) {
        yield* requireOwner(people, input.orgId);
        const { task } = yield* owned(input.orgId);
        const { task: rotated } = yield* tasks.rotateWebhookToken({ id: task.id });
        const url = rotated.webhook?.url ?? null;
        if (url === null) return yield* needsConnect(input.orgId);
        return {
          status: (yield* offer(input.orgId, url, undefined)) ? "configured" : "needs_url",
          sourceId,
          url,
        } as const;
      },
      exclusive,
      Effect.catch((cause) => Effect.flatMap(mapError(cause), Effect.fail)),
    ),
    remove: Effect.fn("KinGithubWebhooks.remove")(
      function* (people, input) {
        yield* requireOwner(people, input.orgId);
        const source = yield* store.getSource(input.orgId, sourceId);
        if (source === undefined) {
          const orphan = yield* findTask(KinTriggerStore.githubAppTaskId(input.orgId));
          if (orphan !== undefined) yield* tasks.delete({ id: orphan.id });
          return;
        }
        const task = yield* findTask(source.scheduledTaskId);
        if (task?.enabled === true) yield* tasks.setEnabled({ id: task.id, enabled: false });
        yield* store.unregisterSource(input.orgId, sourceId);
        if (task !== undefined) yield* tasks.delete({ id: task.id });
      },
      exclusive,
      Effect.catch((cause) => Effect.flatMap(mapError(cause), Effect.fail)),
    ),
  });
});

export const layer = Layer.effect(KinGithubWebhooks, make).pipe(
  Layer.provide(KinTriggerStore.layer),
);
