import { KIN_REACH_COPY } from "@t3tools/client-runtime/kin/kinReach";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_ACCESS_CHOICES,
  KIN_PLACE_SWITCHES,
  kinAccessChangeCopy,
  kinRemoveAccessCopy,
  KIN_TEAMMATE_FOLDS,
  kinFoldCount,
  kinTeamView,
  kinTeammateActions,
  kinTeammateAgentsLine,
  kinTeammateKind,
  kinTeammatePage,
  type KinMadeInvite,
  type KinTeammate,
  KIN_TEAM_COPY,
} from "@t3tools/client-runtime/kin/kinTeam";
import {
  EnvironmentId,
  KinOrgId,
  kinOwnerLevel,
  type KinPersonAccess,
  type KinPersonId,
  type KinPersonPlaceSwitches,
  type KinPersonPlaces,
  type KinRecordKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { KIN_PROFILE_COPY } from "@t3tools/client-runtime/kin/kinProfiles";
import { KIN_HAND_OVER } from "@t3tools/client-runtime/kin/kinHandOver";
import { kinAwayLine } from "@t3tools/client-runtime/kin/kinAway";
import { kinActiveDevices } from "@t3tools/client-runtime/kin/kinDevices";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_PROJECT_PEOPLE,
  KIN_TEAMMATE_PROJECTS,
  kinTeammateProjects,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { IconButton } from "../../components/ui/IconButton";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../state/atom-registry";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { KinAvatar } from "./components/KinAvatar";
import { KinAwaySection, KinHandOverRow } from "./components/KinAway";
import { KinPersonTasks } from "./components/KinPersonTasks";
import { KinDeviceList } from "./KinDevicesScreen";
import { KinInviteLink } from "./components/KinInviteLink";
import { KinPageFold } from "./components/KinPageFold";
import { kinClient } from "./state/kinClient";
import { KinPersonReachSections } from "./KinReachSections";
import { refreshKinTeam, useKinTeam, type KinTeamTarget } from "./state/useKinTeam";
import { useKinOpenCounts, useKinProfiles } from "./state/useKinProfiles";
import { KinWorkToggleRow } from "./components/KinWorkPieces";

export type KinTeammateParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The row's key on the Team page: a person, or an invite nobody has opened. */
  readonly teammate: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** One teammate: which leads they can message, their link, and the way to take access away. */
export function KinTeammateScreen({ route }: StaticScreenProps<KinTeammateParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <Frame title="Teammate" onClose={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a teammate"
          detail="Open Team from your Kin chats."
        />
      </Frame>
    );
  }
  return (
    <KinTeammateBody environmentId={environmentId} orgId={orgId} rowKey={route.params.teammate} />
  );
}

