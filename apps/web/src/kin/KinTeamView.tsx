import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_PROJECT_PEOPLE,
  KIN_TEAMMATE_PROJECTS,
  kinTeammateProjects,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_TEAM_ADD,
  KIN_TEAM_EMPTY,
  KIN_TEAM_LOAD_FAILED,
  KIN_TEAM_NO_EDITS,
  KIN_TEAM_ONLY_OWNER,
  KIN_TEAM_TITLE,
  createKinTeamActions,
  kinRemoveAccessCopy,
  kinTeamView,
  KIN_ACCESS_CHOICES,
  KIN_PLACE_SWITCHES,
  kinAccessChangeCopy,
  kinTeammateActions,
  kinTeammateAgentsLine,
  kinTeammateKind,
  kinTeammateKindEditable,
  kinOpenCountsFollower,
  type KinMadeInvite,
  type KinTeamActions,
  type KinTeamList,
  type KinTeammate,
  KIN_TEAM_COPY,
} from "@t3tools/client-runtime/kin/kinTeam";
import { kinWorkListsMoved } from "@t3tools/client-runtime/kin/kinWorkStream";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinAccessAtom } from "@t3tools/client-runtime/kin/kinAccess";
import type {
  EnvironmentId,
  KinOrgId,
  KinPeopleSetAccessInput,
  KinPersonAccess,
  KinPersonId,
  KinPersonPlaceSwitches,
  KinPersonPlaces,
  KinRecordKey,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ChevronRightIcon, UserPlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Radio, RadioGroup } from "../components/ui/radio-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { KinTeammateDevices } from "./KinDevices";
import { KinInviteDialog, type KinInviteDialogState } from "./KinInviteDialog";
import { KinAwayField, KinHandOverButton } from "./KinAway";
import { KinPersonTasks } from "./KinPersonTasks";
import { KIN_PLACE_PATH } from "./kinPlaces";
import { useKinProfiles } from "./kinPictures";
import { KIN_HAND_OVER } from "@t3tools/client-runtime/kin/kinHandOver";
import { KIN_PERSON_TASKS } from "@t3tools/client-runtime/kin/kinTasksList";
import { kinClient } from "./kinClient";
import { kinTeamAddRequestAtom } from "./kinTeamForm";
import { openKinProfile } from "./KinProfileSheet";
import { KinCompanyChatRow, KinTeamAgentRow } from "./KinTeamAgent";
import { KinPersonReach, KinReachList } from "./KinReach";
import { KIN_REACH_COPY } from "@t3tools/client-runtime/kin/kinReach";
import { useKinHostAt } from "./useKinHost";
import { useKinWork } from "./useKinWork";
import { KinLoadFailed } from "./KinWorkParts";
import { useKinGate } from "./useKinHost";
import { KinGateView } from "./KinWorkParts";

interface KinTeamTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

const teamAtoms = ({ environmentId, orgId }: KinTeamTarget) => ({
  peopleAtom: kinClient.people({ environmentId, input: { orgId } }),
  invitesAtom: kinClient.invites({ environmentId, input: { orgId } }),
  profilesAtom: kinClient.profiles({ environmentId, input: { orgId } }),
});

async function refreshKinTeam(target: KinTeamTarget) {
  const { peopleAtom, invitesAtom } = teamAtoms(target);
  // A failed read keeps what is on screen; the page has its own retry.
  const quiet = { refresh: true, reportFailure: false } as const;
  await Promise.all([
    executeAtomQuery(appAtomRegistry, peopleAtom, quiet),
    executeAtomQuery(appAtomRegistry, invitesAtom, quiet),
  ]);
}

const followOpenCounts = kinOpenCountsFollower();

/** The open-task counts the profiles carry follow Work's task changes while Team is open. */
function useKinOpenCounts({ environmentId, orgId }: KinTeamTarget) {
  const work = useKinWork({ environmentId, orgId });
  const seq = work._tag === "ready" && !work.stale ? kinWorkListsMoved(work.live, ["work"]) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the profiles again when the host's Work stream says a task moved
  useEffect(() => {
    if (followOpenCounts(`${environmentId}:${orgId}`, seq))
      appAtomRegistry.refresh(kinClient.profiles({ environmentId, input: { orgId } }));
  }, [seq, environmentId, orgId]);
}

