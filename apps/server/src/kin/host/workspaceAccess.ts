import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import * as TaskFolderStore from "../../workspace/TaskFolderStore.ts";
import { WorkspaceHostAccess } from "../../workspace/WorkspaceHostAccess.ts";
import { KinEnabled } from "../KinEnabled.ts";

const slots = 32;

export const layer = Layer.effect(
  WorkspaceHostAccess,
  Effect.gen(function* () {
    const enabled = (yield* KinEnabled).enabled;
    const sql = yield* SqlClient.SqlClient;
    if (!enabled) {
      const [policy] = yield* sql`SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'kin_fenced_folders'`;
      if (policy === undefined) return yield* WorkspaceHostAccess;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const tasks = yield* TaskFolderStore.TaskFolderStore;
    const permits = yield* Semaphore.make(slots);
    const real = (dir: string) =>
      fs.realPath(dir).pipe(Effect.orElseSucceed(() => path.resolve(dir)));
    const contains = (root: string, location: string) => {
      const relative = path.relative(root, location);
      return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
    };

    if (enabled) yield* sql`CREATE TABLE IF NOT EXISTS kin_fenced_folders (path TEXT PRIMARY KEY)`;
    const recorded = yield* sql<{ path: string }>`SELECT path FROM kin_fenced_folders`;
    const fencedRoots = new Set(recorded.map((row) => row.path));
    const memoryRoot = path.join(yield* real(config.stateDir), "kin");
    const pathFenced = Effect.fnUntraced(function* (cwd: string) {
      const matches = (location: string) => {
        if (contains(memoryRoot, location)) {
          const checkout = path.relative(memoryRoot, location).split(path.sep)[1];
          if (checkout === "memory-read" || checkout?.startsWith("memory-read-")) return true;
        }
        for (let folder = location; ; folder = path.dirname(folder)) {
          if (fencedRoots.has(folder)) return true;
          if (path.dirname(folder) === folder) return false;
        }
      };
      return matches(path.resolve(cwd)) || matches(yield* real(cwd));
    });

    const threadFenced = Effect.fnUntraced(
      function* (threadId: ThreadId) {
        if (!enabled) return false;
        if (threadId.startsWith("kin:")) return true;
        const [kin] = yield* sql`
        WITH RECURSIVE parents(thread_id) AS (
          SELECT ${threadId}
          UNION
          SELECT tasks.thread_id FROM orchestration_v2_projection_subagents tasks
          JOIN parents ON parents.thread_id = tasks.child_thread_id WHERE tasks.origin = 'app_owned'
        )
        SELECT 1 FROM parents WHERE substr(thread_id, 1, 4) = 'kin:' LIMIT 1`;
        return kin !== undefined;
      },
      Effect.orElseSucceed(() => true),
    );

    const includingRepository = Effect.fnUntraced(function* (cwd: string) {
      const roots = [cwd];
      for (let parent = path.dirname(cwd); parent !== cwd; parent = path.dirname(cwd)) {
        cwd = parent;
        if (yield* fs.exists(path.join(parent, ".git")).pipe(Effect.orElseSucceed(() => true))) {
          roots.push(parent);
          break;
        }
      }
      return roots;
    });

    const register = Effect.fn("KinWorkspaceAccess.register")(
      function* (cwd: string, thread: ThreadId) {
        // Drain in-flight host commands before a provider can write to newly fenced folders.
        return yield* permits.withPermits(slots)(
          Effect.gen(function* () {
            const [project] = yield* sql<{ root: string }>`
          SELECT p.workspace_root AS root FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = json_extract(t.payload_json, '$.projectId')
          WHERE t.thread_id = ${thread} AND json_extract(t.payload_json, '$.worktreePath') IS NOT NULL`;
            const task = yield* tasks.findContaining(cwd);
            const roots = yield* Effect.forEach(
              [
                cwd,
                ...(project ? [project.root] : []),
                ...(task
                  ? [
                      task.root,
                      task.projectRoot,
                      ...task.repositories.map((repo) => repo.repositoryPath),
                    ]
                  : []),
              ],
              real,
            );
            const repositories = (yield* Effect.forEach(roots, includingRepository)).flat();
            const next = [...new Set(repositories.filter((root) => !fencedRoots.has(root)))];
            if (next.length === 0) return true;
            yield* sql.withTransaction(
              Effect.forEach(
                next,
                (root) => sql`INSERT OR IGNORE INTO kin_fenced_folders (path) VALUES (${root})`,
                { discard: true },
              ),
            );
            for (const root of next) fencedRoots.add(root);
            return true;
          }),
        );
      },
      Effect.orElseSucceed(() => false),
    );

    // Cover checkouts already used on a deployment upgraded from the previous shell policy.
    const previous = !enabled
      ? []
      : yield* sql<{ threadId: ThreadId; cwd: string }>`
      WITH RECURSIVE fenced_threads(thread_id) AS (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE substr(thread_id, 1, 4) = 'kin:'
        UNION
        SELECT tasks.child_thread_id FROM orchestration_v2_projection_subagents tasks
        JOIN fenced_threads ON fenced_threads.thread_id = tasks.thread_id
        WHERE tasks.origin = 'app_owned' AND tasks.child_thread_id IS NOT NULL
      )
      SELECT t.thread_id AS threadId,
        coalesce(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS cwd
      FROM orchestration_v2_projection_threads t
      JOIN fenced_threads f ON f.thread_id = t.thread_id
      JOIN projection_projects p ON p.project_id = json_extract(t.payload_json, '$.projectId')
      WHERE cwd IS NOT NULL`;
    for (const { cwd, threadId } of previous)
      if (!(yield* register(cwd, threadId)))
        return {
          fenced: () => Effect.succeed(true),
          register: () => Effect.succeed(false),
          guard: (_paths, _effect, refused) => refused,
        };

    return {
      fenced: Effect.fn("KinWorkspaceAccess.fenced")(function* (cwd, threadId) {
        if (threadId !== undefined && (yield* threadFenced(threadId))) return true;
        return yield* pathFenced(cwd);
      }),
      register,
      guard: (paths, effect, refused) =>
        permits.withPermit(
          Effect.gen(function* () {
            for (const target of paths) if (yield* pathFenced(target)) return yield* refused;
            return yield* effect;
          }),
        ),
    };
  }).pipe(Effect.orDie),
).pipe(Layer.provide(TaskFolderStore.layer));
