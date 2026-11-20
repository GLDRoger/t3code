import { CommandId, type KinAgentId, type KinOrgId, ProjectId } from "@t3tools/contracts";

import type * as ProjectService from "../../project/ProjectService.ts";

/** A project per lead, rooted at its own memory checkout: its wake-ups and scheduled runs use it. */
export const leadProjectId = (orgId: string, agentId: string) =>
  ProjectId.make(`kin:${orgId}:${agentId}`);

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
  projects.bootstrap({
    commandId: CommandId.make(`kin-project:${input.orgId}:${input.agentId}`),
    projectId: leadProjectId(input.orgId, input.agentId),
    workspaceRoot: input.workspaceRoot,
    title: `Kin · ${input.orgName} · ${input.name}`,
  });
