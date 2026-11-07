import {
  AuthStandardClientScopes,
  KinChatError,
  TrimmedNonEmptyString,
  type KinAgentId,
  type KinOrgId,
  type KinPersonId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as KinChatRepository from "./KinChatRepository.ts";

export class KinIdentityConfig extends Context.Service<
  KinIdentityConfig,
  {
    readonly orgName: typeof TrimmedNonEmptyString.Type;
    readonly ownerHandle: typeof TrimmedNonEmptyString.Type;
    readonly ownerDisplayName: typeof TrimmedNonEmptyString.Type;
  }
>()("t3/kin/chat/KinIdentity/KinIdentityConfig") {
  static readonly layer = Layer.effect(
    KinIdentityConfig,
    Config.all({
      orgName: Config.schema(TrimmedNonEmptyString, "KIN_ORG_NAME").pipe(Config.withDefault("Kin")),
      ownerHandle: Config.schema(TrimmedNonEmptyString, "KIN_OWNER_HANDLE").pipe(
        Config.withDefault("owner"),
      ),
      ownerDisplayName: Config.schema(TrimmedNonEmptyString, "KIN_OWNER_DISPLAY_NAME").pipe(
        Config.withDefault("Owner"),
      ),
    }),
  );
}

type IdentityError = KinChatRepository.RepositoryError;
export type PersonIdentity = { readonly orgId: KinOrgId; readonly personId: KinPersonId };
export type AgentIdentity = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly ownerPersonId: KinPersonId;
  readonly threadId: ThreadId;
};
type AgentThreadInput = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly threadId: ThreadId;
};

// Build once and share between WS handlers and the /kin/mcp toolkit; the visibility set is instance-local.
export class KinIdentity extends Context.Service<
  KinIdentity,
  {
    readonly resolve: (
      session: AuthenticatedSession,
    ) => Effect.Effect<ReadonlyArray<PersonIdentity>>;
    readonly resolveAgent: (
      scope: McpInvocationScope,
    ) => Effect.Effect<AgentIdentity, IdentityError>;
    readonly registerAgentThread: (input: AgentThreadInput) => Effect.Effect<void, IdentityError>;
    readonly endAgentThread: (input: {
      readonly orgId: KinOrgId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<boolean, IdentityError>;
    readonly isAgentThread: (threadId: ThreadId) => boolean;
  }
>()("t3/kin/chat/KinIdentity") {
  static readonly layer = Layer.effect(
    KinIdentity,
    Effect.gen(function* () {
      const repository = yield* KinChatRepository.KinChatRepository;
      const config = yield* KinIdentityConfig;
      const sql = yield* SqlClient.SqlClient;
      const owner = yield* repository
        .bootstrapIdentity({
          ...config,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.tapError((error) => Effect.logError("Kin identity bootstrap failed", error)));
      const active = new Set(
        (yield* repository.listActiveAgentThreads()).map((row) => row.threadId),
      );
      const lock = yield* Semaphore.make(1);
      return KinIdentity.of({
        resolve: Effect.fn("KinIdentity.resolve")(function (session) {
          return Effect.succeed(
            AuthStandardClientScopes.every((scope) => session.scopes.includes(scope))
              ? [{ orgId: owner.orgId, personId: owner.personId }]
              : [],
          );
        }),
        resolveAgent: Effect.fn("KinIdentity.resolveAgent")(function* (scope) {
          const caller = scope.thread;
          if (caller === undefined || caller.subagent === true)
            return yield* new KinChatError({
              reason: "not_allowed",
              message: "Kin agent identity required.",
            });
          const row = yield* repository.findAgentThread(caller.threadId);
          if (Option.isNone(row) || row.value.endedAt !== null) {
            return yield* new KinChatError({
              reason: "not_allowed",
              message: "Kin agent thread is not active.",
            });
          }
          if (!(yield* repository.hasRunningWakeup(row.value)))
            return yield* new KinChatError({
              reason: "not_allowed",
              message: "Kin wake-up is not running.",
            });
          const agent = yield* repository.getAgent(row.value);
          if (Option.isNone(agent) || agent.value.retiredAt !== null)
            return yield* new KinChatError({
              reason: "not_allowed",
              message: "Kin agent identity required.",
            });
          return {
            orgId: row.value.orgId,
            agentId: agent.value.agentId,
            ownerPersonId: agent.value.ownerPersonId,
            threadId: caller.threadId,
          };
        }),
        registerAgentThread: Effect.fn("KinIdentity.registerAgentThread")(
          function* (input) {
            const row = yield* repository.registerAgentThread({
              ...input,
              startedAt: DateTime.formatIso(yield* DateTime.now),
              endedAt: null,
            });
            yield* sql.afterCommit(
              Effect.sync(() => {
                active.add(row.threadId);
              }),
            );
          },
          Effect.uninterruptible,
          lock.withPermits(1),
        ),
        endAgentThread: Effect.fn("KinIdentity.endAgentThread")(
          function* (input) {
            const row = yield* repository.getAgentThread(input);
            if (Option.isNone(row))
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin agent thread not found.",
              });
            const ended = yield* repository.endAgentThread({
              ...input,
              endedAt: DateTime.formatIso(yield* DateTime.now),
            });
            yield* sql.afterCommit(
              Effect.sync(() => {
                active.delete(input.threadId);
              }),
            );
            return ended;
          },
          Effect.uninterruptible,
          lock.withPermits(1),
        ),
        isAgentThread: (threadId) => active.has(threadId),
      });
    }),
  );
}
