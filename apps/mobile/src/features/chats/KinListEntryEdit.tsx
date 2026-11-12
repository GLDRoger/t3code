import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinDatesMonth, kinShiftMonth } from "@t3tools/client-runtime/kin/kinDates";
import {
  KIN_FIELD_FILES_MAX,
  KIN_LISTS,
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
  type KinRecordDetail,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { SearchField } from "../../components/ui/SearchField";
import { useNowMinuteMs } from "../../lib/clock";
import { KinMonthGrid } from "./components/KinMonthGrid";
import { KinWorkFrame, KinWorkLoading, KinWorkTextField } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import {
  kinListsOf,
  useKinEntryChanges,
  useKinListContext,
  useKinLists,
  useKinWorkFiles,
} from "./state/useKinMoney";
import { useKinWorkDirectory, type KinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

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
  const allowed = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId));
  const state = kinWorkItemState(
    useAtomValue(kinClient.workItem({ environmentId, input: { orgId, key: itemKey } })),
    null,
  );
  const item = state._tag === "ready" ? state.item : null;
  const directory = useKinWorkDirectory(props, allowed);
  const lists = useKinLists(props, { enabled: allowed, archived: true, seq: null });
  const context = useKinListContext(props, directory, allowed);
  const close = () => navigation.goBack();
  if (!allowed) {
    return (
      <KinWorkFrame title={KIN_LISTS.entry.title} onClose={close}>
        <EmptyState variant="plain" {...KIN_LISTS.onlyOwner} />
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
  const field = what.startsWith(FIELD)
    ? (entry.fields.find((held) => held.key === what.slice(FIELD.length)) ?? null)
    : null;
  const shared = { ...props, item, entry, directory, onClose: close };
  if (what === "amount" && entry.amountEdit !== null)
    return <TypedEdit {...shared} label={KIN_LISTS.entry.amount} field={null} />;
  if (what === "date" && entry.dateLabel !== null)
    return <DayEdit {...shared} label={entry.dateLabel} day={entry.dateDay} which="date" />;
  if (what === "due" && entry.dueLabel !== null)
    return <DayEdit {...shared} label={entry.dueLabel} day={entry.dueDay} which="due" />;
  if (field !== null && (field.type === "text" || field.type === "money"))
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
  fields: { [field.key]: value },
});

/** The amount, or a detail that is typed. */
function TypedEdit(
  props: Shared & { readonly label: string; readonly field: KinListFieldView | null },
) {
  const { item, entry, field } = props;
  const changes = useKinEntryChanges(props, props.itemKey);
  const amount = entry.amountEdit;
  const currency = amount?.currency ?? "INR";
  const [text, setText] = useState(field === null ? (amount?.draft ?? "") : field.draft);
  const [problem, setProblem] = useState<string | null>(null);
  const numeric = field === null || field.type === "money";
  const save = async () => {
    const checked =
      field === null
        ? kinAmountCheck(text, currency, amount?.received ?? null)
        : kinFieldCheck(field, text, currency);
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const saved = await changes.update(
      item.rev,
      field === null
        ? { amount: checked.value as never }
        : fieldPatch(field, checked.value as KinFieldValue | null),
    );
    if (saved) props.onClose();
  };
  const shown = problem ?? changes.problem;
  return (
    <KinWorkFrame
      title={props.label}
      form
      onClose={props.onClose}
      confirm={{
        label: KIN_LISTS.entry.save,
        onPress: () => void save(),
        loading: changes.busy,
        disabled: changes.busy,
      }}
    >
      <View className="px-2">
        <Text textRole="body" className="text-foreground">
          {item.title}
        </Text>
      </View>
      {shown === null ? null : <Notice message={shown} tone="danger" />}
      <ListSection>
        <KinWorkTextField
          label={props.label}
          value={text}
          autoFocus
          multiline={!numeric}
          keyboard={numeric ? "numbers" : "plain"}
          disabled={changes.busy}
          {...(numeric ? { placeholder: KIN_LISTS.entry.amountPlaceholder } : {})}
          onChangeText={setText}
        />
      </ListSection>
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

const sentFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

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
        <EmptyState
          variant="plain"
          title={KIN_LISTS.entry.filesFailed}
          detail="Check your connection to the server and try again."
          action={<Button tone="secondary" label="Try again" onPress={retry} />}
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
