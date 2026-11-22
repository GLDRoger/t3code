import { KIN_THIS_PHONE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import { KIN_PROFILE_COPY, kinRoleLine } from "@t3tools/client-runtime/kin/kinProfiles";
import { KIN_MY_MAILBOX_COPY } from "@t3tools/client-runtime/kin/kinConnections";
import {
  KIN_NOTIFICATIONS_OPENS,
  KIN_SET_UP_ON_COMPUTER,
  KIN_SETTINGS_PAGE_TITLES,
  kinPhoneSettingsRows,
  type KinPhoneSettingsRow,
} from "@t3tools/client-runtime/kin/kinNavigation";
import { Atom } from "effect/reactivity";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { environmentSession } from "../../state/session";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSettingsPageBack } from "../settings/useSettingsPageBack";
import { useKinTab, kinTabFoot } from "./components/KinTab";
import { KinBriefsSection } from "./KinBriefs";
import { useKinIsHome } from "./state/kinHome";
import { openKinNotificationSettings } from "./notifications/installKinNotifications";
import { KinStopRows } from "./KinStopRows";
import { KIN_CONNECTION_LABEL } from "./KinThisPhoneScreen";
import { useKinOwnerLevel } from "./state/kinChatOnly";
import { useKinInbox } from "./state/useKinInbox";
import { useKinProfiles } from "./state/useKinProfiles";
import { useForgetReplacedComputers, useKinLeaving } from "./state/useKinReconnect";

const noSessionAtom = Atom.make(null);

/**
 * Settings where Kin is the whole app: what is used in the day. Set-up pages are on the computer,
 * and one line says so; This phone holds the computers, other teams and each team's way out.
 * Drawn as a tab of the Kin home, or as a pushed page where there is no dock.
 */
const COMPANY_ROWS: Partial<
  Record<
    KinPhoneSettingsRow,
    {
      readonly icon: "person.2" | "robot" | "doc.text" | "eye";
      readonly route: "KinTeam" | "KinAgents" | "KinCompany" | "KinWatchLog";
      readonly title: string;
    }
  >
> = {
  team: { icon: "person.2", route: "KinTeam", title: KIN_SETTINGS_PAGE_TITLES.team },
  agents: { icon: "robot", route: "KinAgents", title: KIN_SETTINGS_PAGE_TITLES.agents },
  company: { icon: "doc.text", route: "KinCompany", title: KIN_SETTINGS_PAGE_TITLES.company },
  watches: { icon: "eye", route: "KinWatchLog", title: KIN_SETTINGS_PAGE_TITLES.watches },
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
  const inbox = useKinInbox();
  const { leaving } = useKinLeaving();
  const host: KinHost =
    inbox.host._tag === "host" && leaving.includes(inbox.host.environmentId)
      ? { _tag: "none" }
      : inbox.host;
  const session = useAtomValue(
    host._tag === "host"
      ? environmentSession.sessionStateValueAtom(host.environmentId)
      : noSessionAtom,
  );
  const probe = host._tag === "host" && host.probe._tag === "ready" ? host.probe : null;
  const orgId = probe?.orgs.me[0]?.orgId ?? null;
  const myPersonId = probe?.orgs.me[0]?.personId ?? null;
  const { held: profiles } = useKinProfiles(
    host._tag === "host" ? host.environmentId : null,
    orgId,
  );
  const mine = profiles?.profiles.find((profile) => profile.personId === myPersonId) ?? null;
  const ownerLevel = useKinOwnerLevel(host._tag === "host" ? host.environmentId : null, session);
  // The pages below belong to whoever runs this Kin: the owner or a co-owner.
  const company =
    host._tag === "host" && orgId !== null && ownerLevel
      ? { environmentId: host.environmentId, orgId }
      : null;
  const rows = kinPhoneSettingsRows({ ownerLevel: company !== null });
  // What Kin checked is everyone's: a teammate's holds the watches on their own things.
  const here =
    host._tag === "host" && orgId !== null ? { environmentId: host.environmentId, orgId } : null;
  const { environments } = useEnvironments();
  const hostComputer =
    host._tag === "host"
      ? (environments.find((one) => one.environmentId === host.environmentId) ?? null)
      : null;
  useForgetReplacedComputers(!inCodingApp);

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
                    <SettingsRow
                      key={page}
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
                case "mailbox":
                  return host._tag !== "host" || orgId === null ? null : (
                    <SettingsRow
                      labelWholeWords
                      key={page}
                      icon="envelope"
                      label={KIN_MY_MAILBOX_COPY.title}
                      onPress={() =>
                        navigation.navigate("KinMyMailbox", {
                          environmentId: host.environmentId,
                          orgId,
                        })
                      }
                    />
                  );
                case "appearance":
                  return inCodingApp ? null : (
                    <SettingsRow
                      labelWholeWords
                      key={page}
                      icon="paintbrush"
                      label={KIN_SETTINGS_PAGE_TITLES.appearance}
                      onPress={() => navigation.navigate("KinAppearance")}
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
          {here === null || rows.company.length === 0 ? null : (
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
                    onPress={() => navigation.navigate(row.route, here)}
                  />
                );
              })}
            </SettingsSection>
          )}
          {company === null ? null : (
            <>
              {rows.company.includes("stop") ? <KinStopRows {...company} /> : null}
              <Text textRole="footnote" className="px-4 text-foreground-muted">
                {KIN_SET_UP_ON_COMPUTER.line}
              </Text>
            </>
          )}
          <SettingsSection>
            <SettingsRow
              labelWholeWords
              icon="iphone"
              label={KIN_THIS_PHONE_COPY.title}
              {...(hostComputer === null
                ? {}
                : {
                    value: hostComputer.label,
                    valueEnd: ` · ${KIN_CONNECTION_LABEL[hostComputer.connection.phase]}`,
                  })}
              onPress={() => navigation.navigate("KinThisPhone")}
            />
          </SettingsSection>
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** Kin's page in the coding app's Settings; where Kin is the whole app, its own Settings. */
export function KinSettingsScreen() {
  return <KinSettings inCodingApp={!useKinIsHome()} />;
}
