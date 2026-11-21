import { kinWorkListsMoved } from "@t3tools/client-runtime/kin/kinWorkStream";
import { useNavigate } from "@tanstack/react-router";

import { KinNeedsYou } from "./KinNeedsYou";
import { kinPlaceOfRecord } from "./kinPlaces";
import { useKinMyDueTasks } from "./useKinPlaces";
import { useKinWork, useKinWorkDirectory, type KinWorkTarget } from "./useKinWork";

/**
 * A wide window with no chat open: what needs you today, the same rows Tasks leads with. For a
 * teammate that is what is on them. The fallback stands in until Work answers, or where it can't.
 */
export function KinToday(props: KinWorkTarget & { readonly fallback: React.ReactNode }) {
  const { environmentId, orgId } = props;
  const navigate = useNavigate();
  const state = useKinWork(props);
  const ready = state._tag === "ready";
  const directory = useKinWorkDirectory(props, ready);
  const mine = useKinMyDueTasks(
    props,
    ready ? directory.names.me : null,
    ready && !state.stale ? kinWorkListsMoved(state.live, ["work"]) : null,
  );
  if (!ready) return props.fallback;
  const params = { environmentId, orgId };
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-6 py-8">
      <KinNeedsYou
        environmentId={environmentId}
        orgId={orgId}
        directory={directory}
        mine={mine}
        onOpenTask={(task) =>
          void navigate({ to: "/kin/$environmentId/$orgId/tasks", params, search: { task } })
        }
        onOpenList={(open) =>
          void navigate({
            to:
              kinPlaceOfRecord({ list: open.list }) === "money"
                ? "/kin/$environmentId/$orgId/money"
                : "/kin/$environmentId/$orgId/docs",
            params,
            search: { list: open.list },
          })
        }
        onOpenMoney={() => void navigate({ to: "/kin/$environmentId/$orgId/money", params })}
      />
    </div>
  );
}