/** The people and unopened links, once both have been read; what was last read stays up. */
function useKinTeam(target: KinTeamTarget) {
  const { environmentId, orgId } = target;
  useKinOpenCounts(target);
  const { peopleAtom, invitesAtom, profilesAtom } = teamAtoms(target);
  const people = useAtomValue(peopleAtom);
  const invites = useAtomValue(invitesAtom);
  const profiles = Option.getOrNull(AsyncResult.value(useAtomValue(profilesAtom)))?.profiles;
  const host = useKinHostAt(environmentId);
  const { personId } = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    orgId,
  );
  const viewer = useAtomValue(kinAccessAtom(connectionAtomRuntime, environmentId));
  const heldPeople = Option.getOrNull(AsyncResult.value(people));
  const heldInvites = Option.getOrNull(AsyncResult.value(invites));
  const list: KinTeamList | null =
    heldPeople === null || heldInvites === null
      ? null
      : {
          people: heldPeople.people,
          joined: heldPeople.joined,
          places: heldPeople.places,
          removed: heldPeople.removed,
          invites: heldInvites.invites,
          profiles,
        };
  return {
    list,
    failed: list === null && (AsyncResult.isFailure(people) || AsyncResult.isFailure(invites)),
    ownerPersonId: personId,
    /** The viewer's own kind; a co-owner acts on members only. */
    viewer: viewer ?? "member",
    refresh: () => void refreshKinTeam(target),
  };
}

