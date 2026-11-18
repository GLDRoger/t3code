import { useKinOpensClients } from "./state/kinChatOnly";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_LINKED,
  kinLinked,
  kinLinkedRest,
  type KinLinkedGroupName,
} from "@t3tools/client-runtime/kin/kinLinked";
import type { KinNotificationDestination } from "@t3tools/client-runtime/kin/kinNotificationDestination";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_TASK_RECORD,
  kinBriefBy,
  kinNextStep,
  kinRecordAskedBy,
  kinRecordChip,
  kinRecordWho,
  kinTaskActivity,
  type KinActivityLine,
  type KinNextStepAct,
  type KinRecordChipTone,
  type KinRecordWho,
} from "@t3tools/client-runtime/kin/kinTaskRecord";
import {
  KIN_WORK_GONE,
  KIN_WORK_HAND_BACK,
  KIN_WORK_ITEM_FAILED,
  KIN_WORK_MILESTONE,
  KIN_WORK_NEW_COPY,
  KIN_WORK_NOTES_MAX,
  kinWorkOnlyOwner,
  KIN_WORK_REPEAT,
  KIN_WORK_TITLE_MAX,
  kinSameRepeat,
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
  kinWorkEditMoved,
  kinWorkStatusOffer,
  kinWorkItemNotice,
  type KinWorkAction,
  type KinWorkNotice,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  EnvironmentId,
  KIN_RECORD_CHANGES_CAP,
  KinOrgId,
  KinRecordKey,
  type KinAgentId,
  type KinChatId,
  type KinRecordComment,
  type KinRecordDetail,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { Pressable, TextInput, View } from "react-native";

import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { Notice } from "../../components/ui/Notice";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KIN_ONLY } from "../../lib/kinOnly";
import { useOpenWorkspaceDetail } from "../layout/useOpenWorkspaceDetail";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { KinNotesVersions } from "./KinNotesVersions";
import { KinAvatar } from "./components/KinAvatar";
import { useKinOpenTarget } from "./components/KinMessagePage";
import { KinAttachments } from "./components/KinMessageBubble";
import { KinTaskNoteComposer } from "./components/KinTaskNoteComposer";
import { KinNextStep } from "./components/KinNextStep";
import { KinWorkDueRow, KinWorkPlaceRow } from "./components/KinWorkTaskMenus";
import { KinListEntryBody } from "./KinListEntry";
import { KinMakeDocumentStep, type KinMakeStep } from "./KinInvoice";
import { KinWorkFrame, KinWorkLoading, KinWorkTaskRow } from "./components/KinWorkPieces";
import { KinWorkAudienceRow } from "./KinWorkShareRow";
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
import { useKinWorkLink } from "./state/kinWorkLink";
import { useKinGate, useKinHostAt } from "./state/useKinHost";
import { KinGateView } from "./components/KinWorkPieces";

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

const ACTIVITY_SYMBOL: Record<KinActivityLine["icon"], AppSymbolName> = {
  comment: "bubble.left",
  made: "plus",
  gave: "person.crop.circle",
  due: "clock",
  brief: "pencil",
  title: "pencil",
  state: "checkmark.circle",
  link: "link",
  change: "circle",
};

const CHIP: Record<
  KinRecordChipTone,
  {
    readonly box: string;
    readonly text: string;
    readonly tint: string;
    readonly icon: AppSymbolName;
  }
> = {
  wait: {
    box: "bg-warning",
    text: "text-warning-foreground",
    tint: "accent-warning-foreground",
    icon: "clock",
  },
  doing: {
    box: "bg-update",
    text: "text-update-foreground",
    tint: "accent-update-foreground",
    icon: "ellipsis.circle",
  },
  late: {
    box: "bg-danger",
    text: "text-danger-foreground",
    tint: "accent-danger-foreground",
    icon: "exclamationmark.circle",
  },
  done: {
    box: "bg-grouped-card",
    text: "text-foreground",
    tint: "accent-icon-muted",
    icon: "checkmark.circle.fill",
  },
  plain: {
    box: "bg-grouped-card",
    text: "text-foreground-muted",
    tint: "accent-icon-muted",
    icon: "circle",
  },
};

const MENU_WAITING = "waiting:";
const MENU_REPEAT = "repeat:";

