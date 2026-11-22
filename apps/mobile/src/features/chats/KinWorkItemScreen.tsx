import { useKinOpensClients } from "./state/kinChatOnly";
import { KIN_RETRY, kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_LINKED,
  kinLinked,
  kinLinkedRest,
  type KinLinkedGroupName,
} from "@t3tools/client-runtime/kin/kinLinked";
import type { KinNotificationDestination } from "@t3tools/client-runtime/kin/kinNotificationDestination";
import { useAtomValue } from "@effect/atom-react";
import { kinAccessMeAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinTaskProjectsAllowed } from "@t3tools/client-runtime/kin/kinWorkClients";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_TASK_LINK,
  KIN_TASK_NOTE_COPY,
  KIN_TASK_RECORD,
  kinProjectNoteLine,
  kinTaskLinkProblem,
  kinBriefBy,
  kinNextStep,
  kinRecordAskedBy,
  kinRecordChip,
  kinRecordWho,
  kinTaskControls,
  kinTaskActivity,
  kinTaskPeopleFolded,
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
  KIN_WORK_STEPS,
  KIN_WORK_URGENT,
  kinSameRepeat,
  kinWorkStepProblem,
  kinWorkAssignees,
  kinWorkClientStays,
  kinWorkHostClients,
  kinWorkItemState,
  kinWorkItemView,
  kinWorkTitleCount,
  kinWorkTitleTooLong,
  type KinWorkItemView,
  type KinWorkLinkView,
  type KinWorkStepsView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_COPY,
  kinWorkApplied,
  kinWorkEditMoved,
  kinWorkStatusOffer,
  kinWorkItemNotice,
  kinWorkTakeLabel,
  type KinWorkAction,
  type KinWorkNotice,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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