/** Who is on the team, whether each has joined, and the links that bring them in. */
export function KinTeamView(props: KinTeamTarget) {
  const gate = useKinGate(
    kinClient.inviteCreate.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  const allowed = gate === null;
  const [adding, setAdding] = useState(false);
  return (
    <>
      {allowed ? (
        <div className="mx-auto flex w-full max-w-3xl justify-end px-4 pt-4">
          <Button size="sm" onClick={() => setAdding(true)}>
            <UserPlusIcon />
            {KIN_TEAM_ADD}
          </Button>
        </div>
      ) : null}
      {allowed ? (
        <KinTeamBody {...props} adding={adding} setAdding={setAdding} />
      ) : (
        <KinGateView gate={gate} refused={KIN_TEAM_ONLY_OWNER} label={KIN_TEAM_TITLE} />
      )}
    </>
  );
}

function KinTeamBody(
  props: KinTeamTarget & {
    readonly adding: boolean;
    readonly setAdding: (adding: boolean) => void;
  },
) {
  const { environmentId, orgId } = props;
  const team = useKinTeam(props);
  const createInvite = useAtomCommand(kinClient.inviteCreate, { reportFailure: false });
  const revokeInvite = useAtomCommand(kinClient.inviteCancel, { reportFailure: false });
  const removeAccess = useAtomCommand(kinClient.personRemoveAccess, { reportFailure: false });
  const setAccess = useAtomCommand(kinClient.personSetAccess, { reportFailure: false });
  const [edits, setEdits] = useState(KIN_TEAM_NO_EDITS);
  const [actions] = useState(() =>
    createKinTeamActions({
      orgId,
      createInvite: (input) => createInvite({ environmentId, input }),
      revokeInvite: (input) => revokeInvite({ environmentId, input }),
      removeAccess: (input) => removeAccess({ environmentId, input }),
      setAccess: (input) => setAccess({ environmentId, input }),
      update: setEdits,
      refresh: () => refreshKinTeam({ environmentId, orgId }),
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the team again when the owner returns to this window after sending a link, so "Joined" is current
  useEffect(() => {
    const reread = () => void refreshKinTeam({ environmentId, orgId });
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [environmentId, orgId]);
  // The link the host just made. Held here and nowhere else, and dropped when its dialog closes.
  const [made, setMade] = useState<KinInviteDialogState | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const addRequested = useAtomValue(kinTeamAddRequestAtom);
  const dialog: KinInviteDialogState | null =
    made ?? (props.adding || addRequested ? { stage: "name" } : null);
  const closeDialog = () => {
    setMade(null);
    props.setAdding(false);
    appAtomRegistry.set(kinTeamAddRequestAtom, false);
  };

  const { list } = team;
  if (list === null) {
    return team.failed ? (
      <KinLoadFailed
        what={KIN_TEAM_LOAD_FAILED}
        cause={null}
        onRetry={team.refresh}
        className="mx-auto w-full max-w-3xl p-4"
      />
    ) : (
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4"
        role="status"
        aria-label="Loading your team"
      >
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-9" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  const rows = kinTeamView(list, edits, team.ownerPersonId);
  const open = rows.find((row) => row.key === openKey) ?? null;
  const alone = rows.every((row) => row.state === "you");
  return (
    <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
        {edits.problem === null ? null : (
          <Alert variant="error">
            <AlertDescription>{edits.problem}</AlertDescription>
          </Alert>
        )}
        <KinTeamAgentRow environmentId={environmentId} orgId={orgId} />
        <KinCompanyChatRow environmentId={environmentId} orgId={orgId} />
        {alone ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>{KIN_TEAM_EMPTY.title}</EmptyTitle>
              <EmptyDescription>{KIN_TEAM_EMPTY.detail}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => props.setAdding(true)}>
                <UserPlusIcon />
                {KIN_TEAM_ADD}
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li key={row.key} className="border-b border-border/60 last:border-b-0">
                <KinTeamRow
                  row={row}
                  onOpen={() => {
                    // Your own row is your profile; there is no access of yours to manage here.
                    if (row.state === "you" && row.personId !== null)
                      openKinProfile({ environmentId, orgId, personId: row.personId });
                    else setOpenKey(row.key);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <KinReachList environmentId={environmentId} orgId={orgId} />
      </div>
      {open === null ? null : (
        <KinTeammateDialog
          teammate={open}
          environmentId={environmentId}
          orgId={orgId}
          actions={actions}
          viewer={team.viewer}
          onMade={(invite) => {
            setOpenKey(null);
            setMade({ stage: "link", invite });
          }}
          onClose={() => setOpenKey(null)}
        />
      )}
      {dialog === null ? null : (
        <KinInviteDialog
          state={dialog}
          environmentId={environmentId}
          actions={actions}
          list={list}
          onMade={(invite) => setMade({ stage: "link", invite })}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}

function KinTeamRow(props: { readonly row: KinTeammate; readonly onOpen: () => void }) {
  const { row } = props;
  const text = (
    <>
      <KinAvatar avatar={row.avatar} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
        {row.roles === "" ? null : (
          <span className="truncate text-xs text-foreground/80">{row.roles}</span>
        )}
        <span className="text-xs text-muted-foreground">
          {row.load === "" ? row.detail : `${row.detail} · ${row.load}`}
        </span>
      </span>
    </>
  );
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
    >
      {text}
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

/**
 * One teammate: which leads they can message, their link, and the way to take access away.
 * A dialog, as T3's Settings opens its details, so it stacks over the Settings modal.
 */
function KinTeammateDialog(props: {
  readonly teammate: KinTeammate;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly actions: KinTeamActions;
  readonly viewer: KinPersonAccess;
  readonly onMade: (invite: KinMadeInvite) => void;
  readonly onClose: () => void;
}) {
  const { teammate, actions } = props;
  const offered = kinTeammateActions(teammate, props.viewer);
  const [kindAsked, setKindAsked] = useState<KinPeopleSetAccessInput["access"] | null>(null);
  const kind = kinTeammateKind(teammate);
  const kindCopy =
    kindAsked === null
      ? null
      : kinAccessChangeCopy(teammate.name, kindAsked, teammate.backAs !== null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const removal = kinRemoveAccessCopy(teammate.name);

  const makeLink = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const made = await actions.makeLink({
      displayName: teammate.name,
      personId: teammate.personId,
      replaces: teammate.inviteId,
    });
    setBusy(false);
    if (made.ok) props.onMade(made.invite);
    else setProblem(made.problem);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      {/* A form opened from here takes its place: one sheet at a time. */}
      <DialogPopup className="data-nested-dialog-open:hidden">
        <DialogHeader>
          <div className="flex items-center gap-3 pe-8">
            <KinAvatar avatar={teammate.avatar} />
            <div className="flex min-w-0 flex-col">
              <DialogTitle>{teammate.name}</DialogTitle>
              <DialogDescription>{teammate.detail}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
          {teammate.personId === null ? null : (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => {
                const personId = teammate.personId;
                if (personId === null) return;
                props.onClose();
                openKinProfile({
                  environmentId: props.environmentId,
                  orgId: props.orgId,
                  personId,
                });
              }}
            >
              Profile
            </Button>
          )}
          {teammate.personId === null ? null : (
            <KinTeammateAway
              environmentId={props.environmentId}
              orgId={props.orgId}
              personId={teammate.personId}
              onLeave={props.onClose}
            />
          )}
          {kinTeammateKindEditable(teammate, props.viewer) ? (
            <Section
              title={teammate.backAs === null ? KIN_TEAM_COPY.canDo : KIN_TEAM_COPY.canDoBack}
            >
              <RadioGroup
                value={kind}
                disabled={busy}
                onValueChange={(value) => {
                  const choice = KIN_ACCESS_CHOICES.find((held) => held.access === value);
                  if (choice !== undefined && choice.access !== kind) setKindAsked(choice.access);
                }}
              >
                {KIN_ACCESS_CHOICES.map((choice) => (
                  <label key={choice.access} className="flex cursor-pointer items-start gap-3">
                    <Radio value={choice.access} className="mt-0.5" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm text-foreground">{choice.label}</span>
                      <span className="text-xs text-muted-foreground">{choice.detail}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </Section>
          ) : null}
          {teammate.places === null || teammate.personId === null ? null : (
            <KinTeammatePlaces
              places={teammate.places}
              personId={teammate.personId}
              environmentId={props.environmentId}
              orgId={props.orgId}
            />
          )}
          {teammate.personId === null ? null : (
            <KinTeammateProjects
              personId={teammate.personId}
              environmentId={props.environmentId}
              orgId={props.orgId}
              onOpen={props.onClose}
            />
          )}
          {teammate.personId === null ? (
            <Section title="Agents">
              <p className="text-sm text-muted-foreground">
                {KIN_REACH_COPY.notJoined(teammate.name)}
              </p>
            </Section>
          ) : (
            <>
              {kinTeammateAgentsLine(teammate) === null ? null : (
                <Section title="Agents">
                  <p className="text-sm text-muted-foreground">{kinTeammateAgentsLine(teammate)}</p>
                </Section>
              )}
              <KinPersonReach
                environmentId={props.environmentId}
                orgId={props.orgId}
                personId={teammate.personId}
                name={teammate.name}
                ownerLevel={kinTeammateAgentsLine(teammate) !== null}
                onOpenAgent={props.onClose}
                section={Section}
              />
            </>
          )}
          {offered.link === null ? null : (
            <Section title="Invite link">
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void makeLink()}
              >
                {offered.link.label}
              </Button>
              <p className="text-xs text-muted-foreground">{offered.link.hint}</p>
              {offered.cancel === null ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  disabled={busy}
                  onClick={() => setCancelling(true)}
                >
                  {offered.cancel.label}
                </Button>
              )}
              {problem === null ? null : (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {problem}
                </p>
              )}
            </Section>
          )}
          {offered.remove && teammate.personId !== null && teammate.state === "joined" ? (
            <KinTeammateDevices
              environmentId={props.environmentId}
              orgId={props.orgId}
              personId={teammate.personId}
            />
          ) : null}
          {offered.remove && teammate.personId !== null ? (
            <Section title="Access">
              <Button
                size="sm"
                variant="destructive-outline"
                className="self-start"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                {removal.confirm}
              </Button>
            </Section>
          ) : null}
        </div>
      </DialogPopup>
      <AlertDialog open={kindCopy !== null} onOpenChange={(open) => !open && setKindAsked(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{kindCopy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{kindCopy?.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                const access = kindAsked;
                setKindAsked(null);
                if (teammate.personId === null || access === null) return;
                setBusy(true);
                void actions.setAccess(teammate.personId, access).finally(() => setBusy(false));
              }}
            >
              {kindCopy?.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{removal.title}</AlertDialogTitle>
            <AlertDialogDescription>{removal.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          {teammate.personId === null ? null : (
            <KinRemoveHandOver
              environmentId={props.environmentId}
              orgId={props.orgId}
              personId={teammate.personId}
              name={teammate.name}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                if (teammate.personId !== null) void actions.removeAccess(teammate.personId);
              }}
            >
              {removal.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {offered.cancel === null ? null : (
        <AlertDialog open={cancelling} onOpenChange={setCancelling}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{offered.cancel.title}</AlertDialogTitle>
              <AlertDialogDescription>{offered.cancel.detail}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>
                {offered.cancel.keep}
              </AlertDialogClose>
              <Button
                variant="destructive"
                onClick={() => {
                  setCancelling(false);
                  if (teammate.inviteId === null) return;
                  // Shown at once; the page says so if the host refuses.
                  void actions.cancelInvite(teammate.inviteId);
                  if (teammate.personId === null) props.onClose();
                }}
              >
                {offered.cancel.label}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </Dialog>
  );
}

/**
 * The projects a teammate is on or leads, each a way to its page; the owner puts them on one or
 * takes them off here as on the project's own page (`kin.work.projectPeople`).
 */
function KinTeammateProjects(props: {
  readonly personId: KinPersonId;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly onOpen: () => void;
}) {
  const { personId, environmentId, orgId } = props;
  const result = useAtomValue(
    kinClient.teammateProjects({ environmentId, input: { orgId, person: personId } }),
  );
  const people = useAtomCommand(kinClient.workProjectPeople, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const read = Option.getOrNull(AsyncResult.value(result));
  const view = read === null ? null : kinTeammateProjects(personId, read.theirs, read.open);
  const change = async (key: KinRecordKey, on: boolean) => {
    setBusy(true);
    setProblem(null);
    const who = { _tag: "person" as const, personId };
    const outcome = await people({
      environmentId,
      input: { orgId, key, ...(on ? { add: [who] } : { remove: [who] }) },
    });
    if (AsyncResult.isFailure(outcome))
      setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_PROJECT_PEOPLE.failed));
    appAtomRegistry.refresh(
      kinClient.teammateProjects({ environmentId, input: { orgId, person: personId } }),
    );
    setBusy(false);
  };
  return (
    <Section title={KIN_TEAMMATE_PROJECTS.title}>
      {view === null ? (
        <Skeleton className="h-9 w-full" />
      ) : view.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_TEAMMATE_PROJECTS.none}</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {view.rows.map((row) => (
            <li key={row.key} className="flex min-h-10 items-center gap-2">
              <Link
                to="/kin/$environmentId/$orgId/tasks"
                params={{ environmentId, orgId }}
                search={{ project: row.key }}
                onClick={props.onOpen}
                className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-2 py-1.5 outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
              >
                <span className="min-w-0 truncate text-sm text-foreground">{row.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{row.line}</span>
              </Link>
              {row.removable ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={KIN_TEAMMATE_PROJECTS.remove(row.title)}
                  title={KIN_TEAMMATE_PROJECTS.remove(row.title)}
                  onClick={() => void change(row.key, false)}
                >
                  <XIcon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {view === null || view.addable.length === 0 ? null : (
        <Select
          value=""
          disabled={busy}
          onValueChange={(key) => {
            if (typeof key === "string" && key !== "") void change(key, true);
          }}
        >
          <SelectTrigger className="w-full min-w-0" aria-label={KIN_TEAMMATE_PROJECTS.add}>
            <SelectValue>{KIN_TEAMMATE_PROJECTS.add}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {view.addable.map((row) => (
              <SelectItem key={row.key} value={row.key}>
                {row.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      <p className="text-xs text-muted-foreground">{KIN_TEAMMATE_PROJECTS.leadHint}</p>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </Section>
  );
}

/** A member's places beyond Tasks (the projects they lead are under Projects). */
function KinTeammatePlaces(props: {
  readonly places: KinPersonPlaces;
  readonly personId: KinPersonId;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const { places, personId, environmentId, orgId } = props;
  const setPlaces = useAtomCommand(kinClient.personSetPlaces, { reportFailure: false });
  // What the owner just switched, shown until the host's next read agrees or refuses.
  const [asked, setAsked] = useState<Partial<KinPersonPlaceSwitches>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const flip = async (place: keyof KinPersonPlaceSwitches, on: boolean) => {
    setProblem(null);
    setAsked((held) => ({ ...held, [place]: on }));
    const result = await setPlaces({ environmentId, input: { orgId, personId, [place]: on } });
    if (AsyncResult.isFailure(result))
      setProblem(kinFailureText(squashAtomCommandFailure(result), "That didn't save."));
    await refreshKinTeam({ environmentId, orgId });
    setAsked((held) => {
      const rest = { ...held };
      delete rest[place];
      return rest;
    });
  };
  return (
    <>
      <Section title={KIN_TEAM_COPY.canSee}>
        <p className="text-xs text-muted-foreground">{KIN_TEAM_COPY.sharedAlways}</p>
        {KIN_PLACE_SWITCHES.map((entry) => {
          const id = `kin-place-${entry.place}`;
          return (
            <div key={entry.place} className="flex items-start justify-between gap-3">
              <label htmlFor={id} className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{entry.label}</span>
                <span className="text-xs text-muted-foreground">{entry.detail}</span>
              </label>
              <Switch
                id={id}
                checked={asked[entry.place] ?? places[entry.place]}
                disabled={asked[entry.place] !== undefined}
                onCheckedChange={(on) => void flip(entry.place, on)}
              />
            </div>
          );
        })}
        {problem === null ? null : (
          <p role="alert" className="text-xs text-destructive-foreground">
            {problem}
          </p>
        )}
      </Section>
    </>
  );
}

function useKinProfile(environmentId: EnvironmentId, orgId: KinOrgId, personId: KinPersonId) {
  const result = useKinProfiles(environmentId, orgId);
  const held = result === null ? null : Option.getOrNull(AsyncResult.value(result));
  return held?.profiles.find((profile) => profile.personId === personId) ?? null;
}

/** Away, their tasks, and giving all their open tasks to someone, from the teammate's own page. */
function KinTeammateAway(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  /** Closes the page before Tasks opens under it. */
  readonly onLeave: () => void;
}) {
  const profile = useKinProfile(props.environmentId, props.orgId, props.personId);
  const navigate = useNavigate();
  if (profile === null) return null;
  const params = { environmentId: props.environmentId, orgId: props.orgId };
  return (
    <>
      <KinAwayField
        environmentId={props.environmentId}
        orgId={props.orgId}
        profile={profile}
        mine={false}
        mayEdit={profile.canEdit === true}
      />
      <Section title={KIN_PERSON_TASKS.title}>
        <KinPersonTasks
          environmentId={props.environmentId}
          orgId={props.orgId}
          personId={props.personId}
          onOpenTask={(task) => {
            props.onLeave();
            void navigate({ to: KIN_PLACE_PATH.tasks, params, search: { task } });
          }}
          onSeeAll={() => {
            props.onLeave();
            void navigate({ to: KIN_PLACE_PATH.tasks, params, search: { person: props.personId } });
          }}
        />
        {(profile.load?.open ?? 0) === 0 ? null : (
          <KinHandOverButton
            environmentId={props.environmentId}
            orgId={props.orgId}
            from={{ _tag: "person", personId: props.personId }}
            fromName={profile.displayName}
          />
        )}
      </Section>
    </>
  );
}

/** Before removing someone who still holds open tasks: give them to someone first. */
function KinRemoveHandOver(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly name: string;
}) {
  const profile = useKinProfile(props.environmentId, props.orgId, props.personId);
  const open = profile?.load?.open ?? 0;
  if (open === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-6">
      <p className="text-sm text-muted-foreground">{KIN_HAND_OVER.removeOffer(open, props.name)}</p>
      <KinHandOverButton
        environmentId={props.environmentId}
        orgId={props.orgId}
        from={{ _tag: "person", personId: props.personId }}
        fromName={props.name}
      />
    </div>
  );
}
