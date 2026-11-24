import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_PEOPLE_CHAT,
  kinAgentChatProblem,
  kinNewChatList,
  kinPeopleChatProblem,
} from "@t3tools/client-runtime/kin/kinPeopleChat";
import { kinPersonSeed } from "@t3tools/client-runtime/kin/kinProfiles";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  KinOrgId,
  type KinAgentId,
  type KinLeadsListResult,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
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
import { runKinCommand } from "@t3tools/client-runtime/kin/kinRunCommand";

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
    const result = await runKinCommand(appAtomRegistry, kinClient.chatWithPerson, {
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

/** Opens the viewer's chat with an agent, made the first time; the problem when it can't. */
function useOpenKinAgentChat() {
  const navigation = useNavigation();
  return async (target: {
    readonly environmentId: EnvironmentId;
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
  }) => {
    const result = await runKinCommand(appAtomRegistry, kinClient.chatWithAgent, {
      environmentId: target.environmentId,
      input: { orgId: target.orgId, agentId: target.agentId },
    });
    if (result._tag !== "Success") return kinAgentChatProblem(squashAtomCommandFailure(result));
    navigation.goBack();
    navigation.navigate("KinChat", {
      environmentId: target.environmentId,
      orgId: target.orgId,
      chatId: result.value.chatId,
    });
    return null;
  };
}

type LeadsResult = AsyncResult.AsyncResult<KinLeadsListResult, unknown> | null;
const noLeadsAtom: Atom.Atom<LeadsResult> = Atom.make<LeadsResult>(null);

/** New → Message someone: everyone else on the team, then the agents the viewer may message. */
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
  const leadsResult = useAtomValue(
    environmentId === null || orgId === null
      ? noLeadsAtom
      : kinClient.leads({ environmentId, input: { orgId } }),
  );
  // Without the agent list the people still show; a failed read lists no agents.
  const leads =
    leadsResult === null
      ? null
      : AsyncResult.isFailure(leadsResult)
        ? { leads: [] }
        : Option.getOrNull(AsyncResult.value(leadsResult));
  const openPerson = useOpenKinPeopleChat();
  const openAgent = useOpenKinAgentChat();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const list = held === null || leads === null ? null : kinNewChatList(held.profiles, me, leads);
  const pick = async (key: string, open: () => Promise<string | null>) => {
    setBusy(key);
    setProblem(null);
    const failure = await open();
    setBusy(null);
    setProblem(failure);
  };
  const onlyAgents = list !== null && list.people.length === 0 && list.agents.length > 0;
  const detail = onlyAgents ? list.agentsNote : KIN_PEOPLE_CHAT.pickDetail;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_PEOPLE_CHAT.pickTitle} onClose={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 16 }}
        >
          {detail === null ? null : (
            <Text textRole="body" className="px-2 text-foreground-muted">
              {detail}
            </Text>
          )}
          {problem === null ? null : <ErrorBanner message={problem} />}
          {list === null || environmentId === null || orgId === null ? (
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
          ) : list.people.length === 0 && list.agents.length === 0 ? (
            <EmptyState
              variant="plain"
              title={KIN_PEOPLE_CHAT.noOne}
              detail={KIN_PEOPLE_CHAT.noOneDetail}
            />
          ) : (
            <>
              {list.people.length === 0 ? null : (
                <ListSection {...(list.peopleTitle === null ? {} : { title: list.peopleTitle })}>
                  {list.people.map((person) => (
                    <ListActionRow
                      key={person.personId}
                      label={person.displayName}
                      leading={
                        <KinAvatar
                          avatar={{ kind: "person", seed: kinPersonSeed(person.personId) }}
                          size="small"
                        />
                      }
                      loading={busy === `person:${person.personId}`}
                      disabled={busy !== null}
                      onPress={() =>
                        void pick(`person:${person.personId}`, () =>
                          openPerson({ environmentId, orgId, personId: person.personId }),
                        )
                      }
                    />
                  ))}
                </ListSection>
              )}
              {list.agents.length === 0 ? null : (
                <ListSection
                  {...(list.agentsTitle === null ? {} : { title: list.agentsTitle })}
                  {...(onlyAgents || list.agentsNote === null ? {} : { footer: list.agentsNote })}
                >
                  {list.agents.map((agent) => (
                    <ListActionRow
                      key={agent.agentId}
                      label={agent.name}
                      {...(agent.intro === null ? {} : { description: agent.intro })}
                      accessibilityLabel={`${KIN_PEOPLE_CHAT.message} ${agent.name}`}
                      leading={<KinAvatar avatar={kinAgentAvatar(agent.agentId)} size="small" />}
                      loading={busy === `agent:${agent.agentId}`}
                      disabled={busy !== null}
                      onPress={() =>
                        void pick(`agent:${agent.agentId}`, () =>
                          openAgent({ environmentId, orgId, agentId: agent.agentId }),
                        )
                      }
                    />
                  ))}
                </ListSection>
              )}
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