function Frame(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={props.title} onClose={props.onClose} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function KinTeammateBody(props: KinTeamTarget & { readonly rowKey: string }) {
  const navigation = useNavigation();
  const team = useKinTeam(props);
  // Held here and nowhere else; closing the sheet drops it.
  const [made, setMade] = useState<KinMadeInvite | null>(null);
  const close = () => navigation.goBack();
  if (made !== null) {
    return (
      <Frame title="Invite link" onClose={close}>
        <KinInviteLink invite={made} environmentId={props.environmentId} />
      </Frame>
    );
  }
  const teammate =
    team.list === null
      ? null
      : (kinTeamView(team.list, team.edits, team.ownerPersonId).find(
          (row) => row.key === props.rowKey,
        ) ?? null);
  if (team.list === null || teammate === null) {
    return (
      <Frame title="Teammate" onClose={close}>
        {team.list === null && team.allowed && !team.failed ? (
          <View className="items-center py-12">
            <AppActivityIndicator />
          </View>
        ) : (
          <EmptyState
            variant="plain"
            title="This person isn't here any more"
            detail="Their invite was cancelled or has been used. Open Team to see who is on it now."
          />
        )}
      </Frame>
    );
  }
  return (
    <Frame title="Teammate" onClose={close}>
      <KinTeammateDetails
        target={props}
        teammate={teammate}
        actions={team.actions}
        viewer={team.viewer}
        problem={team.edits.problem}
        onMade={setMade}
        onClose={close}
      />
    </Frame>
  );
}

function KinTeammateDetails(props: {
  readonly target: KinTeamTarget;
  readonly teammate: KinTeammate;
  readonly actions: ReturnType<typeof useKinTeam>["actions"];
  readonly viewer: KinPersonAccess;
  readonly problem: string | null;
  readonly onMade: (invite: KinMadeInvite) => void;
  readonly onClose: () => void;
}) {
  const { teammate, actions } = props;
  const navigation = useNavigation();
  const offered = kinTeammateActions(teammate, props.viewer);
  // The host says whose profile this reader may change: the owner's and a co-owner's alike.
  const profiles = useKinProfiles(props.target.environmentId, props.target.orgId).held;
  useKinOpenCounts(props.target);
  const profile = profiles?.profiles.find((held) => held.personId === teammate.personId) ?? null;
  const mayEdit = profile?.canEdit ?? props.viewer === "owner";
  const openTasks = kinOwnerLevel(props.viewer) ? (profile?.load?.open ?? 0) : 0;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const makeLink = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await actions.makeLink({
      displayName: teammate.name,
      personId: teammate.personId,
      replaces: teammate.inviteId,
    });
    setBusy(false);
    if (result.ok) props.onMade(result.invite);
    else setProblem(result.problem);
  };

  const askRemove = () => {
    const { personId } = teammate;
    if (personId === null) return;
    const copy = kinRemoveAccessCopy(teammate.name);
    Dialog.confirm({
      title: copy.title,
      message:
        openTasks === 0
          ? copy.detail
          : `${copy.detail}\n\n${KIN_HAND_OVER.removeOffer(openTasks, teammate.name)}`,
      confirmText: copy.confirm,
      destructive: true,
      onConfirm: () => void actions.removeAccess(personId),
    });
  };

  const askKind = (access: (typeof KIN_ACCESS_CHOICES)[number]["access"]) => {
    const { personId } = teammate;
    if (personId === null || access === kinTeammateKind(teammate)) return;
    const copy = kinAccessChangeCopy(teammate.name, access, teammate.backAs !== null);
    Dialog.confirm({
      title: copy.title,
      message: copy.detail,
      confirmText: copy.confirm,
      onConfirm: () => {
        setBusy(true);
        void actions.setAccess(personId, access).finally(() => setBusy(false));
      },
    });
  };

  const shown = problem ?? props.problem;
  const page = kinTeammatePage(teammate, props.viewer);
  const away = profile === null ? null : kinAwayLine(profile, { mine: false });
  const linkSection =
    offered.link === null ? null : (
      <ListSection title="Invite link" footer={offered.link.hint}>
        <ListActionRow
          label={offered.link.label}
          icon="link"
          loading={busy}
          disabled={busy}
          onPress={() => void makeLink()}
        />
        {offered.cancel === null ? null : (
          <View className="border-t border-border-subtle">
            <ListActionRow
              label={offered.cancel.label}
              icon="xmark"
              disabled={busy}
              onPress={() => {
                const { inviteId } = teammate;
                const { cancel } = offered;
                if (inviteId === null || cancel === null) return;
                Dialog.confirm({
                  title: cancel.title,
                  message: cancel.detail,
                  confirmText: cancel.label,
                  cancelText: cancel.keep,
                  destructive: true,
                  onConfirm: () => {
                    // Shown at once; the Team page says so if the host refuses.
                    void actions.cancelInvite(inviteId);
                    if (teammate.personId === null) props.onClose();
                  },
                });
              }}
            />
          </View>
        )}
      </ListSection>
    );
  const { personId } = teammate;
  return (
    <>
      <View className="items-center gap-3 pt-2">
        <KinAvatar avatar={teammate.avatar} size="large" />
        <View className="items-center gap-1">
          <Text textRole="title" className="text-center font-t3-bold text-foreground">
            {teammate.name}
          </Text>
          <Text textRole="footnote" className="text-center text-foreground-muted">
            {teammate.detail}
          </Text>
          {teammate.roles === "" ? null : (
            <Text textRole="footnote" className="text-center text-foreground-muted">
              {teammate.roles}
            </Text>
          )}
          {away === null ? null : (
            <Text textRole="footnote" className="text-center text-foreground">
              {away}
            </Text>
          )}
        </View>
      </View>
      {shown === null ? null : <ErrorBanner message={shown} />}
      {page.canSee && teammate.places !== null && personId !== null ? (
        <KinTeammatePlaces target={props.target} personId={personId} places={teammate.places} />
      ) : null}
      {page.canDo ? (
        <ListSection
          title={teammate.backAs === null ? KIN_TEAM_COPY.canDo : KIN_TEAM_COPY.canDoBack}
        >
          {KIN_ACCESS_CHOICES.map((choice, index) => (
            <ListChoiceRow
              key={choice.access}
              label={choice.label}
              description={choice.detail}
              selected={kinTeammateKind(teammate) === choice.access}
              separated={index > 0}
              disabled={busy}
              onPress={() => askKind(choice.access)}
            />
          ))}
        </ListSection>
      ) : null}
      {personId === null ? (
        <ListSection title="Agents">
          <View className="px-4 py-3">
            <Text textRole="body" className="text-foreground-muted">
              {KIN_REACH_COPY.notJoined(teammate.name)}
            </Text>
          </View>
        </ListSection>
      ) : (
        page.folds.map((fold) => {
          switch (fold) {
            case "tasks":
              return (
                <KinPageFold
                  key={fold}
                  title={KIN_TEAMMATE_FOLDS.tasks}
                  summary={teammate.load === "" ? null : teammate.load}
                >
                  <KinPersonTasks
                    environmentId={props.target.environmentId}
                    orgId={props.target.orgId}
                    personId={personId}
                    {...(offered.remove && openTasks > 0
                      ? { footer: KIN_HAND_OVER.removeOffer(openTasks, teammate.name) }
                      : {})}
                  >
                    {profile === null || openTasks === 0 ? null : (
                      <KinHandOverRow
                        environmentId={props.target.environmentId}
                        orgId={props.target.orgId}
                        from={{ _tag: "person", personId: profile.personId }}
                        fromName={profile.displayName}
                      />
                    )}
                  </KinPersonTasks>
                </KinPageFold>
              );
            case "projects":
              return (
                <KinTeammateProjectsFold key={fold} target={props.target} personId={personId} />
              );
            case "reach":
              return (
                <KinPageFold key={fold} title={KIN_TEAMMATE_FOLDS.reach} summary={null}>
                  {kinTeammateAgentsLine(teammate) === null ? null : (
                    <ListSection title="Agents">
                      <View className="px-4 py-3">
                        <Text textRole="body" className="text-foreground-muted">
                          {kinTeammateAgentsLine(teammate)}
                        </Text>
                      </View>
                    </ListSection>
                  )}
                  <KinPersonReachSections
                    environmentId={props.target.environmentId}
                    orgId={props.target.orgId}
                    personId={personId}
                    name={teammate.name}
                    ownerLevel={kinTeammateAgentsLine(teammate) !== null}
                  />
                </KinPageFold>
              );
            case "profile":
              return (
                <KinPageFold key={fold} title={KIN_TEAMMATE_FOLDS.profile} summary={null}>
                  <ListSection>
                    <ListRow
                      label={KIN_PROFILE_COPY.title}
                      description={KIN_TEAM_COPY.profileRow}
                      icon="person.crop.circle"
                      onPress={() =>
                        navigation.navigate("KinProfile", {
                          ...props.target,
                          personId,
                          over: "teammate",
                        })
                      }
                    />
                    {/* Their page is the record: their profile is edited in a sheet on it. */}
                    {mayEdit ? (
                      <View className="border-t border-border-subtle">
                        <ListActionRow
                          icon="pencil"
                          label={KIN_PROFILE_COPY.edit}
                          onPress={() =>
                            navigation.navigate("KinProfileEdit", { ...props.target, personId })
                          }
                        />
                      </View>
                    ) : null}
                  </ListSection>
                  {profile === null ? null : (
                    <KinAwaySection
                      environmentId={props.target.environmentId}
                      orgId={props.target.orgId}
                      profile={profile}
                      mine={false}
                      mayEdit={profile.canEdit === true}
                    />
                  )}
                </KinPageFold>
              );
            case "devices":
              return (
                <KinTeammateDevicesFold
                  key={fold}
                  target={{ ...props.target, personId }}
                  link={page.link === "devices" ? linkSection : null}
                />
              );
          }
        })
      )}
      {page.link === "open" ? linkSection : null}
      {page.remove ? (
        <ListSection>
          <ListActionRow
            label="Remove access"
            icon="person.fill.xmark"
            tone="danger"
            disabled={busy}
            onPress={askRemove}
          />
        </ListSection>
      ) : null}
    </>
  );
}

