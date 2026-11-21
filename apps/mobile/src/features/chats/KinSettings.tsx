import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import { KIN_DEVICES_COPY } from "@t3tools/client-runtime/kin/kinDevices";
import { KIN_PROFILE_COPY, kinRoleLine } from "@t3tools/client-runtime/kin/kinProfiles";
import {
  KIN_NOTIFICATIONS_OPENS,
  KIN_SET_UP_ON_COMPUTER,
  KIN_SETTINGS_PAGE_TITLES,
  kinPhoneSettingsRows,
  type KinPhoneSettingsRow,
} from "@t3tools/client-runtime/kin/kinNavigation";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { Fragment, useState } from "react";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
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
import { useSettingsPageBack } from "../settings/useSettingsPageBack";
import { useKinTab, kinTabFoot } from "./components/KinTab";
import { KinBriefsSection } from "./KinBriefs";
import { useKinIsHome } from "./state/kinHome";
import { openKinNotificationSettings } from "./notifications/installKinNotifications";
import { KinStopRows } from "./KinStopRows";
import { useChatOnlyEnvironments, useKinOwnerLevel } from "./state/kinChatOnly";
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
 * Settings where Kin is the whole app: what is used in the day. Everyone has themselves, their
 * notifications, appearance and briefs; the owner and a co-owner add the company's day-to-day
 * pages and Stop all agents. Set-up pages are on the computer, and one line says so.
 * Drawn as a tab of the Kin home, or as a pushed page where there is no dock.
 */
const COMPANY_ROWS: Partial<
  Record<
    KinPhoneSettingsRow,
    {
      readonly icon: "person.2" | "robot" | "doc.text";
      readonly route: "KinTeam" | "KinAgents" | "KinCompany";
      readonly title: string;
    }
  >
> = {
  team: { icon: "person.2", route: "KinTeam", title: KIN_SETTINGS_PAGE_TITLES.team },
  agents: { icon: "robot", route: "KinAgents", title: KIN_SETTINGS_PAGE_TITLES.agents },
  company: { icon: "doc.text", route: "KinCompany", title: KIN_SETTINGS_PAGE_TITLES.company },
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
  const rows = kinPhoneSettingsRows({ ownerLevel: company !== null });

  // Two computers with one name are told apart by the address their rows show.
  const nameOf = (environment: EnvironmentPresentation) =>
    environment.displayUrl !== null &&
    environments.filter((one) => one.label === environment.label).length > 1
      ? `${environment.label} (${shortAddress(environment.displayUrl)})`
      : environment.label;
  // The team on screen has its name; an old one this phone still holds goes by its computer's.
  const teamOf = (environmentId: EnvironmentId) =>
    host._tag === "host" && host.environmentId === environmentId
      ? team
      : (environments.find((one) => one.environmentId === environmentId)?.label ?? null);
  const heldTeams = environments.filter(
    (held) =>
      teammateIds.includes(held.environmentId) &&
      !(host._tag === "host" && host.environmentId === held.environmentId),
  );
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
      teamOf(environmentId) === null
        ? KIN_DEVICE_COPY.leaveTeamTitle
        : `Leave ${teamOf(environmentId)}?`,
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
          contentContainerStyle={{
            padding: 16,
            paddingBottom: kinTabFoot(bottomClearance),
            gap: 20,
          }}
        >
          <SettingsSection title="You">
            {rows.you.map((page) => {
              switch (page) {
                case "profile":
                  return host._tag !== "host" || orgId === null || mine === null ? null : (
                    <Fragment key={page}>
                      <SettingsRow
                        labelWholeWords
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
                          labelWholeWords
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
                      labelWholeWords
                      key={page}
                      icon="bell.badge"
                      label={KIN_SETTINGS_PAGE_TITLES.notifications}
                      value={KIN_NOTIFICATIONS_OPENS}
                      valuePosition="below"
                      onPress={() => void openKinNotificationSettings()}
                    />
                  );
                case "appearance":
                  return inCodingApp ? null : (
                    <SettingsRow
                      labelWholeWords
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
          </SettingsSection>
          {host._tag !== "host" || orgId === null ? null : (
            <KinBriefsSection
              environmentId={host.environmentId}
              orgId={orgId}
              checkIns={company !== null}
            />
          )}
          {company === null ? null : (
            <>
              <SettingsSection title="Company">
                {rows.company.map((page) => {
                  const row = COMPANY_ROWS[page];
                  if (row === undefined) return null;
                  return (
                    <SettingsRow
                      labelWholeWords
                      key={page}
                      icon={row.icon}
                      label={row.title}
                      onPress={() => navigation.navigate(row.route, company)}
                    />
                  );
                })}
              </SettingsSection>
              {rows.company.includes("stop") ? <KinStopRows {...company} /> : null}
              <Text textRole="footnote" className="px-4 text-foreground-muted">
                {KIN_SET_UP_ON_COMPUTER.line}
              </Text>
            </>
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
            <SettingsSection
              title={KIN_SETTINGS_PAGE_TITLES.approvals}
              footer="Your agents ask before anything that needs your say. You approve on this phone with Face ID."
            >
              <SettingsRow
                labelWholeWords
                icon="person.fill.checkmark"
                label="Approve from this phone"
                onPress={() => navigation.navigate("KinApprovals", company)}
              />
            </SettingsSection>
          )}
          {/* Another team this phone still holds: its connection shows here, not in its Leave. */}
          {heldTeams.length === 0 ? null : (
            <SettingsSection>
              {heldTeams.map((environment) => (
                <KinConnection key={environment.environmentId} environment={environment} />
              ))}
            </SettingsSection>
          )}
          {inCodingApp ? null : (
            <SettingsSection>
              <SettingsRow
                labelWholeWords
                icon="info.circle"
                label="About"
                onPress={() => navigation.navigate("SettingsAbout")}
              />
            </SettingsSection>
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
                  ? KIN_DEVICE_COPY.leaveTeam
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

/** "192.168.1.20:3773" for "http://192.168.1.20:3773/": the scheme and the closing slash say nothing. */
const shortAddress = (url: string) =>
  url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");

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
          description={
            environment.displayUrl === null ? undefined : shortAddress(environment.displayUrl)
          }
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