import { useState, type ReactNode, useRef, type ComponentRef } from "react";
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
import { KinAttachments } from "./components/KinMessageBubble";
import { KinTaskNoteComposer } from "./components/KinTaskNoteComposer";
import { KinNextStep } from "./components/KinNextStep";
import { connectionAtomRuntime } from "../../connection/runtime";
import { KinDayField } from "./components/KinDayField";
import { KinWorkStatusRow } from "./components/KinWorkTaskMenus";
import { KinWorkPlacePicker } from "./components/KinWorkPlacePicker";
import { KinListEntryBody } from "./KinListEntry";
import { KinMakeDocumentStep } from "./KinInvoice";
import type { KinMakeStep } from "./kinMakeStep";
import {
  KIN_URGENT_SYMBOL,
  KinWorkFieldBox,
  KinWorkFrame,
  KinWorkLoading,
  KinWorkTaskRow,
  KinWorkToggleRow,
} from "./components/KinWorkPieces";
import { KinWorkAudienceRow } from "./KinWorkShareRow";
import { kinClient } from "./state/kinClient";
import { useKinAskRecord } from "./state/useKinAskRecord";
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
import { kinLines, useKinTextGrows } from "./components/kinTextGrows";

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
  const titleField = useRef<ComponentRef<typeof TextInput>>(null);
  const briefField = useRef<ComponentRef<typeof TextInput>>(null);
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const openDetail = useOpenWorkspaceDetail();
  const { environmentId, orgId, itemKey } = props;
  const openLinked = useKinOpenLinked(props);
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
  const addLink = useAtomCommand(kinClient.workLinkAdd, { reportFailure: false });
  const removeLink = useAtomCommand(kinClient.workLinkRemove, { reportFailure: false });
  const canLink = useAtomValue(kinClient.workLinkAdd.permissionAtom(environmentId));
  const place = useKinWorkPlace(environmentId);
  const work = useKinWork(props);
  // Make invoice and Make its PDF are a step of this page, never a sheet over it.
  const [making, setMaking] = useState<KinMakeStep | null>(null);
  // Asked by and Held by, folded under one row when the card on top already names them.
  const [peopleOpen, setPeopleOpen] = useState(false);
  // An older server has no clients or projects: the task shows as it always did.
  const opensClients = useKinOpensClients(environmentId);
  const hostClients = kinWorkHostClients(work._tag === "ready" ? work.live.summary : null);
  const choices = useKinWorkChoices(props, hostClients && canChange);
  // A teammate moves a task only into a project they lead, as the host takes it.
  const projectsAllowed = kinTaskProjectsAllowed(
    useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId)),
  );
  const now = new Date(useNowMinuteMs());
  const back = () => navigation.goBack();
  const task = state._tag === "ready" && state.item.list === undefined ? state.item : null;
  const asker = useKinAskRecord(props, task === null ? null : { key: task.key, title: task.title });

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
  const linkFailed = (outcome: AsyncResult.AsyncResult<unknown, unknown>, what: string) => {
    if (!AsyncResult.isFailure(outcome)) return false;
    Dialog.alert(kinFailureText(squashAtomCommandFailure(outcome), what));
    return true;
  };
  const askLink = () =>
    Dialog.prompt({
      title: KIN_TASK_LINK.add,
      message: KIN_TASK_LINK.url,
      placeholder: KIN_TASK_LINK.urlPlaceholder,
      initialValue: "",
      confirmText: KIN_TASK_LINK.next,
      onConfirm: (typed) => {
        const url = typed.trim();
        if (url === "") return;
        const problem = kinTaskLinkProblem(url);
        if (problem !== null) return Dialog.alert(problem);
        Dialog.prompt({
          title: KIN_TASK_LINK.add,
          message: KIN_TASK_LINK.name,
          initialValue: "",
          confirmText: KIN_TASK_LINK.save,
          onConfirm: (named) => {
            const name = named.trim();
            void addLink({
              environmentId,
              input: { orgId, key: itemKey, url, ...(name === "" ? {} : { name }) },
            }).then((outcome) => {
              if (!linkFailed(outcome, KIN_TASK_LINK.notAdded)) appAtomRegistry.refresh(itemAtom);
            });
          },
        });
      },
    });
  const askUnlink = (link: KinWorkLinkView) => {
    const { removeUrl } = link;
    if (removeUrl === undefined) return;
    Dialog.confirm({
      title: KIN_TASK_LINK.removeTitle,
      message: link.label,
      confirmText: KIN_TASK_LINK.removeConfirm,
      destructive: true,
      onConfirm: () =>
        void removeLink({ environmentId, input: { orgId, key: itemKey, url: removeUrl } }).then(
          (outcome) => {
            if (!linkFailed(outcome, KIN_TASK_LINK.notRemoved)) appAtomRegistry.refresh(itemAtom);
          },
        ),
    });
  };
  const linkedSection = (
    detail: KinRecordDetail,
    links: ReadonlyArray<KinWorkLinkView>,
    editsLinks = false,
  ) => (
    <KinWorkLinked
      detail={detail}
      links={links}
      onOpen={openLinked}
      onOpenLink={openLink}
      onOpenThread={openThread}
      {...(editsLinks ? { onAddLink: askLink, onRemoveLink: askUnlink } : {})}
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
  const clientStays = hostClients ? kinWorkClientStays(shown, choices.projectClients) : null;
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
  const folded = kinTaskPeopleFolded(shown, step);
  const controls = kinTaskControls({
    view,
    change: act !== null,
    give: canGive,
    step: step.acts,
  });
  const dated = view.due !== null;
  const repeats = act !== null && view.can.repeat === true && !view.closed;
  const repeatMenu: ReadonlyArray<AppBarMenuItem> = !repeats
    ? []
    : [
        {
          id: "repeat",
          title: KIN_WORK_REPEAT.menu(view.repeat?.text ?? null),
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
    ...(controls.menu.give && view.assignLabel !== null
      ? [{ id: "give", title: view.assignLabel, onPress: giveTo }]
      : []),
    ...repeatMenu,
    ...(controls.menu.handBack
      ? [{ id: "hand-back", title: KIN_WORK_HAND_BACK.button, onPress: handBack }]
      : []),
    ...(controls.menu.takeBack
      ? [
          {
            id: "take-back",
            title: kinWorkTakeLabel(item, names),
            onPress: () => void changes.run(item, { type: "takeBack" }, names),
          },
        ]
      : []),
    ...(controls.menu.drop && act !== null
      ? [
          {
            id: "dropped",
            title: KIN_WORK_COPY.drop,
            destructive: true,
            onPress: () => act({ type: "state", state: "dropped" }),
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
      title: KIN_TASK_NOTE_COPY.removeTitle,
      message: KIN_TASK_RECORD.removeDetail,
      confirmText: KIN_TASK_NOTE_COPY.remove,
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
      actions={asker.actions}
      menus={[...asker.menus, ...menus]}
      form={edit !== null}
      // The form opens at the top, wherever the page was scrolled to.
      showTop={edit === null ? null : edit.key}
      {...(footer === undefined ? {} : { footer })}
    >
      <View className="gap-2.5 px-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <KinRecordChip tone={chip.tone} label={chip.label} />
          {view.urgent && !view.closed ? <KinUrgentFlag /> : null}
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
            <KinWorkFieldBox label={"Title"} input={titleField}>
              <TextInput
                ref={titleField}
                accessibilityLabel="Title"
                value={edit.title}
                editable={!saving}
                autoCapitalize="sentences"
                returnKeyType="done"
                onChangeText={(title) => changes.setEdit({ title })}
                textAlignVertical="center"
                placeholderTextColorClassName="accent-placeholder"
                className="min-h-8 font-sans text-base text-foreground"
              />
              {kinWorkTitleCount(edit.title) === null ? null : (
                <Text
                  textRole="footnote"
                  className={
                    kinWorkTitleTooLong(edit.title)
                      ? "text-danger-foreground tabular-nums"
                      : "text-foreground-muted tabular-nums"
                  }
                >
                  {kinWorkTitleCount(edit.title)}
                </Text>
              )}
            </KinWorkFieldBox>
            <KinWorkFieldBox label={KIN_TASK_RECORD.brief} input={briefField}>
              <TextInput
                ref={briefField}
                accessibilityLabel={KIN_TASK_RECORD.brief}
                value={edit.notes}
                editable={!saving}
                // Opened from the brief's own Edit: the words go there, not into the title.
                autoFocus
                multiline
                maxLength={KIN_WORK_NOTES_MAX}
                onChangeText={(notes) => changes.setEdit({ notes })}
                textAlignVertical="top"
                placeholder={KIN_WORK_NEW_COPY.notesPlaceholder}
                placeholderTextColorClassName="accent-placeholder"
                className="min-h-24 font-sans text-base text-foreground"
              />
            </KinWorkFieldBox>
          </ListSection>
          {[
            moved?.title == null ? null : KIN_WORK_COPY.nowSays(moved.title),
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
      {view.steps === null ? null : (
        <KinTaskSteps
          steps={view.steps}
          disabled={saving}
          onTick={
            act === null || !view.steps.editable
              ? null
              : (index, title, done) => act({ type: "tick", index, title, done })
          }
          onChange={
            act === null || !view.steps.editable
              ? null
              : (steps, said) => act({ type: "steps", steps, said })
          }
        />
      )}
      <ListSection title={KIN_TASK_RECORD.details}>
        {askedBy === null || (folded?.asked === true && !peopleOpen) ? null : (
          <KinDetailPerson
            icon="person.crop.circle"
            label={KIN_TASK_RECORD.askedBy}
            who={kinRecordWho(askedBy, names)}
          />
        )}
        {folded?.held === true && !peopleOpen ? null : (
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
        )}
        {view.owner.principal._tag === "agent" ? (
          <KinWorkLeadChat
            {...props}
            agentId={view.owner.principal.agentId}
            name={view.owner.name}
            onOpen={openChat}
          />
        ) : null}
        {act === null || controls.page.status === null ? null : (
          <KinWorkStatusRow
            view={view}
            offer={offer}
            status={controls.page.status}
            people={[...waitingOn.people, ...waitingOn.leads]}
            disabled={saving}
            onAct={act}
          />
        )}
        {act === null || view.steps?.editable !== true || view.closed ? null : (
          <KinWorkToggleRow
            icon={KIN_URGENT_SYMBOL}
            label={KIN_WORK_URGENT.label}
            value={view.urgent}
            disabled={saving}
            onValueChange={(urgent) => act({ type: "urgent", urgent })}
          />
        )}
        {reword !== null && !view.closed ? (
          <KinDayField
            icon="clock"
            label={KIN_TASK_RECORD.due}
            day={view.dueDay}
            // A timed date has no one day to mark, so the row says it as it is.
            {...(view.due !== null && view.dueDay === null ? { detail: capital(view.due) } : {})}
            none={KIN_WORK_COPY.noDate}
            zone={names.zone}
            now={now}
            disabled={saving}
            onPick={(day) => reword({ type: "due", day })}
          />
        ) : view.due === null ? null : (
          <ListRowLayout
            icon="clock"
            label={KIN_TASK_RECORD.due}
            detail={capital(view.due)}
            {...(view.late ? { tone: "danger" as const } : {})}
          />
        )}
        {!hostClients ? null : act === null || !view.can.project ? (
          view.project === null ? null : (
            <ListRow
              icon="folder"
              label={KIN_WORK_NEW_COPY.projectLabel}
              detail={view.project.title}
              detailEllipsizeMode="tail"
              onPress={openProject}
            />
          )
        ) : (
          <KinWorkPlacePicker
            target={props}
            noun="project"
            icon="folder"
            label={KIN_WORK_NEW_COPY.projectLabel}
            held={view.project}
            choices={choices.projects}
            done={choices.doneProjects}
            only={projectsAllowed}
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
              detailEllipsizeMode="tail"
              {...(view.side === "theirs" ? { description: KIN_WORK_NEW_COPY.sideTheirs } : {})}
              onPress={openParty}
            />
          ) : (
            <ListRowLayout
              icon="person.2"
              label={KIN_WORK_NEW_COPY.clientLabel}
              detail={view.party.title}
              detailEllipsizeMode="tail"
              {...(view.side === "theirs" ? { description: KIN_WORK_NEW_COPY.sideTheirs } : {})}
            />
          )
        ) : (
          <KinWorkPlacePicker
            target={props}
            noun="client"
            icon="person.2"
            label={KIN_WORK_NEW_COPY.clientLabel}
            held={view.party}
            choices={choices.clients}
            disabled={saving}
            onPick={(party) => act({ type: "place", party })}
            onOpen={openParty}
            side={{ value: view.side, onPick: (side) => act({ type: "place", side }) }}
          />
        )}
        {clientStays === null ? null : (
          <Text textRole="footnote" className="px-4 pb-3 text-foreground-muted">
            {clientStays}
          </Text>
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
        {folded === null || peopleOpen ? null : (
          <ListRow
            icon="person.crop.circle"
            label={folded.label}
            onPress={() => setPeopleOpen(true)}
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
                      accessibilityLabel={KIN_TASK_RECORD.editBrief}
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
        {...(item.projectNote === undefined
          ? {}
          : { projectNote: kinProjectNoteLine(item.projectNote, names, now) })}
        onOpenProject={(project) => openRecord("KinProject", { environmentId, orgId, project })}
      />
      {linkedSection(shown, view.links, canLink && view.can.links === true)}
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
    </KinWorkFrame>
  );
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A task someone marked urgent, beside where it stands. */
function KinUrgentFlag() {
  return (
    <View className="flex-row items-center gap-1">
      <SymbolView
        name={KIN_URGENT_SYMBOL}
        size={12}
        tintColorClassName="accent-warning-foreground"
        type="monochrome"
      />
      <Text textRole="footnote" className="font-t3-medium text-warning-foreground">
        {KIN_WORK_URGENT.label}
      </Text>
    </View>
  );
}

/**
 * A task's checklist: a tap on a box ticks it; a step is added at the foot and removed with its
 * cross. Ticking every step leaves the task open: done is still the top card's to say.
 */
function KinTaskSteps(props: {
  readonly steps: KinWorkStepsView;
  readonly disabled: boolean;
  readonly onTick: ((index: number, title: string, done: boolean) => void) | null;
  readonly onChange:
    | ((
        steps: ReadonlyArray<{ readonly title: string; readonly done: boolean }>,
        said: "added" | "removed",
      ) => void)
    | null;
}) {
  const { steps, onTick, onChange } = props;
  const [draft, setDraft] = useState("");
  const held = steps.items.map((item) => ({ title: item.title, done: item.done }));
  const problem = draft.trim() === "" ? null : kinWorkStepProblem(draft, held.length);
  const add = () => {
    const title = draft.trim();
    if (onChange === null || title === "" || problem !== null) return;
    onChange([...held, { title, done: false }], "added");
    setDraft("");
  };
  return (
    <View className="gap-2">
      <ListSection
        title={
          steps.count === null ? KIN_WORK_STEPS.title : `${KIN_WORK_STEPS.title} · ${steps.count}`
        }
      >
        {steps.items.map((item) => (
          <View key={`${item.index}:${item.title}`} className="min-h-12 flex-row items-center">
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: item.done, disabled: onTick === null }}
              accessibilityLabel={onTick === null ? item.title : item.label}
              disabled={onTick === null || props.disabled}
              onPress={() => onTick?.(item.index, item.title, !item.done)}
              className="min-w-0 flex-1 flex-row items-center gap-3 py-3 pl-4 active:opacity-60"
            >
              <SymbolView
                name={item.done ? "checkmark.circle.fill" : "circle"}
                size={20}
                tintColorClassName={item.done ? "accent-icon" : "accent-icon-muted"}
                type="monochrome"
              />
              <Text
                textRole="body"
                className={cn(
                  "min-w-0 flex-1",
                  item.done ? "text-foreground-muted line-through" : "text-foreground",
                )}
              >
                {item.title}
              </Text>
            </Pressable>
            {onChange === null ? (
              <View className="w-4" />
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${KIN_WORK_STEPS.remove}: ${item.title}`}
                disabled={props.disabled}
                hitSlop={8}
                onPress={() =>
                  onChange(
                    held.filter((_, index) => index !== item.index),
                    "removed",
                  )
                }
                className="px-4 py-3 active:opacity-60"
              >
                <SymbolView
                  name="xmark"
                  size={12}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
              </Pressable>
            )}
          </View>
        ))}
        {onChange === null ? null : (
          <View className="min-h-12 flex-row items-center gap-3 px-4 py-2">
            <SymbolView
              name="plus"
              size={16}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
            <TextInput
              accessibilityLabel={KIN_WORK_STEPS.add}
              value={draft}
              editable={!props.disabled}
              autoCapitalize="sentences"
              returnKeyType="done"
              submitBehavior="submit"
              onChangeText={setDraft}
              onSubmitEditing={add}
              placeholder={KIN_WORK_STEPS.placeholder}
              placeholderTextColorClassName="accent-placeholder"
              className="min-h-8 min-w-0 flex-1 font-sans text-base text-foreground"
            />
          </View>
        )}
      </ListSection>
      {problem === null ? null : (
        <Text accessibilityRole="alert" textRole="footnote" className="px-2 text-danger-foreground">
          {problem}
        </Text>
      )}
      {steps.allDone === null ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {steps.allDone}
        </Text>
      )}
    </View>
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
  const grows = useKinTextGrows();
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
            <Text
              textRole="footnote"
              numberOfLines={kinLines(1, grows)}
              className="shrink text-foreground-muted"
            >
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
  readonly projectNote?: ReturnType<typeof kinProjectNoteLine>;
  readonly onOpenProject: (key: KinRecordKey) => void;
}) {
  const pinned = props.projectNote;
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
      {pinned === undefined ? null : (
        <View
          accessible
          accessibilityLabel={`${KIN_TASK_RECORD.fromProject}, ${pinned.project.title}. ${pinned.body}`}
          className="flex-row gap-2.5 px-1"
        >
          <View className="w-7 items-center pt-0.5">
            <SymbolView name="folder" size={15} tintColorClassName="accent-icon-muted" />
          </View>
          <View className="min-w-0 flex-1">
            <Text textRole="footnote" className="text-foreground-muted">
              <Text className="font-t3-medium text-foreground">{KIN_TASK_RECORD.fromProject} </Text>
              <Text
                accessibilityRole="link"
                className="text-foreground underline"
                onPress={() => props.onOpenProject(pinned.project.key)}
              >
                {pinned.project.title}
              </Text>
              {` · ${pinned.who}, ${pinned.when}`}
            </Text>
            <Text textRole="body" selectable className="mt-1 text-foreground">
              {pinned.body}
            </Text>
          </View>
        </View>
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
        pinned !== undefined ? null : (
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {KIN_TASK_RECORD.noActivity}
          </Text>
        )
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
            label={KIN_TASK_NOTE_COPY.remove}
            accessibilityLabel={KIN_TASK_NOTE_COPY.removeLabel}
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
  /** Only where this viewer may change the entry's web links. */
  readonly onAddLink?: () => void;
  readonly onRemoveLink?: (link: KinWorkLinkView) => void;
}) {
  const rest = kinLinkedRest(props.links);
  const { onAddLink, onRemoveLink } = props;
  return (
    <KinLinkedSection
      item={props.detail}
      // Both pages show the entry's client, project and milestone in their rows already.
      parentsShown
      onOpen={props.onOpen}
    >
      {rest.length === 0 && onAddLink === undefined ? null : (
        <>
          {rest.map((link) => (
            <KinWorkLink
              key={link.key}
              link={link}
              onOpen={() => props.onOpenLink(link)}
              onOpenThread={props.onOpenThread}
              {...(onRemoveLink === undefined || link.removeUrl === undefined
                ? {}
                : { onRemove: () => onRemoveLink(link) })}
            />
          ))}
          {onAddLink === undefined ? null : (
            <ListActionRow label={KIN_TASK_LINK.add} onPress={onAddLink} />
          )}
        </>
      )}
    </KinLinkedSection>
  );
}

/** Opens a Linked row: a chat at its message, a record as a record link, a doc as a doc. */
export function useKinOpenLinked(target: KinWorkTarget) {
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const { environmentId, orgId } = target;
  return (to: KinNotificationDestination) =>
    to._tag === "chat"
      ? navigation.navigate("KinChat", {
          environmentId,
          orgId,
          chatId: to.chatId,
          ...(to.messageId === null ? {} : { message: to.messageId }),
        })
      : to._tag !== "record"
        ? undefined
        : to.kind === "client"
          ? openRecord("KinClient", { environmentId, orgId, party: to.key })
          : to.kind === "project"
            ? openRecord("KinProject", { environmentId, orgId, project: to.key })
            : to.kind === "doc"
              ? openRecord("KinDoc", { environmentId, orgId, doc: to.key })
              : openRecord("KinWorkItem", { environmentId, orgId, task: to.key });
}

/** What links to an entry or doc and what it links to, by kind; `children` follow the groups. */
export function KinLinkedSection(props: {
  readonly item: Parameters<typeof kinLinked>[0];
  readonly parentsShown: boolean;
  readonly onOpen: (to: KinNotificationDestination) => void;
  readonly children?: ReactNode;
}) {
  const grows = useKinTextGrows();
  const [expanded, setExpanded] = useState<ReadonlySet<KinLinkedGroupName>>(new Set());
  const linked = kinLinked(props.item, undefined, { expanded, parentsShown: props.parentsShown });
  const children = props.children ?? null;
  if (linked.groups.length === 0 && children === null && linked.unlisted === 0) return null;
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
            const { open } = item;
            const row = (
              <View className="min-w-0 flex-row gap-2 px-4 py-3">
                {item.kind === "message" ? null : (
                  <Text textRole="body" className="text-foreground-muted">
                    {item.name}
                  </Text>
                )}
                <Text
                  textRole="body"
                  numberOfLines={kinLines(1, grows)}
                  className="min-w-0 flex-1 text-foreground"
                >
                  {title}
                </Text>
              </View>
            );
            return open === null ? (
              <View key={item.key} accessibilityLabel={title} className="bg-grouped-card">
                {row}
              </View>
            ) : (
              <RowPressable
                key={item.key}
                accessibilityRole="button"
                accessibilityLabel={item.kind === "message" ? title : `${item.name}, ${title}`}
                onPress={() => props.onOpen(open)}
                className="bg-grouped-card"
              >
                {row}
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
      {children}
    </ListSection>
  );
}

function KinWorkLink(props: {
  readonly link: KinWorkLinkView;
  readonly onOpen: () => void;
  readonly onOpenThread: (thread: NonNullable<KinWorkLinkView["thread"]>) => void;
  readonly onRemove?: () => void;
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
      {props.onRemove === undefined ? null : (
        <ListActionRow
          tone="danger"
          label={KIN_TASK_LINK.remove(link.label)}
          onPress={props.onRemove}
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
