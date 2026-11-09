import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";

// Unconfigured lead runners must not call any of these external services.
export const dormantLeadDependencies = Layer.mergeAll(
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(VcsProcess.VcsProcess)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "kin-dormant-lead-" }),
  // Not a lead dependency: push deep links name the host environment.
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env_kin")),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
