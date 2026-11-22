import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_DEFAULT_FILTER,
  kinWorkOffline,
  kinWorkOnlyOwner,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_PROJECTS,
  KIN_PROJECT_FAILED,
  KIN_PROJECT_GONE,
  KIN_PROJECT_REFUSED,
  KIN_PROJECT_LEAD,
  kinCampaignResultOpens,
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
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useNowMinuteMs } from "../../lib/clock";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  KinFoldSection,
  KinGateView,
  KinWorkFrame,
  KinWorkLoading,
  KinWorkPrivateMark,
  KinWorkProblemNotice,
  KinWorkTaskRow,
  KinWorkTimelineLines,
  KinWorkToggleRow,
} from "./components/KinWorkPieces";
import { KinWorkHealthWord } from "./KinWorkLists";
import { KinTasksList } from "./KinTasksList";
import { KinPlaceLists } from "./KinPlaceLists";
import { KinDocsUnder } from "./KinDocsList";
import { KinCampaignResultsSection } from "./KinMarketing";
import { useKinSectionOn } from "./state/useKinShell";
import { KinProjectPeopleSection } from "./KinProjectPeopleScreen";
import { kinClient } from "./state/kinClient";
import { useKinAskRecord } from "./state/useKinAskRecord";
import { kinHostConnected, useKinGate } from "./state/useKinHost";
import {
  useKinProjectPage,
  useKinWork,
  useKinWorkDirectory,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";
import { KinAsideNote, KinAttentionSection } from "./KinAttention";
import { KinProjectNoteSection } from "./components/KinProjectNote";
import { useKinWorkLink } from "./state/kinWorkLink";

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
  const gate = useKinGate(
    kinClient.workRead.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  // A teammate who follows a link asks the host nothing.
  if (gate !== null) {
    return (
      <KinWorkFrame title={KIN_PROJECTS.title} onBack={() => navigation.goBack()}>
        <KinGateView
          gate={gate}
          refused={kinWorkOnlyOwner("clients")}
          offline={kinWorkOffline("clients")}
          label={KIN_PROJECTS.title}
        />
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
      ) : state._tag === "refused" ? (
        <EmptyState variant="plain" {...KIN_PROJECT_REFUSED} />
      ) : work._tag === "refused" ? (
        <EmptyState variant="plain" {...kinWorkOnlyOwner("clients")} />
      ) : work._tag === "offline" ? (
        <EmptyState variant="plain" {...kinWorkOffline("clients")} />
      ) : state._tag === "failed" || work._tag === "failed" ? (
        <EmptyState
          variant="plain"
          {...KIN_PROJECT_FAILED}
          action={<Button tone="secondary" label={KIN_RETRY} onPress={refresh} />}
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
  const openRecord = useKinWorkLink();
  const { environmentId, orgId } = props;
  const canChange = useAtomValue(kinClient.workProjectUpdate.permissionAtom(environmentId));
  const canNote = useAtomValue(kinClient.workProjectNote.permissionAtom(environmentId));
  const dealsOn = useKinSectionOn(environmentId, "deals");
  const update = useAtomCommand(kinClient.workProjectUpdate, { reportFailure: false });
  const now = new Date(useNowMinuteMs());
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const view = kinProjectPageView(props.page, props.directory.names, now);
  // A project's lead adds its milestones too; the host checks they still lead it.
  const leads =
    view.lead.personId !== null &&
    view.lead.personId === kinFeedViewer(props.directory.orgs, orgId).personId;

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
  const asker = useKinAskRecord(props, { key: view.key, title: view.name });
  const openTask = (task: KinRecordKey) =>
    openRecord("KinWorkItem", { environmentId, orgId, task });
  return (
    <KinTasksList
      environmentId={environmentId}
      orgId={orgId}
      live={props.live}
      stale={props.stale}
      directory={props.directory}
      title="Project"
      onBack={() => navigation.goBack()}
      choices={null}
      initial={{ ...KIN_WORK_DEFAULT_FILTER, project: view.ref }}
      within={{
        bar: canChange
          ? {
              actions: [
                ...asker.actions,
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
                ...asker.menus,
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
          : asker,
        header: (
          <>
            <KinProjectSummary
              view={view}
              problem={problem}
              onDismissProblem={() => setProblem(null)}
              onOpenTask={openTask}
              onOpenClient={(to) => openRecord("KinClient", { environmentId, orgId, party: to })}
              onAddMilestone={
                (canChange || leads) && view.state === "open"
                  ? () =>
                      navigation.navigate("KinMilestoneForm", {
                        environmentId,
                        orgId,
                        project: view.key,
                      })
                  : null
              }
              onChangeLead={
                canChange
                  ? () =>
                      navigation.navigate("KinProjectLead", {
                        environmentId,
                        orgId,
                        project: view.key,
                      })
                  : null
              }
              privacy={{
                shown: canChange,
                disabled: busy || view.privacy.inherited,
                onChange: (sensitive) => void change({ sensitive }),
              }}
              people={
                <KinProjectPeopleSection
                  environmentId={environmentId}
                  orgId={orgId}
                  view={view}
                  onChanged={props.onRefresh}
                  onAdd={() =>
                    navigation.navigate("KinProjectPeople", {
                      environmentId,
                      orgId,
                      project: view.key,
                    })
                  }
                />
              }
              results={
                props.page.results === undefined ? null : (
                  <KinCampaignResultsSection
                    results={props.page.results}
                    audience={view.audience}
                    deals={dealsOn}
                    onOpen={(id) => {
                      const opened = kinCampaignResultOpens(orgId, view.key, view.name, id);
                      navigation.navigate("KinMarketingList", {
                        environmentId,
                        orgId,
                        title: opened.title,
                        ...(opened.to === "contacts"
                          ? { campaign: view.key }
                          : opened.to === "deals"
                            ? { campaign: view.key, deals: id === "won" ? "won" : "open" }
                            : {
                                cameFrom: opened.filter.cameFrom ?? "",
                                show: id === "prospects" ? "prospects" : "clients",
                              }),
                      });
                    }}
                  />
                )
              }
              docs={
                <KinDocsUnder
                  environmentId={environmentId}
                  orgId={orgId}
                  names={props.directory.names}
                  under={{ project: view.key }}
                />
              }
            />
            <View className="gap-5 px-4 pb-2">
              {props.page.can?.note === undefined ? null : (
                <KinProjectNoteSection
                  environmentId={environmentId}
                  orgId={orgId}
                  projectKey={view.key}
                  note={props.page.note ?? null}
                  canEdit={props.page.can.note && canNote}
                  onChanged={props.onRefresh}
                />
              )}
              <KinAsideNote
                environmentId={environmentId}
                orgId={orgId}
                record={view.key}
                names={props.directory.names}
              />
              <KinAttentionSection
                environmentId={environmentId}
                orgId={orgId}
                scope={{ type: "project", key: view.key }}
                names={props.directory.names}
                onOpen={(to) => {
                  if (to.type === "record") openTask(to.key);
                }}
              />
              <KinPlaceLists
                environmentId={environmentId}
                orgId={orgId}
                place={{ project: { key: view.key, title: view.name } }}
                seq={props.stale ? null : props.page.seq}
                directory={props.directory}
              />
            </View>
          </>
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
  readonly onAddMilestone: (() => void) | null;
  /** The owner's way to pick who leads it; null for anyone else. */
  readonly onChangeLead: (() => void) | null;
  /** The owner's switch; anyone else sees only the private mark. */
  readonly privacy: {
    readonly shown: boolean;
    readonly disabled: boolean;
    readonly onChange: (on: boolean) => void;
  };
  /** The docs linked to the project. */
  readonly docs: ReactNode;
  /** Who is on it, and the ways to change that. */
  readonly people: ReactNode;
  /** A campaign's results, for a reader with Clients. */
  readonly results: ReactNode;
}) {
  const { view } = props;
  const { party } = view;
  const count = KIN_PROJECTS.count;
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
          {[view.kind, party?.title, view.target, view.ledBy]
            .filter((part) => part != null)
            .join(" · ")}
        </Text>
        {view.terms === null ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {view.terms}
          </Text>
        )}
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
            onPress={() => props.onOpenClient(party.key)}
          />
        </ListSection>
      )}
      {props.results}
      <ListSection title={KIN_PROJECT_LEAD.title}>
        {props.onChangeLead === null ? (
          <ListRowLayout label={view.lead.name} />
        ) : (
          <ListRow
            icon="person.crop.circle"
            label={view.lead.name}
            detail={KIN_PROJECT_LEAD.change}
            onPress={props.onChangeLead}
          />
        )}
      </ListSection>
      {view.specChanged.length === 0 ? null : (
        <ListSection title={KIN_PROJECTS.specChanged}>
          {view.specChanged.map((row) => (
            <ListRow
              key={row.key}
              label={row.title}
              description={row.line}
              onPress={() => props.onOpenTask(row.key)}
            />
          ))}
        </ListSection>
      )}
      <ListSection title={KIN_PROJECTS.milestones}>
        {view.milestones.length === 0 ? (
          <ListRowLayout
            label={
              props.onAddMilestone === null
                ? KIN_PROJECTS.noMilestones
                : KIN_PROJECTS.noMilestonesAdd
            }
            disabled
          />
        ) : (
          view.milestones.map((row) => (
            <ListRow
              key={row.key}
              label={row.title}
              description={row.line}
              {...(row.badge === null ? {} : { detail: row.badge })}
              onPress={() => props.onOpenTask(row.key)}
            />
          ))
        )}
        {props.onAddMilestone === null ? null : (
          <ListActionRow
            icon="plus"
            label={KIN_PROJECTS.addMilestone}
            onPress={props.onAddMilestone}
          />
        )}
      </ListSection>
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
      {view.money.length === 0 ? null : (
        <KinFoldSection
          title={KIN_PROJECTS.money}
          summary={view.money.map((line) => `${line.label} ${line.value}`)[0] ?? null}
        >
          {view.money.map((line) => (
            <ListRowLayout key={line.label} label={line.label} detail={line.value} />
          ))}
        </KinFoldSection>
      )}
      {view.pullRequests.length === 0 ? null : (
        <KinFoldSection
          title={KIN_PROJECTS.pullRequests}
          summary={String(view.pullRequests.length)}
        >
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
        </KinFoldSection>
      )}
      {props.people}
      {view.meetings.length === 0 ? null : (
        <KinFoldSection
          title={KIN_PROJECTS.meetings}
          summary={count(view.meetings.length, "meeting", "meetings")}
        >
          {view.meetings.map((row) => (
            <KinWorkTaskRow
              key={row.key}
              inset
              row={row}
              saving={false}
              onPress={() => props.onOpenTask(row.key)}
              onAct={null}
            />
          ))}
        </KinFoldSection>
      )}
      {props.docs}
      <KinFoldSection
        title={KIN_PROJECTS.changed}
        summary={
          view.changed.length === 0
            ? KIN_PROJECTS.nothingChanged
            : count(view.changed.length, "change", "changes")
        }
      >
        {view.changed.length === 0 ? null : (
          <View className="gap-2 bg-grouped-card px-4 py-3">
            <KinWorkTimelineLines lines={view.changed} onOpenTask={props.onOpenTask} />
            {view.changedMore === null ? null : (
              <Text textRole="footnote" className="text-foreground-muted">
                {view.changedMore}
              </Text>
            )}
          </View>
        )}
      </KinFoldSection>
      {!props.privacy.shown && view.repos.length === 0 && view.notes === null ? null : (
        <KinFoldSection title={KIN_PROJECTS.details} summary={null}>
          {view.repos.length === 0 ? null : (
            <View className="gap-2 bg-grouped-card px-4 py-3">
              <Text textRole="footnote" className="text-foreground-muted">
                {KIN_PROJECTS.repos}
              </Text>
              <Text textRole="body" selectable className="text-foreground">
                {view.repos.join("\n")}
              </Text>
            </View>
          )}
          {view.notes === null ? null : (
            <View className="gap-2 bg-grouped-card px-4 py-3">
              <Text textRole="footnote" className="text-foreground-muted">
                {KIN_PROJECTS.notes}
              </Text>
              <Text textRole="body" selectable className="text-foreground">
                {view.notes}
              </Text>
            </View>
          )}
          {props.privacy.shown ? (
            <KinWorkToggleRow
              icon="lock"
              label={KIN_PROJECTS.privateLabel}
              description={view.privacy.note}
              value={view.privacy.private}
              disabled={props.privacy.disabled}
              onValueChange={props.privacy.onChange}
            />
          ) : null}
        </KinFoldSection>
      )}
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_PROJECTS.tasks}
      </Text>
    </View>
  );
}