/** One task as a full page: where it stands, the next step, details, brief, activity, links. */
export function KinWorkItemScreen({ route }: StaticScreenProps<KinWorkItemParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.task));
  if (environmentId === null || orgId === null || key === null) {
    return (
      <KinWorkFrame title="Task" onBack={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a task"
          detail="Open Work from your Kin chats."
        />
      </KinWorkFrame>
    );
  }
  // A fresh screen per task, so one task's changes never show on the next one opened from it.
  return <KinWorkItemGate key={key} environmentId={environmentId} orgId={orgId} itemKey={key} />;
}

type ItemTarget = KinWorkTarget & { readonly itemKey: KinRecordKey };

function KinWorkItemGate(props: ItemTarget) {
  const navigation = useNavigation();
  const gate = useKinGate(
    kinClient.workRead.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  // A teammate who follows a link asks the host nothing.
  if (gate !== null) {
    return (
      <KinWorkFrame title="Task" onBack={() => navigation.goBack()}>
        <KinGateView gate={gate} refused={kinWorkOnlyOwner("tasks")} label="Task" />
      </KinWorkFrame>
    );
  }
  return <KinWorkItemBody {...props} />;
}

function KinWorkItemBody(props: ItemTarget) {
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const openDetail = useOpenWorkspaceDetail();
  const { environmentId, orgId, itemKey } = props;
  const openTarget = useKinOpenTarget(environmentId, orgId);
  const itemAtom = kinClient.workItem({ environmentId, input: { orgId, key: itemKey } });
  const { state: changed, changes } = useKinWorkChanges(props);
  const state = kinWorkItemState(useAtomValue(itemAtom), useKinWorkAnswer(props, itemKey));
  useKinWorkItemWatch(
    props,
    itemKey,
    state._tag === "ready" ? state.item.seq : null,
    state._tag === "ready" ? state.item.tasks?.map((task) => task.key) : undefined,
  );
  const directory = useKinWorkDirectory(props, true);
  const canGive = useAtomValue(kinClient.workAssign.permissionAtom(environmentId));
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId));
  const canComment = useAtomValue(kinClient.workComment.permissionAtom(environmentId));
  const host = useKinHostAt(environmentId);
  const insets = useSafeAreaInsets();
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  // Pages of comments older than the sheet's, read on asking; a newer sheet keeps them.
  const [older, setOlder] = useState<{
    readonly comments: ReadonlyArray<KinRecordComment>;
    readonly more: boolean;
  } | null>(null);
  const readOlder = useAtomCommand(kinClient.workComments, { reportFailure: false });
  const removeComment = useAtomCommand(kinClient.workCommentRemove, { reportFailure: false });
  const place = useKinWorkPlace(environmentId);
  const work = useKinWork(props);
  // Make invoice and Make its PDF are a step of this page, never a sheet over it.
  const [making, setMaking] = useState<KinMakeStep | null>(null);
  // An older server has no clients or projects: the task shows as it always did.
  const opensClients = useKinOpensClients(environmentId);
  const hostClients = kinWorkHostClients(work._tag === "ready" ? work.live.summary : null);
  const choices = useKinWorkChoices(props, hostClients && canChange);
  const now = new Date(useNowMinuteMs());
  const back = () => navigation.goBack();

  if (state._tag !== "ready") {
    return (
      <KinWorkFrame title="Task" onBack={back}>
        {state._tag === "loading" ? (
          <KinWorkLoading label="Loading task" />
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
      </KinWorkFrame>
    );
  }
  const { item } = state;
  const { orgs, people, joined, invited, names } = directory;
  const openChat = (chatId: KinChatId) =>
    navigation.navigate("KinChat", { environmentId, orgId, chatId });
  const openLink = (link: KinWorkLinkView) => {
    const { open } = link;
    if (open === null) return;
    if (open.type === "chat") return openChat(open.chatId);
    if (open.type === "task")
      return openRecord("KinWorkItem", { environmentId, orgId, task: open.key });
    void tryOpenExternalUrl(open.href, "markdown-link");
  };
  const openThread = (thread: NonNullable<KinWorkLinkView["thread"]>) =>
    openDetail({ name: "Thread", params: thread });
  const linkedSection = (detail: KinRecordDetail, links: ReadonlyArray<KinWorkLinkView>) => (
    <KinWorkLinked
      detail={detail}
      links={links}
      onOpen={(to) =>
        to._tag === "chat"
          ? navigation.navigate("KinChat", {
              environmentId,
              orgId,
              chatId: to.chatId,
              ...(to.messageId === null ? {} : { message: to.messageId }),
            })
          : to._tag === "record"
            ? openTarget(to)
            : undefined
      }
      onOpenLink={openLink}
      onOpenThread={openThread}
    />
  );
  if (item.list !== undefined && making !== null)
    return (
      <KinMakeDocumentStep
        {...props}
        {...making}
        itemKey={item.key}
        onBack={() => setMaking(null)}
      />
    );
  if (item.list !== undefined) {
    const read = kinWorkItemView(item, names, now, KIN_RECORD_CHANGES_CAP, place);
    return (
      <KinWorkFrame title={item.title} onBack={back}>
        <KinListEntryBody
          {...props}
          onMake={setMaking}
          item={item}
          view={read}
          directory={directory}
          now={now}
          links={linkedSection(item, read.links)}
          history={<KinWorkHistory view={read} />}
        />
      </KinWorkFrame>
    );
  }
  const shown = kinWorkApplied(item, changed);
  const view = kinWorkItemView(shown, names, now, KIN_RECORD_CHANGES_CAP, place);
  const saving = changed.pending[itemKey] !== undefined;
  const notice = kinWorkItemNotice(changed, item);
  // Each control shows only where the host said it takes it (`view.can`).
  const act = canChange ? (action: KinWorkAction) => void changes.run(item, action, names) : null;
  const reword = view.can.edit ? act : null;
  const offer = kinWorkStatusOffer(view);
  const waitingOn = kinWorkAssignees({
    orgs,
    orgId,
    people,
    joined,
    invited,
    names,
    current: view.waitingOn,
  });
  const giveTo = () =>
    navigation.navigate("KinWorkAssign", { environmentId, orgId, task: itemKey });
  const handBack = () =>
    navigation.navigate("KinWorkHandBack", {
      environmentId,
      orgId,
      task: itemKey,
      to: view.handBackTo ?? "",
    });
  const step = kinNextStep({ item: shown, view, names, now, change: act !== null, give: canGive });
  const onStep = (id: KinNextStepAct) => {
    if (id === "openWaiting" && step.waiting !== null)
      return navigation.navigate("KinChat", {
        environmentId,
        orgId,
        chatId: step.waiting.chatId,
        message: step.waiting.messageId,
      });
    if (id === "give") return giveTo();
    if (id === "handBack") return handBack();
    if (act === null) return;
    if (id === "keep") return act({ type: "confirm" });
    if (id === "decline") return act({ type: "decline" });
    act({ type: "state", state: id === "done" ? "done" : "open" });
  };
  const openParty = () =>
    openRecord("KinClient", { environmentId, orgId, party: view.party?.key ?? "" });
  const openProject = () =>
    openRecord("KinProject", { environmentId, orgId, project: view.project?.key ?? "" });
  const { edit } = changed;
  const moved = edit === null ? null : kinWorkEditMoved(edit, item);
  const saveEdit = async () => {
    if (saving || edit === null || edit.title.trim() === "") return;
    if (await changes.saveEdit(item, names)) appAtomRegistry.refresh(itemAtom);
  };
  const askedBy = kinRecordAskedBy(item);
  const heldBy = kinRecordWho(item.owner, names);
  const briefBy = kinBriefBy(shown, names, now);
  const chip = kinRecordChip(shown, view, names, now);
  const status: ReadonlyArray<AppBarMenuItem> =
    act === null
      ? []
      : [
          ...(offer.done
            ? [
                {
                  id: "done",
                  title: KIN_WORK_COPY.done,
                  ...(view.leadNote === null ? {} : { subtitle: view.leadNote }),
                  onPress: () => act({ type: "state", state: "done" }),
                },
              ]
            : []),
          ...(offer.reopen
            ? [
                {
                  id: "reopen",
                  title: KIN_WORK_COPY.reopen,
                  ...(view.leadNote === null ? {} : { subtitle: view.leadNote }),
                  onPress: () => act({ type: "state", state: "open" }),
                },
              ]
            : []),
          ...(!offer.menu
            ? []
            : offer.states.map((choice) => ({
                id: choice.state,
                title: choice.label,
                selected: view.state === choice.state,
                onPress: () => act({ type: "state", state: choice.state }),
              }))),
          ...(!offer.menu || !offer.waiting
            ? []
            : [
                {
                  id: "waiting-on",
                  title: KIN_WORK_COPY.waitingOn,
                  items: [
                    ...[...waitingOn.people, ...waitingOn.leads].map((to) => ({
                      id: `${MENU_WAITING}${to.key}`,
                      title: to.name,
                      selected: to.current,
                      disabled: to.invited === true,
                      onPress: () =>
                        act({ type: "state", state: "waiting", waitingOn: to.principal }),
                    })),
                    {
                      id: MENU_WAITING,
                      title: KIN_WORK_COPY.waitingOnNobody,
                      onPress: () => act({ type: "state", state: "waiting", waitingOn: null }),
                    },
                  ],
                },
              ]),
          ...(!offer.menu || !offer.drop
            ? []
            : [
                {
                  id: "dropped",
                  title: KIN_WORK_COPY.drop,
                  destructive: true,
                  onPress: () => act({ type: "state", state: "dropped" }),
                },
              ]),
        ];
  const repeatShown = view.repeat?.text ?? KIN_WORK_REPEAT.never;
  const dated = view.due !== null;
  const repeats = act !== null && view.can.repeat === true && !view.closed;
  const repeatMenu: ReadonlyArray<AppBarMenuItem> = !repeats
    ? []
    : [
        {
          id: "repeat",
          title: `${KIN_WORK_REPEAT.label}: ${repeatShown}`,
          items: [
            ...(dated
              ? []
              : [
                  {
                    id: `${MENU_REPEAT}needs-due`,
                    title: KIN_WORK_REPEAT.needsDue,
                    disabled: true,
                    onPress: () => undefined,
                  },
                ]),
            ...KIN_WORK_REPEAT.choices.map((choice, index) => ({
              id: `${MENU_REPEAT}${index}`,
              title: choice.label,
              selected: kinSameRepeat(choice.rule, view.repeat?.rule ?? null),
              disabled: !dated,
              onPress: () => act({ type: "repeat", rule: choice.rule }),
            })),
            ...(view.repeat === null
              ? []
              : [
                  {
                    id: `${MENU_REPEAT}stop`,
                    title: KIN_WORK_REPEAT.stop,
                    onPress: () => act({ type: "repeat", rule: null }),
                  },
                ]),
          ],
        },
      ];
  // The less-used moves; each is here only where the host takes it from this viewer.
  const moreItems: ReadonlyArray<AppBarMenuItem> = [
    ...(reword === null || edit !== null
      ? []
      : [{ id: "edit", title: "Edit title and brief", onPress: () => changes.startEdit(item) }]),
    ...(status.length === 0
      ? []
      : [{ id: "status", title: KIN_WORK_COPY.status, inline: true, items: status }]),
    ...(canGive && view.assignLabel !== null
      ? [{ id: "give", title: view.assignLabel, onPress: giveTo }]
      : []),
    ...repeatMenu,
    ...(act !== null && view.handBackTo !== null
      ? [{ id: "hand-back", title: KIN_WORK_HAND_BACK.button, onPress: handBack }]
      : []),
    ...(canGive && view.takeBack
      ? [
          {
            id: "take-back",
            title: KIN_WORK_COPY.takeBack,
            onPress: () => void changes.run(item, { type: "takeBack" }, names),
          },
        ]
      : []),
  ];
  const menus: ReadonlyArray<AppBarMenu> =
    moreItems.length === 0 || saving
      ? []
      : [{ title: KIN_TASK_RECORD.more, icon: "ellipsis", items: moreItems }];
  const sheetComments = item.comments ?? [];
  const firstSeq = sheetComments[0]?.seq;
  const earlier = (older?.comments ?? []).filter(
    (one) => firstSeq === undefined || one.seq < firstSeq,
  );
  const comments = [...earlier, ...sheetComments];
  const moreComments = older === null ? item.olderComments === true : older.more;
  const loadOlder = async () => {
    const before = comments[0]?.seq;
    if (before === undefined) return;
    const outcome = await readOlder({
      environmentId,
      input: { orgId, key: itemKey, beforeSeq: before },
    });
    if (AsyncResult.isFailure(outcome)) return;
    setOlder({ comments: [...outcome.value.comments, ...earlier], more: outcome.value.older });
  };
  const askRemove = (commentId: string) =>
    Dialog.confirm({
      title: "Remove this note?",
      message: "It stays in Activity as removed, without its words or files.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () =>
        void removeComment({ environmentId, input: { orgId, key: itemKey, commentId } }).then(
          () => {
            setOlder(null);
            appAtomRegistry.refresh(itemAtom);
          },
        ),
    });
  const connected = host._tag === "host" && host.connected;
  const footer =
    canComment && edit === null
      ? {
          node: (
            <KinTaskNoteComposer
              environmentId={environmentId}
              orgId={orgId}
              itemKey={itemKey}
              connected={connected}
              bottomInset={Math.max(insets.bottom, 12)}
            />
          ),
          bottomInset: Math.max(insets.bottom, 12),
        }
      : undefined;
  return (
    <KinWorkFrame
      title={view.title}
      onBack={back}
      menus={menus}
      form={edit !== null}
      {...(footer === undefined ? {} : { footer })}
    >
      <View className="gap-2.5 px-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <KinRecordChip tone={chip.tone} label={chip.label} />
          <Text textRole="footnote" className="text-foreground-muted">
            {view.heading === "Task" ? item.key : `${item.key} · ${view.heading}`}
          </Text>
        </View>
        {edit !== null ? null : (
          <Text
            textRole="title"
            accessibilityRole="header"
            selectable
            className="font-t3-medium text-foreground"
          >
            {view.title}
          </Text>
        )}
        {view.remarks.map((line) => (
          <Text key={line} textRole="footnote" className="text-foreground-muted">
            {line}
          </Text>
        ))}
      </View>
      {edit === null ? null : (
        <View className="gap-3">
          <ListSection>
            <View className="gap-2 px-4 py-3">
              <Text className="text-sm text-foreground-muted">Title</Text>
              <TextInput
                accessibilityLabel="Title"
                value={edit.title}
                editable={!saving}
                autoFocus
                autoCapitalize="sentences"
                returnKeyType="done"
                maxLength={KIN_WORK_TITLE_MAX}
                onChangeText={(title) => changes.setEdit({ title })}
                textAlignVertical="center"
                placeholder={KIN_WORK_NEW_COPY.titlePlaceholder}
                placeholderTextColorClassName="accent-placeholder"
                className="min-h-8 font-sans text-base text-foreground"
              />
            </View>
            <View className="gap-2 px-4 py-3">
              <Text className="text-sm text-foreground-muted">{KIN_TASK_RECORD.brief}</Text>
              <TextInput
                accessibilityLabel={KIN_TASK_RECORD.brief}
                value={edit.notes}
                editable={!saving}
                multiline
                maxLength={KIN_WORK_NOTES_MAX}
                onChangeText={(notes) => changes.setEdit({ notes })}
                textAlignVertical="top"
                placeholder={KIN_WORK_NEW_COPY.notesPlaceholder}
                placeholderTextColorClassName="accent-placeholder"
                className="min-h-24 font-sans text-base text-foreground"
              />
            </View>
          </ListSection>
          {[
            moved?.title == null ? null : `It now says: ${moved.title}`,
            moved?.notes == null ? null : `The brief now says: ${moved.notes}`,
          ].map((line) =>
            line === null ? null : (
              <Text key={line} textRole="footnote" className="px-2 text-foreground-muted">
                {line}
              </Text>
            ),
          )}
          <View className="flex-row gap-2 px-2">
            <Button
              tone="primary"
              size="compact"
              label={KIN_WORK_COPY.save}
              loading={saving}
              disabled={saving || edit.title.trim() === ""}
              onPress={() => void saveEdit()}
            />
            <Button
              tone="secondary"
              size="compact"
              label="Cancel"
              disabled={saving}
              onPress={changes.cancelEdit}
            />
          </View>
        </View>
      )}
      <KinNextStep
        step={step}
        busy={saving}
        onAct={onStep}
        footnote={
          step.acts.some((one) => one.id === "done" || one.id === "reopen") ? view.leadNote : null
        }
      />
      {notice === null ? null : (
        <KinWorkNoticeLine
          notice={notice}
          saving={saving}
          onUndo={() => void changes.undo(names, item)}
          onDismiss={changes.dismiss}
        />
      )}
      <ListSection title={KIN_TASK_RECORD.details}>
        {askedBy === null ? null : (
          <KinDetailPerson
            icon="person.crop.circle"
            label={KIN_TASK_RECORD.askedBy}
            who={kinRecordWho(askedBy, names)}
          />
        )}
        <KinDetailPerson
          icon="person.fill.checkmark"
          label={KIN_TASK_RECORD.heldBy}
          who={view.owner.retired ? { ...heldBy, name: `${heldBy.name} (retired)` } : heldBy}
          description={[
            view.given,
            step.words === null && view.reason !== null ? `“${view.reason}”` : null,
          ]
            .filter((line) => line !== null)
            .join("\n")}
        />
        {view.owner.principal._tag === "agent" ? (
          <KinWorkLeadChat
            {...props}
            agentId={view.owner.principal.agentId}
            name={view.owner.name}
            onOpen={openChat}
          />
        ) : null}
        {reword !== null && !view.closed ? (
          <KinWorkDueRow view={view} now={now} disabled={saving} onAct={reword} late={view.late} />
        ) : view.due === null ? null : (
          <ListRowLayout
            icon="clock"
            label={KIN_TASK_RECORD.due}
            detail={view.due.charAt(0).toUpperCase() + view.due.slice(1)}
            {...(view.late ? { tone: "danger" as const } : {})}
          />
        )}
        {!hostClients ? null : act === null || !view.can.project ? (
          view.project === null ? null : (
            <ListRow
              icon="folder"
              label={KIN_WORK_NEW_COPY.projectLabel}
              detail={view.project.title}
              onPress={openProject}
            />
          )
        ) : (
          <KinWorkPlaceRow
            icon="folder"
            label={KIN_WORK_NEW_COPY.projectLabel}
            none={KIN_WORK_NEW_COPY.none}
            held={view.project}
            choices={choices.projects}
            clearable={view.can.clearProject}
            disabled={saving}
            onPick={(project) => act({ type: "place", project })}
            onOpen={openProject}
          />
        )}
        {!hostClients ? null : act === null || !view.can.party ? (
          view.party === null ? null : opensClients ? (
            <ListRow
              icon="person.2"
              label={KIN_WORK_NEW_COPY.clientLabel}
              detail={view.party.title}
              {...(view.side === "theirs" ? { description: KIN_WORK_NEW_COPY.sideTheirs } : {})}
              onPress={openParty}
            />
          ) : (
            <ListRowLayout
              icon="person.2"
              label={KIN_WORK_NEW_COPY.clientLabel}
              detail={view.party.title}
              {...(view.side === "theirs" ? { description: KIN_WORK_NEW_COPY.sideTheirs } : {})}
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
            onOpen={openParty}
            side={{ value: view.side, onPick: (side) => act({ type: "place", side }) }}
          />
        )}
        {view.milestone === null ? null : (
          <ListRow
            icon="list.bullet"
            label={KIN_WORK_MILESTONE.label}
            detail={view.milestone.title}
            onPress={() =>
              openRecord("KinWorkItem", {
                environmentId,
                orgId,
                task: view.milestone?.key ?? "",
              })
            }
          />
        )}
        {repeats || view.repeat === null ? null : (
          <ListRowLayout
            icon="arrow.clockwise"
            label={KIN_WORK_REPEAT.label}
            detail={view.repeat.text}
          />
        )}
        {!hostClients ? null : (
          <KinWorkAudienceRow
            environmentId={environmentId}
            orgId={orgId}
            itemKey={item.key}
            view={view}
            names={names}
            disabled={saving}
            onMark={act === null ? null : (on) => act({ type: "private", private: on })}
          />
        )}
      </ListSection>
      {view.tasks === null ? null : (
        <ListSection title={KIN_WORK_MILESTONE.tasks}>
          {view.tasks.length === 0 ? (
            <ListRowLayout label={KIN_WORK_MILESTONE.noTasks} disabled />
          ) : (
            view.tasks.map((row) => (
              <KinWorkTaskRow
                key={row.key}
                row={row}
                saving={false}
                inset
                onAct={null}
                onPress={() => openRecord("KinWorkItem", { environmentId, orgId, task: row.key })}
              />
            ))
          )}
        </ListSection>
      )}
      {edit !== null ? null : (
        <View className="gap-2">
          <ListSection
            title={KIN_TASK_RECORD.brief}
            {...(reword === null
              ? {}
              : {
                  trailing: (
                    <Button
                      tone="text"
                      size="compact"
                      label={KIN_TASK_RECORD.edit}
                      accessibilityLabel="Edit the brief"
                      onPress={() => changes.startEdit(item)}
                    />
                  ),
                })}
          >
            <View className="gap-2.5 px-4 py-3.5">
              <Text
                textRole="body"
                selectable
                className={view.notes === null ? "text-foreground-muted" : "text-foreground"}
              >
                {view.notes ?? KIN_TASK_RECORD.noBrief}
              </Text>
              {briefBy === null ? null : (
                <View className="flex-row items-center gap-1.5">
                  {briefBy.avatar === null ? null : (
                    <KinAvatar avatar={briefBy.avatar} size="mini" />
                  )}
                  <Text textRole="footnote" className="text-foreground-muted">
                    {briefBy.name}, {briefBy.when}
                  </Text>
                </View>
              )}
            </View>
          </ListSection>
          <KinNotesVersions
            item={item}
            names={names}
            now={now}
            busy={saving}
            onRestore={act === null ? null : (notes) => act({ type: "edit", notes })}
          />
        </View>
      )}
      <KinActivity
        lines={kinTaskActivity({ changes: item.changes, comments }, names, now)}
        note={view.historyNote}
        environmentId={environmentId}
        onPressPreview={setPreviewFile}
        onRemove={askRemove}
        {...(moreComments ? { onOlder: () => void loadOlder() } : {})}
      />
      {linkedSection(shown, view.links)}
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
    </KinWorkFrame>
  );
}

/** Where the task stands for this viewer, in one word or two, above its title. */
function KinRecordChip(props: { readonly tone: KinRecordChipTone; readonly label: string }) {
  const look = CHIP[props.tone];
  return (
    <View className={cn("flex-row items-center gap-1.5 rounded-full px-2.5 py-1", look.box)}>
      <SymbolView name={look.icon} size={13} tintColorClassName={look.tint} />
      <Text textRole="footnote" className={cn("font-t3-medium", look.text)}>
        {props.label}
      </Text>
    </View>
  );
}

/** A person or agent in Details, with their picture so an agent reads as one at a glance. */
function KinDetailPerson(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly who: KinRecordWho;
  readonly description?: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={[`${props.label}: ${props.who.name}`, props.description]
        .filter(Boolean)
        .join(". ")}
    >
      <ListRowLayout
        icon={props.icon}
        label={props.label}
        {...(props.description ? { description: props.description } : {})}
        accessory={
          <View className="max-w-[55%] shrink flex-row items-center gap-1.5">
            <KinAvatar avatar={props.who.avatar} size="mini" />
            <Text textRole="footnote" numberOfLines={1} className="shrink text-foreground-muted">
              {props.who.name}
            </Text>
          </View>
        }
      />
    </View>
  );
}

/** Who did what to the task and when, oldest first: its changes and its notes in one thread. */
function KinActivity(props: {
  readonly lines: ReadonlyArray<KinActivityLine>;
  readonly note: string | null;
  readonly environmentId: EnvironmentId;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onRemove: (commentId: string) => void;
  readonly onOlder?: () => void;
}) {
  return (
    <View className="gap-3">
      <Text
        textRole="footnote"
        accessibilityRole="header"
        className="px-2 font-t3-medium text-foreground-muted"
      >
        {KIN_TASK_RECORD.activity}
      </Text>
      {props.note === null ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {props.note}
        </Text>
      )}
      {props.onOlder === undefined ? null : (
        <View className="px-1">
          <Button
            tone="text"
            size="compact"
            label={KIN_TASK_RECORD.older}
            onPress={props.onOlder}
          />
        </View>
      )}
      {props.lines.length === 0 ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {KIN_TASK_RECORD.noActivity}
        </Text>
      ) : (
        props.lines.map((line) => (
          <View key={line.key} className="flex-row gap-2.5 px-1">
            <View className="w-7 items-center pt-0.5">
              <SymbolView
                name={ACTIVITY_SYMBOL[line.icon]}
                size={15}
                tintColorClassName="accent-icon-muted"
              />
            </View>
            <View className="min-w-0 flex-1">
              <Text textRole="footnote" className="text-foreground-muted">
                {line.who === null ? null : (
                  <Text className="font-t3-medium text-foreground">{line.who} </Text>
                )}
                {activityTail(line)}
              </Text>
              {line.comment === null || line.comment.removed ? null : (
                <KinCommentBody
                  comment={line.comment}
                  environmentId={props.environmentId}
                  onPressPreview={props.onPressPreview}
                  onRemove={() => props.onRemove(line.comment?.commentId ?? "")}
                />
              )}
              {line.before === null && line.after === null ? null : (
                <KinBeforeAfter before={line.before} after={line.after} />
              )}
            </View>
          </View>
        ))
      )}
    </View>
  );
}

