import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_DEFAULT_FILTER,
  KIN_WORK_OFFLINE,
  KIN_WORK_ONLY_OWNER,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_PROJECTS,
  KIN_PROJECT_FAILED,
  KIN_PROJECT_GONE,
  kinProjectPageView,
  type KinProjectPageView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { kinWorkSend, type KinWorkFormProblem } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import {
  EnvironmentId,
  KinOrgId,
  KinRecordKey,
  type KinProjectPage,
  type KinProjectState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { useNowMinuteMs } from "../../lib/clock";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  KinWorkFrame,
  KinWorkLoading,
  KinWorkPrivateMark,
  KinWorkProblemNotice,
  KinWorkTaskRow,
  KinWorkTimelineLines,
} from "./components/KinWorkPieces";
import { KinWorkHealthWord } from "./KinWorkLists";
import { KinWorkTaskList } from "./KinWorkScreen";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import {
  useKinProjectPage,
  useKinWork,
  useKinWorkDirectory,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";

export type KinProjectParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The project's short handle, such as `P-3`. */
  readonly project: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** One project: how it is going and why, what is in the way, and its tasks. */
export function KinProjectScreen({ route }: StaticScreenProps<KinProjectParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.project));
  if (environmentId === null || orgId === null || key === null) {
    return (
      <KinWorkFrame title={KIN_PROJECTS.title} onBack={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a project"
          detail="Open Work from your Kin chats."
        />
      </KinWorkFrame>
    );
  }
  return <KinProjectGate key={key} environmentId={environmentId} orgId={orgId} projectKey={key} />;
}

type ProjectTarget = KinWorkTarget & { readonly projectKey: KinRecordKey };

function KinProjectGate(props: ProjectTarget) {
  const navigation = useNavigation();
  const allowed = useAtomValue(kinClient.workRead.permissionAtom(props.environmentId));
  // A teammate who follows a link asks the host nothing.
  if (!allowed) {
    return (
      <KinWorkFrame title={KIN_PROJECTS.title} onBack={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      </KinWorkFrame>
    );
  }
  return <KinProjectStates {...props} />;
}

function KinProjectStates(props: ProjectTarget) {
  const navigation = useNavigation();
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const work = useKinWork(target);
  const directory = useKinWorkDirectory(target, true);
  const { state, refresh } = useKinProjectPage(target, props.projectKey);
  if (state._tag === "ready" && work._tag === "ready") {
    return (
      <KinProjectBody
        {...props}
        page={state.value}
        stale={state.stale || work.stale}
        live={work.live}
        directory={directory}
        onRefresh={refresh}
      />
    );
  }
  return (
    <KinWorkFrame title={KIN_PROJECTS.title} onBack={() => navigation.goBack()}>
      {state._tag === "gone" ? (
        <EmptyState variant="plain" {...KIN_PROJECT_GONE} />
      ) : state._tag === "refused" || work._tag === "refused" ? (
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      ) : work._tag === "offline" ? (
        <EmptyState variant="plain" {...KIN_WORK_OFFLINE} />
      ) : state._tag === "failed" || work._tag === "failed" ? (
        <EmptyState
          variant="plain"
          {...KIN_PROJECT_FAILED}
          action={<Button tone="secondary" label="Try again" onPress={refresh} />}
        />
      ) : (
        <KinWorkLoading label="Loading project" />
      )}
    </KinWorkFrame>
  );
}

function KinProjectBody(
  props: ProjectTarget & {
    readonly page: KinProjectPage;
    readonly stale: boolean;
    readonly live: KinWorkLive;
    readonly directory: KinWorkDirectory;
    readonly onRefresh: () => void;
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const canChange = useAtomValue(kinClient.workProjectUpdate.permissionAtom(environmentId));
  const update = useAtomCommand(kinClient.workProjectUpdate, { reportFailure: false });
  const now = new Date(useNowMinuteMs());
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const view = kinProjectPageView(props.page, props.directory.names, now);

  const change = async (input: {
    readonly state?: KinProjectState;
    readonly sensitive?: boolean;
  }) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        update({ environmentId, input: { orgId, key: view.key, rev: view.rev, ...input } }),
      noun: "project",
      name: view.name,
      own: view.key,
    });
    setBusy(false);
    if (outcome.ok) props.onRefresh();
    else {
      setProblem(outcome.problem);
      if (outcome.problem.kind === "conflict") props.onRefresh();
    }
  };
  const openTask = (task: KinRecordKey) =>
    navigation.navigate("KinWorkItem", { environmentId, orgId, task });
  return (
    <KinWorkTaskList
      environmentId={environmentId}
      orgId={orgId}
      live={props.live}
      stale={props.stale}
      directory={props.directory}
      title="Project"
      onBack={() => navigation.goBack()}
      areas={null}
      choices={null}
      initial={{ ...KIN_WORK_DEFAULT_FILTER, project: view.ref }}
      within={{
        bar: canChange
          ? {
              actions: [
                {
                  accessibilityLabel: KIN_PROJECTS.edit,
                  icon: "pencil",
                  disabled: busy,
                  onPress: () =>
                    navigation.navigate("KinProjectForm", {
                      environmentId,
                      orgId,
                      project: view.key,
                    }),
                },
              ],
              menus: [
                {
                  title: "More",
                  icon: "ellipsis",
                  items:
                    view.state === "open"
                      ? [
                          {
                            id: "done",
                            title: KIN_PROJECTS.done,
                            disabled: busy,
                            onPress: () => void change({ state: "done" }),
                          },
                          {
                            id: "dropped",
                            title: KIN_PROJECTS.drop,
                            destructive: true,
                            disabled: busy,
                            onPress: () => void change({ state: "dropped" }),
                          },
                        ]
                      : [
                          {
                            id: "open",
                            title: KIN_PROJECTS.reopen,
                            disabled: busy,
                            onPress: () => void change({ state: "open" }),
                          },
                        ],
                },
              ],
            }
          : {},
        header: (
          <KinProjectSummary
            view={view}
            problem={problem}
            onDismissProblem={() => setProblem(null)}
            onOpenTask={openTask}
            onOpenClient={(to) =>
              navigation.navigate("KinClient", { environmentId, orgId, party: to })
            }
            privacy={{
              disabled: !canChange || busy || view.privacy.inherited,
              onChange: (sensitive) => void change({ sensitive }),
            }}
          />
        ),
      }}
    />
  );
}

