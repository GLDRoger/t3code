import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, useRoute } from "@react-navigation/native";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  KIN_DAILY_LIMIT,
  kinDailyLimitChoices,
  kinDailyLimitUse,
  kinDailyLimitWaiting,
} from "@t3tools/client-runtime/kin/kinBudget";
import { KIN_COMPANY } from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { KIN_CONNECTIONS_COPY } from "@t3tools/client-runtime/kin/kinConnections";
import {
  KIN_PROFILE_COPY,
  KIN_TEAM_AGENT_COPY,
  kinRoleLine,
  kinTeamAgentChoices,
  kinTeamAgentLabel,
} from "@t3tools/client-runtime/kin/kinProfiles";
import { kinHomeTabs } from "@t3tools/client-runtime/kin/kinJoin";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
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
import { useKinIsHome } from "./state/kinHome";
import { openKinNotificationSettings } from "./notifications/installKinNotifications";
import { useChatOnlyEnvironments, useKinOwnerLevel } from "./state/kinChatOnly";
import { kinClient } from "./state/kinClient";
import { useKinInbox } from "./state/useKinInbox";
import { useKinProfiles } from "./state/useKinProfiles";
import { useKinReconnect } from "./state/useKinReconnect";

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
  const teammateIds = useChatOnlyEnvironments();
  const { host, state } = useKinInbox();
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
  const waiting = state._tag === "ready" ? selectKinInboxView(state.inbox.value).waiting.length : 0;

  const leave = (environmentId: EnvironmentId) =>
    Dialog.alert(
      team === null ? "Leave this team?" : `Leave ${team}?`,
      "You'll be signed out on this phone and its chats will be removed from it. To come back, ask your team for a new join link.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: () => void controller.removeEnvironment(environmentId),
        },
      ],
    );
  const signOut = (environment: EnvironmentPresentation) =>
    Dialog.alert(
      owned.length === 1 ? "Sign out of your Kin?" : `Sign out of ${environment.label}?`,
      "This phone forgets the connection and the chats it holds. To come back, connect it again from the computer that runs your Kin.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => void controller.removeEnvironment(environment.environmentId),
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
          {host._tag !== "host" || orgId === null || mine === null ? null : (
            <SettingsSection title={team ?? undefined}>
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
            </SettingsSection>
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
              <SettingsSection title="Company">
                {pages.includes("team") ? (
                  <SettingsRow
                    icon="person.2"
                    label="Team"
                    onPress={() => navigation.navigate("KinTeam", company)}
                  />
                ) : null}
                <SettingsRow
                  icon="sparkles"
                  label="Agents"
                  onPress={() => navigation.navigate("KinAgents", company)}
                />
                {pages.includes("memory") ? (
                  <SettingsRow
                    icon="brain"
                    label="Memory"
                    onPress={() => navigation.navigate("KinMemory", company)}
                  />
                ) : null}
                <SettingsRow
                  icon="link"
                  label={KIN_CONNECTIONS_COPY.title}
                  onPress={() => navigation.navigate("KinConnections", company)}
                />
                <SettingsRow
                  icon="doc.text"
                  label={KIN_COMPANY.title}
                  onPress={() => navigation.navigate("KinCompany", company)}
                />
                <SettingsRow
                  icon="clock"
                  label="Scheduled tasks"
                  onPress={() => navigation.navigate("SettingsScheduledTasks")}
                />
              </SettingsSection>
              <SettingsSection footer={KIN_TEAM_AGENT_COPY.detail}>
                <KinTeamAgentRow {...company} />
              </SettingsSection>
              <KinDailyLimitSection {...company} />
              <SettingsSection
                title="Approvals"
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
          <SettingsSection>
            <SettingsRow
              icon="bell.badge"
              label="Notifications"
              onPress={() => void openKinNotificationSettings()}
            />
            {inCodingApp ? null : (
              <>
                <SettingsRow
                  icon="paintbrush"
                  label="Appearance"
                  onPress={() => navigation.navigate("SettingsAppearance")}
                />
                <SettingsRow
                  icon="info.circle"
                  label="About"
                  onPress={() => navigation.navigate("SettingsAbout")}
                />
              </>
            )}
          </SettingsSection>
          {/* The coding app signs out of a computer from Environments. */}
          {(inCodingApp ? [] : owned).map((environment) => (
            <Button
              key={environment.environmentId}
              tone="danger"
              fullWidth
              label={owned.length === 1 ? "Sign out" : `Sign out of ${environment.label}`}
              onPress={() => signOut(environment)}
            />
          ))}
          {teammateIds.map((environmentId) => (
            <Button
              key={environmentId}
              tone="danger"
              fullWidth
              label={team === null ? "Leave this team" : `Leave ${team}`}
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
 * with today's use and the work held for it.
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
  const use = kinDailyLimitUse(budget);
  const waiting = kinDailyLimitWaiting(budget);
  return (
    <>
      <SettingsSection
        footer={use === null ? KIN_DAILY_LIMIT.detail : `${KIN_DAILY_LIMIT.detail}\n\n${use}`}
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
              if (AsyncResult.isFailure(outcome)) Dialog.alert(KIN_DAILY_LIMIT.failed);
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
          if (AsyncResult.isFailure(outcome)) Dialog.alert(KIN_TEAM_AGENT_COPY.failed);
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
