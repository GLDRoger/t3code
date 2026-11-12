import { useAtomValue } from "@effect/atom-react";
import { useNavigation, useRoute } from "@react-navigation/native";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import { kinHomeTabs } from "@t3tools/client-runtime/kin/kinJoin";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { environmentSession } from "../../state/session";
import { useConnectionController } from "../connection/useConnectionController";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useKinTab } from "./components/KinTab";
import { openKinNotificationSettings } from "./notifications/installKinNotifications";
import { useChatOnlyEnvironments } from "./state/kinChatOnly";
import { kinClient } from "./state/kinClient";
import { useKinInbox } from "./state/useKinInbox";
import { useKinReconnect } from "./state/useKinReconnect";

const noMembersAtom = Atom.make(null);
const noSessionAtom = Atom.make(null);

/** The name the team knows the viewer by; a chat's member list is the only place a teammate's session can read it. */
function useMyName(): string | null {
  const { host, state } = useKinInbox();
  const chatId = state._tag === "ready" ? (state.inbox.value.chats[0]?.chatId ?? null) : null;
  const members = useAtomValue(
    state._tag !== "ready" || chatId === null
      ? noMembersAtom
      : kinClient.chatMembers({ environmentId: state.environmentId, input: { chatId } }),
  );
  if (members === null || host._tag !== "host" || host.probe._tag !== "ready") return null;
  const me = new Set<string>(host.probe.orgs.me.map((mine) => mine.personId));
  return (
    Option.getOrNull(AsyncResult.value(members))?.members.find(
      (member) => member.principal._tag === "person" && me.has(member.principal.personId),
    )?.displayName ?? null
  );
}

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
 * itself; a teammate, whose session reaches none of the rest, gets the app and the way to leave.
 * Drawn as a tab of the Kin home, or as a pushed page where there is no dock.
 */
export function KinSettings(props: {
  /** The coding app's Settings already holds environments, sign-out and the app's own pages. */
  readonly inCodingApp?: boolean;
}) {
  const inCodingApp = props.inCodingApp === true;
  const navigation = useNavigation();
  const pushed = useRoute().name !== "Home";
  const bottomClearance = useKinTab()?.bottomClearance ?? 0;
  const controller = useConnectionController();
  const { environments } = useEnvironments();
  const teammateIds = useChatOnlyEnvironments();
  const { host, state } = useKinInbox();
  const name = useMyName();
  const session = useAtomValue(
    host._tag === "host"
      ? environmentSession.sessionStateValueAtom(host.environmentId)
      : noSessionAtom,
  );
  const probe = host._tag === "host" && host.probe._tag === "ready" ? host.probe : null;
  const team = probe?.orgs.orgs[0]?.name ?? null;
  const orgId = probe?.orgs.me[0]?.orgId ?? null;
  const owned = environments.filter(
    (held) =>
      !teammateIds.includes(held.environmentId) &&
      (!inCodingApp || (host._tag === "host" && held.environmentId === host.environmentId)),
  );
  // The pages below belong to whoever runs this Kin; a teammate's session would be refused.
  const company =
    host._tag === "host" && orgId !== null && !teammateIds.includes(host.environmentId)
      ? { environmentId: host.environmentId, orgId }
      : null;
  const pages = kinHomeTabs(session);
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
        {...(pushed ? { onBack: () => navigation.goBack() } : {})}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32 + bottomClearance, gap: 20 }}
        >
          {teammateIds.length === 0 || (name === null && team === null) ? null : (
            <SettingsSection>
              <View accessible className="bg-grouped-card">
                <ListRowLayout
                  icon="person.crop.circle"
                  label={name ?? "You"}
                  description={team ?? undefined}
                />
              </View>
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
                  icon="clock"
                  label="Scheduled tasks"
                  onPress={() => navigation.navigate("SettingsScheduledTasks")}
                />
              </SettingsSection>
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

/** Kin's page in the coding app's Settings, for an owner who reaches Kin from the brand switch. */
export function KinSettingsScreen() {
  return <KinSettings inCodingApp />;
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
