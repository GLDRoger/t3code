import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  KIN_DAILY_LIMIT,
  kinDailyLimitChoices,
  kinDailyLimitUsed,
  kinDailyLimitWaiting,
} from "@t3tools/client-runtime/kin/kinBudget";
import { KIN_DEVICES_COPY } from "@t3tools/client-runtime/kin/kinDevices";
import {
  KIN_COMPANY_CHAT_COPY,
  KIN_PROFILE_COPY,
  KIN_TEAM_AGENT_COPY,
  kinRoleLine,
  kinTeamAgentChoices,
  kinTeamAgentLabel,
} from "@t3tools/client-runtime/kin/kinProfiles";
import { kinHomeTabs } from "@t3tools/client-runtime/kin/kinJoin";
import {
  KIN_SETTINGS_PAGE_TITLES,
  kinSettingsGroups,
  type KinSettingsPage,
} from "@t3tools/client-runtime/kin/kinNavigation";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { Fragment, useState } from "react";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useConnectionController } from "../connection/useConnectionController";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSettingsPageBack } from "../settings/useSettingsPageBack";
import { useKinTab } from "./components/KinTab";
import { KinBriefsSection } from "./KinBriefs";
import { KinCheckInsSection } from "./KinCheckIns";
import { useKinIsHome } from "./state/kinHome";
import { openKinNotificationSettings } from "./notifications/installKinNotifications";
import { useChatOnlyEnvironments, useKinOwnerLevel } from "./state/kinChatOnly";
import { kinClient } from "./state/kinClient";
import { useKinInbox } from "./state/useKinInbox";
import { useKinOpenWaiting } from "./state/useKinOpen";
import { useKinProfiles } from "./state/useKinProfiles";
import { useKinReconnect } from "./state/useKinReconnect";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

const noSessionAtom = Atom.make(null);

const CONNECTION_LABEL: Record<EnvironmentPresentation["connection"]["phase"], string> = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  offline: "Offline",
  available: "Not connected",
  error: "Can't connect",
  unsupported: "Update this app",
};

/**
 * Settings where Kin is the whole app: only what this product needs. The owner gets the
 * connection to their Kin, the company (team, agents, memory, schedules), approvals and the app
 * itself, and so does a co-owner; a member gets the app and the way to leave.
 * Drawn as a tab of the Kin home, or as a pushed page where there is no dock.
 */
/** Company pages that open a screen of their own; Check-ins and Approvals are sections here. */
const COMPANY_ROWS: Partial<
  Record<
    KinSettingsPage,
    {
      readonly icon: "person.2" | "robot" | "brain" | "link" | "doc.text";
      readonly route: "KinTeam" | "KinAgents" | "KinMemory" | "KinConnections" | "KinCompany";
    }
  >
> = {
  team: { icon: "person.2", route: "KinTeam" },
  agents: { icon: "robot", route: "KinAgents" },
  connections: { icon: "link", route: "KinConnections" },
  memory: { icon: "brain", route: "KinMemory" },
  company: { icon: "doc.text", route: "KinCompany" },
};

