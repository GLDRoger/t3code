import { KinOrgId, KinRecordKey, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { KinNumbersView } from "../kin/KinNumbersView";

const isKey = Schema.is(KinRecordKey);

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/numbers")({
  // The open number rides in the address, so it can be linked to and Back closes it.
  validateSearch: (search: Record<string, unknown>): { readonly key?: KinRecordKey } =>
    isKey(search.key) ? { key: search.key } : {},
  component: KinNumbersRoute,
});

function KinNumbersRoute() {
  const { environmentId, orgId } = Route.useParams();
  const { key } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <KinNumbersView
      key={`${environmentId}:${orgId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={KinOrgId.make(orgId)}
      number={key ?? null}
      onOpen={(next) =>
        void navigate({
          to: "/kin/$environmentId/$orgId/numbers",
          params: { environmentId, orgId },
          search: next === null ? {} : { key: next },
        })
      }
    />
  );
}
