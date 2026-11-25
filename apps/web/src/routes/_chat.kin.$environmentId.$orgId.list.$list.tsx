import { KinListId, KinOrgId, KinRecordKey, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { KinListSectionPage } from "../kin/KinListSection";
import { KIN_PLACE_PATH } from "../kin/kinPlaces";
import { KinWorkNotice } from "../kin/KinWorkParts";

const isKey = Schema.is(KinRecordKey);
const isList = Schema.is(KinListId);

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/list/$list")({
  // The open entry rides in the address, so it can be linked to and Back closes it.
  validateSearch: (search: Record<string, unknown>): { readonly task?: KinRecordKey } =>
    isKey(search.task) ? { task: search.task } : {},
  component: KinListSectionRoute,
});

function KinListSectionRoute() {
  const { environmentId, orgId, list } = Route.useParams();
  const { task } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const pushed = useLocation({ select: (location) => location.state.kinDialogPushed === true });
  const params = { environmentId, orgId };
  if (!isList(list))
    return <KinWorkNotice title="This link doesn't open a list" detail="Open Lists from Docs." />;
  const place = (to: keyof typeof KIN_PLACE_PATH, search: Record<string, string>) =>
    void navigate({ to: KIN_PLACE_PATH[to], params, search });
  return (
    <KinListSectionPage
      key={`${environmentId}:${orgId}:${list}`}
      environmentId={environmentId as EnvironmentId}
      orgId={KinOrgId.make(orgId)}
      list={list}
      openKey={task ?? null}
      onOpenKey={(key) => {
        // Closing an entry this page opened is the browser's Back, so Back never reopens it.
        if (key === null && pushed) {
          router.history.back();
          return;
        }
        void navigate({
          to: "/kin/$environmentId/$orgId/list/$list",
          params: { ...params, list },
          search: key === null ? {} : { task: key },
          replace: key === null || task !== undefined,
          state: { kinDialogPushed: key !== null && (task === undefined || pushed) },
        });
      }}
      onOpenClient={(key) => place("clients", { client: key })}
      onOpenProject={(key) => place("clients", { project: key })}
      onOpenDoc={(key) => place("docs", { doc: key })}
      onGone={() => place("docs", {})}
    />
  );
}
