import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_DEFAULT_FILTER,
  KIN_WORK_NEW,
  kinWorkDraftFor,
  type KinWorkDraft,
} from "@t3tools/client-runtime/kin/kinWork";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_PROJECTS,
  KIN_PROJECT_FAILED,
  KIN_PROJECT_REFUSED,
  KIN_PROJECT_GONE,
  KIN_PROJECT_LEAD,
  kinCampaignResultOpens,
  kinProjectLeadChoices,
  kinProjectPageView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { kinWorkSend, type KinWorkFormProblem } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { KinCampaignResultId } from "@t3tools/client-runtime/kin/kinMarketing";
import type { KinListOpen } from "@t3tools/client-runtime/kin/kinMoney";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type {
  KinPersonId,
  KinProjectPage,
  KinProjectState,
  KinRecordKey,
  KinWorkPrincipal,
} from "@t3tools/contracts";
import { EllipsisIcon, ExternalLinkIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Button } from "../components/ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Radio, RadioGroup } from "../components/ui/radio-group";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Switch } from "../components/ui/switch";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAskRecord } from "./KinAskRecord";
import { KinAsideNote, KinAttentionSection } from "./KinAttention";
import { KinDocsUnder } from "./KinDocsList";
import { KinProjectNoteSection } from "./KinProjectNote";
import { KinProjectPeopleSection } from "./KinProjectPeople";
import { KinMilestoneDialog, KinProjectDialog } from "./KinWorkForms";
import { KinCampaignDealsDialog } from "./KinDeals";
import { KinCampaignResultsSection, KinContactListDialog } from "./KinMarketing";
import { useKinSectionOn, useKinShell } from "./useKinShell";
import { KinWorkClientsList } from "./KinWorkClients";
import {
  KinWorkHealthBadge,
  KinWorkNotice,
  KinLoadFailed,
  KinWorkPrivateMark,
  KinWorkProblem,
  KinWorkRowSkeletons,
  KinWorkSection,
  KinWorkTimeline,
  KinWorkStaleLine,
} from "./KinWorkParts";
import { KinWorkPlaceLists } from "./KinWorkPlaceLists";
import { KinWorkRow, KinWorkTaskList } from "./KinWorkTasks";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { kinHostConnected } from "./useKinHost";
import { useKinOpensClients } from "./useKinOwnerLevel";
import {
  useKinProjectPage,
  type KinWorkChangesHandle,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

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
  readonly onOpenDoc: (key: KinRecordKey) => void;
  /** Opens the new-task form already in this project; null where tasks can't be added. */
  readonly onAddTask:
    | ((draft: KinWorkDraft) => void)
    | null /** Opens one of the lists agents set up, narrowed to this project. */;
  readonly onOpenList: (open: KinListOpen) => void;
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
  if (state._tag === "refused") return <KinWorkNotice {...KIN_PROJECT_REFUSED} />;
  if (state._tag === "failed")
    return (
      <KinLoadFailed
        what={KIN_PROJECT_FAILED.title}
        cause={state.cause}
        onRetry={refresh}
        className="mx-auto w-full max-w-3xl p-4"
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
  const opensClients = useKinOpensClients(props.environmentId);
  const { environmentId, orgId, page } = props;
  const { names } = props.directory;
  const canChange = useAtomValue(kinClient.workProjectUpdate.permissionAtom(environmentId));
  const canNote = useAtomValue(kinClient.workProjectNote.permissionAtom(environmentId));
  const dealsOn = useKinSectionOn(environmentId, "deals");
  const update = useAtomCommand(kinClient.workProjectUpdate, { reportFailure: false });
  const now = new Date(useNowMinuteMs());
  const [editing, setEditing] = useState(false);
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosingLead, setChoosingLead] = useState(false);
  const [openResult, setOpenResult] = useState<KinCampaignResultId | null>(null);
  const privateId = useId();
  const view = kinProjectPageView(page, names, now, useKinShell(props.environmentId));
  const { party } = view;
  const opened =
    openResult === null ? null : kinCampaignResultOpens(orgId, view.key, view.name, openResult);
  const change = async (input: {
    readonly state?: KinProjectState;
    readonly sensitive?: boolean;
    readonly owner?: KinWorkPrincipal;
  }) => {
    if (busy) return false;
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
    return outcome.ok;
  };
  // A project's lead adds its milestones too; the host checks they still lead it.
  const leads =
    view.lead.personId !== null &&
    view.lead.personId === kinFeedViewer(props.directory.orgs, orgId).personId;
  const addsMilestone = (canChange || leads) && view.closed === null;
  const addTask =
    props.onAddTask === null || view.closed !== null
      ? null
      : () => props.onAddTask?.(kinWorkDraftFor({ party, project: view.ref }));
  const summary = (
    <div className="flex flex-col gap-6 pb-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start gap-2">
          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-medium text-foreground">{view.name}</h2>
              {view.health === null ? null : <KinWorkHealthBadge health={view.health} />}
              {view.closed === null ? null : (
                <span className="text-sm text-muted-foreground">{view.closed}</span>
              )}
              {view.privacy.private ? <KinWorkPrivateMark /> : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {party === null ? null : !opensClients ? (
                // Someone the host keeps Clients from sees the name, with nowhere to go.
                `${party.title} · `
              ) : (
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
              {view.kind === null ? null : `${view.kind} · `}
              {view.target}
              {view.ledBy === null ? null : ` · ${view.ledBy}`}
            </p>
            {view.terms === null ? null : (
              <p className="text-sm text-muted-foreground">{view.terms}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <KinAskRecord
              environmentId={environmentId}
              orgId={orgId}
              record={{ key: view.key, title: view.name }}
              disabled={busy}
            />
            {canChange ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
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
              </>
            ) : null}
          </div>
        </div>
        {view.why.length === 0 ? null : (
          <p className="text-sm text-foreground">{view.why.join(" ")}</p>
        )}
        <p className="text-xs text-muted-foreground tabular-nums">{view.counts}</p>
        {props.pageStale ? (
          <KinWorkStaleLine environmentId={environmentId} onRetry={props.onRefresh} />
        ) : null}
        {problem === null ? null : (
          <KinWorkProblem problem={problem} onOpenExisting={props.onOpenProject} />
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-xs font-medium text-muted-foreground">{KIN_PROJECT_LEAD.title}</h3>
          <p className="truncate text-sm text-foreground">{view.lead.name}</p>
        </div>
        {canChange ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setChoosingLead(true)}>
            {KIN_PROJECT_LEAD.change}
          </Button>
        ) : null}
      </div>
      {page.results === undefined ? null : (
        <KinCampaignResultsSection
          results={page.results}
          audience={view.audience}
          deals={dealsOn}
          onOpen={setOpenResult}
        />
      )}
      {page.can?.note === undefined ? null : (
        <KinProjectNoteSection
          environmentId={environmentId}
          orgId={orgId}
          projectKey={view.key}
          note={page.note ?? null}
          canEdit={page.can.note && canNote}
          onChanged={props.onRefresh}
        />
      )}
      <KinAsideNote environmentId={environmentId} orgId={orgId} record={view.key} names={names} />
      <KinAttentionSection
        environmentId={environmentId}
        orgId={orgId}
        scope={{ type: "project", key: view.key }}
        names={names}
        onOpen={(to) => {
          if (to.type === "record") props.onOpenTask(to.key);
        }}
      />
      {view.specChanged.length === 0 ? null : (
        <KinWorkSection title={KIN_PROJECTS.specChanged}>
          <ul className="-mx-2 flex flex-col">
            {view.specChanged.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={() => props.onOpenTask(row.key)}
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <span className="line-clamp-2 text-sm text-foreground">{row.title}</span>
                  <span className="text-xs text-warning-foreground">{row.line}</span>
                </button>
              </li>
            ))}
          </ul>
        </KinWorkSection>
      )}
      <KinWorkSection
        title={KIN_PROJECTS.milestones}
        action={
          addsMilestone ? (
            <Button size="xs" variant="ghost" onClick={() => setAddingMilestone(true)}>
              <PlusIcon />
              {KIN_PROJECTS.addMilestone}
            </Button>
          ) : null
        }
      >
        {view.milestones.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {addsMilestone ? KIN_PROJECTS.noMilestonesAdd : KIN_PROJECTS.noMilestones}
          </p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {view.milestones.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={() => props.onOpenTask(row.key)}
                  className="flex w-full flex-col gap-1.5 rounded-md px-2 py-2 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {row.title}
                    </span>
                    {row.badge === null ? null : (
                      <span
                        className={
                          row.tone === "late"
                            ? "shrink-0 text-xs font-medium text-destructive-foreground"
                            : row.tone === "at_risk"
                              ? "shrink-0 text-xs font-medium text-warning-foreground"
                              : "shrink-0 text-xs text-muted-foreground"
                        }
                      >
                        {row.badge}
                      </span>
                    )}
                  </span>
                  <span aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${Math.round(row.progress * 100)}%` }}
                    />
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">{row.line}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </KinWorkSection>
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
      {view.money.length === 0 ? null : (
        <KinWorkSection
          title={KIN_PROJECTS.money}
          fold={{ summary: view.money.map((line) => `${line.label} ${line.value}`)[0] ?? null }}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {view.money.map((line) => (
              <div key={line.label} className="contents">
                <dt className="text-muted-foreground">{line.label}</dt>
                <dd className="text-end text-foreground tabular-nums">{line.value}</dd>
              </div>
            ))}
          </dl>
        </KinWorkSection>
      )}
      {view.pullRequests.length === 0 ? null : (
        <KinWorkSection
          title={KIN_PROJECTS.pullRequests}
          fold={{ summary: String(view.pullRequests.length) }}
        >
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
      <KinProjectPeopleSection
        environmentId={environmentId}
        orgId={orgId}
        view={view}
        people={props.directory.people}
        names={names}
        onChanged={props.onRefresh}
      />
      {view.meetings.length === 0 ? null : (
        <KinWorkSection
          title={KIN_PROJECTS.meetings}
          fold={{ summary: KIN_PROJECTS.count(view.meetings.length, "meeting", "meetings") }}
        >
          <ul className="-mx-2 flex flex-col">
            {view.meetings.map((row) => (
              <li key={row.key}>
                <KinWorkRow
                  row={row}
                  saving={false}
                  onOpen={() => props.onOpenTask(row.key)}
                  onAct={null}
                />
              </li>
            ))}
          </ul>
        </KinWorkSection>
      )}
      <KinDocsUnder
        environmentId={props.environmentId}
        orgId={props.orgId}
        directory={props.directory}
        under={{ project: props.projectKey }}
        onOpen={props.onOpenDoc}
      />
      <KinWorkSection
        title={KIN_PROJECTS.changed}
        fold={{
          summary:
            view.changed.length === 0
              ? KIN_PROJECTS.nothingChanged
              : KIN_PROJECTS.count(view.changed.length, "change", "changes"),
        }}
      >
        {view.changed.length === 0 ? (
          <p className="text-sm text-muted-foreground">{KIN_PROJECTS.nothingChanged}</p>
        ) : (
          <KinWorkTimeline lines={view.changed} onOpenTask={props.onOpenTask} />
        )}
        {view.changedMore === null ? null : (
          <p className="text-xs text-muted-foreground">{view.changedMore}</p>
        )}
      </KinWorkSection>
      {!canChange && view.repos.length === 0 && view.notes === null ? null : (
        <KinWorkSection title={KIN_PROJECTS.details} fold={{ summary: null }}>
          <div className="flex flex-col gap-6">
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
            {canChange ? (
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Label htmlFor={privateId}>{KIN_PROJECTS.privateLabel}</Label>
                  <p className="text-xs text-muted-foreground">{view.privacy.note}</p>
                </div>
                <Switch
                  id={privateId}
                  checked={view.privacy.private}
                  // Its client keeps it private whatever its own label says, so there is nothing to change.
                  disabled={busy || view.privacy.inherited}
                  onCheckedChange={(checked) => void change({ sensitive: checked })}
                />
              </div>
            ) : null}
          </div>
        </KinWorkSection>
      )}
      <KinWorkPlaceLists
        environmentId={environmentId}
        orgId={orgId}
        place={{ project: view.ref }}
        seq={props.pageStale ? null : page.seq}
        directory={props.directory}
        onOpenList={props.onOpenList}
        onOpenKey={props.onOpenTask}
      />
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
      {addingMilestone ? (
        <KinMilestoneDialog
          environmentId={environmentId}
          orgId={orgId}
          project={view.key}
          onSaved={() => {
            setAddingMilestone(false);
            props.onRefresh();
          }}
          onOpenExisting={(key) => {
            setAddingMilestone(false);
            props.onOpenTask(key);
          }}
          onClose={() => setAddingMilestone(false)}
        />
      ) : null}
      {choosingLead ? (
        <KinProjectLeadSheet
          current={view.lead.personId}
          people={props.directory.people}
          busy={busy}
          onSave={async (personId) => {
            if (await change({ owner: { _tag: "person", personId } })) setChoosingLead(false);
          }}
          onClose={() => setChoosingLead(false)}
        />
      ) : null}
      {opened === null ? null : opened.to === "contacts" ? (
        <KinContactListDialog
          environmentId={environmentId}
          orgId={orgId}
          input={opened.input}
          title={opened.title}
          onOpenClient={(key) => {
            setOpenResult(null);
            props.onOpenClient(key);
          }}
          onClose={() => setOpenResult(null)}
        />
      ) : opened.to === "deals" ? (
        <KinCampaignDealsDialog
          environmentId={environmentId}
          orgId={orgId}
          input={opened.input}
          title={opened.title}
          directory={props.directory}
          onOpen={(key) => {
            setOpenResult(null);
            props.onOpenTask(key);
          }}
          onClose={() => setOpenResult(null)}
        />
      ) : (
        <Dialog open onOpenChange={(open) => (open ? undefined : setOpenResult(null))}>
          <DialogPopup className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{opened.title}</DialogTitle>
            </DialogHeader>
            <div className="flex h-[60vh] min-h-0 flex-col">
              <KinWorkClientsList
                environmentId={environmentId}
                orgId={orgId}
                live={props.live}
                stale={props.stale}
                directory={props.directory}
                start={opened.filter}
                onOpen={(key) => {
                  setOpenResult(null);
                  props.onOpenClient(key);
                }}
                onAdd={null}
              />
            </div>
          </DialogPopup>
        </Dialog>
      )}
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

/** The owner picks who leads a project; the host applies it on the lead's next request. */
function KinProjectLeadSheet(props: {
  readonly current: KinPersonId | null;
  readonly people: Parameters<typeof kinProjectLeadChoices>[0];
  readonly busy: boolean;
  readonly onSave: (personId: KinPersonId) => Promise<void>;
  readonly onClose: () => void;
}) {
  const choices = kinProjectLeadChoices(props.people);
  const [picked, setPicked] = useState<KinPersonId | null>(props.current);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>{KIN_PROJECT_LEAD.choose}</SheetTitle>
          <SheetDescription>{KIN_PROJECT_LEAD.detail}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6">
          <RadioGroup
            value={picked ?? ""}
            disabled={props.busy}
            onValueChange={(value) => {
              const choice = choices.find((held) => held.personId === value);
              if (choice !== undefined) setPicked(choice.personId);
            }}
          >
            {choices.map((choice) => (
              <label
                key={choice.personId}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-accent"
              >
                <Radio value={choice.personId} />
                <span className="truncate text-sm text-foreground">{choice.name}</span>
              </label>
            ))}
          </RadioGroup>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={props.busy || picked === null || picked === props.current}
            aria-busy={props.busy}
            onClick={() => {
              if (picked !== null) void props.onSave(picked);
            }}
          >
            {KIN_PROJECT_LEAD.save}
          </Button>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
