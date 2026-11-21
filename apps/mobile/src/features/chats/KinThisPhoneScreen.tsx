import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { KIN_DEVICES_COPY } from "@t3tools/client-runtime/kin/kinDevices";
import { KIN_THIS_PHONE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
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
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useKinIsHome } from "./state/kinHome";
import { useChatOnlyEnvironments, useKinOwnerLevel } from "./state/kinChatOnly";
import { useKinInbox } from "./state/useKinInbox";
import {
  kinHeldComputersAtom,
  kinReplacedComputersAtom,
  useKinLeaving,
  useKinReconnect,
} from "./state/useKinReconnect";

const noSessionAtom = Atom.make(null);

export const KIN_CONNECTION_LABEL: Record<EnvironmentPresentation["connection"]["phase"], string> =
  {
    connected: "Connected",
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    offline: "Offline",
    available: "Not connected",
    error: "Can't connect",
    unsupported: "Update this app",
  };

/** "192.168.1.20:3773" for "http://192.168.1.20:3773/": the scheme and the closing slash say nothing. */
const shortAddress = (url: string) =>
  url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");

/**
 * The computers and teams this phone holds, and its one way out of each team. A computer a newer
 * pairing of the same Kin replaced is not drawn here; Settings forgets it.
 */
export function KinThisPhoneScreen() {
  const inCodingApp = !useKinIsHome();
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const held = useAtomValue(kinHeldComputersAtom);
  const replaced = useAtomValue(kinReplacedComputersAtom);
  const { leaving: left, forget } = useKinLeaving();
  const gone = (environmentId: EnvironmentId) =>
    left.includes(environmentId) || (!inCodingApp && replaced.includes(environmentId));
  const teammateIds = useChatOnlyEnvironments().filter((id) => !gone(id));
  const inbox = useKinInbox();
  const hostId =
    inbox.host._tag === "host" && !gone(inbox.host.environmentId) ? inbox.host.environmentId : null;
  const probe =
    inbox.host._tag === "host" && inbox.host.probe._tag === "ready" ? inbox.host.probe : null;
  const orgId = probe?.orgs.me[0]?.orgId ?? null;
  const myPersonId = probe?.orgs.me[0]?.personId ?? null;
  const session = useAtomValue(
    hostId === null ? noSessionAtom : environmentSession.sessionStateValueAtom(hostId),
  );
  const ownerLevel = useKinOwnerLevel(hostId, session);
  const company =
    hostId !== null && orgId !== null && ownerLevel ? { environmentId: hostId, orgId } : null;

  const shown = environments.filter((one) => !gone(one.environmentId));
  // Your Kin: the computer Kin opens on, and in the Kin app any other computer this phone runs.
  const yourKin = shown.filter(
    (one) =>
      one.environmentId === hostId || (!inCodingApp && !teammateIds.includes(one.environmentId)),
  );
  const otherTeams = shown.filter(
    (one) => teammateIds.includes(one.environmentId) && one.environmentId !== hostId,
  );
  // Two computers with one name are told apart by the address their rows show.
  const nameOf = (environment: EnvironmentPresentation) =>
    environment.displayUrl !== null &&
    shown.filter((one) => one.label === environment.label).length > 1
      ? `${environment.label} (${shortAddress(environment.displayUrl)})`
      : environment.label;
  const heldOf = (environmentId: EnvironmentId) =>
    held.find((one) => one.environmentId === environmentId) ?? null;
  const teamOf = (environment: EnvironmentPresentation) =>
    (environment.environmentId === hostId ? probe?.orgs.orgs[0]?.name : null) ??
    heldOf(environment.environmentId)?.team ??
    environment.label;
  // The coding app signs out of a computer it runs from its own Environments.
  const exits: ReadonlyArray<EnvironmentPresentation> = [...yourKin, ...otherTeams]
    .filter((one) => !inCodingApp || teammateIds.includes(one.environmentId))
    // The computer Kin opens on answers for its team, so its team's other copies offer Forget.
    .sort((a, b) => Number(b.environmentId === hostId) - Number(a.environmentId === hostId))
    .filter((one, index, all) => all.findIndex((other) => teamOf(other) === teamOf(one)) === index);
  const hasExit = (environmentId: EnvironmentId) =>
    exits.some((one) => one.environmentId === environmentId);

  const askForget = (environment: EnvironmentPresentation) =>
    Dialog.alert(
      KIN_THIS_PHONE_COPY.forgetTitle(nameOf(environment)),
      KIN_THIS_PHONE_COPY.forgetDetail,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: KIN_THIS_PHONE_COPY.forget,
          style: "destructive",
          onPress: () => forget(environment.environmentId),
        },
      ],
    );
  const askSignOut = (environment: EnvironmentPresentation) =>
    Dialog.alert(
      KIN_THIS_PHONE_COPY.signOutTitle(teamOf(environment)),
      KIN_THIS_PHONE_COPY.signOutDetail({
        team: teamOf(environment),
        computer: nameOf(environment),
        teammate: teammateIds.includes(environment.environmentId),
      }),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => forget(environment.environmentId),
        },
      ],
    );
  // A row whose team has its Sign out below leaves by that; any other row offers Forget.
  const row = (environment: EnvironmentPresentation) => (
    <KinConnection
      key={environment.environmentId}
      environment={environment}
      onForget={
        inCodingApp || hasExit(environment.environmentId) ? null : () => askForget(environment)
      }
    />
  );

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_THIS_PHONE_COPY.title} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {/* The owner links devices from T3 Code's Sharing & access settings. */}
          {hostId !== null &&
          orgId !== null &&
          myPersonId !== null &&
          teammateIds.includes(hostId) ? (
            <SettingsSection>
              <SettingsRow
                labelWholeWords
                icon="iphone"
                label={KIN_DEVICES_COPY.title}
                value={KIN_DEVICES_COPY.rowDetail}
                onPress={() =>
                  navigation.navigate("KinDevices", {
                    environmentId: hostId,
                    orgId,
                    personId: myPersonId,
                  })
                }
              />
            </SettingsSection>
          ) : null}
          {yourKin.length === 0 ? null : (
            <SettingsSection
              title={KIN_THIS_PHONE_COPY.yourKin}
              footer={KIN_THIS_PHONE_COPY.yourKinFooter}
            >
              {yourKin.map(row)}
            </SettingsSection>
          )}
          {company === null ? null : (
            <SettingsSection footer={KIN_THIS_PHONE_COPY.approveFooter}>
              <SettingsRow
                labelWholeWords
                icon="person.fill.checkmark"
                label={KIN_THIS_PHONE_COPY.approve}
                onPress={() => navigation.navigate("KinApprovals", company)}
              />
            </SettingsSection>
          )}
          {otherTeams.length === 0 ? null : (
            <SettingsSection title={KIN_THIS_PHONE_COPY.otherTeams}>
              {otherTeams.map(row)}
            </SettingsSection>
          )}
          {inCodingApp ? null : (
            <SettingsSection>
              <SettingsRow
                labelWholeWords
                icon="info.circle"
                label={KIN_THIS_PHONE_COPY.about}
                onPress={() => navigation.navigate("SettingsAbout")}
              />
            </SettingsSection>
          )}
          {exits.map((environment) => (
            <Button
              key={environment.environmentId}
              tone="danger"
              fullWidth
              label={KIN_THIS_PHONE_COPY.signOut(teamOf(environment))}
              onPress={() => askSignOut(environment)}
            />
          ))}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** One computer this phone holds: where it stands, a way to try again now, and Forget. */
function KinConnection(props: {
  readonly environment: EnvironmentPresentation;
  readonly onForget: (() => void) | null;
}) {
  const { environment, onForget } = props;
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
          detail={status === "failed" ? "Couldn't reconnect" : KIN_CONNECTION_LABEL[phase]}
        />
      </View>
      {phase === "connected" || reconnect === null ? null : (
        <ListActionRow
          label={status === "pending" ? "Reconnecting…" : "Reconnect"}
          disabled={status === "pending"}
          onPress={reconnect}
        />
      )}
      {onForget === null ? null : (
        <ListActionRow
          tone="danger"
          label={KIN_THIS_PHONE_COPY.forget}
          accessibilityLabel={KIN_THIS_PHONE_COPY.forgetTitle(environment.label).replace(/\?$/, "")}
          onPress={onForget}
        />
      )}
    </>
  );
}
