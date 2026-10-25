import {
  ProviderDriverKind,
  type KinAgentProfile,
  type OrchestratorMcpTarget,
} from "@t3tools/contracts";

/**
 * A profile's own provider and model apply only when the caller did not pick a
 * target. Model choice beyond that is the agent's call, guided by the Kin base
 * prompt and the user's models.md.
 */
export function applyKinProfileTarget(input: {
  readonly target: OrchestratorMcpTarget | undefined;
  readonly profile: Pick<KinAgentProfile, "provider" | "model">;
}): OrchestratorMcpTarget | undefined {
  const { target, profile } = input;
  const pinned =
    target?.providerInstanceId !== undefined ||
    target?.driverKind !== undefined ||
    target?.model !== undefined;
  if (pinned || (profile.provider === "inherit" && profile.model === "inherit")) return target;
  return {
    ...target,
    ...(profile.provider === "inherit"
      ? {}
      : { driverKind: ProviderDriverKind.make(profile.provider) }),
    ...(profile.model === "inherit" ? {} : { model: profile.model }),
  };
}
