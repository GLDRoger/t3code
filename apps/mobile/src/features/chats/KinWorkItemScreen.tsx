import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_GONE,
  KIN_WORK_ITEM_FAILED,
  KIN_WORK_NEW_COPY,
  KIN_WORK_ONLY_OWNER,
  KIN_WORK_PRIVATE,
  kinWorkAssignees,
  kinWorkHostClients,
  kinWorkItemState,
  kinWorkItemView,
  type KinWorkItemView,
  type KinWorkLinkView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_COPY,
  kinWorkApplied,
  kinWorkItemNotice,
  type KinWorkNotice,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  EnvironmentId,
  KIN_RECORD_CHANGES_CAP,
  KinOrgId,
  KinRecordKey,
  type KinAgentId,
  type KinChatId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { appAtomRegistry } from "../../state/atom-registry";
import { KIN_ONLY } from "../../lib/kinOnly";
import { useOpenWorkspaceDetail } from "../layout/useOpenWorkspaceDetail";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { KinAvatar } from "./components/KinAvatar";
import { KinWorkStateSymbol } from "./components/KinWorkStateSymbol";
import {
  KinWorkDueRow,
  KinWorkPlaceRow,
  KinWorkSideRow,
  KinWorkStatusRow,
} from "./components/KinWorkTaskMenus";
import { KinListEntryBody } from "./KinListEntry";
import { kinClient } from "./state/kinClient";
import {
  useKinWork,
  useKinWorkAnswer,
  useKinWorkChanges,
  useKinWorkChoices,
  useKinWorkDirectory,
  useKinWorkItemWatch,
  useKinWorkPlace,
  type KinWorkTarget,
} from "./state/useKinWork";

export type KinWorkItemParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The task's short handle, such as `W-12`. */
  readonly task: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

const LINK_SYMBOL: Record<KinWorkLinkView["kind"], AppSymbolName> = {
  pull_request: PullRequestGlyph.pullRequest,
  worker: "play",
  message: "bubble.left",
  task: "checkmark.circle",
  note: "doc.text",
  link: "link",
};

/** One task: where it stands, who has it, what it links to and how it got here. */
export function KinWorkItemScreen({ route }: StaticScreenProps<KinWorkItemParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.task));
  if (environmentId === null || orgId === null || key === null) {
    return (
      <Frame title="Task" onClose={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a task"
          detail="Open Work from your Kin chats."
        />
      </Frame>
    );
  }
  // A fresh screen per task, so one task's changes never show on the next one opened from it.
  return <KinWorkItemGate key={key} environmentId={environmentId} orgId={orgId} itemKey={key} />;
}