export function KinSettings(props: {
  /** The coding app's Settings already holds environments, sign-out and the app's own pages. */
  readonly inCodingApp?: boolean;
}) {
  const inCodingApp = props.inCodingApp === true;
  const navigation = useNavigation();
  const pushed = useRoute().name !== "Home";
  const settingsBack = useSettingsPageBack();
  const bottomClearance = useKinTab()?.bottomClearance ?? 0;
  const controller = useConnectionController();
  const { environments } = useEnvironments();
  // Signed out or left here: nothing about that computer shows while the phone lets it go.
  const [left, setLeft] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const teammateIds = useChatOnlyEnvironments().filter((id) => !left.has(id));
  const inbox = useKinInbox();
  const { state } = inbox;
  const host: KinHost =
    inbox.host._tag === "host" && left.has(inbox.host.environmentId)
      ? { _tag: "none" }
      : inbox.host;
  const session = useAtomValue(
    host._tag === "host"
      ? environmentSession.sessionStateValueAtom(host.environmentId)
      : noSessionAtom,
  );
  const probe = host._tag === "host" && host.probe._tag === "ready" ? host.probe : null;
  const team = probe?.orgs.orgs[0]?.name ?? null;
  const orgId = probe?.orgs.me[0]?.orgId ?? null;
  const myPersonId = probe?.orgs.me[0]?.personId ?? null;
  const { held: profiles } = useKinProfiles(
    host._tag === "host" ? host.environmentId : null,
    orgId,
  );
  const mine = profiles?.profiles.find((profile) => profile.personId === myPersonId) ?? null;
  const owned = environments.filter(
    (held) =>
      !left.has(held.environmentId) &&
      !teammateIds.includes(held.environmentId) &&
      (!inCodingApp || (host._tag === "host" && held.environmentId === host.environmentId)),
  );
  const ownerLevel = useKinOwnerLevel(host._tag === "host" ? host.environmentId : null, session);
  // The pages below belong to whoever runs this Kin: the owner or a co-owner.
  const company =
    host._tag === "host" && orgId !== null && ownerLevel
      ? { environmentId: host.environmentId, orgId }
      : null;
  const pages = kinHomeTabs(session, ownerLevel);
  // The same You and Company as web Settings; the phone adds its own rows to each.
  const groups = kinSettingsGroups({
    ownerLevel: company !== null,
    computer: false,
    notifications: true,
  });
  const you = groups[0]!;
  const companyGroup = groups.find((group) => group.id === "company");
  const openWaiting = useKinOpenWaiting(host, state._tag === "ready" ? state.inbox.value : null);
  const waiting =
    state._tag === "ready" ? selectKinInboxView(state.inbox.value, openWaiting).waiting.length : 0;

  // Two computers with one name are told apart by the address their rows show.
  const nameOf = (environment: EnvironmentPresentation) =>
    environment.displayUrl !== null &&
    environments.filter((one) => one.label === environment.label).length > 1
      ? `${environment.label} (${environment.displayUrl})`
      : environment.label;
  // The team on screen has its name; an old one this phone still holds goes by its computer and state.
  const teamOf = (environmentId: EnvironmentId) => {
    if (host._tag === "host" && host.environmentId === environmentId) return team;
    const held = environments.find((one) => one.environmentId === environmentId);
    return held === undefined
      ? null
      : `${nameOf(held)} (${CONNECTION_LABEL[held.connection.phase].toLowerCase()})`;
  };
  const forget = (environmentId: EnvironmentId) => {
    setLeft((held) => new Set(held).add(environmentId));
    void controller.removeEnvironment(environmentId).then((result) => {
      if (result._tag === "Success") return;
      setLeft((held) => {
        const next = new Set(held);
        next.delete(environmentId);
        return next;
      });
    });
  };
  const leave = (environmentId: EnvironmentId) =>
    Dialog.alert(
      teamOf(environmentId) === null ? "Leave this team?" : `Leave ${teamOf(environmentId)}?`,
      KIN_DEVICE_COPY.leave("phone"),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: () => forget(environmentId),
        },
      ],
    );
  const signOut = (environment: EnvironmentPresentation) =>
    Dialog.alert(
      owned.length === 1 ? "Sign out of your Kin?" : `Sign out of ${nameOf(environment)}?`,
      "This phone forgets the connection and the chats it holds. To come back, connect it again from the computer that runs your Kin.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => forget(environment.environmentId),
        },
      ],
    );

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={inCodingApp ? "Kin" : "Settings"}
        {...(inCodingApp
          ? settingsBack === undefined
            ? {}
            : { onBack: settingsBack }
          : pushed
            ? { onBack: () => navigation.goBack() }
            : {})}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32 + bottomClearance, gap: 20 }}
        >
          <SettingsSection title={you.title}>
            {you.pages.map((page) => {
              switch (page) {
                case "profile":
                  return host._tag !== "host" || orgId === null || mine === null ? null : (
                    <Fragment key={page}>
                      <SettingsRow
                        icon="person.crop.circle"
                        label={mine.displayName}
                        value={kinRoleLine(mine.roleTags) || KIN_PROFILE_COPY.mine}
                        onPress={() =>
                          navigation.navigate("KinProfile", {
                            environmentId: host.environmentId,
                            orgId,
                            personId: mine.personId,
                          })
                        }
                      />
                      {/* The owner links devices from T3 Code's Sharing & access settings. */}
                      {teammateIds.includes(host.environmentId) ? (
                        <SettingsRow
                          icon="iphone"
                          label={KIN_DEVICES_COPY.title}
                          value={KIN_DEVICES_COPY.rowDetail}
                          onPress={() =>
                            navigation.navigate("KinDevices", {
                              environmentId: host.environmentId,
                              orgId,
                              personId: mine.personId,
                            })
                          }
                        />
                      ) : null}
                    </Fragment>
                  );
                case "notifications":
                  return (
                    <SettingsRow
                      key={page}
                      icon="bell.badge"
                      label={KIN_SETTINGS_PAGE_TITLES.notifications}
                      onPress={() => void openKinNotificationSettings()}
                    />
                  );
                case "appearance":
                  return inCodingApp ? null : (
                    <SettingsRow
                      key={page}
                      icon="paintbrush"
                      label={KIN_SETTINGS_PAGE_TITLES.appearance}
                      onPress={() => navigation.navigate("SettingsAppearance")}
                    />
                  );
                default:
                  return null;
              }
            })}
            {inCodingApp ? null : (
              <SettingsRow
                icon="info.circle"
                label="About"
                onPress={() => navigation.navigate("SettingsAbout")}
              />
            )}
          </SettingsSection>
          {host._tag !== "host" || orgId === null ? null : (
            <KinBriefsSection environmentId={host.environmentId} orgId={orgId} />
          )}
          {owned.length === 0 ? null : (
            <SettingsSection
              title="Your Kin"
              footer="The computer your Kin runs on. This phone talks to it directly."
            >
              {owned.map((environment) => (
                <KinConnection key={environment.environmentId} environment={environment} />
              ))}
            </SettingsSection>
          )}
          {company === null ? null : (
            <>
              <SettingsSection title={companyGroup?.title}>
                {(companyGroup?.pages ?? []).map((page) => {
                  const row = COMPANY_ROWS[page];
                  if (row === undefined) return null;
                  if ((page === "team" || page === "memory") && !pages.includes(page)) return null;
                  return (
                    <SettingsRow
                      key={page}
                      icon={row.icon}
                      label={KIN_SETTINGS_PAGE_TITLES[page]}
                      onPress={() => navigation.navigate(row.route, company)}
                    />
                  );
                })}
              </SettingsSection>
              <SettingsSection footer={KIN_TEAM_AGENT_COPY.detail}>
                <KinTeamAgentRow {...company} />
              </SettingsSection>
              <SettingsSection footer={KIN_COMPANY_CHAT_COPY.detail}>
                <KinCompanyChatRow {...company} />
              </SettingsSection>
              <KinDailyLimitSection {...company} />
              <KinCheckInsSection {...company} />
              <SettingsSection
                title={KIN_SETTINGS_PAGE_TITLES.approvals}
                footer="Your agents ask before anything that needs your say. You approve on this phone with Face ID."
              >
                <SettingsRow
                  icon="exclamationmark.circle"
                  label="Waiting on you"
                  value={waiting === 0 ? "Nothing" : `${waiting}`}
                  valuePosition="trailing"
                  onPress={() => navigation.navigate("KinWaiting")}
                />
                <SettingsRow
                  icon="person.fill.checkmark"
                  label="Approve from this phone"
                  onPress={() => navigation.navigate("KinApprovals", company)}
                />
              </SettingsSection>
            </>
          )}
          {/* The coding app signs out of a computer from Environments. */}
          {(inCodingApp ? [] : owned).map((environment) => (
            <Button
              key={environment.environmentId}
              tone="danger"
              fullWidth
              label={owned.length === 1 ? "Sign out" : `Sign out of ${nameOf(environment)}`}
              onPress={() => signOut(environment)}
            />
          ))}
          {teammateIds.map((environmentId) => (
            <Button
              key={environmentId}
              tone="danger"
              fullWidth
              label={
                teamOf(environmentId) === null
                  ? "Leave this team"
                  : `Leave ${teamOf(environmentId)}`
              }
              onPress={() => leave(environmentId)}
            />
          ))}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** Kin's page in the coding app's Settings; where Kin is the whole app, its own Settings. */
