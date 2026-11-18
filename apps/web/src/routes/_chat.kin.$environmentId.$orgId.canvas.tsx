import { KinOrgId, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { KinCanvasPage } from "../kin/canvas/KinCanvasPage";

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/canvas")({
  component: KinCanvasRoute,
});

function KinCanvasRoute() {
  const { environmentId, orgId } = Route.useParams();
  return (
    <KinCanvasPage
      // One canvas per company, so a camera or a drag never carries over to another.
      key={`${environmentId}:${orgId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={KinOrgId.make(orgId)}
    />
  );
}