function Frame(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={props.title} onClose={props.onClose} />
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

function KinWorkItemGate(props: ItemTarget) {
  const navigation = useNavigation();
  const allowed = useAtomValue(kinClient.workRead.permissionAtom(props.environmentId));
  // A teammate who follows a link asks the host nothing.
  if (!allowed) {
    return (
      <Frame title={props.itemKey} onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      </Frame>
    );
  }
  return <KinWorkItemBody {...props} />;
}

function KinWorkItemBody(props: ItemTarget) {
  const navigation = useNavigation();
  const openDetail = useOpenWorkspaceDetail();
  const { environmentId, orgId, itemKey } = props;
  const itemAtom = kinClient.workItem({ environmentId, input: { orgId, key: itemKey } });
  const { state: changed, changes } = useKinWorkChanges(props);
  const state = kinWorkItemState(useAtomValue(itemAtom), useKinWorkAnswer(props, itemKey));
  useKinWorkItemWatch(props, itemKey, state._tag === "ready" ? state.item.seq : null);
  const directory = useKinWorkDirectory(props, true);
  const canGive = useAtomValue(kinClient.workAssign.permissionAtom(environmentId));
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId));
  const place = useKinWorkPlace(environmentId);
  const work = useKinWork(props);
  // An older server has no clients or projects: the task shows as it always did.
  const hostClients = kinWorkHostClients(work._tag === "ready" ? work.live.summary : null);
  const choices = useKinWorkChoices(props, hostClients && canChange);
  const now = new Date(useNowMinuteMs());
  const close = () => navigation.goBack();

  if (state._tag !== "ready") {
    return (
      <Frame title={itemKey} onClose={close}>
        {state._tag === "loading" ? (
          <View
            className="items-center py-12"
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Loading task"
          >
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
  const { item } = state;
  const { orgs, people, joined, invited, names } = directory;
  if (item.list !== undefined) {
    const read = kinWorkItemView(item, names, now, KIN_RECORD_CHANGES_CAP, place);
    return (
      <Frame title={`${item.key}`} onClose={close}>
        <KinListEntryBody
          {...props}
          item={item}
          view={read}
          directory={directory}
          now={now}
          links={
            read.links.length === 0 ? null : (
              <ListSection title="Links">
                {read.links.map((link) => (
                  <KinWorkLink
                    key={link.key}
                    link={link}
                    onOpen={() => {
                      const { open } = link;
                      if (open === null) return;
                      if (open.type === "chat") {
                        navigation.goBack();
                        return navigation.navigate("KinChat", {
                          environmentId,
                          orgId,
                          chatId: open.chatId,
                        });
                      }
                      if (open.type === "task")
                        return navigation.navigate("KinWorkItem", {
                          environmentId,
                          orgId,
                          task: open.key,
                        });
                      void tryOpenExternalUrl(open.href, "markdown-link");
                    }}
                    onOpenThread={(thread) => {
                      navigation.goBack();
                      openDetail({ name: "Thread", params: thread });
                    }}
                  />
                ))}
              </ListSection>
            )
          }
          history={<KinWorkHistory view={read} />}
        />
      </Frame>
    );
  }
  const view = kinWorkItemView(
    kinWorkApplied(item, changed),
    names,
    now,
    KIN_RECORD_CHANGES_CAP,
    place,
  );
  const saving = changed.pending[itemKey] !== undefined;
  const notice = kinWorkItemNotice(changed, item);
  // An older host reads and hands over; everything else needs one that takes changes.
  const act =
    canChange && view.editable
      ? (action: Parameters<typeof changes.run>[1]) => void changes.run(item, action, names)
      : null;
  const waitingOn = kinWorkAssignees({
    orgs,
    orgId,
    people,
    joined,
    invited,
    names,
    current: view.waitingOn,
  });
  const openChat = (chatId: KinChatId) => {
    navigation.goBack();
    navigation.navigate("KinChat", { environmentId, orgId, chatId });
  };
  const openLink = (link: KinWorkLinkView) => {
    const { open } = link;
    if (open === null) return;
    if (open.type === "chat") return openChat(open.chatId);
    if (open.type === "task")
      return navigation.navigate("KinWorkItem", { environmentId, orgId, task: open.key });
    void tryOpenExternalUrl(open.href, "markdown-link");
  };
  return (
    <Frame title={view.heading} onClose={close}>
      <View className="gap-3 px-2">
        <Text
          textRole="headline"
          accessibilityRole="header"
          className="font-t3-bold text-foreground"
        >
          {view.title}
        </Text>
        <View className="flex-row flex-wrap items-center gap-2">
          <KinWorkStateSymbol state={view.state} />
          <Text textRole="body" className="text-foreground">
            {view.status}
          </Text>
          {view.late ? (
            <Text textRole="footnote" className="font-t3-medium text-danger-foreground">
              Late
            </Text>
          ) : null}
        </View>
        {[view.given, ...view.remarks].map((line) =>
          line === null ? null : (
            <Text key={line} textRole="footnote" className="text-foreground-muted">
              {line}
            </Text>
          ),
        )}
      </View>
      {act === null || view.suggestion === null ? null : (
        <View className="gap-3 px-2">
          <Text textRole="body" className="text-foreground">
            {view.suggestion} Keep it?
          </Text>
          <View className="flex-row gap-2">
            <Button
              tone="primary"
              size="compact"
              label={KIN_WORK_COPY.keep}
              disabled={saving}
              onPress={() => act({ type: "confirm" })}
            />
            <Button
              tone="secondary"
              size="compact"
              label={KIN_WORK_COPY.decline}
              disabled={saving}
              onPress={() => act({ type: "decline" })}
            />
          </View>
        </View>
      )}
      {act === null ? null : (
        <View className="gap-2">
          {view.closed ? (
            <Button
              tone="secondary"
              fullWidth
              icon="arrow.uturn.backward"
              label={KIN_WORK_COPY.reopen}
              loading={saving}
              onPress={() => act({ type: "state", state: "open" })}
            />
          ) : (
            <Button
              tone="primary"
              fullWidth
              icon="checkmark"
              label={KIN_WORK_COPY.done}
              loading={saving}
              onPress={() => act({ type: "state", state: "done" })}
            />
          )}
          {view.leadNote === null ? null : (
            <Text textRole="footnote" className="px-2 text-foreground-muted">
              {view.leadNote}
            </Text>
          )}
        </View>
      )}
      {notice === null ? null : (
        <KinWorkNoticeLine
          notice={notice}
          saving={saving}
          onUndo={() => void changes.undo(names, item)}
          onDismiss={changes.dismiss}
        />
      )}
      <ListSection>
        <ListRowLayout
          leading={<KinAvatar avatar={view.owner.avatar} size="mini" />}
          label={view.owner.name}
          detail={view.owner.retired ? "Has it · Retired" : "Has it"}
        />
        {act === null || view.closed ? null : (
          <KinWorkStatusRow
            view={view}
            people={[...waitingOn.people, ...waitingOn.leads]}
            disabled={saving}
            onAct={act}
          />
        )}
        {act !== null && !view.closed ? (
          <KinWorkDueRow view={view} now={now} disabled={saving} onAct={act} />
        ) : view.due === null ? null : (
          <ListRowLayout
            icon="clock"
            label={view.due.charAt(0).toUpperCase() + view.due.slice(1)}
            detail="Due"
          />
        )}
        {canGive && view.assignLabel !== null ? (
          <ListActionRow
            label={view.assignLabel}
            disabled={saving}
            onPress={() =>
              navigation.navigate("KinWorkAssign", { environmentId, orgId, task: itemKey })
            }
          />
        ) : null}
        {canGive && view.takeBack ? (
          <ListActionRow
            label={KIN_WORK_COPY.takeBack}
            disabled={saving}
            onPress={() => void changes.run(item, { type: "takeBack" }, names)}
          />
        ) : null}
        {view.owner.principal._tag === "agent" ? (
          <KinWorkLeadChat
            {...props}
            agentId={view.owner.principal.agentId}
            name={view.owner.name}
            onOpen={openChat}
          />
        ) : null}
        {act === null ? null : (
          <ListActionRow
            label="Edit title and notes"
            disabled={saving}
            onPress={() =>
              navigation.navigate("KinWorkEdit", { environmentId, orgId, task: itemKey })
            }
          />
        )}
      </ListSection>
      {!hostClients ? null : (
        <ListSection>
          {act === null ? (
            view.party === null ? null : (
              <ListRow
                icon="person.2"
                label={KIN_WORK_NEW_COPY.clientLabel}
                detail={view.party.title}
                onPress={() =>
                  navigation.navigate("KinClient", {
                    environmentId,
                    orgId,
                    party: view.party?.key ?? "",
                  })
                }
              />
            )
          ) : (
            <KinWorkPlaceRow
              icon="person.2"
              label={KIN_WORK_NEW_COPY.clientLabel}
              none={KIN_WORK_NEW_COPY.none}
              held={view.party}
              choices={choices.clients}
              disabled={saving}
              onPick={(party) => act({ type: "place", party })}
            />
          )}
          {act === null || view.party === null ? null : (
            <KinWorkSideRow
              side={view.side}
              disabled={saving}
              onPick={(side) => act({ type: "place", side })}
            />
          )}
          {act === null ? (
            view.project === null ? null : (
              <ListRow
                icon="folder"
                label={KIN_WORK_NEW_COPY.projectLabel}
                detail={view.project.title}
                onPress={() =>
                  navigation.navigate("KinProject", {
                    environmentId,
                    orgId,
                    project: view.project?.key ?? "",
                  })
                }
              />
            )
          ) : (
            <KinWorkPlaceRow
              icon="folder"
              label={KIN_WORK_NEW_COPY.projectLabel}
              none={KIN_WORK_NEW_COPY.none}
              held={view.project}
              choices={choices.projects}
              disabled={saving}
              onPick={(project) => act({ type: "place", project })}
            />
          )}
          {view.party === null ? null : (
            <ListActionRow
              label={`Open ${view.party.title}`}
              onPress={() =>
                navigation.navigate("KinClient", {
                  environmentId,
                  orgId,
                  party: view.party?.key ?? "",
                })
              }
            />
          )}
          {view.project === null ? null : (
            <ListActionRow
              label={`Open ${view.project.title}`}
              onPress={() =>
                navigation.navigate("KinProject", {
                  environmentId,
                  orgId,
                  project: view.project?.key ?? "",
                })
              }
            />
          )}
          {act === null && !view.privacy.private ? null : (
            <ListToggleRow
              icon="lock"
              label={KIN_WORK_PRIVATE}
              description={view.privacy.note}
              value={view.privacy.private}
              disabled={act === null || saving || view.privacy.inherited}
              onValueChange={(on) => act?.({ type: "private", private: on })}
            />
          )}
        </ListSection>
      )}
      {view.notes === null ? null : (
        <View className="gap-2 px-2">
          <Text textRole="footnote" className="text-foreground-muted">
            Notes
          </Text>
          <Text textRole="body" selectable className="text-foreground">
            {view.notes}
          </Text>
        </View>
      )}
      {view.links.length === 0 ? null : (
        <ListSection title="Links">
          {view.links.map((link) => (
            <KinWorkLink
              key={link.key}
              link={link}
              onOpen={() => openLink(link)}
              onOpenThread={(thread) => {
                navigation.goBack();
                openDetail({ name: "Thread", params: thread });
              }}
            />
          ))}
        </ListSection>
      )}
      <KinWorkHistory view={view} />
    </Frame>
  );
}

/** What just happened to the task: said quietly when it worked, plainly when it didn't. */
function KinWorkNoticeLine(props: {
  readonly notice: KinWorkNotice;
  readonly saving: boolean;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
}) {
  const { notice } = props;
  return (
    <Notice
      message={notice.text}
      tone={notice.kind === "failed" ? "danger" : "default"}
      {...(notice.kind === "saved" ? { icon: "checkmark.circle" as const } : {})}
      {...(notice.undo === null
        ? { onDismiss: props.onDismiss }
        : {
            action: { label: KIN_WORK_COPY.undo, onPress: props.onUndo, pending: props.saving },
          })}
    />
  );
}

function KinWorkLink(props: {
  readonly link: KinWorkLinkView;
  readonly onOpen: () => void;
  readonly onOpenThread: (thread: NonNullable<KinWorkLinkView["thread"]>) => void;
}) {
  const { link } = props;
  const { thread } = link;
  const content = {
    icon: LINK_SYMBOL[link.kind],
    label: link.label,
    ...(link.detail === null ? {} : { description: link.detail }),
  };
  return (
    <>
      {link.open === null ? (
        <ListRowLayout {...content} />
      ) : (
        <ListRow {...content} onPress={props.onOpen} />
      )}
      {/* A lead's work opens its thread the way its task card does; a Kin-only app has no threads. */}
      {thread === null || KIN_ONLY ? null : (
        <ListActionRow
          label={KIN_WORK_COPY.openThread}
          onPress={() => props.onOpenThread(thread)}
        />
      )}
    </>
  );
}

function KinWorkLeadChat(
  props: KinWorkTarget & {
    readonly agentId: KinAgentId;
    readonly name: string;
    readonly onOpen: (chatId: KinChatId) => void;
  },
) {
  const { environmentId, orgId } = props;
  // The owner's list keeps a retired agent, whose chat is where it is restored.
  const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
  const result = useAtomValue(
    canRestore
      ? kinClient.agents({ environmentId, orgId })
      : kinClient.leads({ environmentId, input: { orgId } }),
  );
  const lead = Option.getOrNull(AsyncResult.value(result))?.leads.find(
    (held) => held.agentId === props.agentId,
  );
  if (lead === undefined) return null;
  return (
    <ListActionRow
      label={`Chat with ${props.name}`}
      onPress={() => props.onOpen(lead.ownerChatId)}
    />
  );
}

function KinWorkHistory({ view }: { readonly view: KinWorkItemView }) {
  if (view.history.length === 0) return null;
  return (
    <View className="gap-2 px-2">
      <Text textRole="footnote" className="text-foreground-muted">
        History
      </Text>
      {view.history.map((line) => (
        <View key={line.key} className="flex-row gap-3">
          <Text textRole="footnote" className="w-16 text-foreground-muted">
            {line.when}
          </Text>
          <Text textRole="footnote" className="min-w-0 flex-1 text-foreground">
            {line.text}
          </Text>
        </View>
      ))}
      {view.historyNote === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {view.historyNote}
        </Text>
      )}
    </View>
  );
}
