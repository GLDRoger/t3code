import { archivistScope } from "@t3tools/keeper/chronicle";
import { ArchivistKeeper } from "@t3tools/keeper/archivist";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const ProjectRow = Schema.Struct({
  projectId: Schema.String,
  workspaceRoot: Schema.String,
});
const decodeProjects = Schema.decodeUnknownEffect(Schema.Array(ProjectRow));

/** One look at every project. The 8-will / 30-note gate still decides whether a chronicle is written. */
export const tickArchivists = Effect.fn("KinArchivist.tick")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const keeper = yield* ArchivistKeeper;
  const projects = yield* sql`
    SELECT project_id AS projectId, workspace_root AS workspaceRoot
    FROM projection_projects
  `.pipe(
    Effect.flatMap(decodeProjects),
    Effect.orElseSucceed(() => []),
  );
  const nowMillis = yield* Clock.currentTimeMillis.pipe(
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
  );
  for (const project of projects) {
    yield* keeper
      .tick({
        scope: archivistScope(project.projectId),
        projectRoot: project.workspaceRoot,
        nowMillis,
      })
      .pipe(
        Effect.tap((result) =>
          result.ran
            ? Effect.logInfo("kin.archivist.wrote", {
                projectId: project.projectId,
                pass: result.pass,
              })
            : Effect.void,
        ),
        Effect.catch((error) =>
          Effect.logWarning("kin.archivist.tick-failed", {
            projectId: project.projectId,
            detail: error.message,
          }),
        ),
      );
  }
});
