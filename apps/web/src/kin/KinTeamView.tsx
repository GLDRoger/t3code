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
  KIN_TEAM_PAGE,
  KIN_TEAMMATE_PAGE,
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
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
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
import { KinTalkToSection } from "./KinTeamAgent";
import { KinPersonReach, KinReachList } from "./KinReach";
import { KIN_REACH_COPY } from "@t3tools/client-runtime/kin/kinReach";
import { useKinHostAt } from "./useKinHost";
import { useKinWork } from "./useKinWork";
import { useKinGate } from "./useKinHost";
import { KinGateView } from "./KinWorkParts";
import { KinSettingsChoice, useKinSettingsSave } from "./settings/KinSettingsControls";
import { KinSettingsSubpage } from "./settings/KinSettingsSubpage";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";

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
  if (gate === null) return <KinTeamBody {...props} />;
  if (gate !== "loading")
    return <KinGateView gate={gate} refused={KIN_TEAM_ONLY_OWNER} label={KIN_TEAM_TITLE} />;
  return (
    <KinSettingsPage purpose={KIN_TEAM_PAGE.purpose}>
      <KinSettingsSection title={KIN_TEAM_PAGE.people}>
        <KinSettingsLoading rows={5} />
      </KinSettingsSection>
    </KinSettingsPage>
  );
}

function KinTeamBody(props: KinTeamTarget) {
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
  const [adding, setAdding] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const addRequested = useAtomValue(kinTeamAddRequestAtom);
  const mayRestrict = useAtomValue(kinClient.reachSet.permissionAtom(environmentId));
  const reach = useAtomValue(kinClient.reach({ environmentId, input: { orgId } }));
  const dialog: KinInviteDialogState | null =
    made ?? (adding || addRequested ? { stage: "name" } : null);
  const closeDialog = () => {
    setMade(null);
    setAdding(false);
    appAtomRegistry.set(kinTeamAddRequestAtom, false);
  };

  const { list } = team;
  const rows = list === null ? null : kinTeamView(list, edits, team.ownerPersonId);
  const open = rows?.find((row) => row.key === openKey) ?? null;
  const alone = rows !== null && rows.every((row) => row.state === "you");
  const limits = Option.getOrNull(AsyncResult.value(reach))?.limits ?? null;
  // Nobody restricted: said once on People. Restrictions, or a failed read, get their own list.
  const reachNone = mayRestrict && limits !== null && limits.length === 0;
  const reachList = mayRestrict && (limits === null ? AsyncResult.isFailure(reach) : !reachNone);
  const inviteDialog =
    dialog === null || list === null ? null : (
      <KinInviteDialog
        state={dialog}
        environmentId={environmentId}
        actions={actions}
        list={list}
        onMade={(invite) => setMade({ stage: "link", invite })}
        onClose={closeDialog}
      />
    );
  if (open !== null)
    return (
      <KinSettingsSubpage title={open.name} backTo={KIN_TEAM_TITLE} onBack={() => setOpenKey(null)}>
        <KinTeammatePage
          teammate={open}
          environmentId={environmentId}
          orgId={orgId}
          actions={actions}
          viewer={team.viewer}
          problem={edits.problem}
          onMade={(invite) => {
            setOpenKey(null);
            setMade({ stage: "link", invite });
          }}
          onClose={() => setOpenKey(null)}
        />
        {inviteDialog}
      </KinSettingsSubpage>
    );
  return (
    <KinSettingsPage
      purpose={KIN_TEAM_PAGE.purpose}
      action={
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <PlusIcon />
          {KIN_TEAM_ADD}
        </Button>
      }
    >
      <KinTalkToSection environmentId={environmentId} orgId={orgId} />
      <KinSettingsSection
        title={KIN_TEAM_PAGE.people}
        {...(reachNone
          ? { description: KIN_TEAM_PAGE.reachNone, searchId: "kin-who-can-message" }
          : {})}
        problem={edits.problem}
      >
        {rows === null ? (
          team.failed ? (
            <KinSettingsLoadFailed onRetry={team.refresh}>
              {KIN_TEAM_PAGE.loadFailed}
            </KinSettingsLoadFailed>
          ) : (
            <KinSettingsLoading rows={5} />
          )
        ) : (
          <>
            {rows.map((row) => (
              <KinSettingsRow
                key={row.key}
                leading={<KinAvatar avatar={row.avatar} size="xs" />}
                title={row.name}
                detail={row.line === "" ? undefined : row.line}
                status={
                  row.status === null ? undefined : (
                    <KinSettingsStatus tone="quiet">{row.status}</KinSettingsStatus>
                  )
                }
                openLabel={KIN_TEAM_PAGE.open(row.name)}
                onOpen={() => {
                  // Your own row is your profile; there is no access of yours to manage here.
                  if (row.state === "you" && row.personId !== null)
                    openKinProfile({ environmentId, orgId, personId: row.personId });
                  else setOpenKey(row.key);
                }}
              />
            ))}
            {alone ? <KinSettingsEmpty>{KIN_TEAM_PAGE.alone}</KinSettingsEmpty> : null}
          </>
        )}
      </KinSettingsSection>
      {reachList ? (
        <KinTeammateBlock>
          <KinReachList environmentId={environmentId} orgId={orgId} />
        </KinTeammateBlock>
      ) : null}
      {inviteDialog}
    </KinSettingsPage>
  );
}

