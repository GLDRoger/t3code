import { KinOrgId, KinRecordKey, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { KinWorkView } from "../kin/KinWorkView";

const isTaskKey = Schema.is(KinRecordKey);

function KinWorkRoute() {
  const { environmentId, orgId } = Route.useParams();
  const { task } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <KinWorkView
      // One mounted view per organization, so a list being read never lands under another.
      key={`${environmentId}:${orgId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={KinOrgId.make(orgId)}
      openKey={task ?? null}
      onOpenKey={(key) =>
        void navigate({ search: key === null ? {} : { task: key }, replace: key === null })
      }
    />
  );
}

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/work")({
  // The open task rides in the address, so a task can be linked to and Back closes it.
  validateSearch: (raw: Record<string, unknown>): { task?: KinRecordKey } =>
    isTaskKey(raw.task) ? { task: raw.task } : {},
  component: KinWorkRoute,
});
