import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_PEOPLE_CHAT,
  kinMessageablePeople,
  kinPeopleChatProblem,
} from "@t3tools/client-runtime/kin/kinPeopleChat";
import { kinPersonSeed } from "@t3tools/client-runtime/kin/kinProfiles";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { KinAvatar } from "./components/KinAvatar";
import { kinClient } from "./state/kinClient";
import { useKinHostAt } from "./state/useKinHost";
import { useKinProfiles } from "./state/useKinProfiles";

export type KinPeoplePickParams = {
  readonly environmentId: string;
  readonly orgId: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** Opens the viewer's chat with a teammate, made the first time; the problem when it can't. */
export function useOpenKinPeopleChat() {
  const navigation = useNavigation();
  return async (target: {
    readonly environmentId: EnvironmentId;
    readonly orgId: KinOrgId;
    readonly personId: KinPersonId;
  }) => {
    const result = await kinClient.chatWithPerson.run(appAtomRegistry, {
      environmentId: target.environmentId,
      input: { orgId: target.orgId, personId: target.personId },
    });
    if (result._tag !== "Success") return kinPeopleChatProblem(squashAtomCommandFailure(result));
    navigation.goBack();
    navigation.navigate("KinChat", {
      environmentId: target.environmentId,
      orgId: target.orgId,
      chatId: result.value.chatId,
    });
    return null;
  };
}

/** New → Message a teammate: everyone else on the team, one tap to their chat. */
export function KinPeoplePickScreen({ route }: StaticScreenProps<KinPeoplePickParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const { held, failed } = useKinProfiles(environmentId, orgId);
  const host = useKinHostAt(environmentId ?? EnvironmentId.make("none"));
  const me = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    orgId,
  ).personId;
  const open = useOpenKinPeopleChat();
  const [busy, setBusy] = useState<KinPersonId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const people = held === null ? null : kinMessageablePeople(held.profiles, me);
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_PEOPLE_CHAT.pickTitle} onClose={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 16 }}
        >
          <Text textRole="body" className="px-2 text-foreground-muted">
            {KIN_PEOPLE_CHAT.pickDetail}
          </Text>
          {problem === null ? null : <ErrorBanner message={problem} />}
          {people === null || environmentId === null || orgId === null ? (
            failed ? (
              <EmptyState
                variant="plain"
                title="Couldn't load the team"
                detail={KIN_PEOPLE_CHAT.loadFailed}
              />
            ) : (
              <View className="items-center py-12">
                <AppActivityIndicator />
              </View>
            )
          ) : people.length === 0 ? (
            <EmptyState
              variant="plain"
              title={KIN_PEOPLE_CHAT.noOne}
              detail={KIN_PEOPLE_CHAT.noOneDetail}
            />
          ) : (
            <ListSection>
              {people.map((person) => (
                <ListActionRow
                  key={person.personId}
                  label={person.displayName}
                  leading={
                    <KinAvatar
                      avatar={{ kind: "person", seed: kinPersonSeed(person.personId) }}
                      size="small"
                    />
                  }
                  loading={busy === person.personId}
                  disabled={busy !== null}
                  onPress={async () => {
                    setBusy(person.personId);
                    setProblem(null);
                    const failure = await open({ environmentId, orgId, personId: person.personId });
                    setBusy(null);
                    setProblem(failure);
                  }}
                />
              ))}
            </ListSection>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