/** A section whose content isn't rows (a block another screen shares), padded inside its card. */
function KinTeammateBlock(props: { readonly title?: string; readonly children: ReactNode }) {
  return (
    <KinSettingsSection {...(props.title === undefined ? {} : { title: props.title })}>
      <div className="flex flex-col gap-2 px-4 py-3">{props.children}</div>
    </KinSettingsSection>
  );
}

/**
 * One teammate's own page inside Team: their profile and away, what they can do and see, their
 * projects, who they can message, their link and devices, and Remove access last.
 */
function KinTeammatePage(props: {
  readonly teammate: KinTeammate;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly actions: KinTeamActions;
  readonly viewer: KinPersonAccess;
  /** The team's last refused change, said here as on the list. */
  readonly problem: string | null;
  readonly onMade: (invite: KinMadeInvite) => void;
  readonly onClose: () => void;
}) {
  const { teammate, actions } = props;
  const target = { environmentId: props.environmentId, orgId: props.orgId };
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
  const personId = teammate.personId;
  const agentsLine = kinTeammateAgentsLine(teammate);
  const removable = offered.remove && personId !== null;

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
    // Their kind is on the Team row already; the line earns the top only when something is out.
    <KinSettingsPage {...(teammate.status === null ? {} : { purpose: teammate.detail })}>
      {personId === null ? null : (
        <KinSettingsSection>
          <KinSettingsRow
            leading={<KinAvatar avatar={teammate.avatar} size="xs" />}
            title={KIN_TEAMMATE_PAGE.profile}
            detail={teammate.roles === "" ? undefined : teammate.roles}
            openLabel={KIN_TEAMMATE_PAGE.openProfile(teammate.name)}
            onOpen={() => {
              props.onClose();
              openKinProfile({ ...target, personId });
            }}
          />
        </KinSettingsSection>
      )}
      {personId === null ? null : <KinTeammateAway {...target} personId={personId} />}
      {kinTeammateKindEditable(teammate, props.viewer) ? (
        <KinSettingsSection
          title={teammate.backAs === null ? KIN_TEAM_COPY.canDo : KIN_TEAM_COPY.canDoBack}
          description={KIN_ACCESS_CHOICES.find((choice) => choice.access === kind)?.detail}
          problem={props.problem}
        >
          <KinSettingsRow
            title={KIN_TEAMMATE_PAGE.access}
            control={
              <KinSettingsChoice
                label={KIN_TEAMMATE_PAGE.access}
                value={kind === "owner" ? null : kind}
                disabled={busy}
                options={KIN_ACCESS_CHOICES.map((choice) => ({
                  value: choice.access,
                  label: choice.label,
                }))}
                onChange={setKindAsked}
              />
            }
          />
        </KinSettingsSection>
      ) : null}
      {teammate.places === null || personId === null ? null : (
        <KinTeammatePlaces {...target} places={teammate.places} personId={personId} />
      )}
      {personId === null ? null : (
        <KinTeammateProjects {...target} personId={personId} onOpen={props.onClose} />
      )}
      {personId === null ? (
        <KinTeammateBlock title="Agents">
          <p className="text-sm text-muted-foreground">{KIN_REACH_COPY.notJoined(teammate.name)}</p>
        </KinTeammateBlock>
      ) : (
        <>
          {agentsLine === null ? null : (
            <KinTeammateBlock title="Agents">
              <p className="text-sm text-muted-foreground">{agentsLine}</p>
            </KinTeammateBlock>
          )}
          <KinPersonReach
            {...target}
            personId={personId}
            name={teammate.name}
            ownerLevel={agentsLine !== null}
            onOpenAgent={props.onClose}
            section={KinTeammateBlock}
          />
        </>
      )}
      {offered.link === null ? null : (
        <KinSettingsSection problem={problem}>
          <KinSettingsRow
            title={KIN_TEAMMATE_PAGE.link}
            detail={offered.link.hint}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void makeLink()}
              >
                {offered.link.label}
              </Button>
            }
          />
        </KinSettingsSection>
      )}
      {removable && teammate.state === "joined" ? (
        <KinTeammateBlock>
          <KinTeammateDevices {...target} personId={personId} />
        </KinTeammateBlock>
      ) : null}
      {offered.cancel === null && !removable ? null : (
        <KinSettingsSection>
          {offered.cancel === null ? null : (
            <KinSettingsRow
              title={KIN_TEAMMATE_PAGE.unopened}
              detail={KIN_TEAMMATE_PAGE.cancelDetail}
              control={
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() => setCancelling(true)}
                >
                  {offered.cancel.label}
                </Button>
              }
            />
          )}
          {removable ? (
            <KinSettingsRow
              title={KIN_TEAMMATE_PAGE.removeTitle}
              detail={KIN_TEAMMATE_PAGE.removeDetail}
              control={
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  {KIN_TEAMMATE_PAGE.remove}
                </Button>
              }
            />
          ) : null}
        </KinSettingsSection>
      )}
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
          {personId === null ? null : (
            <KinRemoveHandOver {...target} personId={personId} name={teammate.name} />
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
    </KinSettingsPage>
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
  const navigate = useNavigate();
  const result = useAtomValue(
    kinClient.teammateProjects({ environmentId, input: { orgId, person: personId } }),
  );
  const people = useAtomCommand(kinClient.workProjectPeople, { reportFailure: false });
  const save = useKinSettingsSave();
  const read = Option.getOrNull(AsyncResult.value(result));
  const view = read === null ? null : kinTeammateProjects(personId, read.theirs, read.open);
  const change = async (key: KinRecordKey, on: boolean) => {
    const who = { _tag: "person" as const, personId };
    await save.run(key, KIN_PROJECT_PEOPLE.failed, () =>
      people({
        environmentId,
        input: { orgId, key, ...(on ? { add: [who] } : { remove: [who] }) },
      }),
    );
    appAtomRegistry.refresh(
      kinClient.teammateProjects({ environmentId, input: { orgId, person: personId } }),
    );
  };
  return (
    <KinSettingsSection
      title={KIN_TEAMMATE_PROJECTS.title}
      description={KIN_TEAMMATE_PROJECTS.leadHint}
      problem={save.problem}
      action={
        view === null || view.addable.length === 0 ? undefined : (
          <Select
            value=""
            disabled={save.busy !== null}
            onValueChange={(key) => {
              if (typeof key === "string" && key !== "") void change(key, true);
            }}
          >
            <SelectTrigger size="sm" className="w-44" aria-label={KIN_TEAMMATE_PROJECTS.add}>
              <SelectValue>{KIN_TEAMMATE_PROJECTS.add}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {view.addable.map((row) => (
                <SelectItem key={row.key} value={row.key}>
                  {row.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )
      }
    >
      {view === null ? (
        <KinSettingsLoading rows={1} />
      ) : view.rows.length === 0 ? (
        <KinSettingsEmpty>{KIN_TEAMMATE_PROJECTS.none}</KinSettingsEmpty>
      ) : (
        view.rows.map((row) => (
          <KinSettingsRow
            key={row.key}
            title={row.title}
            detail={row.line}
            onOpen={() => {
              props.onOpen();
              void navigate({
                to: "/kin/$environmentId/$orgId/tasks",
                params: { environmentId, orgId },
                search: { project: row.key },
              });
            }}
            control={
              row.removable ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={save.busy !== null}
                  aria-label={KIN_TEAMMATE_PROJECTS.remove(row.title)}
                  title={KIN_TEAMMATE_PROJECTS.remove(row.title)}
                  onClick={() => void change(row.key, false)}
                >
                  <XIcon />
                </Button>
              ) : undefined
            }
          />
        ))
      )}
    </KinSettingsSection>
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
      setProblem(kinFailureText(squashAtomCommandFailure(result), KIN_TEAM_COPY.saveFailed));
    await refreshKinTeam({ environmentId, orgId });
    setAsked((held) => {
      const rest = { ...held };
      delete rest[place];
      return rest;
    });
  };
  return (
    <KinSettingsSection
      title={KIN_TEAM_COPY.canSee}
      description={KIN_TEAM_COPY.sharedAlways}
      problem={problem}
    >
      {KIN_PLACE_SWITCHES.map((entry) => (
        <KinSettingsRow
          key={entry.place}
          title={entry.label}
          detail={entry.detail}
          control={
            <Switch
              aria-label={entry.label}
              checked={asked[entry.place] ?? places[entry.place]}
              disabled={asked[entry.place] !== undefined}
              onCheckedChange={(on) => void flip(entry.place, on)}
            />
          }
        />
      ))}
    </KinSettingsSection>
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
}) {
  const profile = useKinProfile(props.environmentId, props.orgId, props.personId);
  const navigate = useNavigate();
  if (profile === null) return null;
  const params = { environmentId: props.environmentId, orgId: props.orgId };
  return (
    <>
      <KinTeammateBlock>
        <KinAwayField
          environmentId={props.environmentId}
          orgId={props.orgId}
          profile={profile}
          mine={false}
          mayEdit={profile.canEdit === true}
        />
      </KinTeammateBlock>
      <KinTeammateBlock title={KIN_PERSON_TASKS.title}>
        <KinPersonTasks
          environmentId={props.environmentId}
          orgId={props.orgId}
          personId={props.personId}
          onOpenTask={(task) => {
            void navigate({ to: KIN_PLACE_PATH.tasks, params, search: { task } });
          }}
          onSeeAll={() => {
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
      </KinTeammateBlock>
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
