import { useAtomValue } from "@effect/atom-react";
import { KIN_DATES } from "@t3tools/client-runtime/kin/kinDates";
import { KIN_SUBSCRIPTIONS } from "@t3tools/client-runtime/kin/kinSubscriptions";
import { KIN_LIST_DEFAULT_FILTER } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_MONEY, type KinListOpen } from "@t3tools/client-runtime/kin/kinMoney";
import {
  KIN_WORK_DEFAULT_FILTER,
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  KIN_WORK_NO_DRAFT,
  KIN_WORK_OFFLINE,
  KIN_WORK_ONLY_OWNER,
  kinWorkHostClients,
  kinWorkHostEdits,
  type KinWorkDraft,
  type KinWorkFilter,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_CLIENTS,
  KIN_CLIENTS_OLDER_HOST,
  KIN_PROJECTS,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { KIN_WORK_HOME } from "@t3tools/client-runtime/kin/kinWorkHome";
import { KinOrgId, type EnvironmentId, type KinRecordKey } from "@t3tools/contracts";
import {
  useChildMatches,
  useLocation,
  useNavigate,
  useParams,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { isElectron } from "../env";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { KinDocPage } from "./KinDocPage";
import { KinDocsList } from "./KinDocsList";
import { KinSubscriptionsPage } from "./KinSubscriptions";
import { KinSearchDialog } from "./KinSearchDialog";
import { KinWorkClientPage, KinWorkClientsList } from "./KinWorkClients";
import { KinWorkDates } from "./KinWorkDates";
import { KinClientDialog, KinProjectDialog } from "./KinWorkForms";
import { KinWorkItemSheet } from "./KinWorkItemSheet";
import { KinWorkListPage } from "./KinWorkLists";
import { KinWorkMoney } from "./KinWorkMoney";
import { KinWorkNewDialog } from "./KinWorkNewDialog";
import { KinWorkNotice, KinWorkRowSkeletons, KinLoadFailed } from "./KinWorkParts";
import { KinWorkProjectPage } from "./KinWorkProjects";
import { KinWorkTaskList } from "./KinWorkTasks";
import { kinClient } from "./kinClient";
import {
  KIN_PLACE_PATH,
  kinPlaceOfRecord,
  kinRecordOf,
  kinSearchOf,
  type KinPlace,
  type KinPlaceDialog,
  type KinRecordWhere,
} from "./kinPlaces";
import { openKinMemoryInstead } from "./kinSettingsAddress";
import { kinListsOf, useKinAskAgent, useKinLists } from "./useKinMoney";
import {
  kinWorkLiveAtom,
  useKinWork,
  useKinWorkChanges,
  useKinWorkChoices,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

const PLACES_ROUTE = "/_chat/kin/$environmentId/$orgId/_places";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** A record opened from its place's list, so the way back is one step back. */
    kinFromList?: boolean;
    kinTaskPushed?: boolean;
    kinDialogPushed?: boolean;
    kinHistoryPushed?: boolean;
  }
}

const docOf = (record: KinRecordWhere | null) =>
  record !== null && "doc" in record ? record : null;

/** The layout over Tasks, Money, Clients and Docs: one view, so moving between them keeps it. */
export function KinPlacesRoute() {
  const { environmentId, orgId } = useParams({ from: PLACES_ROUTE });
  const search = useSearch({ from: PLACES_ROUTE });
  const child = useChildMatches()[0]?.routeId.split("/").at(-1);
  const place: KinPlace =
    child === "money" || child === "clients" || child === "docs" ? child : "tasks";
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const record = kinRecordOf(search);
  const params = { environmentId, orgId };
  return (
    <KinPlaceView
      // One mounted view per organization, so a list being read never lands under another.
      key={`${environmentId}:${orgId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={KinOrgId.make(orgId)}
      place={place}
      record={record}
      onGo={(to, next) => {
        const fromList = location.state.kinFromList === true;
        const overDialog = search.open !== undefined;
        // A doc's History opened here is one step on from the doc, so Back lands on the doc.
        const historyPushed = location.state.kinHistoryPushed === true && !overDialog;
        const docFrom = docOf(record);
        const docTo = docOf(next);
        const sameDoc = docFrom !== null && docTo !== null && docFrom.doc === docTo.doc;
        const opensHistory = sameDoc && docTo.history === true && docFrom.history !== true;
        const closesHistory =
          sameDoc &&
          docFrom.history === true &&
          docTo.history !== true &&
          docTo.version === docFrom.version &&
          docTo.changes?.to === docFrom.changes?.to &&
          docTo.changes?.from === docFrom.changes?.from;
        if (closesHistory && historyPushed) {
          router.history.back();
          return;
        }
        // Back from a record opened off this list is the browser's own Back, so the two agree.
        if (to === place && next === null && record !== null && fromList && !overDialog) {
          router.history.go(historyPushed ? -2 : -1);
          return;
        }
        const within = to === place && record !== null;
        void navigate({
          to: KIN_PLACE_PATH[to],
          params,
          search: kinSearchOf(next),
          // A record opened from a record, or from a dialog, takes its spot rather than stacking.
          replace: (within && !opensHistory) || overDialog,
          state: {
            kinFromList: next !== null && (within ? fromList : to === place),
            kinHistoryPushed: opensHistory || (historyPushed && sameDoc),
          },
        });
      }}
      docLink={(key, section) =>
        new URL(
          router.history.createHref(
            router.buildLocation({
              to: KIN_PLACE_PATH.docs,
              params,
              search: { doc: key, ...(section === null ? {} : { section }) },
            }).href,
          ),
          window.location.href,
        ).toString()
      }
      dialog={search.open ?? null}
      onDialog={(next) => {
        const pushed = location.state.kinDialogPushed === true;
        // Closing a dialog this page opened is the browser's Back, so Back never reopens it.
        if (next === null && search.open !== undefined && pushed) {
          router.history.back();
          return;
        }
        const under = {
          ...kinSearchOf(record),
          ...(search.task === undefined ? {} : { task: search.task }),
        };
        void navigate({
          to: KIN_PLACE_PATH[place],
          params,
          search: next === null ? under : { ...under, open: next },
          replace: next === null || search.open !== undefined,
          state: {
            kinFromList: location.state.kinFromList === true,
            kinTaskPushed: location.state.kinTaskPushed === true,
            kinDialogPushed: next !== null && (search.open === undefined || pushed),
          },
        });
      }}
      openKey={search.task ?? null}
      onOpenKey={(key) => {
        const overDialog = search.open !== undefined;
        const pushed = overDialog
          ? location.state.kinDialogPushed === true
          : location.state.kinTaskPushed === true;
        const open = search.task !== undefined;
        // Closing a task this page opened is the browser's Back, so Back never lands on it again.
        if (key === null && open && pushed && !overDialog) {
          router.history.back();
          return;
        }
        void navigate({
          to: KIN_PLACE_PATH[place],
          params,
          search: key === null ? kinSearchOf(record) : { ...kinSearchOf(record), task: key },
          // A task opened from a task, or from a dialog, takes its spot rather than stacking.
          replace: key === null || open || overDialog,
          state: {
            kinFromList: location.state.kinFromList === true,
            kinTaskPushed: key !== null && (overDialog ? pushed : !open || pushed),
          },
        });
      }}
    />
  );
}

type Adding =
  | { readonly type: "task"; readonly draft: KinWorkDraft }
  | { readonly type: "client" }
  | { readonly type: "project" }
  | null;

/**
 * One place: its list, and the record opened from it beside the list on a wide window or in its
 * stead on a narrow one. A record opened from a record takes its spot; nothing stacks.
 */
function KinPlaceView({
  place,
  record,
  onGo,
  openKey,
  onOpenKey: setOpenKey,
  dialog,
  onDialog,
  docLink,
  ...props
}: KinWorkTarget & {
  readonly place: KinPlace;
  readonly record: KinRecordWhere | null;
  readonly onGo: (place: KinPlace, record: KinRecordWhere | null) => void;
  readonly openKey: KinRecordKey | null;
  readonly onOpenKey: (key: KinRecordKey | null) => void;
  /** New task or Search, open over the place; it lives in the address so Back closes it. */
  readonly dialog: KinPlaceDialog | null;
  readonly onDialog: (dialog: KinPlaceDialog | null) => void;
  /** The address of a doc, or one section of it, for Copy link. */
  readonly docLink: (doc: KinRecordKey, section: string | null) => string;
}) {
  const { environmentId } = props;
  const router = useRouter();
  const wide = useMediaQuery("lg");
  const state = useKinWork(props);
  const canAdd = useAtomValue(kinClient.workCreate.permissionAtom(environmentId));
  const canAddClient = useAtomValue(kinClient.workClientCreate.permissionAtom(environmentId));
  const canAddProject = useAtomValue(kinClient.workProjectCreate.permissionAtom(environmentId));
  const canChangeTasks = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId));
  const ready = state._tag === "ready";
  const summary = ready ? state.live.summary : null;
  const hostClients = kinWorkHostClients(summary);
  const directory = useKinWorkDirectory(props, ready);
  const choices = useKinWorkChoices(props, ready && hostClients);
  const changes = useKinWorkChanges(props);
  const agent = useKinAskAgent(props);
  const lists = useKinLists(props, { enabled: ready && place === "docs", archived: true });
  const moneyLists = useKinLists(props, { enabled: ready && place === "money", money: true });
  const [adding, setAdding] = useState<Adding>(null);
  const searching = dialog === "search";
  // Where the task list starts when it is opened from a client: narrowed to that client.
  const [narrowed, setNarrowed] = useState<KinWorkFilter>(KIN_WORK_DEFAULT_FILTER);
  // Where a list starts when a figure or a client opened it: narrowed to what is behind it.
  const [listStart, setListStart] = useState<KinListOpen | null>(null);

  const open = (next: KinRecordWhere | null) => onGo(place, next);
  const openList = (start: KinListOpen) => {
    setListStart(start);
    open({ list: start.list });
  };
  const openClient = (key: KinRecordKey) => open({ party: key });
  const openProject = (key: KinRecordKey) => open({ project: key });
  const openDoc = (doc: KinRecordKey, section?: string) =>
    open(section === undefined ? { doc } : { doc, section });
  const addTask =
    ready && canAdd
      ? (draft: KinWorkDraft) => {
          setAdding({ type: "task", draft });
          onDialog("new");
        }
      : null;
  const addClient =
    ready && hostClients && canAddClient ? () => setAdding({ type: "client" }) : null;
  const addProject =
    ready && hostClients && canAddProject ? () => setAdding({ type: "project" }) : null;
  const title = KIN_WORK_HOME.places[place];

  const header = (
    <WorkspacePageHeader electron={isElectron}>
      {/* A place is a destination of the dock on a narrow window, so only a record has a Back. */}
      {record === null || wide ? null : (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Back to ${title}`}
          onClick={() => open(null)}
        >
          <ArrowLeftIcon />
        </Button>
      )}
      <WorkspaceBreadcrumb ariaLabel={title}>
        <WorkspaceBreadcrumbItem current>
          <h1 className="truncate">
            {record !== null && !wide && "dates" in record
              ? KIN_DATES.title
              : record !== null && !wide && "subscriptions" in record
                ? KIN_SUBSCRIPTIONS.title
                : title}
          </h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {!ready ? null : (
        <div className="ms-auto flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={KIN_WORK_HOME.search}
            onClick={() => onDialog("search")}
          >
            <SearchIcon />
          </Button>
          {place === "tasks" && addTask !== null ? (
            <Button size="sm" onClick={() => addTask(KIN_WORK_NO_DRAFT)}>
              <PlusIcon />
              {KIN_WORK_NEW}
            </Button>
          ) : place === "clients" && addClient !== null && addProject !== null ? (
            <Menu>
              <MenuTrigger render={<Button size="sm" />}>
                <PlusIcon />
                {KIN_WORK_HOME.add}
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={addClient}>{KIN_CLIENTS.add}</MenuItem>
                <MenuItem onClick={addProject}>{KIN_PROJECTS.add}</MenuItem>
              </MenuPopup>
            </Menu>
          ) : place === "clients" && (addClient ?? addProject) !== null ? (
            <Button size="sm" onClick={addClient ?? addProject ?? undefined}>
              <PlusIcon />
              {addClient === null ? KIN_PROJECTS.add : KIN_CLIENTS.add}
            </Button>
          ) : null}
        </div>
      )}
    </WorkspacePageHeader>
  );

  const placeList = () => {
    if (state._tag !== "ready") return null;
    if (place === "money")
      return (
        <KinWorkMoney
          {...props}
          live={state.live}
          stale={state.stale}
          directory={directory}
          lists={moneyLists}
          onOpenList={openList}
          onOpenKey={setOpenKey}
          onDates={() => open({ dates: true })}
          onSubscriptions={() => open({ subscriptions: true })}
          onOpenDoc={openDoc}
        />
      );
    if (place === "docs")
      return (
        <KinDocsList
          {...props}
          directory={directory}
          stale={state.stale}
          onOpen={openDoc}
          lists={lists.state._tag === "ready" ? kinListsOf(lists) : null}
          onOpenList={(list) => openList({ list, filter: KIN_LIST_DEFAULT_FILTER })}
          onAsk={agent === null ? null : agent.ask}
          selected={
            record === null
              ? null
              : "doc" in record
                ? record.doc
                : "list" in record
                  ? record.list
                  : null
          }
        />
      );
    if (place === "clients")
      return !hostClients ? (
        <KinWorkNotice
          {...KIN_CLIENTS_OLDER_HOST}
          action={
            <Button size="sm" variant="outline" onClick={() => onGo("tasks", null)}>
              Open tasks
            </Button>
          }
        />
      ) : (
        <KinWorkClientsList
          {...props}
          live={state.live}
          stale={state.stale}
          directory={directory}
          onOpen={openClient}
          onOpenProject={openProject}
          onAdd={addClient}
          selected={
            record === null
              ? null
              : "party" in record
                ? record.party
                : "project" in record
                  ? record.project
                  : null
          }
        />
      );
    return (
      <KinWorkTaskList
        // Opened from a client, the list starts over narrowed to that client.
        key={narrowed.party?.key ?? "all"}
        {...props}
        live={state.live}
        stale={state.stale}
        directory={directory}
        changes={changes}
        openKey={openKey}
        onOpen={setOpenKey}
        onAdd={addTask === null ? null : () => addTask(KIN_WORK_NO_DRAFT)}
        initial={narrowed}
        choices={hostClients ? choices : null}
        needsYou={{
          onOpenTask: setOpenKey,
          onOpenList: (start) => {
            setListStart(start);
            onGo(kinPlaceOfRecord({ list: start.list }), { list: start.list });
          },
          onOpenMoney: () => onGo("money", null),
        }}
      />
    );
  };

  const recordView = (shown: KinRecordWhere) => {
    if (state._tag !== "ready") return null;
    if ("doc" in shown)
      return (
        <KinDocPage
          key={shown.doc}
          {...props}
          where={shown}
          directory={directory}
          placeTitle={title}
          inPane={wide}
          onGo={open}
          linkTo={(section) => docLink(shown.doc, section)}
        />
      );
    if ("subscriptions" in shown)
      return (
        <KinSubscriptionsPage
          {...props}
          live={state.live}
          stale={state.stale}
          directory={directory}
          onOpenKey={setOpenKey}
        />
      );
    if ("dates" in shown)
      return (
        <KinWorkDates
          {...props}
          live={state.live}
          stale={state.stale}
          directory={directory}
          onOpenKey={setOpenKey}
        />
      );
    if ("list" in shown)
      return (
        <KinWorkListPage
          // A fresh page per list and per way in, so one figure's narrowing never shows on another.
          key={`${shown.list}:${listStart?.list === shown.list ? JSON.stringify(listStart.filter) : ""}`}
          {...props}
          list={shown.list}
          live={state.live}
          stale={state.stale}
          directory={directory}
          initial={listStart?.list === shown.list ? listStart.filter : KIN_LIST_DEFAULT_FILTER}
          openKey={openKey}
          onOpenKey={setOpenKey}
          onGone={() => onGo("docs", null)}
        />
      );
    if (!hostClients) return <KinWorkNotice {...KIN_CLIENTS_OLDER_HOST} />;
    if ("party" in shown)
      return (
        <KinWorkClientPage
          // A fresh page per client, so one client's dialogs never show on another.
          key={shown.party}
          {...props}
          clientKey={shown.party}
          directory={directory}
          changes={changes}
          choices={choices}
          canChangeTasks={canChangeTasks && kinWorkHostEdits(summary)}
          onOpenTask={setOpenKey}
          onOpenClient={openClient}
          onOpenProject={openProject}
          onOpenDoc={openDoc}
          onSeeAll={(party) => {
            setNarrowed({ ...KIN_WORK_DEFAULT_FILTER, party });
            onGo("tasks", null);
          }}
          onAddTask={addTask}
          onOpenList={openList}
        />
      );
    return (
      <KinWorkProjectPage
        key={shown.project}
        {...props}
        projectKey={shown.project}
        live={state.live}
        stale={state.stale}
        directory={directory}
        changes={changes}
        choices={choices}
        openKey={openKey}
        onOpenTask={setOpenKey}
        onOpenClient={openClient}
        onOpenProject={openProject}
        onOpenDoc={openDoc}
        onAddTask={addTask}
        onOpenList={openList}
      />
    );
  };

  // A doc on a narrow window is the whole page, under its own header with its own way back.
  const docAlone = record !== null && "doc" in record && !wide;
  return (
    <>
      {docAlone ? null : header}
      {state._tag === "refused" ? (
        <KinWorkNotice {...KIN_WORK_ONLY_OWNER} />
      ) : state._tag === "offline" ? (
        <KinWorkNotice {...KIN_WORK_OFFLINE} />
      ) : state._tag === "failed" ? (
        <KinLoadFailed
          what={KIN_WORK_LOAD_FAILED}
          cause={null}
          onRetry={() => appAtomRegistry.refresh(kinWorkLiveAtom(props))}
          className="mx-auto w-full max-w-3xl p-4"
        />
      ) : state._tag === "loading" ? (
        <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label={`Loading ${title}`}>
          <KinWorkRowSkeletons />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {record !== null && !wide ? null : (
            <div
              className={
                record === null
                  ? "flex min-h-0 min-w-0 flex-1 flex-col"
                  : "flex min-h-0 w-96 shrink-0 flex-col border-e border-border"
              }
            >
              {placeList()}
            </div>
          )}
          {record === null ? null : (
            <section
              aria-label={place === "money" && "list" in record ? KIN_MONEY.title : title}
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {recordView(record)}
            </section>
          )}
        </div>
      )}
      {!searching ? null : (
        <KinSearchDialog
          {...props}
          onClose={() => onDialog(null)}
          // Whatever a hit opens takes the dialog's place in the address.
          onOpen={(hit) => {
            if (hit.kind === "docs") openDoc(hit.key, hit.section?.id);
            else if (hit.kind === "clients") openClient(hit.key);
            else if (hit.kind === "projects") openProject(hit.key);
            else if (hit.kind === "memory") openKinMemoryInstead(router.history, hit.title, "open");
            // A contact has no page of its own, and a money entry opens on its sheet.
            else setOpenKey(hit.key);
          }}
        />
      )}
      {openKey === null || !ready ? null : (
        <KinWorkItemSheet
          // A fresh sheet per task, so one task's hand-over never shows on another.
          key={openKey}
          {...props}
          itemKey={openKey}
          directory={directory}
          changes={changes}
          choices={hostClients ? choices : null}
          onOpenKey={setOpenKey}
          onOpenClient={openClient}
          onOpenProject={openProject}
          onOpenDoc={(doc) => openDoc(doc)}
          onClose={() => setOpenKey(null)}
        />
      )}
      {adding?.type === "task" && dialog === "new" ? (
        <KinWorkNewDialog
          {...props}
          directory={directory}
          choices={hostClients ? choices : null}
          start={adding.draft}
          onAdded={(key) => {
            setAdding(null);
            // Added from a client or project, it shows up there: the record stays put.
            if (record === null) setOpenKey(key);
            else onDialog(null);
          }}
          onClose={() => {
            setAdding(null);
            onDialog(null);
          }}
        />
      ) : adding?.type === "client" ? (
        <KinClientDialog
          {...props}
          editing={null}
          onSaved={(key) => {
            setAdding(null);
            openClient(key);
          }}
          onOpenExisting={(key) => {
            setAdding(null);
            openClient(key);
          }}
          onClose={() => setAdding(null)}
        />
      ) : adding?.type === "project" ? (
        <KinProjectDialog
          {...props}
          editing={null}
          party={null}
          choices={choices}
          directory={directory}
          onSaved={(key) => {
            setAdding(null);
            openProject(key);
          }}
          onOpenExisting={(key) => {
            setAdding(null);
            openProject(key);
          }}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </>
  );
}
