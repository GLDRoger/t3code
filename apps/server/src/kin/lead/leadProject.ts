import { CommandId, type KinAgentId, type KinOrgId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../../project/ProjectService.ts";

/** A project per lead, rooted at its own memory checkout: its wake-ups and scheduled runs use it. */
export const leadProjectId = (orgId: string, agentId: string) =>
  ProjectId.make(`kin:${orgId}:${agentId}`);

/**
 * Kin's own projects stay archived, out of people's pickers. The command id is fixed per project,
 * so its receipt archives each one once and a person's unarchive sticks.
 */
const archive = (projects: ProjectService.ProjectService["Service"], projectId: ProjectId) =>
  projects.update({
    commandId: CommandId.make(`kin-project-archive:${projectId}`),
    projectId,
    archived: true,
  });

export const bootstrapKinProject = Effect.fn("Kin.bootstrapProject")(function* (
  projects: ProjectService.ProjectService["Service"],
  input: ProjectService.ProjectBootstrapInput,
) {
  const result = yield* projects.bootstrap(input);
  return result.created
    ? { ...result, project: yield* archive(projects, result.project.id) }
    : result;
});

export const bootstrapLeadProject = (
  projects: ProjectService.ProjectService["Service"],
  input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly workspaceRoot: string;
    readonly orgName: string;
    readonly name: string;
  },
) =>
  bootstrapKinProject(projects, {
    commandId: CommandId.make(`kin-project:${input.orgId}:${input.agentId}`),
    projectId: leadProjectId(input.orgId, input.agentId),
    workspaceRoot: input.workspaceRoot,
    title: `Kin · ${input.orgName} · ${input.name}`,
  });

/** Archives, once, the projects Kin made before it archived new ones: only ids its rows prove. */
export const archiveEarlierKinProjects = Effect.fn("Kin.archiveEarlierProjects")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const proven = yield* sql<{ readonly projectId: string }>`
    SELECT 'kin:' || org_id || ':' || agent_id AS "projectId" FROM kin_leads
    UNION SELECT 'kin-dream:' || org_id FROM kin_dream_runs
    UNION SELECT 'kin-dream:' || org_id || ':' || dream_id FROM kin_dream_runs`;
  if (proven.length === 0) return;
  const shells = yield* projects.listShells({
    projectIds: proven.map((row) => ProjectId.make(row.projectId)),
  });
  yield* Effect.forEach(
    shells.filter((shell) => shell.archivedAt == null),
    (shell) => archive(projects, shell.id),
    { discard: true },
  );
});