/** What follows the name: "gave it to Zoya, via Chief of staff · 2h", or a note's time alone. */
const activityTail = (line: KinActivityLine) => {
  const said = [line.text, line.via === null ? "" : `via ${line.via}`]
    .filter((part) => part !== "")
    .join(", ");
  return said === "" ? `· ${line.when}` : `${said} · ${line.when}`;
};

/** A note's words and files, and the way to take it back for whoever may. */
function KinCommentBody(props: {
  readonly comment: NonNullable<KinActivityLine["comment"]>;
  readonly environmentId: EnvironmentId;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onRemove: () => void;
}) {
  const { comment } = props;
  return (
    <View className="mt-1 gap-1.5">
      {comment.body === "" ? null : (
        <Text textRole="body" selectable className="text-foreground">
          {comment.body}
        </Text>
      )}
      {comment.files.length === 0 ? null : (
        <KinAttachments
          attachments={comment.files}
          environmentId={props.environmentId}
          onPressPreview={props.onPressPreview}
        />
      )}
      {comment.canRemove ? (
        <View className="flex-row">
          <Button
            tone="text"
            size="compact"
            label="Remove"
            accessibilityLabel="Remove this note"
            onPress={props.onRemove}
          />
        </View>
      ) : null}
    </View>
  );
}

