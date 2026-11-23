import { KIN_LIST_DEFAULT_FILTER } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_WORK_LOAD_FAILED,
  kinWorkOffline,
  kinWorkOnlyOwner,
} from "@t3tools/client-runtime/kin/kinWork";
import type { KinListId, KinRecordKey } from "@t3tools/contracts";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { hasDesktopWindowChrome } from "./kinDesktopWindow";
import { retryKinAccess } from "./kinClient";
import { KinWorkItemSheet } from "./KinWorkItemSheet";
import { KinWorkListPage } from "./KinWorkLists";
import { KinLoadFailed, KinWorkNotice, KinWorkRowSkeletons } from "./KinWorkParts";
import { kinListsOf, useKinLists } from "./useKinMoney";
import { useKinSectionOn } from "./useKinShell";
import {
  kinWorkLiveAtom,
  useKinWork,
  useKinWorkChanges,
  useKinWorkChoices,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

/** Where a list section's page sends what it can't show itself. */
export interface KinListSectionGo {
  readonly onOpenKey: (key: KinRecordKey | null) => void;
  readonly onOpenClient: (key: KinRecordKey) => void;
  readonly onOpenProject: (key: KinRecordKey) => void;
  readonly onOpenDoc: (key: KinRecordKey) => void;
  /** The list is gone: to Docs, where the company's lists are. */
  readonly onGone: () => void;
}

/**
 * A company list shown as a section: the list's own page as a place of the sidebar, its entries
 * opening over it. The list's own rules decide who reads it, as they do under Lists.
 */
export function KinListSectionPage(
  props: KinWorkTarget &
    KinListSectionGo & {
      readonly list: KinListId;
      readonly openKey: KinRecordKey | null;
    },
) {
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const state = useKinWork(target);
  const ready = state._tag === "ready";
  const directory = useKinWorkDirectory(target, ready);
  const changes = useKinWorkChanges(target);
  const clientsOn = useKinSectionOn(props.environmentId, "clients");
  const choices = useKinWorkChoices(target, ready && clientsOn);
  const lists = useKinLists(target, { enabled: ready, archived: true });
  const name = kinListsOf(lists).find((def) => def.list === props.list)?.name ?? "List";
  return (
    <>
      <WorkspacePageHeader electron={hasDesktopWindowChrome}>
        <WorkspaceBreadcrumb ariaLabel={name}>
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{name}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      {state._tag === "refused" ? (
        <KinWorkNotice {...kinWorkOnlyOwner("docs")} />
      ) : state._tag === "offline" ? (
        <KinWorkNotice {...kinWorkOffline("docs")} />
      ) : state._tag === "failed" ? (
        <KinLoadFailed
          what={KIN_WORK_LOAD_FAILED}
          cause={null}
          onRetry={() => {
            retryKinAccess(props.environmentId);
            appAtomRegistry.refresh(kinWorkLiveAtom(target));
          }}
          className="mx-auto w-full max-w-3xl p-4"
        />
      ) : state._tag === "loading" ? (
        <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label={`Loading ${name}`}>
          <KinWorkRowSkeletons />
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <KinWorkListPage
            {...target}
            list={props.list}
            live={state.live}
            stale={state.stale}
            directory={directory}
            initial={KIN_LIST_DEFAULT_FILTER}
            openKey={props.openKey}
            onOpenKey={props.onOpenKey}
            onGone={props.onGone}
          />
          {props.openKey === null ? null : (
            <KinWorkItemSheet
              key={props.openKey}
              {...target}
              itemKey={props.openKey}
              frame="sheet"
              directory={directory}
              changes={changes}
              choices={clientsOn ? choices : null}
              onOpenKey={props.onOpenKey}
              onOpenClient={props.onOpenClient}
              onOpenProject={props.onOpenProject}
              onOpenDoc={props.onOpenDoc}
              onClose={() => props.onOpenKey(null)}
            />
          )}
        </div>
      )}
    </>
  );
}
