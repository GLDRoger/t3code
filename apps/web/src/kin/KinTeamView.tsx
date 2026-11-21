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
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Switch } from "../components/ui/switch";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { KinTeammateDevices } from "./KinDevices";
import { KinInviteDialog, type KinInviteDialogState } from "./KinInviteDialog";
import { KinAwayRow, KinHandOverButton } from "./KinAway";
import { KinConfirm } from "./KinConfirm";
import { useNowMinuteMs } from "./useKinClock";
import { KIN_PLACE_PATH } from "./kinPlaces";
import { useKinProfiles } from "./kinPictures";
import { KIN_HAND_OVER } from "@t3tools/client-runtime/kin/kinHandOver";
import { KIN_PERSON_TASKS, kinTaskLine } from "@t3tools/client-runtime/kin/kinTasksList";
import { kinClient } from "./kinClient";
import { kinTeamAddRequestAtom } from "./kinTeamForm";
import { openKinProfile } from "./KinProfileSheet";
import { KinTalkToSection } from "./KinTeamAgent";
import { KinPersonReach, KinReachList } from "./KinReach";
import { KIN_REACH_COPY } from "@t3tools/client-runtime/kin/kinReach";
import { useKinHostAt } from "./useKinHost";
import { useKinWork, useKinWorkDirectory } from "./useKinWork";
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
                leading={<KinAvatar avatar={row.avatar} size="sm" />}
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
      {reachList ? <KinReachList environmentId={environmentId} orgId={orgId} /> : null}
      {inviteDialog}
    </KinSettingsPage>
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
            leading={<KinAvatar avatar={teammate.avatar} size="sm" />}
            title={KIN_TEAMMATE_PAGE.profile}
            detail={teammate.roles === "" ? undefined : teammate.roles}
            openLabel={KIN_TEAMMATE_PAGE.openProfile(teammate.name)}
            onOpen={() => {
              props.onClose();
              openKinProfile({ ...target, personId });
            }}
          />
          <KinTeammateAway {...target} personId={personId} />
        </KinSettingsSection>
      )}
      {personId === null ? null : <KinTeammateTasks {...target} personId={personId} />}
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
        <KinSettingsSection title={KIN_REACH_COPY.agentsTitle}>
          <KinSettingsEmpty>{KIN_REACH_COPY.notJoined(teammate.name)}</KinSettingsEmpty>
        </KinSettingsSection>
      ) : (
        <>
          {agentsLine === null ? null : (
            <KinSettingsSection title={KIN_REACH_COPY.agentsTitle}>
              <KinSettingsEmpty>{agentsLine}</KinSettingsEmpty>
            </KinSettingsSection>
          )}
          <KinPersonReach
            {...target}
            personId={personId}
            name={teammate.name}
            ownerLevel={agentsLine !== null}
            onOpenAgent={props.onClose}
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
        <KinTeammateDevices {...target} personId={personId} />
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
      <KinConfirm
        ask={
          kindCopy === null
            ? null
            : { title: kindCopy.title, detail: kindCopy.detail, action: kindCopy.confirm }
        }
        onConfirm={() => {
          const access = kindAsked;
          if (teammate.personId === null || access === null) return;
          setBusy(true);
          void actions.setAccess(teammate.personId, access).finally(() => setBusy(false));
        }}
        onClose={() => setKindAsked(null)}
      />
      <KinConfirm
        ask={
          confirming
            ? {
                title: removal.title,
                detail: removal.detail,
                action: removal.confirm,
                destructive: true,
              }
            : null
        }
        onConfirm={() => {
          if (teammate.personId !== null) void actions.removeAccess(teammate.personId);
        }}
        onClose={() => setConfirming(false)}
      >
        {personId === null ? null : (
          <KinRemoveHandOver {...target} personId={personId} name={teammate.name} />
        )}
      </KinConfirm>
      {offered.cancel === null ? null : (
        <KinConfirm
          ask={
            cancelling
              ? {
                  title: offered.cancel.title,
                  detail: offered.cancel.detail,
                  action: offered.cancel.label,
                  cancel: offered.cancel.keep,
                  destructive: true,
                }
              : null
          }
          onConfirm={() => {
            if (teammate.inviteId === null) return;
            // Shown at once; the page says so if the host refuses.
            void actions.cancelInvite(teammate.inviteId);
            if (teammate.personId === null) props.onClose();
          }}
          onClose={() => setCancelling(false)}
        />
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
          // Picking whom or what to add from a menu on the title line, as "Restrict messaging with…".
          <Menu>
            <MenuTrigger
              render={<Button size="xs" variant="outline" disabled={save.busy !== null} />}
            >
              <PlusIcon />
              {KIN_TEAMMATE_PROJECTS.add}
            </MenuTrigger>
            <MenuPopup align="end">
              {view.addable.map((row) => (
                <MenuItem key={row.key} onClick={() => void change(row.key, true)}>
                  {row.title}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
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
      description={KIN_TEAM_COPY.sharedAlwaysLine}
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

/** Their Away row, beside their profile on the teammate's own page. */
function KinTeammateAway(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
}) {
  const profile = useKinProfile(props.environmentId, props.orgId, props.personId);
  if (profile === null) return null;
  return (
    <KinAwayRow
      environmentId={props.environmentId}
      orgId={props.orgId}
      profile={profile}
      mine={false}
      mayEdit={profile.canEdit === true}
    />
  );
}

/**
 * Their open tasks, the most urgent first, each opening in Tasks; the last row opens all of them,
 * and "Give all open tasks to…" sits on the title line.
 */
function KinTeammateTasks(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
}) {
  const { environmentId, orgId, personId } = props;
  const navigate = useNavigate();
  const profile = useKinProfile(environmentId, orgId, personId);
  const tasksAtom = kinClient.personTasks({ environmentId, input: { orgId, person: personId } });
  const result = useAtomValue(tasksAtom);
  const { names } = useKinWorkDirectory(props, true);
  const now = new Date(useNowMinuteMs());
  const params = { environmentId, orgId };
  const held = Option.getOrNull(AsyncResult.value(result));
  return (
    <KinSettingsSection
      title={KIN_PERSON_TASKS.title}
      description={
        held === null || held.total === 0 ? undefined : KIN_PERSON_TASKS.count(held.total)
      }
      action={
        profile === null || (profile.load?.open ?? 0) === 0 ? undefined : (
          <KinHandOverButton
            environmentId={environmentId}
            orgId={orgId}
            from={{ _tag: "person", personId }}
            fromName={profile.displayName}
            size="xs"
          />
        )
      }
    >
      {held === null ? (
        AsyncResult.isFailure(result) ? (
          <KinSettingsLoadFailed onRetry={() => appAtomRegistry.refresh(tasksAtom)}>
            {KIN_PERSON_TASKS.failed}
          </KinSettingsLoadFailed>
        ) : (
          <KinSettingsLoading rows={3} />
        )
      ) : held.total === 0 ? (
        <KinSettingsEmpty>{KIN_PERSON_TASKS.none}</KinSettingsEmpty>
      ) : (
        <>
          {held.records.map((record) => {
            const line = kinTaskLine(record, names, now);
            // Late is the one thing not fine, so it is the badge; the rest is the line.
            const late = line.lead?.tone === "late" ? line.lead.text : null;
            const lead = late === null ? (line.lead?.text ?? "") : "";
            return (
              <KinSettingsRow
                key={record.key}
                title={record.title}
                detail={[lead, line.rest].filter((part) => part !== "").join(" · ")}
                status={
                  late === null ? null : (
                    <KinSettingsStatus tone="attention">{late}</KinSettingsStatus>
                  )
                }
                onOpen={() => {
                  void navigate({ to: KIN_PLACE_PATH.tasks, params, search: { task: record.key } });
                }}
              />
            );
          })}
          <KinSettingsRow
            title={KIN_PERSON_TASKS.seeAll}
            onOpen={() => {
              void navigate({ to: KIN_PLACE_PATH.tasks, params, search: { person: personId } });
            }}
          />
        </>
      )}
    </KinSettingsSection>
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
    <div className="flex flex-col gap-2">
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
