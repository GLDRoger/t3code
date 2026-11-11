import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_TEAM_ADD,
  KIN_TEAM_EMPTY,
  KIN_TEAM_LOAD_FAILED,
  KIN_TEAM_ONLY_OWNER,
  KIN_TEAM_TITLE,
  kinTeamEntrySummary,
  kinTeamView,
  type KinTeammate,
} from "@t3tools/client-runtime/kin/kinTeam";
import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { KinAvatar } from "./components/KinAvatar";
import { KinListBanner } from "./components/KinListBanner";
import { refreshKinTeam, useKinTeam, type KinTeamTarget } from "./state/useKinTeam";

export type KinTeamParams = { readonly environmentId: string; readonly orgId: string };

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** The way in from the chat list, for the owner only. Its second line counts who has joined. */
export function KinTeamEntry(target: KinTeamTarget) {
  const navigation = useNavigation();
  const team = useKinTeam(target);
  // A failure with nothing read: the host refused, or is away and the page couldn't load either.
  if (!team.allowed || team.failed) return null;
  const summary = kinTeamEntrySummary(team.list, team.ownerPersonId);
  return (
    <>
      <KinListBanner
        title={KIN_TEAM_TITLE}
        summary={summary}
        symbol="person.2"
        accessibilityLabel={`${KIN_TEAM_TITLE}. ${summary}`}
        accessibilityHint="Opens your team and its invite links"
        onPress={() => navigation.navigate("KinTeam", target)}
      />
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}

/** Who is on the team, whether each has joined, and the way to add someone. */
export function KinTeamScreen({ route }: StaticScreenProps<KinTeamParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <View collapsable={false} className="flex-1 bg-screen">
        <AppBar title={KIN_TEAM_TITLE} onBack={() => navigation.goBack()} />
        <ScreenContent surface="screen">
          <EmptyState
            variant="plain"
            title="This link doesn't open anything"
            detail="Open Team from your Kin chats."
          />
        </ScreenContent>
      </View>
    );
  }
  return <KinTeamBody environmentId={environmentId} orgId={orgId} />;
}

function KinTeamBody(target: KinTeamTarget) {
  const navigation = useNavigation();
  const team = useKinTeam(target);
  const { list } = team;
  const add = () => navigation.navigate("KinInvite", target);
  const { environmentId, orgId } = target;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the team again when this screen comes back to the front, so "Joined" is current after a link was sent
  useEffect(
    () => navigation.addListener("focus", () => void refreshKinTeam({ environmentId, orgId })),
    [navigation, environmentId, orgId],
  );
  const rows = list === null ? [] : kinTeamView(list, team.edits, team.ownerPersonId);
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={KIN_TEAM_TITLE}
        onBack={() => navigation.goBack()}
        {...(list === null
          ? {}
          : { refresh: { accessibilityLabel: "Refresh", onPress: team.refresh } })}
        {...(team.allowed
          ? {
              actions: [
                { accessibilityLabel: KIN_TEAM_ADD, icon: "person.badge.plus", onPress: add },
              ],
            }
          : {})}
      />
      <ScreenContent surface="screen">
        {!team.allowed ? (
          <EmptyState variant="plain" {...KIN_TEAM_ONLY_OWNER} />
        ) : list === null ? (
          team.failed ? (
            <EmptyState
              variant="plain"
              title={KIN_TEAM_LOAD_FAILED}
              detail="Check your connection to the server and try again."
              action={<Button tone="secondary" label="Try again" onPress={team.refresh} />}
            />
          ) : (
            <View
              className="items-center py-12"
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Loading your team"
            >
              <AppActivityIndicator />
            </View>
          )
        ) : rows.every((row) => row.state === "you") ? (
          <EmptyState
            variant="plain"
            {...KIN_TEAM_EMPTY}
            action={
              <Button tone="primary" icon="person.badge.plus" label={KIN_TEAM_ADD} onPress={add} />
            }
          />
        ) : (
          <ScreenScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
          >
            {team.edits.problem === null ? null : <ErrorBanner message={team.edits.problem} />}
            <ListSection footer="Teammates chat with you and with the leads and groups you add them to. They can't see your code or settings.">
              {rows.map((row, index) => (
                <View
                  key={row.key}
                  className={index === 0 ? undefined : "border-t border-border-subtle"}
                >
                  <KinTeamRow
                    row={row}
                    onPress={() =>
                      navigation.navigate("KinTeammate", { ...target, teammate: row.key })
                    }
                  />
                </View>
              ))}
              <View className="border-t border-border-subtle">
                <ListActionRow label={KIN_TEAM_ADD} icon="plus" onPress={add} />
              </View>
            </ListSection>
          </ScreenScrollView>
        )}
      </ScreenContent>
    </View>
  );
}

function KinTeamRow(props: { readonly row: KinTeammate; readonly onPress: () => void }) {
  const { row } = props;
  const content = {
    label: row.name,
    description: row.detail,
    leading: <KinAvatar avatar={row.avatar} size="small" />,
  };
  return row.state === "you" ? (
    <ListRowLayout {...content} />
  ) : (
    <ListRow {...content} onPress={props.onPress} />
  );
}
