import { KinOrgId, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { KinMemoryView } from "../kin/KinMemoryView";

function KinMemoryRoute() {
  const { environmentId, orgId } = Route.useParams();
  return (
    <KinMemoryView
      // One mounted view per organization, so a tap in flight never lands on another's list.
      key={`${environmentId}:${orgId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={KinOrgId.make(orgId)}
    />
  );
}

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/memory")({
  component: KinMemoryRoute,
});