/** Their projects, folded under a count. */
function KinTeammateProjectsFold(props: {
  readonly target: KinTeamTarget;
  readonly personId: KinPersonId;
}) {
  const { environmentId, orgId } = props.target;
  const read = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        kinClient.teammateProjects({ environmentId, input: { orgId, person: props.personId } }),
      ),
    ),
  );
  const count =
    read === null ? null : kinTeammateProjects(props.personId, read.theirs, read.open).rows.length;
  return (
    <KinPageFold
      title={KIN_TEAMMATE_FOLDS.projects}
      summary={kinFoldCount(count, "project", "projects")}
    >
      <KinTeammateProjects target={props.target} personId={props.personId} />
    </KinPageFold>
  );
}

/** The devices signed in as them, and a link for another one, folded under a count. */
function KinTeammateDevicesFold(props: {
  readonly target: KinTeamTarget & { readonly personId: KinPersonId };
  readonly link: React.ReactNode;
}) {
  const { environmentId, orgId, personId } = props.target;
  const held = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(kinClient.devices({ environmentId, input: { orgId, personId } })),
    ),
  );
  const nowMs = useNowMinuteMs();
  const count = held === null ? null : kinActiveDevices(held.devices, nowMs).length;
  return (
    <KinPageFold
      title={KIN_TEAMMATE_FOLDS.devices}
      summary={kinFoldCount(count, "device", "devices")}
    >
      <KinDeviceList target={props.target} self={false} />
      {props.link}
    </KinPageFold>
  );
}

