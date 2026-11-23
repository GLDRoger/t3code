import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../../project/ProjectService.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { archiveEarlierKinProjects, bootstrapLeadProject, leadProjectId } from "./leadProject.ts";
import { agentId, orchestrationHarness, orgId, seed } from "./WakeupRunner.testkit.ts";

const withProjects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const cwds = yield* Queue.unbounded<string | null>();
    return yield* effect.pipe(
      Effect.provide(
        Layer.mergeAll(orchestrationHarness({ realProjects: cwds }), NodeServices.layer),
      ),
    );
  }).pipe(provideDeterministicTestRuntime);

const archivedAt = Effect.fn(function* (projectId: ProjectId) {
  const projects = yield* ProjectService.ProjectService;
  return Option.getOrThrow(yield* projects.getById(projectId)).archivedAt;
});

it.effect("a new lead project starts archived", () =>
  withProjects(
    Effect.gen(function* () {
      yield* seed;
      const projects = yield* ProjectService.ProjectService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "kin-lead-project-" });
      const { project, created } = yield* bootstrapLeadProject(projects, {
        orgId,
        agentId,
        workspaceRoot,
        orgName: "Org",
        name: "Lead",
      });
      assert.isTrue(created);
      assert.isNotNull(project.archivedAt);
      assert.isNotNull(yield* archivedAt(leadProjectId(orgId, agentId)));
    }),
  ),
);

it.effect("archives once the earlier projects Kin's rows prove it made", () =>
  withProjects(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const projects = yield* ProjectService.ProjectService;
      const fs = yield* FileSystem.FileSystem;
      yield* sql`INSERT INTO kin_dream_runs (org_id, owner_date, dream_id, full, status, branch, material_from, material_until, started_at, ended_at)
        VALUES (${orgId}, '2026-11-08', 'dream-1', 0, 'failed', 'dream/2026-11-08', 0, 0, 0, 1)`;
      const lead = leadProjectId(orgId, agentId);
      const dream = ProjectId.make(`kin-dream:${orgId}`);
      const unproven = leadProjectId(orgId, "no-such-lead");
      const repo = ProjectId.make("repo");
      for (const projectId of [lead, dream, unproven, repo])
        yield* projects.create({
          commandId: CommandId.make(`create:${projectId}`),
          projectId,
          title: projectId,
          workspaceRoot: yield* fs.makeTempDirectoryScoped({ prefix: "kin-earlier-project-" }),
        });

      yield* archiveEarlierKinProjects();
      assert.isNotNull(yield* archivedAt(lead));
      assert.isNotNull(yield* archivedAt(dream));
      assert.isNull(yield* archivedAt(unproven));
      assert.isNull(yield* archivedAt(repo));

      // A person brings the lead's project back; later starts leave it there.
      yield* projects.update({
        commandId: CommandId.make("person-unarchive"),
        projectId: lead,
        archived: false,
      });
      yield* archiveEarlierKinProjects();
      assert.isNull(yield* archivedAt(lead));
      assert.isNotNull(yield* archivedAt(dream));
    }),
  ),
);
