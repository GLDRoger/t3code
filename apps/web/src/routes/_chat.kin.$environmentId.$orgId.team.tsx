import { KinOrgId, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { KinTeamView } from "../kin/KinTeamView";

function KinTeamRoute() {
  const { environmentId, orgId } = Route.useParams();
  return (
    <KinTeamView
      // One mounted view per organization, so a link made for one never shows under another.
      key={`${environmentId}:${orgId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={KinOrgId.make(orgId)}
    />
  );
}

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/team")({
  component: KinTeamRoute,
});
