import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_PROJECT_PEOPLE,
  KIN_PROJECTS,
  kinProjectPageView,
  kinProjectPeopleChoices,
  type KinProjectPageView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { kinWorkSend, type KinWorkFormProblem } from "@t3tools/client-runtime/kin/kinWorkForms";
import {
  EnvironmentId,
  KinOrgId,
  KinRecordKey,
  type KinPerson,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { IconButton } from "../../components/ui/IconButton";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { KinFoldSection, KinWorkProblemNotice } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import { useKinProjectPage, useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

export type KinProjectPeopleParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly project: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

const same = (a: KinWorkPrincipal, b: KinWorkPrincipal) =>
  a._tag === "person"
    ? b._tag === "person" && a.personId === b.personId
    : b._tag === "agent" && a.agentId === b.agentId;

/**
 * Who is on a project, as its page shows them; the owner, a co-owner and its lead put people and
 * agents on it and take them off (the host's `can.people`).
 */
export function KinProjectPeopleSection(
  props: KinWorkTarget & {
    readonly view: KinProjectPageView;
    readonly onAdd: () => void;
    readonly onChanged: () => void;
  },
) {
  const { environmentId, orgId, view } = props;
  const send = useAtomCommand(kinClient.workProjectPeople, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const changes = view.changesPeople && view.closed === null;
  if (view.people.length === 0 && !changes) return null;
  const remove = async (who: KinWorkPrincipal) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () => send({ environmentId, input: { orgId, key: view.key, remove: [who] } }),
      noun: "project",
      name: view.name,
      own: view.key,
    });
    setBusy(false);
    if (outcome.ok) props.onChanged();
    else setProblem(outcome.problem);
  };
  return (
    <>
      {problem === null ? null : (
        <KinWorkProblemNotice problem={problem} onDismiss={() => setProblem(null)} />
      )}
      <KinFoldSection
        title={KIN_PROJECTS.people}
        summary={
          view.people.length === 0
            ? KIN_PROJECT_PEOPLE.none
            : KIN_PROJECTS.count(view.people.length, "person", "people")
        }
      >
        {view.people.map((row) => (
          <ListRowLayout
            key={row.key}
            leading={<KinAvatar avatar={row.avatar} size="small" />}
            label={row.name}
            description={row.line}
            accessory={
              changes && row.member ? (
                <IconButton
                  icon="xmark"
                  accessibilityLabel={KIN_PROJECT_PEOPLE.remove(row.name)}
                  disabled={busy}
                  onPress={() => void remove(row.who)}
                />
              ) : null
            }
          />
        ))}
        {changes ? (
          <ListRow
            icon="plus"
            label={KIN_PROJECT_PEOPLE.add}
            disabled={busy}
            onPress={props.onAdd}
          />
        ) : null}
      </KinFoldSection>
    </>
  );
}

/** Teammates, then agents at work, to put on a project: each tap ticks or unticks one. */
export function KinProjectPeoplePicker(props: {
  readonly people: ReadonlyArray<KinPerson> | null;
  readonly names: KinWorkNames;
  readonly on: Parameters<typeof kinProjectPeopleChoices>[0]["on"];
  readonly picked: ReadonlyArray<KinWorkPrincipal>;
  readonly disabled?: boolean;
  readonly onChange: (picked: ReadonlyArray<KinWorkPrincipal>) => void;
  readonly footer?: string;
}) {
  const choices = kinProjectPeopleChoices({
    people: props.people,
    names: props.names,
    on: props.on,
  });
  if (choices.length === 0)
    return (
      <Text textRole="footnote" className="px-4 text-foreground-muted">
        {KIN_PROJECT_PEOPLE.nobodyLeft}
      </Text>
    );
  const section = (agent: boolean) => choices.filter((one) => one.agent === agent);
  return (
    <>
      {[false, true].map((agent) =>
        section(agent).length === 0 ? null : (
          <ListSection
            key={agent ? "agents" : "people"}
            title={agent ? KIN_PROJECT_PEOPLE.agents : KIN_PROJECT_PEOPLE.people}
            {...(!agent && props.footer !== undefined ? { footer: props.footer } : {})}
          >
            {section(agent).map((choice, index) => {
              const picked = props.picked.some((who) => same(who, choice.who));
              return (
                <ListChoiceRow
                  key={choice.key}
                  label={choice.name}
                  selected={picked}
                  separated={index > 0}
                  disabled={props.disabled === true}
                  onPress={() =>
                    props.onChange(
                      picked
                        ? props.picked.filter((who) => !same(who, choice.who))
                        : [...props.picked, choice.who],
                    )
                  }
                />
              );
            })}
          </ListSection>
        ),
      )}
    </>
  );
}

/** Puts people and agents on a project: its owner, a co-owner or its lead (`can.people`). */
export function KinProjectPeopleScreen({ route }: StaticScreenProps<KinProjectPeopleParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.project));
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_PROJECT_PEOPLE.choose} onClose={() => navigation.goBack()} />
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
            <KinProjectPeopleAdd environmentId={environmentId} orgId={orgId} projectKey={key} />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function KinProjectPeopleAdd(props: KinWorkTarget & { readonly projectKey: KinRecordKey }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const target = { environmentId, orgId };
  const { state, refresh } = useKinProjectPage(target, props.projectKey);
  const directory = useKinWorkDirectory(target, true);
  const send = useAtomCommand(kinClient.workProjectPeople, { reportFailure: false });
  const now = new Date(useNowMinuteMs());
  const [picked, setPicked] = useState<ReadonlyArray<KinWorkPrincipal>>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  if (state._tag !== "ready") {
    return state._tag === "loading" ? (
      <View className="items-center py-12">
        <AppActivityIndicator />
      </View>
    ) : (
      <KinLoadFailed
        title="Couldn't load this project"
        cause={state._tag === "failed" ? state.cause : null}
        onRetry={refresh}
      />
    );
  }
  const view = kinProjectPageView(state.value, directory.names, now);
  const save = async () => {
    if (busy || picked.length === 0) return;
    setBusy(true);
    setProblem(null);
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () => send({ environmentId, input: { orgId, key: view.key, add: picked } }),
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
      <KinProjectPeoplePicker
        people={directory.people}
        names={directory.names}
        on={view.people}
        picked={picked}
        disabled={busy || !view.changesPeople}
        onChange={setPicked}
        footer={view.privacy.private ? KIN_PROJECT_PEOPLE.privateDetail : KIN_PROJECT_PEOPLE.detail}
      />
      <Button
        tone="primary"
        label={KIN_PROJECT_PEOPLE.save}
        loading={busy}
        disabled={busy || picked.length === 0 || !view.changesPeople}
        onPress={() => void save()}
      />
    </>
  );
}
