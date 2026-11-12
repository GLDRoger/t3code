import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_DEFAULT_FILTER,
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  KIN_WORK_NO_DRAFT,
  KIN_WORK_OFFLINE,
  KIN_WORK_ONLY_OWNER,
  KIN_WORK_TITLE,
  kinWorkEntrySummary,
  kinWorkHostClients,
  kinWorkHostEdits,
  type KinWorkDraft,
  type KinWorkFilter,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_CLIENTS,
  KIN_CLIENTS_OLDER_HOST,
  KIN_PROJECTS,
  KIN_WORK_AREAS,
  type KinWorkArea,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import type { KinRecordKey } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ListChecksIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { isElectron } from "../env";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { KinDocPage, type KinDocWhere } from "./KinDocPage";
import { KinDocsList } from "./KinDocsList";
import { KinSearchDialog } from "./KinSearchDialog";
import { KinWorkClientPage, KinWorkClientsList } from "./KinWorkClients";
import { KinClientDialog, KinProjectDialog } from "./KinWorkForms";
import { KinWorkItemSheet } from "./KinWorkItemSheet";
import { KinWorkNewDialog } from "./KinWorkNewDialog";
import { KinWorkNotice, KinWorkRowSkeletons } from "./KinWorkParts";
import { KinWorkProjectPage, KinWorkProjectsList } from "./KinWorkProjects";
import { KinWorkTaskList } from "./KinWorkTasks";
import { kinClient } from "./kinClient";
import {
  kinWorkLiveAtom,
  useKinWork,
  useKinWorkChanges,
  useKinWorkChoices,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

/** The way in from the chat list, for the owner only. Its second line says what needs a look. */
export function KinWorkEntry(
  props: KinWorkTarget & { readonly active: boolean; readonly onOpen: () => void },
) {
  const { environmentId, orgId } = props;
  const state = useKinWork(props);
  // A teammate, or a host that couldn't be read: no way in rather than a dead one.
  if (state._tag === "refused" || state._tag === "failed") return null;
  return (
    <Link
      to="/kin/$environmentId/$orgId/work"
      params={{ environmentId, orgId }}
      aria-current={props.active ? "page" : undefined}
      data-active={props.active}
      onClick={props.onOpen}
      className="flex items-center gap-2.5 rounded-md px-2 py-2 outline-none ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[active=true]:bg-sidebar-row-selected"
    >
      <span className="flex size-10 shrink-0 items-center justify-center text-sidebar-muted-foreground">
        <ListChecksIcon aria-hidden className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-sidebar-foreground">
          {KIN_WORK_TITLE}
        </span>
        <span className="truncate text-xs text-sidebar-muted-foreground">
          {kinWorkEntrySummary(state._tag === "ready" ? state.live.summary : null)}
        </span>
      </span>
    </Link>
  );
}

/** Which part of Work is on screen: one of its four lists, or one client, project or doc. */
export type KinWorkWhere =
  | { readonly area: KinWorkArea }
  | { readonly party: KinRecordKey }
  | { readonly project: KinRecordKey }
  | KinDocWhere;

const AREA_TITLE: Record<KinWorkArea, string> = {
  tasks: KIN_WORK_TITLE,
  clients: KIN_CLIENTS.title,
  projects: KIN_PROJECTS.title,
  docs: "Docs",
};

type Adding =
  | { readonly type: "task"; readonly draft: KinWorkDraft }
  | { readonly type: "client" }
  | { readonly type: "project" }
  | null;

/**
 * Everything someone owes someone: tasks and who has them, the clients they are owed to, and the
 * projects they belong to.
 */
export function KinWorkView({
  where,
  onGo,
  openKey,
  onOpenKey: setOpenKey,
  docLink,
  ...props
}: KinWorkTarget & {
  readonly where: KinWorkWhere;
  readonly onGo: (where: KinWorkWhere) => void;
  readonly openKey: KinRecordKey | null;
  readonly onOpenKey: (key: KinRecordKey | null) => void;
  /** The address of a doc, or one section of it, for Copy link. */
  readonly docLink: (doc: KinRecordKey, section: string | null) => string;
}) {
  const { environmentId } = props;
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
  const [adding, setAdding] = useState<Adding>(null);
  const [searching, setSearching] = useState(false);
  // Where the task list starts when it is opened from a client: narrowed to that client.
  const [narrowed, setNarrowed] = useState<KinWorkFilter>(KIN_WORK_DEFAULT_FILTER);

  const area: KinWorkArea =
    "area" in where
      ? where.area
      : "party" in where
        ? "clients"
        : "project" in where
          ? "projects"
          : "docs";
  const onPage = !("area" in where);
  const addTask =
    ready && canAdd ? (draft: KinWorkDraft) => setAdding({ type: "task", draft }) : null;
  const add =
    !ready || onPage
      ? null
      : area === "tasks"
        ? addTask === null
          ? null
          : { label: KIN_WORK_NEW, run: () => addTask(KIN_WORK_NO_DRAFT) }
        : !hostClients || area === "docs"
          ? null
          : area === "clients"
            ? canAddClient
              ? { label: KIN_CLIENTS.add, run: () => setAdding({ type: "client" }) }
              : null
            : canAddProject
              ? { label: KIN_PROJECTS.add, run: () => setAdding({ type: "project" }) }
              : null;
  const openClient = (key: KinRecordKey) => onGo({ party: key });
  const openProject = (key: KinRecordKey) => onGo({ project: key });
  const openDoc = (doc: KinRecordKey, section?: string) =>
    onGo(section === undefined ? { doc } : { doc, section });
  const search = !searching ? null : (
    <KinSearchDialog
      {...props}
      onClose={() => setSearching(false)}
      onOpen={(hit) => {
        setSearching(false);
        if (hit.kind === "docs") openDoc(hit.key, hit.section?.id);
        else if (hit.kind === "clients") openClient(hit.key);
        else if (hit.kind === "projects") openProject(hit.key);
        // A contact has no page of its own; its entry lists who it is with.
        else setOpenKey(hit.key);
      }}
    />
  );
  // A doc is its own page, with its own header: it reads the same whoever may open Work.
  if ("doc" in where)
    return (
      <>
        <KinDocPage
          key={where.doc}
          {...props}
          where={where}
          directory={directory}
          onGo={(next) => onGo(next ?? { area: "docs" })}
          linkTo={(section) => docLink(where.doc, section)}
        />
        {search}
      </>
    );
  return (
    <>
      <WorkspacePageHeader electron={isElectron}>
        {onPage ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Back to ${AREA_TITLE[area]}`}
            className="md:hidden"
            onClick={() => onGo({ area })}
          >
            <ArrowLeftIcon />
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Back to chats"
            className="md:hidden"
            render={<Link to="/kin" />}
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <WorkspaceBreadcrumb ariaLabel={KIN_WORK_TITLE}>
          {onPage ? (
            <>
              <WorkspaceBreadcrumbItem>
                <Button size="xs" variant="ghost" onClick={() => onGo({ area: "tasks" })}>
                  {KIN_WORK_TITLE}
                </Button>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem>
                <Button size="xs" variant="ghost" onClick={() => onGo({ area })}>
                  {AREA_TITLE[area]}
                </Button>
              </WorkspaceBreadcrumbItem>
            </>
          ) : (
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">{KIN_WORK_TITLE}</h1>
            </WorkspaceBreadcrumbItem>
          )}
        </WorkspaceBreadcrumb>
        {!ready ? null : (
          <div className="ms-auto flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Search Work"
              onClick={() => setSearching(true)}
            >
              <SearchIcon />
            </Button>
            {add === null ? null : (
              <Button size="sm" onClick={add.run}>
                <PlusIcon />
                {add.label}
              </Button>
            )}
          </div>
        )}
      </WorkspacePageHeader>
      {state._tag === "refused" ? (
        <KinWorkNotice {...KIN_WORK_ONLY_OWNER} />
      ) : state._tag === "offline" ? (
        <KinWorkNotice {...KIN_WORK_OFFLINE} />
      ) : state._tag === "failed" ? (
        <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 p-4">
          <Alert variant="error">
            <AlertDescription>{KIN_WORK_LOAD_FAILED}. Check your connection.</AlertDescription>
          </Alert>
          <Button
            size="sm"
            variant="outline"
            onClick={() => appAtomRegistry.refresh(kinWorkLiveAtom(props))}
          >
            Retry
          </Button>
        </div>
      ) : state._tag === "loading" ? (
        <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label="Loading Work">
          <KinWorkRowSkeletons />
        </div>
      ) : (
        <>
          {hostClients && !onPage ? (
            <div className="mx-auto w-full max-w-3xl px-4 pt-3">
              <ToggleGroup
                aria-label={KIN_WORK_TITLE}
                value={[area]}
                onValueChange={(value) => {
                  const next = KIN_WORK_AREAS.find((held) => held.id === value[0]);
                  if (next !== undefined) onGo({ area: next.id });
                }}
              >
                {KIN_WORK_AREAS.map((held) => (
                  <Toggle key={held.id} value={held.id}>
                    {held.label}
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
          ) : null}
          {area !== "tasks" && !hostClients ? (
            <KinWorkNotice
              {...KIN_CLIENTS_OLDER_HOST}
              action={
                <Button size="sm" variant="outline" onClick={() => onGo({ area: "tasks" })}>
                  Open tasks
                </Button>
              }
            />
          ) : "party" in where ? (
            <KinWorkClientPage
              // A fresh page per client, so one client's dialogs never show on another.
              key={where.party}
              {...props}
              clientKey={where.party}
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
                onGo({ area: "tasks" });
              }}
              onAddTask={addTask}
            />
          ) : "project" in where ? (
            <KinWorkProjectPage
              key={where.project}
              {...props}
              projectKey={where.project}
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
            />
          ) : area === "docs" ? (
            <KinDocsList {...props} directory={directory} stale={state.stale} onOpen={openDoc} />
          ) : area === "clients" ? (
            <KinWorkClientsList
              {...props}
              live={state.live}
              stale={state.stale}
              directory={directory}
              onOpen={openClient}
              onAdd={add?.run ?? null}
            />
          ) : area === "projects" ? (
            <KinWorkProjectsList
              {...props}
              live={state.live}
              stale={state.stale}
              directory={directory}
              onOpen={openProject}
              onAdd={add?.run ?? null}
            />
          ) : (
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
              onAdd={add?.run ?? null}
              initial={narrowed}
              choices={hostClients ? choices : null}
            />
          )}
        </>
      )}
      {search}
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
          onClose={() => setOpenKey(null)}
        />
      )}
      {adding?.type === "task" ? (
        <KinWorkNewDialog
          {...props}
          directory={directory}
          choices={hostClients ? choices : null}
          start={adding.draft}
          onAdded={(key) => {
            setAdding(null);
            // Added from a client or project, it shows up there: the page stays put.
            if (!onPage) setOpenKey(key);
          }}
          onClose={() => setAdding(null)}
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
