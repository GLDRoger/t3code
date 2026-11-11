import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { Linking, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useConnectionController } from "../connection/useConnectionController";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useChatOnlyEnvironments } from "./state/kinChatOnly";
import { kinClient } from "./state/kinClient";
import { useKinInbox } from "./state/useKinInbox";

const noMembersAtom = Atom.make(null);

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

/**
 * Settings on a phone that only holds a teammate's session: what applies to someone who chats and
 * nothing else. Everything about providers, projects and coding belongs to sessions with more
 * access, and those get the full Settings list.
 */
export function KinTeammateSettings(props: {
  /** As a tab of the Kin home: no way back, and room under the list for the tab dock. */
  readonly tab?: { readonly bottomClearance: number };
}) {
  const navigation = useNavigation();
  const controller = useConnectionController();
  const environments = useChatOnlyEnvironments();
  const { host } = useKinInbox();
  const name = useMyName();
  const team =
    host._tag === "host" && host.probe._tag === "ready"
      ? (host.probe.orgs.orgs[0]?.name ?? null)
      : null;

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

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      {props.tab ? (
        <>
          <NativeStackScreenOptions options={{ headerTitle: undefined }} />
          <AppBar title="Settings" />
        </>
      ) : (
        <AppBar title="Settings" onBack={() => navigation.goBack()} />
      )}
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            padding: 16,
            paddingBottom: 32 + (props.tab?.bottomClearance ?? 0),
            gap: 20,
          }}
        >
          {name === null && team === null ? null : (
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
          <SettingsSection>
            <SettingsRow
              icon="bell.badge"
              label="Notifications"
              onPress={() => void Linking.openSettings()}
            />
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
          </SettingsSection>
          {environments.map((environmentId) => (
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
