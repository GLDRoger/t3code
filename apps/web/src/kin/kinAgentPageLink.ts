import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinLeadProfile,
  KinOrgId,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { kinClient } from "./kinClient";
import { withKinAgentPage } from "./kinPlaces";

export interface KinAgentPageTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}

/**
 * Opens an agent's page at its own address: over the Kin page the person is on, or from outside
 * Kin (Settings, the command palette) over the agent's own chat.
 */
export function useOpenKinAgentPage() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  return (target: KinAgentPageTarget & { readonly chatId: KinChatId }) =>
    params.environmentId === target.environmentId && params.orgId === target.orgId
      ? navigate({ to: ".", search: (prev) => withKinAgentPage(prev, target.agentId) })
      : navigate({
          to: "/kin/$environmentId/$orgId/$chatId",
          params: {
            environmentId: target.environmentId,
            orgId: target.orgId,
            chatId: target.chatId,
          },
          search: { agent: target.agentId },
        });
}

const NO_AGENTS: ReadonlyArray<KinLeadProfile> = [];
const noAgentsAtom = Atom.make(NO_AGENTS).pipe(Atom.withLabel("kin:no-agents"));
const agentsOf = Atom.family((key: string) => {
  const [environmentId, orgId] = key.split("\n") as [EnvironmentId, KinOrgId];
  return Atom.make(
    (get) =>
      Option.getOrNull(AsyncResult.value(get(kinClient.leads({ environmentId, input: { orgId } }))))
        ?.leads ?? NO_AGENTS,
  ).pipe(Atom.withLabel("kin:palette-agents"));
});

/** The owner-level viewer's agents, for the command palette; none for anyone else. */
export function useKinPaletteAgents(
  target: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId } | null,
  ownerLevel: boolean,
): ReadonlyArray<KinLeadProfile> {
  return useAtomValue(
    target === null || !ownerLevel
      ? noAgentsAtom
      : agentsOf(`${target.environmentId}\n${target.orgId}`),
  );
}
