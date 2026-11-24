import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinDatesMonth, kinShiftMonth } from "@t3tools/client-runtime/kin/kinDates";
import { kinIssuedAmountQuestion } from "@t3tools/client-runtime/kin/kinInvoices";
import { kinBillToFieldPatch, kinIsBillToField } from "@t3tools/client-runtime/kin/kinBillTo";
import {
  KIN_AMOUNT_SLIP,
  KIN_FIELD_FILES_MAX,
  KIN_LISTS,
  kinAmountAsking,
  kinAmountCheck,
  kinFieldCheck,
  kinListEntryView,
  type KinListEntryView,
  type KinListFieldView,
} from "@t3tools/client-runtime/kin/kinLists";
import { kinWorkDayOf, kinWorkItemState } from "@t3tools/client-runtime/kin/kinWork";
import {
  EnvironmentId,
  KinOrgId,
  KinRecordKey,
  type KinFieldValue,
  type KinMoney,
  type KinRecordDetail,
  KIN_DEFAULT_HOME_CURRENCY,
  kinWhenFormat,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { SearchField } from "../../components/ui/SearchField";
import { useNowMinuteMs } from "../../lib/clock";
import { KinCountryFirstField } from "./components/KinCountryFirst";
import { KinMonthGrid } from "./components/KinMonthGrid";
import { KinWorkFrame, KinWorkLoading, KinWorkTextField } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import {
  useKinCountryNeeded,
  kinListsOf,
  useKinEntryChanges,
  useKinListContext,
  useKinLists,
  useKinWorkFiles,
} from "./state/useKinMoney";
import {
  useKinWorkDirectory,
  useKinWorkItemWatch,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { useKinGate } from "./state/useKinHost";
import { KinGateView } from "./components/KinWorkPieces";

const FIELD = "field:";

export type KinEntryEditParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly task: string;
  /** "amount", "date", "due", or "field:<key>" for one of the list's own details. */
  readonly what: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** One detail of an entry, changed with the control its kind calls for. */
export function KinEntryEditScreen({ route }: StaticScreenProps<KinEntryEditParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.task));
  if (environmentId === null || orgId === null || key === null) {
    return (
      <KinWorkFrame title={KIN_LISTS.entry.title} onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_LISTS.entry.gone} />
      </KinWorkFrame>
    );
  }
  return (
    <KinEntryEditGate
      environmentId={environmentId}
      orgId={orgId}
      itemKey={key}
      what={route.params.what}
    />
  );
}

