import { useAtomValue } from "@effect/atom-react";
import { KIN_DATES } from "@t3tools/client-runtime/kin/kinDates";
import { KIN_SUBSCRIPTIONS } from "@t3tools/client-runtime/kin/kinSubscriptions";
import { KIN_LIST_DEFAULT_FILTER } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_MONEY, type KinListOpen } from "@t3tools/client-runtime/kin/kinMoney";
import { kinPlaceInPlace } from "@t3tools/client-runtime/kin/kinNavigation";
import {
  KIN_WORK_DEFAULT_FILTER,
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  KIN_WORK_NO_DRAFT,
  kinWorkOffline,
  kinWorkOnlyOwner,
  kinWorkHostClients,
  kinWorkHostEdits,
  type KinWorkDraft,
  type KinWorkFilter,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_CLIENTS,
  KIN_CLIENTS_OLDER_HOST,
  KIN_PROJECTS,
  kinClientsTabs,
  kinClientsTabShown,
  type KinClientsTab,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { KIN_WORK_HOME } from "@t3tools/client-runtime/kin/kinWorkHome";
import {
  KinOrgId,
  type EnvironmentId,
  type KinPersonId,
  type KinRecordKey,
} from "@t3tools/contracts";
import {
  useChildMatches,
  useLocation,
  useNavigate,
  useParams,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { isElectron } from "../env";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { KinDocPage } from "./KinDocPage";
import { KinDocsList } from "./KinDocsList";
import { KinSubscriptionsPage } from "./KinSubscriptions";
import { KinSearchDialog } from "./KinSearchDialog";
import { KinWorkClientPage, KinWorkClientsList, KinWorkProjectsTab } from "./KinWorkClients";
import { KinDealNewDialog, KinDealsTab } from "./KinDeals";
import { KinDealPage } from "./KinDealPage";
import { KinImportView } from "./KinImport";
import { KIN_IMPORT } from "@t3tools/client-runtime/kin/kinImport";
import { KIN_DEALS, kinIsDealKey } from "@t3tools/client-runtime/kin/kinDeals";
import type { KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import { KinWorkDates } from "./KinWorkDates";
import {
  KIN_WORK_FORM_COPY,
  type KinClientDraftKind,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import { KinClientDialog, KinProjectDialog } from "./KinWorkForms";
import { useKinOwnerLevel, useKinSeesClients } from "./useKinOwnerLevel";
import { KinWorkItemSheet, useKinOpenedKind } from "./KinWorkItemSheet";
import { KinWorkListPage } from "./KinWorkLists";
import { KinWorkMoney } from "./KinWorkMoney";
import { KinWorkNewDialog } from "./KinWorkNewDialog";
import { KinWorkNotice, KinWorkRowSkeletons, KinLoadFailed } from "./KinWorkParts";
import { KinWorkProjectPage } from "./KinWorkProjects";
import { KinWorkTaskList } from "./KinWorkTasks";
import { kinClient, retryKinAccess } from "./kinClient";
import {
  KIN_PLACE_PATH,
  kinRecordOf,
  kinSearchOf,
  kinTaskAddress,
  type KinPlace,
  type KinPlaceDialog,
  type KinRecordWhere,
} from "./kinPlaces";
import { openKinMemoryInstead } from "./kinSettingsAddress";
import { kinListsOf, useKinAskAgent, useKinLists } from "./useKinMoney";
import { useKinDestinations } from "./useKinPlaces";
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
    /** How many entries this place pushed over its list, so the way back to it is that many back. */
    kinDepth?: number;
    /** How many of those opened a task, so closing the task goes back to what it was over. */
    kinTasks?: number;
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
  // The Clients place's tab stays in the address while records and dialogs open over it.
  const tab: KinClientsTab = (place === "clients" ? search.tab : undefined) ?? "clients";
  const kept = tab === "clients" ? {} : { tab };
  // Pushes count only over the list, and task pushes only over what has no task open, so going
  // back that many always lands there; an address reached any other way closes by navigating.
  const depth = location.state.kinDepth ?? 0;
  const pushedDepth = depth > 0 || (record === null && search.task === undefined) ? depth + 1 : 0;
  const tasks = location.state.kinTasks ?? 0;
  const pushedTasks = tasks > 0 || search.task === undefined ? tasks + 1 : 0;
  return (
    <KinPlaceView
      // One mounted view per organization, so a list being read never lands under another.
      key={`${environmentId}:${orgId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={KinOrgId.make(orgId)}
      place={place}
      record={record}
      onGo={(to, next, stack) => {
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
        // Back to the list from what was opened over it is the browser's own Back, so the two agree.
        if (to === place && next === null && depth > 0 && !overDialog) {
          router.history.go(-depth);
          return;
        }
        const within = to === place && record !== null;
        // A row picked beside an open record, or a hit from a dialog, takes its spot; a record
        // opened from a record stacks, so Back retraces them. A doc's own versions never stack.
        const replace = overDialog || (within && !opensHistory && (!stack || sameDoc));
        void navigate({
          to: KIN_PLACE_PATH[to],
          params,
          search: { ...kinSearchOf(next), ...(to === place ? kept : {}) },
          replace,
          state: {
            kinDepth: next === null || to !== place ? 0 : replace ? depth : pushedDepth,
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
      person={search.person ?? null}
      onDialog={(next) => {
        const pushed = location.state.kinDialogPushed === true;
        // Closing a dialog this page opened is the browser's Back, so Back never reopens it.
        if (next === null && search.open !== undefined && pushed) {
          router.history.back();
          return;
        }
        const under = {
          ...kinSearchOf(record),
          ...kept,
          ...(search.task === undefined ? {} : { task: search.task }),
        };
        const replace = next === null || search.open !== undefined;
        void navigate({
          to: KIN_PLACE_PATH[place],
          params,
          search: next === null ? under : { ...under, open: next },
          replace,
          state: {
            kinDepth: replace ? depth : pushedDepth,
            kinTasks: tasks,
            kinDialogPushed: next !== null && (search.open === undefined || pushed),
          },
        });
      }}
      tab={tab}
      onTab={(next) =>
        void navigate({
          to: KIN_PLACE_PATH.clients,
          params,
          search: { ...kinSearchOf(record), ...(next === "clients" ? {} : { tab: next }) },
          replace: true,
          state: location.state,
        })
      }
      openKey={search.task ?? null}
      onOpenKey={(key, stack) => {
        const overDialog = search.open !== undefined;
        const open = search.task !== undefined;
        // Closing a task this page opened is the browser's Back, so Back never lands on it again.
        if (key === null && open && tasks > 0 && !overDialog) {
          router.history.go(-tasks);
          return;
        }
        // A row picked beside an open task, or a hit from a dialog, takes its spot; a task opened
        // from inside a task stacks, so Back retraces them.
        const replace = key === null || overDialog || (open && !stack);
        void navigate({
          ...kinTaskAddress(place, search, key),
          params,
          replace,
          state: {
            kinDepth: replace ? depth : pushedDepth,
            kinTasks:
              key === null
                ? 0
                : overDialog
                  ? location.state.kinDialogPushed === true
                    ? pushedTasks
                    : tasks
                  : replace
                    ? tasks
                    : pushedTasks,
          },
        });
      }}
    />
  );
}

type Adding =
  | { readonly type: "task"; readonly draft: KinWorkDraft }
  | { readonly type: "client"; readonly start: KinClientDraftKind }
  | { readonly type: "project"; readonly party?: KinWorkRef }
  | { readonly type: "deal"; readonly party: KinWorkRef | null }
  | null;

/**
 * One place: its list, and the record opened from it beside the list on a wide window or in its
 * stead on a narrow one. A record opened from a record takes its spot; nothing stacks.
 */
export function KinPlaceView({
  place,
  record,
  onGo,
  openKey,
  onOpenKey,
  dialog,
  onDialog,
  docLink,
  tab: askedTab,
  onTab,
  person = null,
  ...props
}: KinWorkTarget & {
  readonly place: KinPlace;
  /** A person's page opened Tasks for what they hold. */
  readonly person?: KinPersonId | null;
  /** Which of Clients and Projects the Clients place lists. */
  readonly tab: KinClientsTab;
  readonly onTab: (tab: KinClientsTab) => void;
  readonly record: KinRecordWhere | null;
  /** `stack`: opened from inside a record, so it is one more step back rather than a swap. */
  readonly onGo: (place: KinPlace, record: KinRecordWhere | null, stack: boolean) => void;
  readonly openKey: KinRecordKey | null;
  readonly onOpenKey: (key: KinRecordKey | null, stack: boolean) => void;
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
  const { destinations, known } = useKinDestinations(props);
  // The web stays on its address: a place the host took away says so here and comes back by itself.
  const placeRefused = kinPlaceInPlace({ held: place, tabs: destinations, known }) === "refused";
  const canAdd = useAtomValue(kinClient.workCreate.permissionAtom(environmentId));
  // The host takes a new client from the owner level, and a prospect from a teammate with Clients on.
  const canAddClient = useKinSeesClients(environmentId);
  // Deals are for someone with Clients on; a deals address without it shows Clients.
  const tab = kinClientsTabShown(askedTab, canAddClient);
  const ownerLevel = useKinOwnerLevel(environmentId);
  const canAddProject = useAtomValue(kinClient.workProjectCreate.permissionAtom(environmentId));
  const canChangeTasks = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId));
  const ready = state._tag === "ready";
  const summary = ready ? state.live.summary : null;
  const hostClients = kinWorkHostClients(summary);
  const directory = useKinWorkDirectory(props, ready);
  const choices = useKinWorkChoices(props, ready && hostClients);
  const changes = useKinWorkChanges(props);
  // Each place hands over to its own agent: Money to the books, the rest to the Chief of staff.
  const agent = useKinAskAgent(props, place);
  const lists = useKinLists(props, { enabled: ready && place === "docs", archived: true });
  const moneyLists = useKinLists(props, { enabled: ready && place === "money", money: true });
  const [adding, setAdding] = useState<Adding>(null);
  const searching = dialog === "search";
  // Where the task list starts when it is opened from a client: narrowed to that client.
  const [narrowed, setNarrowed] = useState<KinWorkFilter>(() =>
    person === null
      ? KIN_WORK_DEFAULT_FILTER
      : { ...KIN_WORK_DEFAULT_FILTER, owner: { _tag: "person", personId: person } },
  );
  // Where a list starts when a figure or a client opened it: narrowed to what is behind it.
  const [listStart, setListStart] = useState<KinListOpen | null>(null);

  // From a list, what opens takes the open record's spot; from inside a record, it stacks.
  const opens = (stack: boolean) => ({
    open: (next: KinRecordWhere | null) => onGo(place, next, stack),
    list: (start: KinListOpen) => {
      setListStart(start);
      onGo(place, { list: start.list }, stack);
    },
    party: (key: KinRecordKey) => onGo(place, { party: key }, stack),
    project: (key: KinRecordKey) => onGo(place, { project: key }, stack),
    doc: (doc: KinRecordKey, section?: string) =>
      onGo(place, section === undefined ? { doc } : { doc, section }, stack),
    task: (key: KinRecordKey | null) => onOpenKey(key, stack),
  });
  const fromList = opens(false);
  const fromRecord = opens(true);
  const open = fromList.open;
  const openList = fromList.list;
  const openClient = fromList.party;
  const openProject = fromList.project;
  const openDoc = fromList.doc;
  const setOpenKey = fromList.task;
  // A task opens in the record pane, or as the page on a narrow window; a list entry opens over
  // the place. Until it loads, Money and Docs, where entries live, guess an entry.
  const opened = useKinOpenedKind(props, ready ? openKey : null);
  const taskPage =
    openKey !== null &&
    ready &&
    (kinIsDealKey(openKey) ||
      opened === "task" ||
      (opened === "unknown" && place !== "money" && place !== "docs"));
  const shownTask = useRef<{ readonly key: KinRecordKey; readonly under: string } | null>(null);
  const under = JSON.stringify(record);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focus lives in the DOM: a closed task hands it back to its row
  useEffect(() => {
    const was = shownTask.current;
    shownTask.current = taskPage && openKey !== null ? { key: openKey, under } : null;
    if (was === null || openKey !== null || was.under !== under) return;
    document.querySelector<HTMLElement>(`[data-kin-row="${was.key}"]`)?.focus();
  }, [taskPage, openKey, under]);
  const addTask =
    ready && canAdd
      ? (draft: KinWorkDraft) => {
          setAdding({ type: "task", draft });
          onDialog("new");
        }
      : null;
  const addClient =
    ready && hostClients && canAddClient
      ? (start: KinClientDraftKind) => setAdding({ type: "client", start })
      : null;
  const addLabel = ownerLevel ? KIN_CLIENTS.add : KIN_CLIENTS.addProspect;
  const addProject =
    ready && hostClients && canAddProject ? () => setAdding({ type: "project" }) : null;
  const title = KIN_WORK_HOME.places[place];
  // The host takes a deal from the owner level and a teammate with Clients on, as a prospect.
  const addDeal =
    ready && hostClients && canAddClient
      ? (party: KinWorkRef | null) => setAdding({ type: "deal", party })
      : null;

  const header = (
    <WorkspacePageHeader electron={isElectron}>
      {/* A place is reached from the sidebar, so only a record has a Back. */}
      {(record === null && !taskPage) || wide ? null : (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={taskPage && record !== null ? "Back" : `Back to ${title}`}
          onClick={() => (taskPage ? setOpenKey(null) : open(null))}
        >
          <ArrowLeftIcon />
        </Button>
      )}
      <WorkspaceBreadcrumb ariaLabel={title}>
        <WorkspaceBreadcrumbItem current>
          <h1 className="truncate">
            {record !== null && !wide && !taskPage && "dates" in record
              ? KIN_DATES.title
              : record !== null && !wide && !taskPage && "subscriptions" in record
                ? KIN_SUBSCRIPTIONS.title
                : title}
          </h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {place !== "clients" ||
      !ready ||
      !hostClients ||
      placeRefused ||
      ((record !== null || taskPage) && !wide) ? null : (
        <ToggleGroup
          aria-label={title}
          value={[tab]}
          onValueChange={(value) => {
            const next = kinClientsTabs(canAddClient).find((held) => held.id === value[0]);
            if (next !== undefined) onTab(next.id);
          }}
        >
          {kinClientsTabs(canAddClient).map((held) => (
            <Toggle key={held.id} value={held.id}>
              {held.label}
            </Toggle>
          ))}
        </ToggleGroup>
      )}
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
          ) : place === "clients" && tab === "deals" ? (
            addDeal === null ? null : (
              <Button size="sm" onClick={() => addDeal(null)}>
                <PlusIcon />
                {KIN_DEALS.newDeal}
              </Button>
            )
          ) : place === "clients" && addClient !== null && addProject !== null ? (
            <Menu>
              <MenuTrigger render={<Button size="sm" />}>
                <PlusIcon />
                {KIN_WORK_HOME.add}
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => addClient(ownerLevel ? "client" : "prospect")}>
                  {addLabel}
                </MenuItem>
                {ownerLevel ? (
                  <MenuItem onClick={() => addClient("prospect")}>
                    {KIN_WORK_FORM_COPY.party.prospectTitle}
                  </MenuItem>
                ) : null}
                <MenuItem onClick={addProject}>{KIN_PROJECTS.add}</MenuItem>
                {ownerLevel ? (
                  <MenuItem onClick={() => onDialog("import")}>{KIN_IMPORT.entry}</MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : place === "clients" && (addClient ?? addProject) !== null ? (
            <Button
              size="sm"
              onClick={
                addClient === null
                  ? (addProject ?? undefined)
                  : () => addClient(ownerLevel ? "client" : "prospect")
              }
            >
              <PlusIcon />
              {addClient === null ? KIN_PROJECTS.add : addLabel}
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
            <Button size="sm" variant="outline" onClick={() => onGo("tasks", null, false)}>
              Open tasks
            </Button>
          }
        />
      ) : tab === "deals" ? (
        <KinDealsTab
          {...props}
          directory={directory}
          selected={openKey}
          onOpen={setOpenKey}
          onNew={addDeal === null ? null : () => addDeal(null)}
        />
      ) : tab === "projects" ? (
        <KinWorkProjectsTab
          {...props}
          live={state.live}
          stale={state.stale}
          directory={directory}
          onOpenClient={openClient}
          onOpenProject={openProject}
          onAdd={addProject}
          selected={record !== null && "project" in record ? record.project : null}
        />
      ) : (
        <KinWorkClientsList
          {...props}
          live={state.live}
          stale={state.stale}
          directory={directory}
          onOpen={openClient}
          onAdd={addClient}
          selected={record !== null && "party" in record ? record.party : null}
        />
      );
    return (
      <KinWorkTaskList
        // Opened from a client or a person, the list starts over narrowed to them.
        key={
          narrowed.party?.key ?? (narrowed.owner === null ? "all" : JSON.stringify(narrowed.owner))
        }
        {...props}
        live={state.live}
        stale={state.stale}
        directory={directory}
        changes={changes}
        openKey={openKey}
        onOpen={setOpenKey}
        onOpenProject={openProject}
        onAdd={addTask === null ? null : () => addTask(KIN_WORK_NO_DRAFT)}
        initial={narrowed}
        choices={hostClients ? choices : null}
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
          onGo={fromRecord.open}
          linkTo={(section) => docLink(shown.doc, section)}
          onOpenKey={setOpenKey}
          onOpenClient={openClient}
          onOpenProject={openProject}
        />
      );
    if ("subscriptions" in shown)
      return (
        <KinSubscriptionsPage
          {...props}
          live={state.live}
          stale={state.stale}
          directory={directory}
          onOpenKey={fromRecord.task}
        />
      );
    if ("dates" in shown)
      return (
        <KinWorkDates
          {...props}
          live={state.live}
          stale={state.stale}
          directory={directory}
          onOpenKey={fromRecord.task}
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
          onOpenKey={fromRecord.task}
          onGone={() => onGo("docs", null, false)}
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
          onOpenTask={fromRecord.task}
          onOpenClient={fromRecord.party}
          onOpenProject={fromRecord.project}
          onOpenDoc={fromRecord.doc}
          onSeeAll={(party) => {
            setNarrowed({ ...KIN_WORK_DEFAULT_FILTER, party });
            onGo("tasks", null, false);
          }}
          onAddTask={addTask}
          onOpenList={fromRecord.list}
          onNewDeal={addDeal}
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
        onOpenTask={fromRecord.task}
        onOpenClient={fromRecord.party}
        onOpenProject={fromRecord.project}
        onOpenDoc={fromRecord.doc}
        onAddTask={addTask}
        onOpenList={fromRecord.list}
      />
    );
  };

  const task = (
    key: KinRecordKey,
    frame: "sheet" | "pane" | "page",
    go: ReturnType<typeof opens>,
  ) =>
    kinIsDealKey(key) ? (
      <KinDealPage
        key={key}
        {...props}
        dealKey={key}
        frame={frame}
        directory={directory}
        onOpenTask={go.task}
        onOpenClient={go.party}
        onStartProject={
          addProject === null || !ownerLevel
            ? null
            : (party) => setAdding({ type: "project", party })
        }
        onClose={() => setOpenKey(null)}
      />
    ) : (
      <KinWorkItemSheet
        // A fresh panel per task, so one task's hand-over never shows on another.
        key={key}
        {...props}
        itemKey={key}
        frame={frame}
        directory={directory}
        changes={changes}
        choices={hostClients ? choices : null}
        onOpenKey={go.task}
        onOpenClient={go.party}
        onOpenProject={go.project}
        onOpenDoc={(doc) => go.doc(doc)}
        onClose={() => setOpenKey(null)}
      />
    );
  const opening = record !== null || taskPage;
  // Import a file takes the Clients place over while it is open; the host decides who may.
  const importing = dialog === "import" && place === "clients" && ownerLevel && hostClients;

  // A doc on a narrow window is the whole page, under its own header with its own way back.
  const docAlone = record !== null && "doc" in record && !wide && !taskPage;
  return (
    <>
      {docAlone ? null : header}
      {state._tag === "refused" ? (
        <KinWorkNotice {...kinWorkOnlyOwner(place)} />
      ) : placeRefused && !opening ? (
        <KinWorkNotice {...(place === "money" ? KIN_MONEY.onlyOwner : kinWorkOnlyOwner(place))} />
      ) : state._tag === "offline" ? (
        <KinWorkNotice {...kinWorkOffline(place)} />
      ) : state._tag === "failed" ? (
        <KinLoadFailed
          what={KIN_WORK_LOAD_FAILED}
          cause={null}
          onRetry={() => {
            retryKinAccess(props.environmentId);
            appAtomRegistry.refresh(kinWorkLiveAtom(props));
          }}
          className="mx-auto w-full max-w-3xl p-4"
        />
      ) : state._tag === "loading" ? (
        <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label={`Loading ${title}`}>
          <KinWorkRowSkeletons />
        </div>
      ) : importing ? (
        <KinImportView {...props} directory={directory.names} onOpenDeals={() => onTab("deals")} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* A record under a place taken away says for itself that it isn't theirs; no list beside it. */}
          {opening && (!wide || placeRefused) ? null : (
            <div
              className={
                !opening
                  ? "flex min-h-0 min-w-0 flex-1 flex-col"
                  : "flex min-h-0 w-96 shrink-0 flex-col border-e border-border"
              }
            >
              {placeList()}
            </div>
          )}
          {!opening ? null : (
            <section
              aria-label={
                record !== null && !taskPage && place === "money" && "list" in record
                  ? KIN_MONEY.title
                  : title
              }
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {/* The record stays mounted under a task opened from it, so closing the task costs no read. */}
              {record === null ? null : (
                <div className={taskPage ? "hidden" : "flex min-h-0 min-w-0 flex-1 flex-col"}>
                  {recordView(record)}
                </div>
              )}
              {taskPage && openKey !== null
                ? task(openKey, wide ? "pane" : "page", fromRecord)
                : null}
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
      {openKey === null || !ready || taskPage ? null : task(openKey, "sheet", fromList)}
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
          start={adding.start}
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
      ) : adding?.type === "deal" ? (
        <KinDealNewDialog
          {...props}
          party={adding.party}
          choices={choices}
          directory={directory}
          onAdded={(key) => {
            setAdding(null);
            setOpenKey(key);
          }}
          onClose={() => setAdding(null)}
        />
      ) : adding?.type === "project" ? (
        <KinProjectDialog
          {...props}
          editing={null}
          party={adding.party ?? null}
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