/** What a change replaced, struck through, over what it became; two lines each until tapped. */
function KinBeforeAfter(props: { readonly before: string | null; readonly after: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Before: ${props.before ?? "nothing"}. After: ${props.after ?? "nothing"}`}
      accessibilityHint={open ? "Shows two lines of each" : "Shows all of it"}
      onPress={() => setOpen(!open)}
      className="mt-1.5 gap-1 rounded-xl bg-grouped-card px-2.5 py-2"
    >
      {props.before === null ? null : (
        <Text
          textRole="footnote"
          numberOfLines={open ? undefined : 2}
          className="text-foreground-muted line-through"
        >
          {props.before}
        </Text>
      )}
      {props.after === null ? null : (
        <Text textRole="footnote" numberOfLines={open ? undefined : 2} className="text-foreground">
          {props.after}
        </Text>
      )}
    </Pressable>
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

/** Everything linked to an entry, both ways, by kind; then its pull requests, workers and pages. */
function KinWorkLinked(props: {
  readonly detail: KinRecordDetail;
  readonly links: ReadonlyArray<KinWorkLinkView>;
  readonly onOpen: (to: KinNotificationDestination) => void;
  readonly onOpenLink: (link: KinWorkLinkView) => void;
  readonly onOpenThread: (thread: NonNullable<KinWorkLinkView["thread"]>) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<KinLinkedGroupName>>(new Set());
  const linked = kinLinked(props.detail, undefined, expanded);
  const rest = kinLinkedRest(props.links);
  if (linked.groups.length === 0 && rest.length === 0 && linked.unlisted === 0) return null;
  return (
    <ListSection
      title={KIN_TASK_RECORD.linked}
      {...(linked.unlisted === 0 ? {} : { footer: KIN_LINKED.unlisted(linked.unlisted) })}
    >
      {linked.groups.map((group) => (
        <View key={group.group}>
          <Text textRole="footnote" className="px-4 pt-3 text-foreground-muted">
            {KIN_LINKED.group[group.group]}
          </Text>
          {group.items.map((item) => {
            const title = item.title ?? KIN_LINKED.message;
            return (
              <RowPressable
                key={item.key}
                accessibilityRole="button"
                accessibilityLabel={item.kind === "message" ? title : `${item.key}, ${title}`}
                onPress={() => props.onOpen(item.open)}
                className="bg-grouped-card"
              >
                <View className="min-w-0 flex-row gap-2 px-4 py-3">
                  {item.kind === "message" ? null : (
                    <Text textRole="body" className="text-foreground-muted">
                      {item.key}
                    </Text>
                  )}
                  <Text
                    textRole="body"
                    numberOfLines={1}
                    className="min-w-0 flex-1 text-foreground"
                  >
                    {title}
                  </Text>
                </View>
              </RowPressable>
            );
          })}
          {group.more === 0 ? null : (
            <ListActionRow
              label={KIN_LINKED.more(group.more)}
              onPress={() => setExpanded(new Set([...expanded, group.group]))}
            />
          )}
        </View>
      ))}
      {rest.map((link) => (
        <KinWorkLink
          key={link.key}
          link={link}
          onOpen={() => props.onOpenLink(link)}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </ListSection>
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

/** A list entry's history, as it read before tasks had Activity. */
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