export function KinSettingsScreen() {
  return <KinSettings inCodingApp={!useKinIsHome()} />;
}

/** One computer this phone is connected to: where it stands, and a way to try again now. */
function KinConnection(props: { readonly environment: EnvironmentPresentation }) {
  const { environment } = props;
  const { status, reconnect } = useKinReconnect(environment.environmentId);
  const phase = environment.connection.phase;
  return (
    <>
      <View accessible className="bg-grouped-card">
        <ListRowLayout
          icon="desktopcomputer"
          label={environment.label}
          description={environment.displayUrl ?? undefined}
          detail={status === "failed" ? "Couldn't reconnect" : CONNECTION_LABEL[phase]}
        />
      </View>
      {phase === "connected" || reconnect === null ? null : (
        <ListActionRow
          label={status === "pending" ? "Reconnecting…" : "Reconnect"}
          disabled={status === "pending"}
          onPress={reconnect}
        />
      )}
    </>
  );
}

/**
 * The owner's daily limit as a native menu of plain choices, on this page rather than its own,
 * with the work held for it.
 */
function KinDailyLimitSection(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const target = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const budgetAtom = kinClient.budget(target);
  const result = useAtomValue(budgetAtom);
  const refresh = useAtomRefresh(budgetAtom);
  const canSet = useAtomValue(kinClient.budgetSet.permissionAtom(props.environmentId));
  const set = useAtomCommand(kinClient.budgetSet, { reportFailure: false });
  const budget = Option.getOrNull(AsyncResult.value(result));
  const { choices, current } = kinDailyLimitChoices(budget);
  const label = choices.find((choice) => choice.value === current)?.label ?? "…";
  const waiting = kinDailyLimitWaiting(budget);
  const used = kinDailyLimitUsed(budget);
  return (
    <>
      <SettingsSection
        footer={
          used === null
            ? KIN_DAILY_LIMIT.detail
            : `${KIN_DAILY_LIMIT.used}: ${used}. ${KIN_DAILY_LIMIT.detail}`
        }
      >
        <Menu
          actions={choices.map((choice) => ({
            id: choice.value,
            title: choice.label,
            state: choice.value === current ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => {
            const picked = choices.find((choice) => choice.value === nativeEvent.event);
            if (picked === undefined || picked.value === current) return;
            void set({
              environmentId: props.environmentId,
              input: { orgId: props.orgId, limits: picked.limits },
            }).then((outcome) => {
              if (AsyncResult.isFailure(outcome))
                Dialog.alert(
                  kinFailureText(squashAtomCommandFailure(outcome), KIN_DAILY_LIMIT.failed),
                );
              refresh();
            });
          }}
        >
          <SettingsRow
            icon="chart.bar.xaxis"
            label={KIN_DAILY_LIMIT.title}
            value={label}
            valuePosition="trailing"
            disabled={!canSet || budget === null}
          />
        </Menu>
      </SettingsSection>
      {waiting.length === 0 ? null : (
        <SettingsSection title={KIN_DAILY_LIMIT.waiting}>
          {waiting.map((agent) => (
            <SettingsRow
              key={agent.agentId}
              icon="moon"
              label={agent.name}
              value={agent.line}
              valuePosition="trailing"
            />
          ))}
        </SettingsSection>
      )}
    </>
  );
}

/** Which agent every teammate can chat with, or Off. Picked here, beside the team it serves. */
function KinTeamAgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const leadsAtom = kinClient.leads({
    environmentId: props.environmentId,
    input: { orgId: props.orgId },
  });
  const result = useAtomValue(leadsAtom);
  const refresh = useAtomRefresh(leadsAtom);
  const canSet = useAtomValue(kinClient.teamAgentSet.permissionAtom(props.environmentId));
  const set = useAtomCommand(kinClient.teamAgentSet, { reportFailure: false });
  const list = Option.getOrNull(AsyncResult.value(result));
  const leads = list?.leads ?? [];
  const current = list?.teamAgentId ?? null;
  const choices = kinTeamAgentChoices(leads);
  return (
    <Menu
      actions={choices.map((choice) => ({
        id: choice.agentId ?? "off",
        title: choice.label,
        ...(choice.suggested ? { subtitle: KIN_TEAM_AGENT_COPY.suggested } : {}),
        state: choice.agentId === current ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const picked = choices.find((choice) => (choice.agentId ?? "off") === nativeEvent.event);
        if (picked === undefined || picked.agentId === current) return;
        void set({
          environmentId: props.environmentId,
          input: { orgId: props.orgId, agentId: picked.agentId },
        }).then((outcome) => {
          if (AsyncResult.isFailure(outcome))
            Dialog.alert(
              kinFailureText(squashAtomCommandFailure(outcome), KIN_TEAM_AGENT_COPY.failed),
            );
          refresh();
        });
      }}
    >
      <SettingsRow
        icon="bubble.left.and.bubble.right"
        label={KIN_TEAM_AGENT_COPY.label}
        value={list === null ? "…" : kinTeamAgentLabel(leads, current)}
        valuePosition="trailing"
        disabled={!canSet || list === null}
      />
    </Menu>
  );
}

/** The company chat: Off, or on with the agent that answers when nobody is named. */
function KinCompanyChatRow(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const leadsAtom = kinClient.leads({
    environmentId: props.environmentId,
    input: { orgId: props.orgId },
  });
  const result = useAtomValue(leadsAtom);
  const refresh = useAtomRefresh(leadsAtom);
  const canSet = useAtomValue(kinClient.groupSetCompany.permissionAtom(props.environmentId));
  const set = useAtomCommand(kinClient.groupSetCompany, { reportFailure: false });
  const list = Option.getOrNull(AsyncResult.value(result));
  const current = list?.companyChat?.leadAgentId ?? null;
  const choices = kinTeamAgentChoices(list?.leads ?? []);
  const label = (agentId: string | null, name: string) =>
    agentId === null ? name : `On, ${name} answers`;
  const shown = choices.find((choice) => choice.agentId === current);
  return (
    <Menu
      actions={choices.map((choice) => ({
        id: choice.agentId ?? "off",
        title: label(choice.agentId, choice.label),
        state: choice.agentId === current ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const picked = choices.find((choice) => (choice.agentId ?? "off") === nativeEvent.event);
        if (picked === undefined || picked.agentId === current) return;
        void set({
          environmentId: props.environmentId,
          input: { orgId: props.orgId, leadAgentId: picked.agentId },
        }).then((outcome) => {
          if (AsyncResult.isFailure(outcome))
            Dialog.alert(
              kinFailureText(squashAtomCommandFailure(outcome), KIN_COMPANY_CHAT_COPY.failed),
            );
          refresh();
        });
      }}
    >
      <SettingsRow
        icon="person.2"
        label={KIN_COMPANY_CHAT_COPY.label}
        value={list === null ? "…" : shown === undefined ? "Off" : shown.label}
        valuePosition="trailing"
        disabled={!canSet || list === null}
      />
    </Menu>
  );
}
