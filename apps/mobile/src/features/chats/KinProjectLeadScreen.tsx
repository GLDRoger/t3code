import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_PROJECT_LEAD,
  kinProjectLeadChoices,
  kinProjectPageView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { kinWorkSend, type KinWorkFormProblem } from "@t3tools/client-runtime/kin/kinWorkForms";
import { EnvironmentId, KinOrgId, KinRecordKey, type KinPersonId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinWorkProblemNotice } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import { useKinProjectPage, useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

export type KinProjectLeadParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly project: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** The owner picks who leads a project; the host applies it on the lead's next request. */
export function KinProjectLeadScreen({ route }: StaticScreenProps<KinProjectLeadParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.project));
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_PROJECT_LEAD.title} onClose={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {environmentId === null || orgId === null || key === null ? (
            <EmptyState
              variant="plain"
              title="This link doesn't name a project"
              detail="Open Work from your Kin chats."
            />
          ) : (
            <KinProjectLeadChoices environmentId={environmentId} orgId={orgId} projectKey={key} />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function KinProjectLeadChoices(props: KinWorkTarget & { readonly projectKey: KinRecordKey }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const target = { environmentId, orgId };
  const { state, refresh } = useKinProjectPage(target, props.projectKey);
  const directory = useKinWorkDirectory(target, true);
  const update = useAtomCommand(kinClient.workProjectUpdate, { reportFailure: false });
  const now = new Date(useNowMinuteMs());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  if (state._tag !== "ready") {
    return state._tag === "loading" ? (
      <View className="items-center py-12">
        <AppActivityIndicator />
      </View>
    ) : (
      <EmptyState variant="plain" title="Couldn't load this project" detail="Try again soon." />
    );
  }
  const view = kinProjectPageView(state.value, directory.names, now);
  const choose = async (personId: KinPersonId) => {
    if (busy || personId === view.lead.personId) return;
    setBusy(true);
    setProblem(null);
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        update({
          environmentId,
          input: { orgId, key: view.key, rev: view.rev, owner: { _tag: "person", personId } },
        }),
      noun: "project",
      name: view.name,
      own: view.key,
    });
    setBusy(false);
    if (outcome.ok) {
      refresh();
      navigation.goBack();
    } else setProblem(outcome.problem);
  };
  return (
    <>
      {problem === null ? null : (
        <KinWorkProblemNotice problem={problem} onDismiss={() => setProblem(null)} />
      )}
      <ListSection title={KIN_PROJECT_LEAD.choose} footer={KIN_PROJECT_LEAD.detail}>
        {kinProjectLeadChoices(directory.people).map((choice, index) => (
          <ListChoiceRow
            key={choice.personId}
            label={choice.name}
            selected={choice.personId === view.lead.personId}
            separated={index > 0}
            disabled={busy}
            onPress={() => void choose(choice.personId)}
          />
        ))}
      </ListSection>
    </>
  );
}
