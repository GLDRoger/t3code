import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_ASSIGN,
  KIN_WORK_GONE,
  KIN_WORK_ITEM_FAILED,
  kinWorkOnlyOwner,
  createKinWorkActions,
  kinWorkAssignees,
  kinWorkItemState,
  type KinWorkAssignee,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_TASK_WITH,
  kinTaskWithChoices,
} from "@t3tools/client-runtime/kin/kinTaskRecord";
import {
  EnvironmentId,
  KIN_WORK_ALSO_ON_MAX,
  KinOrgId,
  KinRecordKey,
  type KinRecordDetail,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import type { KinWorkItemParams } from "./KinWorkItemScreen";
import { kinClient } from "./state/kinClient";
import {
  kinWorkAnswersOf,
  useKinWorkAnswer,
  useKinWorkChanges,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";
import { useKinGate } from "./state/useKinHost";
import { KinGateView } from "./components/KinWorkPieces";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

export type KinWorkAssignParams = KinWorkItemParams & {
  /** "yes" picks who else is on the task, several at once, instead of who holds it. */
  readonly with?: string;
};

/** Who takes a task next, a lead to do it or a person to own it; or who else is on it. */
export function KinWorkAssignScreen({ route }: StaticScreenProps<KinWorkAssignParams>) {
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
  const target = { environmentId, orgId, itemKey: key };
  return route.params.with === "yes" ? (
    <KinWorkWithGate {...target} />
  ) : (
    <KinWorkAssignGate {...target} />
  );
}

function Frame(props: {
  readonly onClose: () => void;
  readonly title?: string;
  readonly confirm?: React.ComponentProps<typeof AppBar>["confirm"];
  readonly children: React.ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={props.title ?? KIN_WORK_ASSIGN.title}
        onClose={props.onClose}
        {...(props.confirm === undefined ? {} : { confirm: props.confirm })}
      />
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
  const gate = useKinGate(
    kinClient.workAssign.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  if (gate !== null) {
    return (
      <Frame onClose={() => navigation.goBack()}>
        <KinGateView gate={gate} refused={kinWorkOnlyOwner("tasks")} label="Task" />
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
                label={KIN_RETRY}
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

function KinWorkWithGate(props: ItemTarget) {
  const navigation = useNavigation();
  const gate = useKinGate(
    kinClient.workUpdate.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  if (gate !== null) {
    return (
      <Frame title={KIN_TASK_WITH.add} onClose={() => navigation.goBack()}>
        <KinGateView gate={gate} refused={kinWorkOnlyOwner("tasks")} label="Task" />
      </Frame>
    );
  }
  return <KinWorkWithBody {...props} />;
}

/** Several people or leads put on a task at once; whoever holds it or is on it isn't offered. */
function KinWorkWithBody(props: ItemTarget) {
  const navigation = useNavigation();
  const { environmentId, orgId, itemKey } = props;
  const itemAtom = kinClient.workItem({ environmentId, input: { orgId, key: itemKey } });
  const state = kinWorkItemState(useAtomValue(itemAtom), useKinWorkAnswer(props, itemKey));
  const { orgs, people, joined, invited, names } = useKinWorkDirectory(props, true);
  const { changes } = useKinWorkChanges(props);
  const [picked, setPicked] = useState<ReadonlyArray<KinWorkAssignee>>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => navigation.goBack();
  if (state._tag !== "ready")
    return (
      <Frame title={KIN_TASK_WITH.add} onClose={close}>
        {state._tag === "loading" ? (
          <View className="items-center py-12">
            <AppActivityIndicator />
          </View>
        ) : (
          <EmptyState
            variant="plain"
            {...(state._tag === "gone" ? KIN_WORK_GONE : KIN_WORK_ITEM_FAILED)}
          />
        )}
      </Frame>
    );
  const { item } = state;
  const on = item.alsoOn ?? [];
  const full = on.length + picked.length >= KIN_WORK_ALSO_ON_MAX;
  const choices = kinTaskWithChoices(
    kinWorkAssignees({ orgs, orgId, people, joined, invited, names, current: null }),
    item,
  );
  const save = async () => {
    const first = picked[0];
    if (saving || first === undefined) return;
    setSaving(true);
    setProblem(null);
    const put = await changes.run(
      item,
      {
        type: "alsoOn",
        alsoOn: [...on, ...picked.map((row) => row.principal)],
        who: first.principal,
        said: "added",
      },
      names,
    );
    setSaving(false);
    if (!put) return setProblem(changes.getState().notice?.text ?? null);
    appAtomRegistry.refresh(itemAtom);
    close();
  };
  const rows = (list: ReadonlyArray<KinWorkAssignee>) =>
    list.map((row, index) => {
      const ticked = picked.some((one) => one.key === row.key);
      return (
        <KinWithChoiceRow
          key={row.key}
          row={row}
          ticked={ticked}
          separated={index > 0}
          disabled={saving || row.invited === true || (full && !ticked)}
          onPress={() =>
            setPicked((held) =>
              ticked ? held.filter((one) => one.key !== row.key) : [...held, row],
            )
          }
        />
      );
    });
  return (
    <Frame
      title={KIN_TASK_WITH.add}
      onClose={close}
      confirm={{
        label: "Done",
        disabled: picked.length === 0 || saving,
        loading: saving,
        onPress: () => void save(),
      }}
    >
      {problem === null ? null : <ErrorBanner message={problem} />}
      {choices.people.length === 0 ? null : (
        <ListSection
          title={KIN_WORK_ASSIGN.people}
          {...(full ? { footer: KIN_TASK_WITH.full } : {})}
        >
          {rows(choices.people)}
        </ListSection>
      )}
      {choices.leads.length === 0 ? null : (
        <ListSection title={KIN_WORK_ASSIGN.leads}>{rows(choices.leads)}</ListSection>
      )}
    </Frame>
  );
}

/** One row of a pick of several: a tick that turns on and off, never a radio. */
function KinWithChoiceRow(props: {
  readonly row: KinWorkAssignee;
  readonly ticked: boolean;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const { row } = props;
  const ripple = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="checkbox"
      accessibilityLabel={row.name}
      accessibilityState={{ checked: props.ticked, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      android_ripple={{ color: ripple.backgroundColor }}
      className={cn("bg-grouped-card", props.separated && "border-t border-border-subtle")}
    >
      <ListRowLayout
        label={row.name}
        leading={<KinAvatar avatar={row.avatar} size="mini" />}
        {...(row.invited ? { description: KIN_WORK_ASSIGN.invited } : {})}
        disabled={props.disabled}
        accessory={
          <SymbolView
            name={props.ticked ? "checkmark.circle.fill" : "circle"}
            size={Platform.OS === "android" ? 24 : 22}
            tintColorClassName={props.ticked ? "accent-primary-text" : "accent-icon-muted"}
            type="monochrome"
          />
        }
      />
    </RowPressable>
  );
}
