import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_ASSIGN,
  KIN_WORK_GONE,
  KIN_WORK_ITEM_FAILED,
  KIN_WORK_ONLY_OWNER,
  createKinWorkActions,
  kinWorkAssignees,
  kinWorkItemState,
  type KinWorkAssignee,
} from "@t3tools/client-runtime/kin/kinWork";
import { EnvironmentId, KinOrgId, KinRecordKey, type KinRecordDetail } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import type { KinWorkItemParams } from "./KinWorkItemScreen";
import { kinClient } from "./state/kinClient";
import {
  kinWorkAnswersOf,
  useKinWorkAnswer,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** Who takes a task next: a lead to do it, or a person to own it. */
export function KinWorkAssignScreen({ route }: StaticScreenProps<KinWorkItemParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.task));
  if (environmentId === null || orgId === null || key === null) {
    return (
      <Frame onClose={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a task"
          detail="Open Work from your Kin chats."
        />
      </Frame>
    );
  }
  return <KinWorkAssignGate environmentId={environmentId} orgId={orgId} itemKey={key} />;
}

function Frame(props: { readonly onClose: () => void; readonly children: React.ReactNode }) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_WORK_ASSIGN.title} onClose={props.onClose} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

type ItemTarget = KinWorkTarget & { readonly itemKey: KinRecordKey };

function KinWorkAssignGate(props: ItemTarget) {
  const navigation = useNavigation();
  const allowed = useAtomValue(kinClient.workAssign.permissionAtom(props.environmentId));
  if (!allowed) {
    return (
      <Frame onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      </Frame>
    );
  }
  return <KinWorkAssignBody {...props} />;
}

function KinWorkAssignBody(props: ItemTarget) {
  const navigation = useNavigation();
  const { environmentId, orgId, itemKey } = props;
  const itemAtom = kinClient.workItem({ environmentId, input: { orgId, key: itemKey } });
  const state = kinWorkItemState(useAtomValue(itemAtom), useKinWorkAnswer(props, itemKey));
  const { orgs, people, joined, invited, names } = useKinWorkDirectory(props, true);
  const create = useAtomCommand(kinClient.workCreate, { reportFailure: false });
  const assign = useAtomCommand(kinClient.workAssign, { reportFailure: false });
  const [actions] = useState(() =>
    createKinWorkActions({
      orgId,
      answers: kinWorkAnswersOf(props),
      create: (input) => create({ environmentId, input }),
      assign: (input) => assign({ environmentId, input }),
      reread: () => appAtomRegistry.refresh(itemAtom),
    }),
  );
  // The one being given to, while the host answers.
  const [giving, setGiving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => navigation.goBack();

  if (state._tag !== "ready") {
    return (
      <Frame onClose={close}>
        {state._tag === "loading" ? (
          <View className="items-center py-12">
            <AppActivityIndicator />
          </View>
        ) : state._tag === "gone" ? (
          <EmptyState variant="plain" {...KIN_WORK_GONE} />
        ) : (
          <EmptyState
            variant="plain"
            {...KIN_WORK_ITEM_FAILED}
            action={
              <Button
                tone="secondary"
                label="Try again"
                onPress={() => appAtomRegistry.refresh(itemAtom)}
              />
            }
          />
        )}
      </Frame>
    );
  }

  const give = async (item: KinRecordDetail, to: KinWorkAssignee) => {
    if (giving !== null || to.current || to.invited) return;
    setGiving(to.key);
    setProblem(null);
    const outcome = await actions.give(item, to.principal);
    setGiving(null);
    if (!outcome.ok) return setProblem(outcome.problem);
    appAtomRegistry.refresh(itemAtom);
    navigation.goBack();
  };
  const assignees = kinWorkAssignees({
    orgs,
    orgId,
    people,
    joined,
    invited,
    names,
    current: state.item.owner,
  });
  const rows = (list: ReadonlyArray<KinWorkAssignee>) =>
    list.map((to, index) => (
      <ListChoiceRow
        key={to.key}
        label={to.name}
        leading={<KinAvatar avatar={to.avatar} size="mini" />}
        {...(to.current
          ? { description: "Has it" }
          : to.invited
            ? { description: KIN_WORK_ASSIGN.invited }
            : {})}
        selected={to.current || giving === to.key}
        separated={index > 0}
        disabled={to.invited === true || (giving !== null && giving !== to.key)}
        onPress={() => void give(state.item, to)}
      />
    ));
  return (
    <Frame onClose={close}>
      {problem === null ? null : <ErrorBanner message={problem} />}
      {assignees.leads.length === 0 ? null : (
        <ListSection title={KIN_WORK_ASSIGN.leads} footer={KIN_WORK_ASSIGN.leadsHint}>
          {rows(assignees.leads)}
        </ListSection>
      )}
      {assignees.people.length === 0 ? null : (
        <ListSection title={KIN_WORK_ASSIGN.people}>{rows(assignees.people)}</ListSection>
      )}
    </Frame>
  );
}
