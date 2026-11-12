import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeConfiner, resolveWorkerCredentials } from "../claudeConfinement.ts";
import * as WorkSandbox from "./workSandbox.ts";
import { shellTools, workSessionOptions, workTools } from "./workSession.ts";
import { isWorkThread } from "./workThread.ts";

/**
 * Wraps the Claude query runner; a no-op for every thread that is not a Kin work thread, keyed on
 * the thread id Kin gives its worker. A worker reads untrusted repository text, so it gets file
 * tools in its worktree, or a sandboxed shell alone where `KinWorkSandbox` proves one holds.
 */
export const claudeQueryRunnerWith = <E, R, E2, R2>(
  base: Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, E, R>,
  sandbox: Layer.Layer<WorkSandbox.KinWorkSandbox, E2, R2>,
) =>
  Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      const sandboxes = yield* WorkSandbox.KinWorkSandbox;
      const confiner = yield* makeConfiner();
      const spawning = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
      const scopeProperties = WorkSandbox.workerScopeProperties(WorkSandbox.hostWorkerLimits);
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...runner,
        open: Effect.fn("KinWorkIsolation.open")(function* (input) {
          if (!isWorkThread(input.threadId)) return yield* runner.open(input);
          const environment = yield* HostProcess.Environment;
          const providerEnv = input.options.env ?? environment;
          // The owner's helper runs here, never in the child, which would run it in the worktree.
          const credentials = yield* resolveWorkerCredentials({
            auth: yield* confiner.ownerAuth(input.options.env),
            managed: yield* confiner.managedAuth,
            providerEnv,
          }).pipe(Effect.provide(spawning));
          // The worktree's real path; one that doesn't resolve leaves the file tools nothing.
          const root = yield* confiner.root(input.options.cwd);
          const session = { options: input.options, credentials: {}, environment };
          const prepared = yield* sandboxes.prepare({
            threadId: input.threadId,
            worktree: root,
            session,
            credentials,
          });
          if (prepared._tag === "refused")
            return yield* new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
              method: "kin.worker",
              cause: new Error(prepared.reason),
            });
          const resolved = credentials._tag === "resolved" ? credentials.credentials : {};
          const shell = prepared._tag === "shell" ? prepared : undefined;
          const confinement = confiner.hook({
            root,
            tools: shell === undefined ? workTools : shellTools,
            mcp: false,
          });
          const opened = yield* runner
            .open({
              ...input,
              options: workSessionOptions({
                ...session,
                credentials: resolved,
                confinement,
                place: prepared.place,
                shell,
              }),
              scopeProperties,
            })
            .pipe(Effect.onError(() => shell?.release ?? Effect.void));
          return shell === undefined
            ? opened
            : {
                ...opened,
                messages: opened.messages.pipe(Stream.tap(shell.noteMessage)),
                close: opened.close.pipe(Effect.ensuring(shell.release)),
              };
        }),
      });
    }),
  ).pipe(Layer.provide(base), Layer.provide(sandbox));

export const claudeQueryRunner = <E, R>(
  base: Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, E, R>,
) => claudeQueryRunnerWith(base, WorkSandbox.layer);