/** Everything about the project above its tasks. Health is shown and never set here. */
function KinProjectSummary(props: {
  readonly view: KinProjectPageView;
  readonly problem: KinWorkFormProblem | null;
  readonly onDismissProblem: () => void;
  readonly onOpenTask: (key: KinRecordKey) => void;
  readonly onOpenClient: (key: KinRecordKey) => void;
  readonly privacy: { readonly disabled: boolean; readonly onChange: (on: boolean) => void };
}) {
  const { view } = props;
  const { party, nextDue } = view;
  return (
    <View className="gap-5 px-4 pb-2">
      <View className="gap-1 px-2">
        <View className="flex-row items-start justify-between gap-3">
          <Text
            textRole="headline"
            accessibilityRole="header"
            className="min-w-0 flex-1 font-t3-bold text-foreground"
          >
            {view.name}
          </Text>
          {view.health === null ? (
            <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
              {view.closed}
            </Text>
          ) : (
            <KinWorkHealthWord health={view.health} />
          )}
        </View>
        <Text textRole="footnote" className="text-foreground-muted">
          {[party?.title, view.target, view.ledBy].filter((part) => part != null).join(" · ")}
        </Text>
        {view.privacy.private ? <KinWorkPrivateMark /> : null}
        {view.why.map((line) => (
          <Text key={line} textRole="body" className="text-foreground">
            {line}
          </Text>
        ))}
        <Text textRole="footnote" className="text-foreground-muted">
          {view.counts}
        </Text>
      </View>
      {props.problem === null ? null : (
        <KinWorkProblemNotice problem={props.problem} onDismiss={props.onDismissProblem} />
      )}
      {party == null ? null : (
        <ListSection>
          <ListRow
            icon="person.2"
            label={party.title}
            detail="Client"
            onPress={() => props.onOpenClient(party.key)}
          />
        </ListSection>
      )}
      {view.blocked.length === 0 ? null : (
        <ListSection title={KIN_PROJECTS.blocked}>
          {view.blocked.map((row) => (
            <ListRow
              key={row.key}
              label={row.title}
              description={row.line}
              onPress={() => props.onOpenTask(row.key)}
            />
          ))}
        </ListSection>
      )}
      {nextDue === null ? null : (
        <ListSection title={KIN_PROJECTS.nextDue}>
          <KinWorkTaskRow
            inset
            row={nextDue}
            saving={false}
            onPress={() => props.onOpenTask(nextDue.key)}
            onAct={null}
          />
        </ListSection>
      )}
      {view.pullRequests.length === 0 ? null : (
        <ListSection title={KIN_PROJECTS.pullRequests}>
          {view.pullRequests.map((pull) => {
            const { href } = pull;
            return href === null ? (
              <ListRow
                key={pull.key}
                icon={PullRequestGlyph.pullRequest}
                label={pull.label}
                description={pull.title}
                onPress={() => props.onOpenTask(pull.task)}
              />
            ) : (
              <ListActionRow
                key={pull.key}
                icon={PullRequestGlyph.pullRequest}
                label={pull.label}
                description={pull.title}
                onPress={() => void tryOpenExternalUrl(href, "pull-request")}
              />
            );
          })}
        </ListSection>
      )}
      <View className="gap-2 px-2">
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_PROJECTS.changed}
        </Text>
        {view.changed.length === 0 ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_PROJECTS.nothingChanged}
          </Text>
        ) : (
          <KinWorkTimelineLines lines={view.changed} onOpenTask={props.onOpenTask} />
        )}
        {view.changedMore === null ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {view.changedMore}
          </Text>
        )}
      </View>
      {view.repos.length === 0 ? null : (
        <View className="gap-2 px-2">
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_PROJECTS.repos}
          </Text>
          <Text textRole="body" selectable className="text-foreground">
            {view.repos.join("\n")}
          </Text>
        </View>
      )}
      {view.notes === null ? null : (
        <View className="gap-2 px-2">
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_PROJECTS.notes}
          </Text>
          <Text textRole="body" selectable className="text-foreground">
            {view.notes}
          </Text>
        </View>
      )}
      <ListSection>
        <ListToggleRow
          icon="lock"
          label={KIN_PROJECTS.privateLabel}
          description={view.privacy.note}
          value={view.privacy.private}
          disabled={props.privacy.disabled}
          onValueChange={props.privacy.onChange}
        />
      </ListSection>
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_PROJECTS.tasks}
      </Text>
    </View>
  );
}
