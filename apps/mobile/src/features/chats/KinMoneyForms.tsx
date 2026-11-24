import { useAtomValue } from "@effect/atom-react";
import {
  StackActions,
  useNavigation,
  usePreventRemove,
  type StaticScreenProps,
} from "@react-navigation/native";
import { KIN_AMOUNT_SLIP, KIN_LISTS } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_MONEY_FORMS,
  kinExpenseAmountAbout,
  kinExpenseChoices,
  kinExpenseDraft,
  kinExpenseInput,
  kinExpenseTyped,
  kinInvoiceAmountAbout,
  kinInvoiceBeforeTax,
  kinInvoiceBillsByName,
  kinInvoiceDraft,
  kinInvoiceDueChoices,
  kinInvoiceInput,
  kinInvoiceTax,
  kinInvoiceTaxText,
  kinInvoiceTyped,
  type KinBillToDraft,
  type KinExpenseDraft,
  type KinInvoiceDraft,
} from "@t3tools/client-runtime/kin/kinMoneyForms";
import { KIN_BILL_TO, kinBillToOffered } from "@t3tools/client-runtime/kin/kinBillTo";
import {
  KIN_GST_STATE_NAMES,
  KIN_WORK_FORM_COPY,
  kinIndiaFields,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import { kinWorkDayOf, kinWorkDueLabel } from "@t3tools/client-runtime/kin/kinWork";
import {
  EnvironmentId,
  KIN_DEFAULT_HOME_CURRENCY,
  KinOrgId,
  KinRecordKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { KinWorkFrame, KinWorkTextField } from "./components/KinWorkPieces";
import { KinLinesFields } from "./KinMoneyAnswers";
import {
  kinListsOf,
  useKinCompanyCountry,
  useKinCompanyProfile,
  useKinHomeCurrency,
  useKinLists,
  useKinWorkFiles,
} from "./state/useKinMoney";
import { kinExpenseStartOf, type KinExpenseNewParams } from "./state/kinBillsPick";
import { useKinNewExpense, useKinNewInvoice } from "./state/useKinMoneyAnswers";
import { kinWorkChoicesAtom, useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";
import { useKinSectionNamed, useKinSectionOn } from "./state/useKinShell";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

const targetOf = (params: { readonly environmentId: string; readonly orgId: string }) => {
  const environmentId = Option.getOrNull(decodeEnvironmentId(params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(params.orgId));
  return environmentId === null || orgId === null ? null : { environmentId, orgId };
};

/**
 * Asks before the sheet closes over words typed; a saved form goes to what it made instead. The
 * returned `leave` replaces the form with the entry it made, so Back from there is the screen it
 * was opened from.
 */
function useFormGuard(typed: boolean, busy: boolean, discardTitle: string) {
  const navigation = useNavigation();
  const saved = useRef(false);
  usePreventRemove(typed || busy, ({ data }) => {
    if (saved.current) return navigation.dispatch(data.action);
    if (busy) return;
    Dialog.alert(discardTitle, KIN_MONEY_FORMS.discard.detail, [
      { text: KIN_MONEY_FORMS.discard.keep, style: "cancel" },
      {
        text: KIN_MONEY_FORMS.discard.discard,
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });
  return {
    close: () => navigation.goBack(),
    leave: (target: KinWorkTarget, key: KinRecordKey) => {
      saved.current = true;
      navigation.dispatch(
        StackActions.replace("KinWorkItem", {
          environmentId: String(target.environmentId),
          orgId: String(target.orgId),
          task: key,
        }),
      );
    },
  };
}

/** One picked value among a few, as a row that opens the system menu. */
/** The one line a form asks under its amount when it reads like a slip. */
function Slip(props: { readonly line: string | null }) {
  return props.line === null ? null : (
    <Text textRole="body" accessibilityLiveRegion="polite" className="px-2 text-foreground">
      {props.line}
    </Text>
  );
}

function PickRow(props: {
  readonly label: string;
  readonly value: string;
  readonly shown: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly disabled?: boolean;
  readonly icon?: "clock";
  readonly onPick: (id: string) => void;
}) {
  return (
    <Menu
      title={props.label}
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${props.shown}. Change`}
      actions={props.options.map((one) => ({
        id: one.id,
        title: one.title,
        state: one.id === props.value ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.disabled !== true) props.onPick(event);
      }}
    >
      <View pointerEvents="none">
        <ListRowLayout
          {...(props.icon === undefined ? {} : { icon: props.icon })}
          label={props.shown}
          detail={props.label}
        />
      </View>
    </Menu>
  );
}

const NO_PLACE = "none";

/** Who an invoice bills when it isn't a client: a name, and its details behind More details. */
function BillToFields(props: {
  readonly value: KinBillToDraft;
  readonly disabled: boolean;
  /** India's tax number and state, as the client form asks them. */
  readonly india: boolean;
  /** The way back to the client picker, beside the name. */
  readonly choice: React.ReactNode;
  readonly onChange: (patch: Partial<KinBillToDraft>) => void;
}) {
  const [more, setMore] = useState(false);
  const { value, disabled } = props;
  const party = KIN_WORK_FORM_COPY.party;
  return (
    <>
      <KinWorkTextField
        label={KIN_BILL_TO.name}
        value={value.name}
        placeholder={KIN_BILL_TO.namePlaceholder}
        maxLength={200}
        disabled={disabled}
        onChangeText={(name) => props.onChange({ name })}
      />
      {props.choice}
      {more ? (
        <>
          <KinWorkTextField
            label={KIN_BILL_TO.address}
            value={value.address}
            placeholder={party.addressPlaceholder}
            maxLength={500}
            multiline
            disabled={disabled}
            onChangeText={(address) => props.onChange({ address })}
          />
          <KinWorkTextField
            label={props.india ? party.gstin : KIN_BILL_TO.taxNumber}
            value={value.taxNumber}
            maxLength={100}
            disabled={disabled}
            onChangeText={(taxNumber) => props.onChange({ taxNumber })}
          />
          {props.india ? (
            <ListSection>
              <PickRow
                label={party.place}
                value={value.place || NO_PLACE}
                shown={value.place || party.placeNone}
                options={[
                  { id: NO_PLACE, title: party.placeNone },
                  ...KIN_GST_STATE_NAMES.map((name) => ({ id: name, title: name })),
                ]}
                disabled={disabled}
                onPick={(place) => props.onChange({ place: place === NO_PLACE ? "" : place })}
              />
            </ListSection>
          ) : (
            <KinWorkTextField
              label={KIN_BILL_TO.place}
              value={value.place}
              maxLength={100}
              disabled={disabled}
              onChangeText={(place) => props.onChange({ place })}
            />
          )}
          <KinWorkTextField
            label={KIN_BILL_TO.email}
            value={value.email}
            keyboard="email"
            maxLength={100}
            disabled={disabled}
            onChangeText={(email) => props.onChange({ email })}
          />
        </>
      ) : (
        <Button
          tone="secondary"
          fullWidth
          icon="chevron.down"
          label={KIN_BILL_TO.more}
          onPress={() => setMore(true)}
        />
      )}
    </>
  );
}

export type KinInvoiceNewParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The client it is opened from, already picked, and its name. */
  readonly party?: string;
  readonly partyName?: string;
};

/** A new invoice typed by hand: a Draft, made with its lines, which opens on its page. */
export function KinInvoiceNewScreen({ route }: StaticScreenProps<KinInvoiceNewParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  if (target === null)
    return (
      <KinWorkFrame title={KIN_MONEY_FORMS.invoice.title} onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_LISTS.entry.gone} />
      </KinWorkFrame>
    );
  const party = Option.getOrNull(decodeKey(route.params.party));
  return (
    <InvoiceForm
      {...target}
      party={party === null ? null : { key: party, name: route.params.partyName ?? String(party) }}
    />
  );
}

function InvoiceForm(
  props: KinWorkTarget & {
    readonly party: { readonly key: KinRecordKey; readonly name: string } | null;
  },
) {
  const [opened] = useState(() => kinInvoiceDraft(props.party?.key ?? null));
  const [draft, setDraft] = useState<KinInvoiceDraft>(opened);
  const [problem, setProblem] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [requestId] = useState(uuidv4);
  const [made, setMade] = useState<{
    readonly key: KinRecordKey;
    readonly problems: ReadonlyArray<string>;
  } | null>(null);
  const saving = useKinNewInvoice(props);
  const clientsOn = useKinSectionOn(props.environmentId, "clients");
  const named = useKinSectionNamed(props.environmentId);
  const held = Option.getOrNull(AsyncResult.value(useAtomValue(kinWorkChoicesAtom(props))));
  // Clients off: no client or project to pick, so the form asks for a name.
  const choices = clientsOn ? held : null;
  const clients = (choices?.clients ?? []).filter((one) => one.kind !== "vendor");
  const projects = choices?.projects ?? [];
  const offered = kinBillToOffered(kinListsOf(useKinLists(props, { enabled: true })));
  const india = kinIndiaFields(useKinCompanyCountry(props));
  const project = projects.find((one) => one.key === draft.project) ?? null;
  const projectClient = project?.party?.key ?? null;
  const byName = kinInvoiceBillsByName(draft, { clientsOn, offered, projectClient });
  const profile = useKinCompanyProfile(props, true);
  const currency = useKinHomeCurrency(props) ?? KIN_DEFAULT_HOME_CURRENCY;
  const tax = profile.state._tag === "ready" ? kinInvoiceTax(profile.state.value) : null;
  const gst = tax?._tag === "gst";
  const taxText = tax === null ? null : kinInvoiceTaxText(tax);
  const now = new Date(useNowMinuteMs());
  const today = kinWorkDayOf(now);
  const locked = saving.busy || made !== null;
  const guard = useFormGuard(
    made === null && kinInvoiceTyped(draft, opened),
    saving.busy,
    KIN_MONEY_FORMS.discard.invoice,
  );
  const set = (patch: Partial<KinInvoiceDraft>) => {
    if (locked) return;
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const client =
    clients.find((one) => one.key === draft.party) ??
    (props.party !== null && props.party.key === draft.party ? props.party : null);
  const beforeTax = kinInvoiceBeforeTax(draft.lines, currency);
  const about = kinInvoiceAmountAbout(draft.lines);
  const slip = saving.slip(about);
  const save = async () => {
    const checked = kinInvoiceInput(props.orgId, draft, {
      currency,
      gst: gst && tax.registered,
      clientRequestId: requestId,
      byName,
      india,
      projectClient,
    });
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const result = await saving.save(checked.input, about);
    if (result === null) return;
    if (result.problems.length > 0)
      return setMade({ key: result.invoice, problems: result.problems });
    guard.leave(props, result.invoice);
  };
  const choice = !clientsOn ? null : project?.party != null ? (
    <Text textRole="footnote" className="px-2 text-foreground-muted">
      {KIN_BILL_TO.projectBills(project.party.title)}
    </Text>
  ) : offered ? (
    <Button
      tone="secondary"
      fullWidth
      label={draft.byName ? named(KIN_BILL_TO.pickClient) : KIN_BILL_TO.byName}
      disabled={locked}
      onPress={() => set({ byName: !draft.byName })}
    />
  ) : null;
  const shown = problem ?? saving.problem;
  return (
    <KinWorkFrame
      title={KIN_MONEY_FORMS.invoice.title}
      form
      showTop={shown}
      onClose={guard.close}
      confirm={{
        label:
          made !== null
            ? KIN_MONEY_FORMS.invoice.tryAgain
            : slip !== null
              ? KIN_AMOUNT_SLIP.save
              : KIN_MONEY_FORMS.invoice.save,
        onPress: () => void save(),
        loading: saving.busy,
        disabled: saving.busy,
      }}
    >
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_MONEY_FORMS.invoice.detail}
      </Text>
      {shown === null ? null : <Notice message={shown} tone="danger" />}
      {made === null ? null : (
        <Notice
          message={KIN_MONEY_FORMS.invoice.savedWithout(made.key, made.problems)}
          tone="danger"
          action={{
            label: KIN_MONEY_FORMS.invoice.openDraft(made.key),
            onPress: () => guard.leave(props, made.key),
          }}
        />
      )}
      {byName ? (
        <BillToFields
          value={draft.billTo}
          disabled={locked}
          india={india}
          choice={choice}
          onChange={(patch) => set({ billTo: { ...draft.billTo, ...patch } })}
        />
      ) : (
        <ListSection>
          {clients.length === 0 && client === null ? (
            <ListRowLayout
              label={named(KIN_MONEY_FORMS.invoice.noClients)}
              detail={named(KIN_MONEY_FORMS.invoice.party)}
            />
          ) : (
            <PickRow
              label={named(KIN_MONEY_FORMS.invoice.party)}
              value={draft.party ?? ""}
              shown={client?.name ?? named(KIN_MONEY_FORMS.invoice.pickClient)}
              options={clients.map((one) => ({ id: one.key, title: one.name }))}
              disabled={locked}
              onPick={(key) => set({ party: clients.find((one) => one.key === key)?.key ?? null })}
            />
          )}
        </ListSection>
      )}
      {byName ? null : choice}
      <KinWorkTextField
        label={KIN_MONEY_FORMS.invoice.what}
        value={draft.title}
        placeholder={KIN_MONEY_FORMS.invoice.whatPlaceholder}
        hint={KIN_MONEY_FORMS.invoice.whatHint}
        maxLength={280}
        disabled={locked}
        onChangeText={(title) => set({ title })}
      />
      <KinLinesFields
        lines={draft.lines}
        disabled={locked}
        codes={gst}
        detail={KIN_MONEY_FORMS.invoice.linesDetail}
        onChange={(lines) => set({ lines })}
      />
      {beforeTax === null ? null : (
        <Text textRole="body" className="px-2 text-foreground">
          {beforeTax}
        </Text>
      )}
      <Slip line={slip} />
      {gst && tax.registered ? (
        <KinWorkTextField
          label={KIN_MONEY_FORMS.invoice.gstRate}
          value={draft.gstRate}
          keyboard="decimal"
          hint={KIN_MONEY_FORMS.invoice.gstHint}
          disabled={locked}
          onChangeText={(gstRate) => set({ gstRate })}
        />
      ) : taxText === null ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {taxText}
        </Text>
      )}
      <ListSection>
        <PickRow
          label={KIN_MONEY_FORMS.invoice.due}
          icon="clock"
          value={draft.dueOn ?? ""}
          shown={
            draft.dueOn === null ? KIN_MONEY_FORMS.invoice.noDue : kinWorkDueLabel(draft.dueOn, now)
          }
          options={[
            { id: "", title: KIN_MONEY_FORMS.invoice.noDue },
            ...kinInvoiceDueChoices(today, now).map((one) => ({ id: one.day, title: one.label })),
          ]}
          disabled={locked}
          onPick={(day) => set({ dueOn: day === "" ? null : day })}
        />
      </ListSection>
      {more ? (
        <>
          <KinWorkTextField
            label={KIN_MONEY_FORMS.invoice.notes}
            value={draft.notes}
            hint={KIN_MONEY_FORMS.invoice.notesHint}
            maxLength={4_000}
            multiline
            disabled={locked}
            onChangeText={(notes) => set({ notes })}
          />
          {projects.length === 0 ? null : (
            <ListSection>
              <PickRow
                label={KIN_MONEY_FORMS.invoice.project}
                value={draft.project ?? ""}
                shown={
                  projects.find((one) => one.key === draft.project)?.name ??
                  KIN_MONEY_FORMS.invoice.noProject
                }
                options={[
                  { id: "", title: KIN_MONEY_FORMS.invoice.noProject },
                  ...projects.map((one) => ({ id: one.key, title: one.name })),
                ]}
                disabled={locked}
                onPick={(key) =>
                  set({ project: projects.find((one) => one.key === key)?.key ?? null })
                }
              />
            </ListSection>
          )}
        </>
      ) : (
        <Button
          tone="secondary"
          fullWidth
          icon="chevron.down"
          label={KIN_MONEY_FORMS.invoice.more}
          onPress={() => setMore(true)}
        />
      )}
    </KinWorkFrame>
  );
}

/** A new expense typed by hand; the first one starts the company's Expenses list. */
export function KinExpenseNewScreen({ route }: StaticScreenProps<KinExpenseNewParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  if (target === null)
    return (
      <KinWorkFrame title={KIN_MONEY_FORMS.expense.title} onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_LISTS.entry.gone} />
      </KinWorkFrame>
    );
  return <ExpenseForm {...target} start={kinExpenseStartOf(route.params)} />;
}

function ExpenseForm(
  props: KinWorkTarget & { readonly start: ReturnType<typeof kinExpenseStartOf> },
) {
  const now = new Date(useNowMinuteMs());
  const today = kinWorkDayOf(now);
  const [opened] = useState(() => ({ ...kinExpenseDraft(today), ...props.start.draft }));
  const [draft, setDraft] = useState<KinExpenseDraft>(opened);
  const [problem, setProblem] = useState<string | null>(null);
  const [requestId] = useState(uuidv4);
  const saving = useKinNewExpense(props);
  const currency = useKinHomeCurrency(props) ?? KIN_DEFAULT_HOME_CURRENCY;
  const lists = useKinLists(props, { enabled: true });
  const directory = useKinWorkDirectory(props, true);
  const choices = kinExpenseChoices(
    lists.state._tag === "ready"
      ? kinListsOf(lists).find((one) => one.list === "expenses")
      : undefined,
    directory.names.people,
  );
  const files = useKinWorkFiles(props, "");
  const chatFiles = files.state._tag === "ready" ? files.state.files.slice(0, 20) : [];
  // A bill's file may be in a chat this person isn't in; it is offered all the same.
  const start = props.start.receipt;
  const held =
    start === null || chatFiles.some((file) => file.attachmentId === start.attachmentId)
      ? chatFiles
      : [start, ...chatFiles];
  const guard = useFormGuard(
    kinExpenseTyped(draft, opened),
    saving.busy,
    KIN_MONEY_FORMS.discard.expense,
  );
  const set = (patch: Partial<KinExpenseDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const days = [0, 1, 2, 3, 4, 5, 6].map((back) => {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    return kinWorkDayOf(day);
  });
  const save = async () => {
    const checked = kinExpenseInput(props.orgId, draft, { currency, clientRequestId: requestId });
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const key = await saving.save(checked.input, kinExpenseAmountAbout(draft));
    if (key !== null) guard.leave(props, key);
  };
  const shown = problem ?? saving.problem;
  const slip = saving.slip(kinExpenseAmountAbout(draft));
  const category = choices.categories.find((one) => one.value === draft.category);
  const receipt = held.find((file) => file.attachmentId === draft.receipt);
  return (
    <KinWorkFrame
      title={KIN_MONEY_FORMS.expense.title}
      form
      showTop={shown}
      onClose={guard.close}
      confirm={{
        label: slip === null ? KIN_MONEY_FORMS.expense.save : KIN_AMOUNT_SLIP.save,
        onPress: () => void save(),
        loading: saving.busy,
        disabled: saving.busy,
      }}
    >
      {choices.first ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {KIN_MONEY_FORMS.expense.firstList}
        </Text>
      ) : null}
      {shown === null ? null : <Notice message={shown} tone="danger" />}
      <KinWorkTextField
        label={KIN_MONEY_FORMS.expense.what}
        value={draft.title}
        placeholder={KIN_MONEY_FORMS.expense.whatPlaceholder}
        maxLength={280}
        autoFocus
        onChangeText={(title) => set({ title })}
      />
      <KinWorkTextField
        label={KIN_MONEY_FORMS.expense.amount}
        value={draft.amount}
        placeholder={KIN_MONEY_FORMS.expense.amountPlaceholder}
        hint={KIN_MONEY_FORMS.expense.amountRefundHint}
        keyboard="numbers"
        onChangeText={(amount) => set({ amount })}
      />
      <Slip line={slip} />
      <ListSection>
        <PickRow
          label={KIN_MONEY_FORMS.expense.paidOn}
          icon="clock"
          value={draft.paidOn}
          shown={kinWorkDueLabel(draft.paidOn, now)}
          options={days.map((day) => ({ id: day, title: kinWorkDueLabel(day, now) }))}
          onPick={(paidOn) => set({ paidOn })}
        />
      </ListSection>
      <KinWorkTextField
        label={KIN_MONEY_FORMS.expense.vendor}
        value={draft.vendor}
        maxLength={200}
        onChangeText={(vendor) => set({ vendor })}
      />
      {choices.categories.length === 0 && choices.paidWith.length === 0 ? null : (
        <ListSection>
          {choices.categories.length === 0 ? null : (
            <PickRow
              label={KIN_MONEY_FORMS.expense.category}
              value={draft.category}
              shown={category?.label ?? KIN_MONEY_FORMS.expense.noCategory}
              options={[
                { id: "", title: KIN_MONEY_FORMS.expense.noCategory },
                ...choices.categories.map((one) => ({ id: one.value, title: one.label })),
              ]}
              onPick={(picked) => set({ category: picked })}
            />
          )}
          {choices.paidWith.length === 0 ? null : (
            <PickRow
              label={KIN_MONEY_FORMS.expense.paidWith}
              value={draft.paidWith}
              shown={draft.paidWith === "" ? KIN_MONEY_FORMS.expense.notSaid : draft.paidWith}
              options={[
                { id: "", title: KIN_MONEY_FORMS.expense.notSaid },
                ...choices.paidWith.map((one) => ({ id: one, title: one })),
              ]}
              onPick={(paidWith) => set({ paidWith })}
            />
          )}
        </ListSection>
      )}
      {choices.fundedByNote === null ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {choices.fundedByNote}
        </Text>
      )}
      {choices.fundedBy.length === 0 ? null : (
        <ListSection>
          <PickRow
            label={KIN_MONEY_FORMS.expense.fundedBy}
            value={draft.fundedBy}
            shown={
              choices.fundedBy.find((one) => one.value === draft.fundedBy)?.label ??
              KIN_MONEY_FORMS.expense.company
            }
            options={[
              { id: "", title: KIN_MONEY_FORMS.expense.company },
              ...choices.fundedBy.map((one) => ({ id: one.value, title: one.label })),
            ]}
            onPick={(fundedBy) => set({ fundedBy })}
          />
        </ListSection>
      )}
      {choices.receipt ? (
        <>
          <ListSection>
            <PickRow
              label={KIN_MONEY_FORMS.expense.receipt}
              value={draft.receipt ?? ""}
              shown={receipt?.name ?? KIN_MONEY_FORMS.expense.noReceipt}
              options={[
                { id: "", title: KIN_MONEY_FORMS.expense.noReceipt },
                ...held.map((file) => ({ id: file.attachmentId, title: file.name })),
              ]}
              onPick={(picked) => set({ receipt: picked === "" ? null : picked })}
            />
          </ListSection>
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {KIN_MONEY_FORMS.expense.receiptHint}
          </Text>
        </>
      ) : null}
    </KinWorkFrame>
  );
}