function KinEntryEditGate(
  props: KinWorkTarget & { readonly itemKey: KinRecordKey; readonly what: string },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, itemKey, what } = props;
  const gate = useKinGate(kinClient.workUpdate.permissionStateAtom(environmentId), environmentId);
  const allowed = gate === null;
  const state = kinWorkItemState(
    useAtomValue(kinClient.workItem({ environmentId, input: { orgId, key: itemKey } })),
    null,
  );
  const item = state._tag === "ready" ? state.item : null;
  useKinWorkItemWatch(props, itemKey, item === null ? null : item.seq);
  const directory = useKinWorkDirectory(props, allowed);
  const lists = useKinLists(props, { enabled: allowed, archived: true });
  const context = useKinListContext(props, directory, allowed);
  const close = () => navigation.goBack();
  if (!allowed) {
    return (
      <KinWorkFrame title={KIN_LISTS.entry.title} onClose={close}>
        <KinGateView
          gate={gate ?? "refused"}
          refused={KIN_LISTS.onlyOwner}
          label={KIN_LISTS.entry.title}
        />
      </KinWorkFrame>
    );
  }
  if (item === null) {
    return (
      <KinWorkFrame title={KIN_LISTS.entry.title} onClose={close}>
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
  const fields =
    entry.billTo === null
      ? entry.fields
      : [...entry.fields, entry.billTo.name, ...entry.billTo.details];
  const field = what.startsWith(FIELD)
    ? (fields.find((held) => held.key === what.slice(FIELD.length)) ?? null)
    : null;
  const shared = { ...props, item, entry, directory, onClose: close };
  if (what === "amount" && entry.amountEdit !== null)
    return <TypedEdit {...shared} label={KIN_LISTS.entry.amount} field={null} />;
  if (what === "date" && entry.dateLabel !== null)
    return <DayEdit {...shared} label={entry.dateLabel} day={entry.dateDay} which="date" />;
  if (what === "due" && entry.dueLabel !== null)
    return <DayEdit {...shared} label={entry.dueLabel} day={entry.dueDay} which="due" />;
  if (
    field !== null &&
    (field.type === "text" || field.type === "money" || field.type === "number")
  )
    return <TypedEdit {...shared} label={field.label} field={field} />;
  if (field !== null && field.type === "date")
    return (
      <DayEdit
        {...shared}
        label={field.label}
        day={typeof field.value === "string" ? field.value : null}
        which={field}
      />
    );
  if (field !== null && field.type === "file") return <FileEdit {...shared} field={field} />;
  return (
    <KinWorkFrame title={KIN_LISTS.entry.title} onClose={close}>
      <EmptyState variant="plain" {...KIN_LISTS.entry.gone} />
    </KinWorkFrame>
  );
}

type Shared = KinWorkTarget & {
  readonly itemKey: KinRecordKey;
  readonly item: KinRecordDetail;
  readonly entry: KinListEntryView;
  readonly directory: KinWorkDirectory;
  readonly onClose: () => void;
};

const fieldPatch = (field: KinListFieldView, value: KinFieldValue | null) => ({
  fields: kinIsBillToField(field.key)
    ? kinBillToFieldPatch(field.key, value)
    : { [field.key]: value },
});

/** The amount, or a detail that is typed. */
function TypedEdit(
  props: Shared & { readonly label: string; readonly field: KinListFieldView | null },
) {
  const { item, entry, field } = props;
  const changes = useKinEntryChanges(props, props.itemKey);
  const amount = entry.amountEdit;
  const currency = amount?.currency ?? KIN_DEFAULT_HOME_CURRENCY;
  const [text, setText] = useState(field === null ? (amount?.draft ?? "") : field.draft);
  const [problem, setProblem] = useState<string | null>(null);
  const isAmount = field === null || field.type === "money";
  const numeric = isAmount || field.type === "number";
  // An amount waits on the company's country; the field gives way to that step.
  const waiting = useKinCountryNeeded(props) && isAmount;
  const save = async () => {
    const checked =
      field === null
        ? kinAmountCheck(text, currency, amount?.received ?? null, amount?.belowZero ?? false)
        : kinFieldCheck(field, text, currency);
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const keep = async () => {
      const saved = await changes.update(
        item.rev,
        field === null
          ? { amount: checked.value as never }
          : fieldPatch(field, checked.value as KinFieldValue | null),
        field === null ? text.trim() : undefined,
      );
      if (saved) props.onClose();
    };
    const question =
      field === null ? kinIssuedAmountQuestion(item, checked.value as KinMoney | null) : null;
    if (question === null) return keep();
    Dialog.confirm({
      title: question.title,
      message: question.message,
      confirmText: question.confirm,
      onConfirm: () => void keep(),
    });
  };
  const shown = problem ?? changes.problem;
  const asking = field === null ? kinAmountAsking(changes.ask, text.trim()) : null;
  return (
    <KinWorkFrame
      title={props.label}
      form
      onClose={props.onClose}
      confirm={{
        label: asking === null ? KIN_LISTS.entry.save : KIN_AMOUNT_SLIP.save,
        onPress: () => void save(),
        loading: changes.busy,
        disabled: changes.busy || waiting,
      }}
    >
      <View className="px-2">
        <Text textRole="body" className="text-foreground">
          {item.title}
        </Text>
      </View>
      {shown === null ? null : <Notice message={shown} tone="danger" />}
      <ListSection>
        <KinCountryFirstField target={props} label={props.label}>
          <KinWorkTextField
            label={props.label}
            value={text}
            autoFocus
            multiline={!numeric}
            keyboard={numeric ? "numbers" : "plain"}
            disabled={changes.busy}
            {...(isAmount ? { placeholder: KIN_LISTS.entry.amountPlaceholder } : {})}
            onChangeText={(next) => {
              setText(next);
              setProblem(null);
            }}
          />
        </KinCountryFirstField>
      </ListSection>
      {asking === null ? null : (
        <Text textRole="body" accessibilityLiveRegion="polite" className="px-2 text-foreground">
          {asking.line}
        </Text>
      )}
    </KinWorkFrame>
  );
}

/** Any day at all, a month at a time. A tap on a day keeps it. */
function DayEdit(
  props: Shared & {
    readonly label: string;
    readonly day: string | null;
    readonly which: "date" | "due" | KinListFieldView;
  },
) {
  const { item, which } = props;
  const { names } = props.directory;
  const changes = useKinEntryChanges(props, props.itemKey);
  const now = new Date(useNowMinuteMs());
  const [month, setMonth] = useState((props.day ?? kinWorkDayOf(now)).slice(0, 7));
  const grid = kinDatesMonth(month, [], names, now);
  const keep = async (day: string | null) => {
    const saved = await changes.update(
      item.rev,
      which === "date"
        ? day === null
          ? { dateAt: null }
          : { dateAt: day, dateAllDay: true }
        : which === "due"
          ? day === null
            ? { dueAt: null }
            : { dueAt: day, dueAllDay: true }
          : fieldPatch(which, day),
    );
    if (saved) props.onClose();
  };
  return (
    <KinWorkFrame title={props.label} onClose={props.onClose}>
      <View className="px-2">
        <Text textRole="body" className="text-foreground">
          {item.title}
        </Text>
      </View>
      {changes.problem === null ? null : (
        <Notice message={changes.problem} tone="danger" onDismiss={changes.dismiss} />
      )}
      <KinMonthGrid
        label={grid.label}
        weeks={grid.weeks}
        selected={props.day}
        disabled={changes.busy}
        onPick={(day) => void keep(day)}
        onShift={(by) => setMonth(kinShiftMonth(month, by))}
      />
      {props.day === null ? null : (
        <Button
          tone="secondary"
          label={KIN_LISTS.entry.noDate}
          disabled={changes.busy}
          onPress={() => void keep(null)}
        />
      )}
    </KinWorkFrame>
  );
}

const sentFormat = kinWhenFormat("date");

/** The files already in the owner's chats, newest first, to keep one on the entry. */
function FileEdit(props: Shared & { readonly field: KinListFieldView }) {
  const { item, field } = props;
  const changes = useKinEntryChanges(props, props.itemKey);
  const [text, setText] = useState("");
  const input = useRef<TextInputInstance>(null);
  const { state, retry } = useKinWorkFiles(props, text);
  const held = field.files.map((file) => file.attachmentId);
  const files =
    state._tag === "ready" ? state.files.filter((file) => !held.includes(file.attachmentId)) : [];
  const full = held.length >= KIN_FIELD_FILES_MAX;
  return (
    <KinWorkFrame title={KIN_LISTS.entry.filesTitle} form onClose={props.onClose}>
      {changes.problem === null ? null : (
        <Notice message={changes.problem} tone="danger" onDismiss={changes.dismiss} />
      )}
      <View className="flex-row">
        <SearchField
          inputRef={input}
          autoFocus={false}
          accessibilityLabel={KIN_LISTS.entry.filesSearch}
          clearAccessibilityLabel="Clear search"
          placeholder={KIN_LISTS.entry.filesSearch}
          value={text}
          onChangeText={setText}
        />
      </View>
      {full ? (
        <EmptyState
          variant="plain"
          title={`${field.label} keeps at most ${KIN_FIELD_FILES_MAX} files`}
          detail="Take one off the entry first."
        />
      ) : state._tag === "loading" ? (
        <KinWorkLoading label="Loading files" />
      ) : state._tag === "failed" ? (
        <KinLoadFailed
          title={KIN_LISTS.entry.filesFailed}
          cause={"cause" in state ? state.cause : null}
          onRetry={retry}
        />
      ) : files.length === 0 ? (
        <Text textRole="body" className="px-2 text-foreground-muted">
          {text.trim() === "" ? KIN_LISTS.entry.filesNone : KIN_LISTS.entry.filesNoMatch}
        </Text>
      ) : (
        <ListSection>
          {files.map((file) => (
            <ListRow
              key={file.attachmentId}
              icon={file.mimeType.startsWith("image/") ? "photo" : "doc"}
              label={file.name}
              detail={sentFormat.format(new Date(file.sentAt))}
              disabled={changes.busy}
              onPress={() =>
                void changes
                  .update(item.rev, fieldPatch(field, [...held, file.attachmentId]))
                  .then((saved) => {
                    if (saved) props.onClose();
                  })
              }
            />
          ))}
        </ListSection>
      )}
    </KinWorkFrame>
  );
}
