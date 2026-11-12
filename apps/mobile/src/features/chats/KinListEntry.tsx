import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_LISTS,
  KIN_LIST_LABEL_MAX,
  kinListEditDraftOf,
  kinListEditInput,
  kinListEntryView,
  kinListStateLabel,
  kinPaymentCheck,
  type KinListEntryView,
  type KinPaymentDraft,
} from "@t3tools/client-runtime/kin/kinLists";
import {
  kinWorkDayOf,
  kinWorkDueChoices,
  kinWorkDueLabel,
  kinWorkItemState,
  type KinWorkItemView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  ChatAttachmentId,
  EnvironmentId,
  KinListId,
  KinOrgId,
  KinRecordKey,
  type KinFileRef,
  type KinListDefinition,
  type KinRecordDetail,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { MessageAttachmentList } from "../threads/ThreadFeed";
import {
  KinWorkFrame,
  KinWorkLoading,
  KinWorkPrivateMark,
  KinWorkTextField,
} from "./components/KinWorkPieces";
import { KinWorkStateSymbol } from "./components/KinWorkStateSymbol";
import { kinClient } from "./state/kinClient";
import {
  kinListsOf,
  useKinAskAgent,
  useKinEntryChanges,
  useKinListChanges,
  useKinListContext,
  useKinLists,
} from "./state/useKinMoney";
import { useKinWorkDirectory, type KinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

const NO_PLAYBACK = () => {};
const DAY = "day:";
const NO_DAY = "none";
const STATE = "state:";

/** An entry's files, opened by the app's own previews. */
function EntryFiles(props: {
  readonly environmentId: EnvironmentId;
  readonly files: ReadonlyArray<KinFileRef>;
  readonly onPreview: (source: FilePreviewSource) => void;
}) {
  return (
    <View className="w-[280px] max-w-full gap-2">
      <MessageAttachmentList
        attachments={props.files.map((file) => ({
          type: file.mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
          id: ChatAttachmentId.make(file.attachmentId),
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: 1,
        }))}
        environmentId={props.environmentId}
        onPressPreview={props.onPreview}
        onPlaybackStart={NO_PLAYBACK}
      />
    </View>
  );
}

/** One of the entry's two dates: the days people pick, or none. Any other day is a message away. */
function DayRow(props: {
  readonly label: string;
  readonly text: string | null;
  readonly day: string | null;
  readonly now: Date;
  readonly disabled: boolean;
  readonly onPick: (day: string | null) => void;
}) {
  const shown = props.text ?? KIN_LISTS.entry.noDate;
  return (
    <Menu
      title={props.label}
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${shown}. Change`}
      actions={[
        ...kinWorkDueChoices(props.now).map((choice) => {
          const date = kinWorkDueLabel(choice.day, props.now);
          return {
            id: `${DAY}${choice.day}`,
            title: choice.label,
            ...(date.toLowerCase() === choice.label.toLowerCase() ? {} : { subtitle: date }),
            state: choice.day === props.day ? ("on" as const) : ("off" as const),
          };
        }),
        ...(props.text === null ? [] : [{ id: NO_DAY, title: KIN_LISTS.entry.noDate }]),
      ]}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.disabled) return;
        if (event === NO_DAY) return props.onPick(null);
        if (event.startsWith(DAY)) props.onPick(event.slice(DAY.length));
      }}
    >
      <View pointerEvents="none">
        <ListRowLayout icon="clock" label={shown} detail={props.label} disabled={props.disabled} />
      </View>
    </Menu>
  );
}

/**
 * An entry of any list: every field by its type, its files, what repeats, and for an entry that
 * takes payments, what came in and what is left. The quick taps are here; anything else is a
 * message to an agent.
 */
export function KinListEntryBody(
  props: KinWorkTarget & {
    readonly item: KinRecordDetail;
    /** The same entry as a task reads it: its notes, links, history and privacy. */
    readonly view: KinWorkItemView;
    readonly directory: KinWorkDirectory;
    readonly now: Date;
    readonly links: React.ReactNode;
    readonly history: React.ReactNode;
  },
) {
  const navigation = useNavigation();
  const { item, view, environmentId, orgId } = props;
  const lists = useKinLists(props, { enabled: true, archived: true, seq: null });
  const context = useKinListContext(props, props.directory);
  const def = kinListsOf(lists).find((one) => one.list === item.list) ?? null;
  const entry = kinListEntryView(item, def, context);
  const changes = useKinEntryChanges(props, item.key);
  const agent = useKinAskAgent(props);
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId));
  const canPay = useAtomValue(kinClient.workPaymentRecord.permissionAtom(environmentId));
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const { busy } = changes;
  const { finish } = entry;
  const today = kinWorkDayOf(props.now);
  const openPlace = (fact: KinListEntryView["facts"][number]) => {
    if (fact.opens === null) return;
    if (fact.id === "project")
      return navigation.navigate("KinProject", { environmentId, orgId, project: fact.opens });
    navigation.navigate("KinClient", { environmentId, orgId, party: fact.opens });
  };
  const takeBack = (paymentId: string) =>
    Dialog.confirm({
      title: KIN_LISTS.entry.takeBackTitle,
      message: KIN_LISTS.entry.takeBackDetail,
      confirmText: KIN_LISTS.entry.takeBack,
      destructive: true,
      onConfirm: () => void changes.takeBack(paymentId),
    });
  return (
    <>
      <View className="gap-3 px-2">
        <Text
          textRole="headline"
          accessibilityRole="header"
          className="font-t3-bold text-foreground"
        >
          {item.title}
        </Text>
        {entry.amount === null ? null : (
          <Text textRole="title" selectable className="font-t3-bold tabular-nums text-foreground">
            {entry.amount}
          </Text>
        )}
        <View className="flex-row flex-wrap items-center gap-2">
          <KinWorkStateSymbol state={entry.state} />
          <Text textRole="body" className="text-foreground">
            {entry.stateLabel}
          </Text>
          {entry.late ? (
            <Text textRole="footnote" className="font-t3-medium text-danger-foreground">
              {KIN_LISTS.late}
            </Text>
          ) : null}
        </View>
        {entry.balance === null ? null : (
          <View className="flex-row gap-6">
            <View className="gap-0.5">
              <Text textRole="footnote" className="text-foreground-muted">
                {KIN_LISTS.entry.left}
              </Text>
              <Text textRole="body" selectable className="tabular-nums text-foreground">
                {entry.balance.settled ? KIN_LISTS.entry.paidInFull : entry.balance.leftText}
              </Text>
            </View>
            <View className="gap-0.5">
              <Text textRole="footnote" className="text-foreground-muted">
                {KIN_LISTS.entry.received}
              </Text>
              <Text textRole="body" selectable className="tabular-nums text-foreground">
                {entry.balance.receivedText}
              </Text>
            </View>
          </View>
        )}
      </View>
      {!canChange ? null : (
        <View className="gap-2">
          {finish === null ? null : (
            <Button
              tone="primary"
              fullWidth
              icon="checkmark"
              label={finish.label}
              loading={busy}
              disabled={busy || (finish.pays !== null && !canPay)}
              onPress={() =>
                void (finish.pays === null
                  ? changes.update(item.rev, { state: "done" })
                  : changes.pay({ amount: finish.pays, paidOn: today, clientRequestId: uuidv4() }))
              }
            />
          )}
          {finish?.pays == null || !canPay ? null : (
            <Button
              tone="secondary"
              fullWidth
              label={KIN_LISTS.entry.recordPayment}
              disabled={busy}
              onPress={() =>
                navigation.navigate("KinPayment", { environmentId, orgId, task: item.key })
              }
            />
          )}
        </View>
      )}
      {changes.problem === null ? null : (
        <Notice message={changes.problem} tone="danger" onDismiss={changes.dismiss} />
      )}
      <ListSection>
        {!canChange ? null : (
          <Menu
            title={KIN_LISTS.entry.status}
            accessibilityRole="button"
            accessibilityLabel={`${KIN_LISTS.entry.status}: ${entry.stateLabel}. Change`}
            actions={entry.states.map((choice) => ({
              id: `${STATE}${choice.state}`,
              title: choice.label,
              state: choice.current ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent: { event } }) => {
              const choice = entry.states.find((held) => `${STATE}${held.state}` === event);
              if (busy || choice === undefined || choice.current) return;
              void changes.update(item.rev, { state: choice.state });
            }}
          >
            <View pointerEvents="none">
              <ListRowLayout
                label={entry.stateLabel}
                detail={KIN_LISTS.entry.status}
                disabled={busy}
              />
            </View>
          </Menu>
        )}
        {entry.dateLabel === null ? null : canChange ? (
          <DayRow
            label={entry.dateLabel}
            text={entry.date}
            day={entry.dateDay}
            now={props.now}
            disabled={busy}
            onPick={(day) =>
              void changes.update(
                item.rev,
                day === null ? { dateAt: null } : { dateAt: day, dateAllDay: true },
              )
            }
          />
        ) : (
          <ListRowLayout
            icon="clock"
            label={entry.date ?? KIN_LISTS.entry.noDate}
            detail={entry.dateLabel}
          />
        )}
        {entry.dueLabel === null ? null : canChange && !entry.closed ? (
          <DayRow
            label={entry.dueLabel}
            text={entry.due}
            day={entry.dueDay}
            now={props.now}
            disabled={busy}
            onPick={(day) =>
              void changes.update(
                item.rev,
                day === null ? { dueAt: null } : { dueAt: day, dueAllDay: true },
              )
            }
          />
        ) : (
          <ListRowLayout
            icon="clock"
            label={entry.due ?? KIN_LISTS.entry.noDate}
            detail={entry.dueLabel}
          />
        )}
        {entry.facts.map((fact) =>
          fact.opens === null ? (
            <ListRowLayout key={fact.id} label={fact.value} detail={fact.label} />
          ) : (
            <ListRow
              key={fact.id}
              label={fact.value}
              detail={fact.label}
              onPress={() => openPlace(fact)}
            />
          ),
        )}
        {entry.repeat === null ? null : (
          <>
            <ListRowLayout label={entry.repeat} detail={KIN_LISTS.entry.repeats} />
            {canChange ? (
              <ListActionRow
                label={KIN_LISTS.entry.stopRepeat}
                disabled={busy}
                onPress={() => void changes.update(item.rev, { repeat: null })}
              />
            ) : null}
          </>
        )}
      </ListSection>
      {entry.fields.length === 0 ? null : (
        <ListSection {...(view.privacy.private ? { footer: KIN_LISTS.entry.private } : {})}>
          {entry.fields.map((field) => {
            const { opens } = field;
            const label = (
              <View className="flex-row items-center gap-2">
                <Text className="text-sm text-foreground-muted">{field.label}</Text>
                {field.private ? <KinWorkPrivateMark label="" /> : null}
                {field.retired ? (
                  <Text textRole="footnote" className="text-foreground-muted">
                    {KIN_LISTS.entry.retiredField}
                  </Text>
                ) : null}
              </View>
            );
            if (field.files.length > 0) {
              return (
                <View key={field.key} className="gap-2 px-4 py-3">
                  {label}
                  <EntryFiles
                    environmentId={environmentId}
                    files={field.files}
                    onPreview={setPreview}
                  />
                </View>
              );
            }
            return opens === null ? (
              <View key={field.key} className="min-h-14 justify-center gap-1 px-4 py-3">
                {label}
                <Text
                  textRole="body"
                  selectable
                  className={field.text === null ? "text-foreground-muted" : "text-foreground"}
                >
                  {field.text ?? "–"}
                </Text>
              </View>
            ) : (
              <ListRow
                key={field.key}
                label={field.text ?? "–"}
                detail={field.label}
                onPress={() =>
                  opens.list === "projects"
                    ? navigation.navigate("KinProject", {
                        environmentId,
                        orgId,
                        project: opens.key,
                      })
                    : navigation.navigate("KinClient", { environmentId, orgId, party: opens.key })
                }
              />
            );
          })}
        </ListSection>
      )}
      {entry.otherFiles.length === 0 ? null : (
        <View className="gap-2 px-2">
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_LISTS.entry.files}
          </Text>
          <EntryFiles
            environmentId={environmentId}
            files={entry.otherFiles}
            onPreview={setPreview}
          />
        </View>
      )}
      {entry.balance === null ? null : (
        <ListSection title={KIN_LISTS.entry.payments}>
          {entry.payments.length === 0 ? (
            <Text textRole="body" className="px-4 py-3 text-foreground-muted">
              {KIN_LISTS.entry.noPayments}
            </Text>
          ) : (
            entry.payments.map((payment) => {
              const detail = [
                payment.when,
                payment.note,
                payment.voided ? KIN_LISTS.entry.takenBack : null,
              ]
                .filter((part) => part !== null)
                .join(" · ");
              return (
                <View key={payment.paymentId}>
                  <ListRowLayout
                    label={payment.amount}
                    description={detail}
                    disabled={payment.voided}
                  />
                  {payment.voided || !canPay ? null : (
                    <ListActionRow
                      label={`${KIN_LISTS.entry.takeBack} ${payment.amount}`}
                      tone="danger"
                      disabled={busy}
                      onPress={() => takeBack(payment.paymentId)}
                    />
                  )}
                </View>
              );
            })
          )}
        </ListSection>
      )}
      {view.notes === null ? null : (
        <View className="gap-2 px-2">
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_LISTS.entry.notes}
          </Text>
          <Text textRole="body" selectable className="text-foreground">
            {view.notes}
          </Text>
        </View>
      )}
      {props.links}
      {props.history}
      {agent === null ? null : (
        <Button
          tone="secondary"
          icon="bubble.left"
          label={KIN_LISTS.entry.askChange}
          onPress={() => {
            navigation.goBack();
            agent.ask(`About ${item.key} (${item.title}): `);
          }}
        />
      )}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </>
  );
}

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);
const decodeList = Schema.decodeUnknownOption(KinListId);

export type KinPaymentParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly task: string;
};

/** Money that came in against an entry: how much, when, and a word about how. */
export function KinPaymentScreen({ route }: StaticScreenProps<KinPaymentParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.task));
  const close = () => navigation.goBack();
  if (environmentId === null || orgId === null || key === null) {
    return (
      <KinWorkFrame title={KIN_LISTS.entry.recordPayment} onClose={close}>
        <EmptyState variant="plain" {...KIN_LISTS.entry.gone} />
      </KinWorkFrame>
    );
  }
  return <KinPaymentForm environmentId={environmentId} orgId={orgId} itemKey={key} />;
}

function KinPaymentForm(props: KinWorkTarget & { readonly itemKey: KinRecordKey }) {
  const navigation = useNavigation();
  const { environmentId, orgId, itemKey } = props;
  const allowed = useAtomValue(kinClient.workPaymentRecord.permissionAtom(environmentId));
  const state = kinWorkItemState(
    useAtomValue(kinClient.workItem({ environmentId, input: { orgId, key: itemKey } })),
    null,
  );
  const item = state._tag === "ready" ? state.item : null;
  const directory = useKinWorkDirectory(props, allowed);
  const lists = useKinLists(props, { enabled: allowed, archived: true, seq: null });
  const context = useKinListContext(props, directory, allowed);
  const changes = useKinEntryChanges(props, itemKey);
  const now = new Date(useNowMinuteMs());
  const today = kinWorkDayOf(now);
  const [draft, setDraft] = useState<KinPaymentDraft>({ amount: "", paidOn: today, note: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [requestId] = useState(uuidv4);
  const close = () => navigation.goBack();
  const title = KIN_LISTS.entry.recordPayment;
  if (!allowed) {
    return (
      <KinWorkFrame title={title} onClose={close}>
        <EmptyState variant="plain" {...KIN_LISTS.onlyOwner} />
      </KinWorkFrame>
    );
  }
  if (item === null) {
    return (
      <KinWorkFrame title={title} onClose={close}>
        {state._tag === "loading" ? (
          <KinWorkLoading label="Loading entry" />
        ) : (
          <EmptyState variant="plain" {...KIN_LISTS.entry.gone} />
        )}
      </KinWorkFrame>
    );
  }
  const def = kinListsOf(lists).find((one) => one.list === item.list) ?? null;
  const entry = kinListEntryView(item, def, context);
  const left = entry.balance?.left ?? null;
  if (left === null || entry.balance === null) {
    return (
      <KinWorkFrame title={title} onClose={close}>
        <EmptyState
          variant="plain"
          title="Nothing to receive"
          detail="This entry doesn't take payments."
        />
      </KinWorkFrame>
    );
  }
  const days = [0, 1, 2, 3, 4, 5, 6].map((back) =>
    kinWorkDayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)),
  );
  const save = async () => {
    const checked = kinPaymentCheck(draft, left);
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const saved = await changes.pay({
      amount: checked.amount,
      paidOn: draft.paidOn,
      ...(draft.note.trim() === "" ? {} : { note: draft.note.trim() }),
      clientRequestId: requestId,
    });
    if (saved) close();
  };
  const shown = problem ?? changes.problem;
  return (
    <KinWorkFrame
      title={title}
      form
      onClose={close}
      confirm={{
        label: KIN_LISTS.entry.paySave,
        onPress: () => void save(),
        loading: changes.busy,
        disabled: changes.busy || draft.amount.trim() === "",
      }}
    >
      <View className="gap-1 px-2">
        <Text textRole="body" className="text-foreground">
          {item.title}
        </Text>
        <Text textRole="footnote" className="tabular-nums text-foreground-muted">
          {`${entry.balance.leftText} ${KIN_LISTS.entry.left.toLowerCase()}`}
        </Text>
      </View>
      {shown === null ? null : <Notice message={shown} tone="danger" />}
      <ListSection>
        <KinWorkTextField
          label={KIN_LISTS.entry.payAmount}
          value={draft.amount}
          autoFocus
          keyboard="numbers"
          disabled={changes.busy}
          placeholder={entry.balance.leftText}
          onChangeText={(amount) => setDraft({ ...draft, amount })}
        />
      </ListSection>
      <ListSection>
        <Menu
          title={KIN_LISTS.entry.payDay}
          accessibilityRole="button"
          accessibilityLabel={`${KIN_LISTS.entry.payDay}: ${kinWorkDueLabel(draft.paidOn, now)}. Change`}
          actions={days.map((day) => ({
            id: `${DAY}${day}`,
            title: kinWorkDueLabel(day, now),
            state: day === draft.paidOn ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent: { event } }) => {
            if (event.startsWith(DAY)) setDraft({ ...draft, paidOn: event.slice(DAY.length) });
          }}
        >
          <View pointerEvents="none">
            <ListRowLayout
              icon="clock"
              label={kinWorkDueLabel(draft.paidOn, now)}
              detail={KIN_LISTS.entry.payDay}
            />
          </View>
        </Menu>
      </ListSection>
      <ListSection>
        <KinWorkTextField
          label={KIN_LISTS.entry.payNote}
          value={draft.note}
          maxLength={500}
          disabled={changes.busy}
          placeholder={KIN_LISTS.entry.payNotePlaceholder}
          onChangeText={(note) => setDraft({ ...draft, note })}
        />
      </ListSection>
    </KinWorkFrame>
  );
}

export type KinListSettingsParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly list: string;
};

/** A list's own names, the details it keeps, and putting it away. */
export function KinListSettingsScreen({ route }: StaticScreenProps<KinListSettingsParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const list = Option.getOrNull(decodeList(route.params.list));
  const close = () => navigation.goBack();
  if (environmentId === null || orgId === null || list === null) {
    return (
      <KinWorkFrame title={KIN_LISTS.edit.title} onClose={close}>
        <EmptyState
          variant="plain"
          title="This link doesn't open a list"
          detail="Open Lists from Work."
        />
      </KinWorkFrame>
    );
  }
  return <KinListSettingsGate environmentId={environmentId} orgId={orgId} list={list} />;
}

function KinListSettingsGate(props: KinWorkTarget & { readonly list: KinListId }) {
  const navigation = useNavigation();
  const allowed = useAtomValue(kinClient.workListUpdate.permissionAtom(props.environmentId));
  const lists = useKinLists(props, { enabled: allowed, archived: true, seq: null });
  const def = kinListsOf(lists).find((one) => one.list === props.list);
  const close = () => navigation.goBack();
  if (!allowed || lists.state._tag === "refused") {
    return (
      <KinWorkFrame title={KIN_LISTS.edit.title} onClose={close}>
        <EmptyState variant="plain" {...KIN_LISTS.onlyOwner} />
      </KinWorkFrame>
    );
  }
  if (def === undefined) {
    return (
      <KinWorkFrame title={KIN_LISTS.edit.title} onClose={close}>
        {lists.state._tag === "loading" ? (
          <KinWorkLoading label="Loading list" />
        ) : (
          <EmptyState
            variant="plain"
            title="This list isn't here"
            detail="It may have been renamed. Open Lists to see what there is."
          />
        )}
      </KinWorkFrame>
    );
  }
  // The form restarts from the list as it is after each change to its fields.
  return <KinListSettingsForm key={def.rev} {...props} def={def} />;
}

function KinListSettingsForm(props: KinWorkTarget & { readonly def: KinListDefinition }) {
  const navigation = useNavigation();
  const { def, orgId } = props;
  const changes = useKinListChanges(props);
  const [draft, setDraft] = useState(() => kinListEditDraftOf(def));
  const close = () => navigation.goBack();
  const save = async () => {
    const checked = kinListEditInput(orgId, def, draft);
    if (!checked.ok) return changes.setProblem(checked.problem);
    if (checked.input === null || (await changes.send(checked.input))) close();
  };
  const change = (patch: {
    readonly archived?: boolean;
    readonly retireFields?: ReadonlyArray<string>;
    readonly restoreFields?: ReadonlyArray<string>;
  }) => changes.send({ orgId, list: def.list, rev: def.rev, ...patch });
  return (
    <KinWorkFrame
      title={KIN_LISTS.edit.title}
      form
      onClose={close}
      confirm={{
        label: KIN_LISTS.edit.save,
        onPress: () => void save(),
        loading: changes.busy,
        disabled: changes.busy,
      }}
    >
      {changes.problem === null ? null : (
        <Notice message={changes.problem} tone="danger" onDismiss={changes.dismiss} />
      )}
      <ListSection>
        <KinWorkTextField
          label={KIN_LISTS.edit.name}
          value={draft.name}
          maxLength={KIN_LIST_LABEL_MAX}
          disabled={changes.busy}
          onChangeText={(name) => setDraft({ ...draft, name })}
        />
      </ListSection>
      <ListSection title={KIN_LISTS.edit.states}>
        {def.states.map((state) => (
          <KinWorkTextField
            key={state}
            label={kinListStateLabel(null, state)}
            value={draft.stateLabels[state] ?? ""}
            maxLength={KIN_LIST_LABEL_MAX}
            disabled={changes.busy}
            onChangeText={(text) =>
              setDraft({ ...draft, stateLabels: { ...draft.stateLabels, [state]: text } })
            }
          />
        ))}
      </ListSection>
      {def.fields.length === 0 ? null : (
        <ListSection title={KIN_LISTS.edit.fields}>
          {def.fields.map((field) => (
            <View key={field.key}>
              <ListRowLayout
                label={field.label}
                {...(field.retired ? { description: KIN_LISTS.edit.retired } : {})}
              />
              <ListActionRow
                label={`${field.retired ? KIN_LISTS.edit.restore : KIN_LISTS.edit.retire}: ${field.label}`}
                disabled={changes.busy}
                onPress={() =>
                  void change(
                    field.retired ? { restoreFields: [field.key] } : { retireFields: [field.key] },
                  )
                }
              />
            </View>
          ))}
        </ListSection>
      )}
      <ListSection {...(def.archivedAt === null ? { footer: KIN_LISTS.edit.archiveDetail } : {})}>
        <ListActionRow
          label={def.archivedAt === null ? KIN_LISTS.edit.archive : KIN_LISTS.edit.restoreList}
          disabled={changes.busy}
          onPress={() =>
            void change({ archived: def.archivedAt === null }).then((ok) => {
              if (ok) close();
            })
          }
        />
      </ListSection>
    </KinWorkFrame>
  );
}