/** A member's places beyond Tasks. */
function KinTeammatePlaces(props: {
  readonly target: KinTeamTarget;
  readonly personId: KinPersonId;
  readonly places: KinPersonPlaces;
}) {
  const { target, personId, places } = props;
  // What the owner just switched, shown until the host's next read agrees or refuses.
  const [asked, setAsked] = useState<Partial<KinPersonPlaceSwitches>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const flip = async (place: keyof KinPersonPlaceSwitches, on: boolean) => {
    setProblem(null);
    setAsked((held) => ({ ...held, [place]: on }));
    const result = await runAtomCommand(
      appAtomRegistry,
      kinClient.personSetPlaces,
      {
        environmentId: target.environmentId,
        input: { orgId: target.orgId, personId, [place]: on },
      },
      { label: "kin:person:set-places", reportFailure: false, reportDefect: true },
    );
    if (AsyncResult.isFailure(result))
      setProblem(kinFailureText(squashAtomCommandFailure(result), KIN_TEAM_COPY.saveFailed));
    await refreshKinTeam(target);
    setAsked((held) => {
      const rest = { ...held };
      delete rest[place];
      return rest;
    });
  };
  return (
    <>
      <ListSection title={KIN_TEAM_COPY.canSee} footer={problem ?? KIN_TEAM_COPY.sharedAlways}>
        {KIN_PLACE_SWITCHES.map((entry, index) => (
          <View
            key={entry.place}
            className={index === 0 ? undefined : "border-t border-border-subtle"}
          >
            <KinWorkToggleRow
              label={entry.label}
              description={entry.detail}
              value={asked[entry.place] ?? places[entry.place]}
              disabled={asked[entry.place] !== undefined}
              onValueChange={(on) => void flip(entry.place, on)}
            />
          </View>
        ))}
      </ListSection>
    </>
  );
}

