import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_DEFAULT_FILTER,
  KIN_WORK_NEW,
  KIN_WORK_STALE,
  kinWorkDraftFor,
  type KinWorkDraft,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_PROJECTS,
  KIN_PROJECT_FAILED,
  KIN_PROJECT_GONE,
  KIN_PROJECT_VIEWS,
  kinProjectPageView,
  kinProjectRow,
  kinProjectsNothing,
  type KinProjectRowView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { kinWorkSend, type KinWorkFormProblem } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinProjectPage, KinProjectState, KinRecordKey } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { EllipsisIcon, ExternalLinkIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { KinWorkProjectRow } from "./KinWorkClients";
import { KinProjectDialog } from "./KinWorkForms";
import {
  KinWorkHealthBadge,
  KinWorkNotice,
  KinWorkPrivateMark,
  KinWorkProblem,
  KinWorkRowSkeletons,
  KinWorkSection,
  KinWorkTimeline,
} from "./KinWorkParts";
import { KinWorkRow, KinWorkTaskList } from "./KinWorkTasks";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { kinHostConnected } from "./useKinHost";
import {
  useKinProjectPage,
  useKinProjectsList,
  type KinWorkChangesHandle,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

/** Every project with how it is going, as the host works it out. */
export function KinWorkProjectsList(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly onOpen: (key: KinRecordKey) => void;
    readonly onAdd: (() => void) | null;
  },
) {
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const { state, list } = useKinProjectsList(props, props.stale ? null : props.live.seq);
  const { filter } = state;
  const rows = state.records.map((row) => kinProjectRow(row, names, now));
  const nothing = kinProjectsNothing(filter);
  return (
    <LegendList<KinProjectRowView>
      data={rows}
      keyExtractor={(row) => row.key}
      extraData={state}
      recycleItems
      onEndReached={() => void list.loadMore()}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-1">
          {props.stale || state.stale ? (
            <p role="status" className="text-xs text-muted-foreground">
              {KIN_WORK_STALE}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <ToggleGroup
              variant="pill"
              size="sm"
              aria-label="Show"
              value={[filter.view]}
              onValueChange={(value) => {
                const view = KIN_PROJECT_VIEWS.find((held) => held.id === value[0]);
                if (view !== undefined) list.setFilter({ ...filter, view: view.id });
              }}
            >
              {KIN_PROJECT_VIEWS.map((view) => (
                <Toggle key={view.id} value={view.id}>
                  {view.label}
                </Toggle>
              ))}
            </ToggleGroup>
            <div className="min-w-0 flex-1">
              <Input
                type="search"
                aria-label={KIN_PROJECTS.search}
                placeholder={KIN_PROJECTS.search}
                value={filter.text}
                onChange={(event) => list.setFilter({ ...filter, text: event.currentTarget.value })}
              />
            </div>
          </div>
        </div>
      }
      ListEmptyComponent={
        <div className="mx-auto w-full max-w-3xl px-4">
          {state.loading ? (
            <div role="status" aria-label="Loading projects">
              <KinWorkRowSkeletons />
            </div>
          ) : state.failed !== null ? (
            <div className="flex flex-col items-start gap-3 py-4">
              <Alert variant="error">
                <AlertDescription>
                  {KIN_PROJECTS.loadFailed}. Check your connection.
                </AlertDescription>
              </Alert>
              <Button size="sm" variant="outline" onClick={list.refresh}>
                Retry
              </Button>
            </div>
          ) : (
            <KinWorkNotice
              title={nothing.title}
              detail={nothing.detail}
              {...(nothing.offerNew && props.onAdd !== null
                ? {
                    action: (
                      <Button onClick={props.onAdd}>
                        <PlusIcon />
                        {KIN_PROJECTS.add}
                      </Button>
                    ),
                  }
                : {})}
            />
          )}
        </div>
      }
      ListFooterComponent={
        !state.more ? null : (
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3">
            <p className="text-xs text-muted-foreground" role="status">
              {state.moreFailed
                ? "Couldn't load more."
                : `Showing ${rows.length} of ${state.total ?? rows.length}`}
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={state.loadingMore}
              aria-busy={state.loadingMore}
              onClick={() => void list.loadMore()}
            >
              {state.moreFailed ? "Try again" : "Show more"}
            </Button>
          </div>
        )
      }
      renderItem={({ item: row }) => (
        <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4 py-1">
          <KinWorkProjectRow row={row} onOpen={() => props.onOpen(row.key)} />
        </div>
      )}
      estimatedItemSize={56}
      drawDistance={640}
      className={cn("min-h-0 flex-1 overscroll-contain pb-6", state.refreshing && "opacity-70")}
    />
  );
}

type PageProps = KinWorkTarget & {
  readonly projectKey: KinRecordKey;
  readonly live: KinWorkLive;
  readonly stale: boolean;
  readonly directory: KinWorkDirectory;
  readonly changes: KinWorkChangesHandle;
  readonly choices: KinWorkChoices;
  readonly openKey: KinRecordKey | null;
  readonly onOpenTask: (key: KinRecordKey) => void;
  readonly onOpenClient: (key: KinRecordKey) => void;
  readonly onOpenProject: (key: KinRecordKey) => void;
  /** Opens the new-task form already in this project; null where tasks can't be added. */
  readonly onAddTask: ((draft: KinWorkDraft) => void) | null;
};

/** One project: how it is going and why, what is stuck, what is next, and its tasks. */
export function KinWorkProjectPage(props: PageProps) {
  const { state, refresh } = useKinProjectPage(props, props.projectKey);
  if (state._tag === "loading")
    return (
      <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label="Loading project">
        <KinWorkRowSkeletons />
      </div>
    );
  if (state._tag === "gone") return <KinWorkNotice {...KIN_PROJECT_GONE} />;
  if (state._tag === "refused" || state._tag === "failed")
    return (
      <KinWorkNotice
        {...KIN_PROJECT_FAILED}
        action={
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        }
      />
    );
  return <ProjectPage {...props} page={state.value} pageStale={state.stale} onRefresh={refresh} />;
}

function ProjectPage(
  props: PageProps & {
    readonly page: KinProjectPage;
    readonly pageStale: boolean;
    readonly onRefresh: () => void;
  },
) {
  const { environmentId, orgId, page } = props;
  const { names } = props.directory;
  const canChange = useAtomValue(kinClient.workProjectUpdate.permissionAtom(environmentId));
  const update = useAtomCommand(kinClient.workProjectUpdate, { reportFailure: false });
  const now = new Date(useNowMinuteMs());
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const privateId = useId();
  const view = kinProjectPageView(page, names, now);
  const { party } = view;
  const change = async (input: {
    readonly state?: KinProjectState;
    readonly sensitive?: boolean;
  }) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        update({ environmentId, input: { orgId, key: view.key, rev: view.rev, ...input } }),
      noun: "project",
      name: view.name,
      own: view.key,
    });
    setBusy(false);
    if (outcome.ok) props.onRefresh();
    else {
      setProblem(outcome.problem);
      if (outcome.problem.kind === "conflict") props.onRefresh();
    }
  };
  const addTask =
    props.onAddTask === null || view.closed !== null
      ? null
      : () => props.onAddTask?.(kinWorkDraftFor({ party, project: view.ref }));
  const summary = (
    <div className="flex flex-col gap-6 pb-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-medium text-foreground">{view.name}</h2>
              {view.health === null ? null : <KinWorkHealthBadge health={view.health} />}
              {view.closed === null ? null : (
                <span className="text-sm text-muted-foreground">{view.closed}</span>
              )}
              {view.privacy.private ? <KinWorkPrivateMark /> : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {party === null ? null : (
                <>
                  <button
                    type="button"
                    onClick={() => props.onOpenClient(party.key)}
                    className="rounded-sm underline-offset-2 outline-none ring-ring hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset"
                  >
                    {party.title}
                  </button>
                  {" · "}
                </>
              )}
              {view.target}
              {view.ledBy === null ? null : ` · ${view.ledBy}`}
            </p>
          </div>
          {canChange ? (
            <div className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                <PencilIcon />
                {KIN_PROJECTS.edit}
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button size="icon-sm" variant="ghost" aria-label="More" disabled={busy} />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  {view.closed === null ? (
                    <>
                      <MenuItem onClick={() => void change({ state: "done" })}>
                        {KIN_PROJECTS.done}
                      </MenuItem>
                      <MenuItem
                        variant="destructive"
                        onClick={() => void change({ state: "dropped" })}
                      >
                        {KIN_PROJECTS.drop}
                      </MenuItem>
                    </>
                  ) : (
                    <MenuItem onClick={() => void change({ state: "open" })}>
                      {KIN_PROJECTS.reopen}
                    </MenuItem>
                  )}
                </MenuPopup>
              </Menu>
            </div>
          ) : null}
        </div>
        {view.why.length === 0 ? null : (
          <p className="text-sm text-foreground">{view.why.join(" ")}</p>
        )}
        <p className="text-xs text-muted-foreground tabular-nums">{view.counts}</p>
        {props.pageStale ? (
          <p role="status" className="text-xs text-muted-foreground">
            {KIN_WORK_STALE}
          </p>
        ) : null}
        {problem === null ? null : (
          <KinWorkProblem problem={problem} onOpenExisting={props.onOpenProject} />
        )}
      </div>
      {view.blocked.length === 0 ? null : (
        <KinWorkSection title={KIN_PROJECTS.blocked}>
          <ul className="-mx-2 flex flex-col">
            {view.blocked.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={() => props.onOpenTask(row.key)}
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <span className="line-clamp-2 text-sm text-foreground">{row.title}</span>
                  <span className="text-xs text-muted-foreground">{row.line}</span>
                </button>
              </li>
            ))}
          </ul>
        </KinWorkSection>
      )}
      {view.nextDue === null ? null : (
        <KinWorkSection title={KIN_PROJECTS.nextDue}>
          <KinWorkRow
            row={view.nextDue}
            saving={false}
            onOpen={() => {
              if (view.nextDue !== null) props.onOpenTask(view.nextDue.key);
            }}
            onAct={null}
          />
        </KinWorkSection>
      )}
      {view.pullRequests.length === 0 ? null : (
        <KinWorkSection title={KIN_PROJECTS.pullRequests}>
          <ul className="-mx-2 flex flex-col">
            {view.pullRequests.map((pull) => {
              const content = (
                <>
                  <PullRequestGlyph.pullRequest
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="shrink-0 text-foreground">{pull.label}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {pull.title}
                  </span>
                </>
              );
              const row =
                "flex min-h-9 w-full items-center gap-3 rounded-md px-2 py-1.5 text-start text-sm outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";
              return (
                <li key={pull.key}>
                  {pull.href === null ? (
                    <button
                      type="button"
                      className={row}
                      onClick={() => props.onOpenTask(pull.task)}
                    >
                      {content}
                    </button>
                  ) : (
                    <a href={pull.href} target="_blank" rel="noreferrer" className={row}>
                      {content}
                      <ExternalLinkIcon
                        aria-hidden
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </KinWorkSection>
      )}
      <KinWorkSection title={KIN_PROJECTS.changed}>
        {view.changed.length === 0 ? (
          <p className="text-sm text-muted-foreground">{KIN_PROJECTS.nothingChanged}</p>
        ) : (
          <KinWorkTimeline lines={view.changed} onOpenTask={props.onOpenTask} />
        )}
        {view.changedMore === null ? null : (
          <p className="text-xs text-muted-foreground">{view.changedMore}</p>
        )}
      </KinWorkSection>
      {view.repos.length === 0 ? null : (
        <KinWorkSection title={KIN_PROJECTS.repos}>
          <p className="text-sm text-foreground">{view.repos.join(", ")}</p>
        </KinWorkSection>
      )}
      {view.notes === null ? null : (
        <KinWorkSection title={KIN_PROJECTS.notes}>
          <p className="whitespace-pre-wrap text-sm text-foreground">{view.notes}</p>
        </KinWorkSection>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Label htmlFor={privateId}>{KIN_PROJECTS.privateLabel}</Label>
          <p className="text-xs text-muted-foreground">{view.privacy.note}</p>
        </div>
        <Switch
          id={privateId}
          checked={view.privacy.private}
          // Its client keeps it private whatever its own label says, so there is nothing to change.
          disabled={!canChange || busy || view.privacy.inherited}
          onCheckedChange={(checked) => void change({ sensitive: checked })}
        />
      </div>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{KIN_PROJECTS.tasks}</h3>
        {addTask === null ? null : (
          <Button size="xs" variant="ghost" onClick={addTask}>
            <PlusIcon />
            {KIN_WORK_NEW}
          </Button>
        )}
      </div>
    </div>
  );
  return (
    <>
      <KinWorkTaskList
        environmentId={environmentId}
        orgId={orgId}
        live={props.live}
        stale={props.stale}
        directory={props.directory}
        changes={props.changes}
        openKey={props.openKey}
        onOpen={props.onOpenTask}
        onAdd={addTask}
        initial={{ ...KIN_WORK_DEFAULT_FILTER, project: view.ref }}
        within="project"
        choices={null}
        header={summary}
      />
      {editing ? (
        <KinProjectDialog
          environmentId={environmentId}
          orgId={orgId}
          editing={{ project: page.project, targetDay: view.targetDay }}
          party={null}
          choices={props.choices}
          onSaved={() => {
            setEditing(false);
            props.onRefresh();
          }}
          onOpenExisting={(key) => {
            setEditing(false);
            props.onOpenProject(key);
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}