/** The projects a member is on, and the way to put them on one or take them off. */
function KinTeammateProjects(props: {
  readonly target: KinTeamTarget;
  readonly personId: KinPersonId;
}) {
  const navigation = useNavigation();
  const { personId } = props;
  const { environmentId, orgId } = props.target;
  const query = kinClient.teammateProjects({ environmentId, input: { orgId, person: personId } });
  const result = useAtomValue(query);
  const canChange = useAtomValue(kinClient.workProjectPeople.permissionAtom(environmentId));
  const people = useAtomCommand(kinClient.workProjectPeople, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const read = Option.getOrNull(AsyncResult.value(result));
  const view = read === null ? null : kinTeammateProjects(personId, read.theirs, read.open);
  const change = async (key: KinRecordKey, on: boolean) => {
    setBusy(true);
    setProblem(null);
    const who = [{ _tag: "person" as const, personId }];
    const outcome = await people({
      environmentId,
      input: { orgId, key, ...(on ? { add: who } : { remove: who }) },
    });
    if (AsyncResult.isFailure(outcome))
      setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_PROJECT_PEOPLE.failed));
    appAtomRegistry.refresh(query);
    setBusy(false);
  };
  return (
    <ListSection
      title={KIN_TEAMMATE_PROJECTS.title}
      footer={problem ?? KIN_TEAMMATE_PROJECTS.leadHint}
    >
      {view === null ? (
        <View className="items-center py-4">
          <AppActivityIndicator />
        </View>
      ) : view.rows.length === 0 ? (
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground-muted">
            {KIN_TEAMMATE_PROJECTS.none}
          </Text>
        </View>
      ) : (
        view.rows.map((row, index) => (
          <View
            key={row.key}
            className={cn("flex-row items-center", index > 0 && "border-t border-border-subtle")}
          >
            <View className="min-w-0 flex-1">
              <ListRow
                label={row.title}
                detail={row.line}
                onPress={() =>
                  navigation.navigate("KinProject", { environmentId, orgId, project: row.key })
                }
              />
            </View>
            {canChange && row.removable ? (
              <View className="pr-2">
                <IconButton
                  icon="xmark"
                  accessibilityLabel={KIN_TEAMMATE_PROJECTS.remove(row.title)}
                  disabled={busy}
                  onPress={() => void change(row.key, false)}
                />
              </View>
            ) : null}
          </View>
        ))
      )}
      {view === null || !canChange || view.addable.length === 0 ? null : (
        <View className="border-t border-border-subtle">
          <Menu
            title={KIN_TEAMMATE_PROJECTS.add}
            accessibilityLabel={KIN_TEAMMATE_PROJECTS.add}
            actions={view.addable.map((row) => ({ id: row.key, title: row.title }))}
            onPressAction={({ nativeEvent }) => {
              const row = view.addable.find((one) => one.key === nativeEvent.event);
              if (row !== undefined && !busy) void change(row.key, true);
            }}
          >
            <View pointerEvents="none">
              <ListRowLayout icon="plus" label={KIN_TEAMMATE_PROJECTS.add} disabled={busy} />
            </View>
          </Menu>
        </View>
      )}
    </ListSection>
  );
}
