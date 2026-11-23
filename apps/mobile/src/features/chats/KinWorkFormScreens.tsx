import { KIN_PROMISES } from "@t3tools/client-runtime/kin/kinPromises";
import { KIN_MARKETING } from "@t3tools/client-runtime/kin/kinMarketing";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinWorkOnlyOwner, type KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import { kinParseMoney } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_DEALS } from "@t3tools/client-runtime/kin/kinDeals";
import {
  KIN_CLIENTS,
  kinClientPrivateNote,
  KIN_CLIENT_FAILED,
  KIN_CLIENT_GONE,
  KIN_PROJECTS,
  KIN_PROJECT_FAILED,
  KIN_PROJECT_GONE,
  KIN_PROJECT_PEOPLE,
  KIN_SHORT_FORMS,
  kinPartyFirstDeal,
  kinProjectPageView,
  kinShortFormFold,
  type KinShortFormField,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_FORM_COPY,
  KIN_WORK_FORM_LIMITS,
  KIN_GST_STATE_NAMES,
  kinClientCreateInput,
  kinClientDraftCheck,
  kinClientDraftOf,
  kinClientDraftWithGstin,
  kinClientGstinNote,
  kinIndiaFields,
  kinClientUpdateInput,
  kinContactCreateInput,
  kinContactDetailAdd,
  kinContactDetailCanAdd,
  kinContactDetailRemove,
  kinContactDetailSet,
  kinContactDraftCheck,
  kinContactDraftOf,
  kinContactUpdateInput,
  kinProjectCreateInput,
  kinProjectDraftCheck,
  KIN_PROJECT_BILLING_LABELS,
  kinProjectDraftOf,
  kinProjectTargetHint,
  kinProjectUpdateInput,
  kinFormTyped,
  kinWorkFormMoved,
  kinWorkReadState,
  kinWorkSend,
  type KinClientDraft,
  type KinClientDraftKind,
  type KinWorkFormProblem,
  type KinWorkReadState,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import {
  EnvironmentId,
  KinOrgId,
  KinRecordKey,
  type KinContact,
  type KinPartyDetail,
  type KinPartyPage,
  type KinPartyWithDealResult,
  type KinProjectDetail,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  KinGateView,
  KinWorkFrame,
  KinWorkLoading,
  KinWorkProblemNotice,
  KinWorkTextField,
  KinWorkToggleRow,
  useKinAskBeforeDiscard,
} from "./components/KinWorkPieces";
import { KinCountryFirstField } from "./components/KinCountryFirst";
import { KinDayField } from "./components/KinDayField";
import { KinPageFold } from "./components/KinPageFold";
import { useKinCompanyCountry, useKinHomeCurrency } from "./state/useKinMoney.ts";
import { useKinSectionOn } from "./state/useKinShell";
import { KinWorkPlacePicker } from "./components/KinWorkPlacePicker";
import { KinProjectPeoplePicker } from "./KinProjectPeopleScreen";
import { KinCameFromFields, KinTagFields, useKinMarketing } from "./KinMarketing";
import { kinWorkRefParam, type KinWorkParams } from "./state/kinWorkParams";
import { useKinIsOwnerLevel, useKinSeesClients } from "./state/kinChatOnly";
import { kinClient } from "./state/kinClient";
import { kinHostConnected, useKinGate } from "./state/useKinHost";
import {
  kinWorkChoicesAtom,
  useKinWorkChoices,
  useKinWorkDirectory,
  useKinWorkZone,
  useKinWorkForm,
  type KinWorkTarget,
} from "./state/useKinWork";

const COPY = KIN_WORK_FORM_COPY;

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

export function targetOf(params: { readonly environmentId: string; readonly orgId: string }) {
  const environmentId = Option.getOrNull(decodeEnvironmentId(params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(params.orgId));
  return environmentId === null || orgId === null ? null : { environmentId, orgId };
}

export const keyParam = (key: string | undefined) => Option.getOrNull(decodeKey(key));

/** Everything a form shows before it has what it edits. */
export function FormMessage(props: { readonly title: string; readonly children: React.ReactNode }) {
  const navigation = useNavigation();
  return (
    <KinWorkFrame title={props.title} onClose={() => navigation.goBack()}>
      {props.children}
    </KinWorkFrame>
  );
}

export const NO_LINK = (
  <EmptyState
    variant="plain"
    title="This link doesn't open anything"
    detail="Open Work from your Kin chats."
  />
);

/** The form's states while what it edits is being read: nothing to type into yet. */
function waiting(
  state: Exclude<KinWorkReadState<unknown>, { readonly _tag: "ready" }>,
  copy: {
    readonly gone: { readonly title: string; readonly detail: string };
    readonly failed: { readonly title: string; readonly detail: string };
  },
  retry: () => void,
) {
  return state._tag === "loading" ? (
    <KinWorkLoading label="Loading" />
  ) : state._tag === "gone" ? (
    <EmptyState variant="plain" {...copy.gone} />
  ) : state._tag === "refused" ? (
    <EmptyState variant="plain" {...kinWorkOnlyOwner("clients")} />
  ) : (
    <EmptyState
      variant="plain"
      {...copy.failed}
      action={<Button tone="secondary" label={KIN_RETRY} onPress={retry} />}
    />
  );
}

export function FormShell(props: {
  readonly title: string;
  readonly submit: string;
  readonly saving: boolean;
  readonly canSave: boolean;
  readonly problem: KinWorkFormProblem | null;
  readonly onOpenExisting?: (key: KinRecordKey) => void;
  readonly onSave: () => void;
  readonly children: React.ReactNode;
}) {
  const navigation = useNavigation();
  return (
    <KinWorkFrame
      form
      showTop={props.problem?.text ?? null}
      title={props.title}
      onClose={() => navigation.goBack()}
      confirm={{
        label: props.submit,
        onPress: props.onSave,
        loading: props.saving,
        disabled: !props.canSave || props.saving,
      }}
    >
      {props.problem === null ? null : (
        <KinWorkProblemNotice
          problem={props.problem}
          {...(props.onOpenExisting === undefined ? {} : { onOpenExisting: props.onOpenExisting })}
        />
      )}
      {props.children}
    </KinWorkFrame>
  );
}

export type KinClientFormParams = Pick<KinWorkParams, "environmentId" | "orgId" | "party"> & {
  /** A new one starts as a prospect. */
  readonly prospect?: boolean;
};

/** A prospect, client or vendor, new or being edited. */
export function KinClientFormScreen({ route }: StaticScreenProps<KinClientFormParams>) {
  const target = targetOf(route.params);
  const key = keyParam(route.params.party);
  const title = route.params.party === undefined ? COPY.party.newTitle : COPY.party.editTitle;
  if (target === null || (route.params.party !== undefined && key === null))
    return <FormMessage title={title}>{NO_LINK}</FormMessage>;
  return key === null ? (
    <ClientFormGate
      {...target}
      editing={null}
      can={null}
      start={route.params.prospect === true ? "prospect" : "client"}
    />
  ) : (
    <ClientFormRead {...target} clientKey={key} />
  );
}

function ClientFormRead(props: KinWorkTarget & { readonly clientKey: KinRecordKey }) {
  const atom = kinClient.workClient({
    environmentId: props.environmentId,
    input: { orgId: props.orgId, key: props.clientKey },
  });
  const state = kinWorkReadState(useAtomValue(atom));
  if (state._tag !== "ready")
    return (
      <FormMessage title={COPY.party.editTitle}>
        {waiting(state, { gone: KIN_CLIENT_GONE, failed: KIN_CLIENT_FAILED }, () =>
          appAtomRegistry.refresh(atom),
        )}
      </FormMessage>
    );
  return (
    <ClientFormGate
      {...props}
      editing={state.value.party}
      can={state.value.can ?? null}
      contacts={state.value.contacts}
      privateHides={state.value.privateHides}
      start="client"
    />
  );
}

type ClientFormProps = KinWorkTarget & {
  readonly editing: KinPartyDetail | null;
  /** What the host says this reader may change; null for a new one or from an older host. */
  readonly can: KinPartyPage["can"] | null;
  /** An existing one's contacts, whose emails and phones are edited in their own form. */
  readonly contacts?: ReadonlyArray<KinContact>;
  /** Who stops seeing it once kept private (`KinPartyPage.privateHides`). */
  readonly privateHides?: ReadonlyArray<string> | undefined;
  readonly start: KinClientDraftKind;
};

function ClientFormGate(props: ClientFormProps) {
  const ownerLevel = useKinIsOwnerLevel(props.environmentId);
  const seesClients = useKinSeesClients(props.environmentId);
  const gate = useKinGate(
    (props.editing === null
      ? kinClient.workClientCreate
      : kinClient.workClientUpdate
    ).permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  // A teammate adds prospects with Clients on, and changes only what the host says they may.
  const allowed = props.editing === null ? seesClients : (props.can?.edit ?? ownerLevel);
  const shown = gate ?? (allowed === null ? "loading" : allowed ? null : "refused");
  if (shown !== null)
    return (
      <FormMessage title={props.editing === null ? COPY.party.newTitle : COPY.party.editTitle}>
        <KinGateView
          gate={shown}
          refused={kinWorkOnlyOwner("clients")}
          label={props.editing === null ? COPY.party.newTitle : COPY.party.editTitle}
        />
      </FormMessage>
    );
  return <ClientForm {...props} member={!(props.can?.owner ?? ownerLevel)} />;
}

const NO_PLACE = "none";
const ABROAD = "abroad";

function ClientForm(props: ClientFormProps & { readonly member: boolean }) {
  const navigation = useNavigation();
  const { environmentId, orgId, editing, member } = props;
  const marketing = useKinMarketing(props);
  const create = useAtomCommand(kinClient.workClientCreate, { reportFailure: false });
  const createWithDeal = useAtomCommand(kinClient.workPartyWithDealCreate, {
    reportFailure: false,
  });
  const update = useAtomCommand(kinClient.workClientUpdate, { reportFailure: false });
  // One id for the form's life: trying again after a dropped answer never adds a second client.
  const [requestId] = useState(uuidv4);
  const [key] = useState(() => editing?.key ?? null);
  // "About how much?": an amount makes the client's deal in the same step.
  const home = useKinHomeCurrency(props) ?? "USD";
  const [amount, setAmount] = useState("");
  const money = amount.trim() === "" ? null : kinParseMoney(amount, home);
  // The form keeps the `send` it was made with; the amount reaches it at the tap on save.
  const dealt = useRef<typeof money>(null);
  const { state, form } = useKinWorkForm<KinClientDraft, KinPartyDetail | KinPartyWithDealResult>(
    environmentId,
    {
      noun: "client",
      start: kinClientDraftOf(editing ?? undefined, member ? "prospect" : props.start),
      editing: editing === null ? null : { key: editing.key, rev: editing.rev },
      latest: editing === null ? null : kinClientDraftOf(editing),
      nameOf: (draft) => draft.name,
      check: kinClientDraftCheck,
      send: (change) =>
        change.type === "create"
          ? dealt.current !== null
            ? createWithDeal({
                environmentId,
                input: {
                  orgId,
                  ...kinClientCreateInput(change.draft),
                  deal: kinPartyFirstDeal(change.draft.name, dealt.current),
                  acceptDealLeftOut: true,
                  clientRequestId: requestId,
                },
              })
            : create({
                environmentId,
                input: { orgId, ...kinClientCreateInput(change.draft), clientRequestId: requestId },
              })
          : update({
              environmentId,
              input: {
                orgId,
                key: change.key,
                rev: change.rev,
                ...kinClientUpdateInput(change.changed),
              },
            }),
      reread: () => {
        if (key !== null)
          appAtomRegistry.refresh(kinClient.workClient({ environmentId, input: { orgId, key } }));
      },
    },
  );
  const { draft } = state;
  const moved = kinWorkFormMoved(state);
  const leave = useKinAskBeforeDiscard(kinFormTyped(state.from, draft) || amount.trim() !== "");
  const kinds: ReadonlyArray<KinClientDraftKind> = !member
    ? ["prospect", "client", "vendor"]
    : editing !== null && draft.kind !== "vendor"
      ? ["prospect", "client"]
      : [];
  const kindLabel: Record<KinClientDraftKind, string> = {
    prospect: COPY.party.kindProspect,
    client: COPY.party.kindClient,
    vendor: COPY.party.kindVendor,
  };
  const newProspect = editing === null && draft.kind === "prospect";
  const keepsContacts = props.can?.contacts ?? props.can?.edit ?? !member;
  const dealsOn = useKinSectionOn(environmentId, "deals");
  const india = kinIndiaFields(useKinCompanyCountry(props));
  const gstinNote = kinClientGstinNote(draft);
  const placeId = draft.abroad ? ABROAD : draft.placeOfSupply || NO_PLACE;
  const placeLabel = draft.abroad
    ? COPY.party.placeAbroad
    : draft.placeOfSupply || COPY.party.placeNone;
  const takesDeal = editing === null && draft.kind !== "vendor" && dealsOn;
  const amountBad = takesDeal && amount.trim() !== "" && money === null;
  const openClient = (to: KinRecordKey) => {
    leave();
    navigation.goBack();
    navigation.navigate("KinClient", { environmentId, orgId, party: to });
  };
  const save = async () => {
    dealt.current = takesDeal ? money : null;
    const outcome = await form.save();
    if (!outcome.saved) return;
    leave();
    appAtomRegistry.refresh(kinWorkChoicesAtom(props));
    if (key !== null) {
      appAtomRegistry.refresh(kinClient.workClient({ environmentId, input: { orgId, key } }));
      return navigation.goBack();
    }
    const made = outcome.value;
    if (made === null) return navigation.goBack();
    openClient("party" in made ? made.party.key : made.key);
    if ("dealLeftOut" in made) Alert.alert("Client saved", `Deal left out: ${made.dealLeftOut}`);
  };
  const sourceField = (
    <KinCameFromFields
      label={COPY.party.source}
      value={draft.source}
      choices={marketing.cameFrom}
      disabled={state.saving}
      placeholder={COPY.party.sourcePlaceholder}
      moved={moved.source}
      onChange={(source) => form.edit({ source })}
    />
  );
  const tagsField = (
    <KinWorkTextField
      label={COPY.party.tags}
      value={draft.tags}
      disabled={state.saving}
      placeholder={COPY.party.tagsPlaceholder}
      moved={moved.tags}
      onChangeText={(tags) => form.edit({ tags })}
    />
  );
  const fold = kinShortFormFold("party", {
    absent: [
      ...(kinds.length === 0 ? (["kind"] as const) : []),
      ...(takesDeal ? [] : (["value"] as const)),
      ...(member ? (["terms", "address", "private"] as const) : []),
      ...(member || !india ? (["tax"] as const) : []),
    ],
  });
  /** One part of the form: in its place on an edit, under More on a new one. */
  const piece = (which: KinShortFormField<"party">) => {
    switch (which) {
      case "name":
      case "contact":
      case "value":
        return null;
      case "kind":
        return kinds.length === 0 ? null : (
          <View key={which} className="gap-2">
            <Text className="px-2 text-sm text-foreground-muted">{COPY.party.kind}</Text>
            <View className="flex-row flex-wrap gap-2">
              {kinds.map((kind) => (
                <Chip
                  key={kind}
                  label={kindLabel[kind]}
                  selected={draft.kind === kind}
                  disabled={state.saving}
                  onPress={() => form.edit({ kind })}
                />
              ))}
            </View>
          </View>
        );
      case "source":
        return <ListSection key={which}>{sourceField}</ListSection>;
      case "tags":
        return <ListSection key={which}>{tagsField}</ListSection>;
      case "role":
        return (
          <ListSection key={which}>
            <KinWorkTextField
              label={COPY.contact.role}
              value={draft.contactRole}
              disabled={state.saving}
              maxLength={KIN_WORK_FORM_LIMITS.short}
              onChangeText={(contactRole) => form.edit({ contactRole })}
            />
          </ListSection>
        );
      case "terms":
        return member ? null : (
          <ListSection key={which}>
            <KinWorkTextField
              label={COPY.party.terms}
              value={draft.terms}
              multiline
              isPrivate
              disabled={state.saving}
              maxLength={KIN_WORK_FORM_LIMITS.notes}
              placeholder={COPY.party.termsPlaceholder}
              hint={COPY.party.termsHint}
              moved={moved.terms}
              onChangeText={(terms) => form.edit({ terms })}
            />
          </ListSection>
        );
      case "address":
        return member ? null : (
          <ListSection key={which}>
            <KinWorkTextField
              label={COPY.party.address}
              value={draft.address}
              multiline
              disabled={state.saving}
              maxLength={500}
              placeholder={COPY.party.addressPlaceholder}
              hint={COPY.party.addressHint}
              moved={moved.address}
              onChangeText={(address) => form.edit({ address })}
            />
          </ListSection>
        );
      case "tax":
        return member || !india ? null : (
          <View key={which} className="gap-5">
            <ListSection footer={gstinNote === null ? COPY.party.placeHint : undefined}>
              <KinWorkTextField
                label={COPY.party.gstin}
                value={draft.gstin}
                disabled={state.saving}
                maxLength={20}
                hint={COPY.party.gstinHint}
                moved={moved.gstin}
                onChangeText={(gstin) => {
                  const next = kinClientDraftWithGstin(draft, gstin);
                  form.edit({ gstin: next.gstin, placeOfSupply: next.placeOfSupply });
                }}
              />
              <Menu
                title={COPY.party.place}
                accessibilityRole="button"
                accessibilityLabel={`${COPY.party.place}: ${placeLabel}. Change`}
                actions={[
                  { id: NO_PLACE, title: COPY.party.placeNone },
                  ...KIN_GST_STATE_NAMES.map((name) => ({ id: name, title: name })),
                  { id: ABROAD, title: COPY.party.placeAbroad },
                ].map((one) => ({
                  ...one,
                  state: one.id === placeId ? ("on" as const) : ("off" as const),
                }))}
                onPressAction={({ nativeEvent: { event } }) =>
                  form.edit(
                    event === ABROAD
                      ? { abroad: true, placeOfSupply: "" }
                      : { abroad: false, placeOfSupply: event === NO_PLACE ? "" : event },
                  )
                }
              >
                <View pointerEvents="none">
                  <ListRowLayout label={placeLabel} detail={COPY.party.place} />
                </View>
              </Menu>
              {draft.abroad ? (
                <KinWorkTextField
                  label={COPY.party.country}
                  value={draft.placeOfSupply}
                  disabled={state.saving}
                  maxLength={60}
                  onChangeText={(placeOfSupply) => form.edit({ placeOfSupply })}
                />
              ) : null}
            </ListSection>
            {gstinNote === null ? null : <Notice message={gstinNote} />}
          </View>
        );
      case "notes":
        return (
          <ListSection key={which}>
            <KinWorkTextField
              label={COPY.party.notes}
              value={draft.notes}
              multiline
              disabled={state.saving}
              maxLength={KIN_WORK_FORM_LIMITS.notes}
              placeholder={COPY.party.notesPlaceholder}
              moved={moved.notes}
              onChangeText={(notes) => form.edit({ notes })}
            />
          </ListSection>
        );
      case "private":
        return member ? null : (
          <ListSection key={which}>
            <KinWorkToggleRow
              icon="lock"
              label={KIN_CLIENTS.privateLabel}
              description={kinClientPrivateNote({
                private: draft.private,
                wasPrivate: editing?.sensitive ?? false,
                hides: props.privateHides,
              })}
              value={draft.private}
              disabled={state.saving}
              onValueChange={(on) => form.edit({ private: on })}
            />
          </ListSection>
        );
    }
  };
  return (
    <FormShell
      title={
        editing !== null
          ? COPY.party.editTitle
          : newProspect
            ? COPY.party.prospectTitle
            : COPY.party.newTitle
      }
      submit={editing !== null ? COPY.save : newProspect ? KIN_CLIENTS.addProspect : COPY.party.add}
      saving={state.saving}
      canSave={draft.name.trim() !== "" && !amountBad}
      problem={state.problem}
      onOpenExisting={openClient}
      onSave={() => void save()}
    >
      <ListSection>
        <KinWorkTextField
          label={COPY.party.name}
          value={draft.name}
          autoFocus={editing === null}
          disabled={state.saving}
          maxLength={KIN_WORK_FORM_LIMITS.name}
          moved={moved.name}
          onChangeText={(name) => form.edit({ name })}
        />
      </ListSection>
      {editing === null ? (
        <>
          <ListSection
            title={COPY.party.contact}
            footer={`${COPY.party.contactHint} ${COPY.contact.detailsHint}`}
          >
            <KinWorkTextField
              label={COPY.party.contactName}
              value={draft.contactName}
              disabled={state.saving}
              maxLength={KIN_WORK_FORM_LIMITS.name}
              onChangeText={(contactName) => form.edit({ contactName })}
            />
            <ContactDetailFields
              kind="email"
              values={draft.contactEmails}
              disabled={state.saving}
              onChange={(contactEmails) => form.edit({ contactEmails })}
            />
            <ContactDetailFields
              kind="phone"
              values={draft.contactPhones}
              disabled={state.saving}
              onChange={(contactPhones) => form.edit({ contactPhones })}
            />
          </ListSection>
          {!takesDeal ? null : (
            <ListSection>
              <KinWorkTextField
                label={KIN_SHORT_FORMS.aboutHowMuch}
                value={amount}
                keyboard="numbers"
                disabled={state.saving}
                hint={amountBad ? KIN_DEALS.notAmount : KIN_SHORT_FORMS.aboutHowMuchHint}
                onChangeText={setAmount}
              />
            </ListSection>
          )}
          {fold.moreLine === null ? null : (
            <KinPageFold title={KIN_SHORT_FORMS.more} summary={fold.moreLine}>
              {fold.more.map(piece)}
            </KinPageFold>
          )}
        </>
      ) : (
        <>
          {piece("kind")}
          <ListSection>
            {sourceField}
            {tagsField}
          </ListSection>
          {!keepsContacts && (props.contacts ?? []).length === 0 ? null : (
            <ListSection title={KIN_CLIENTS.contacts} footer={COPY.contact.detailsHint}>
              {(props.contacts ?? []).map((contact) => (
                <ListActionRow
                  key={contact.key}
                  icon="person.crop.circle"
                  label={contact.name}
                  description={[contact.role, ...contact.phones, ...contact.emails]
                    .filter((part) => part !== null && part !== "")
                    .join(" · ")}
                  disabled={!keepsContacts}
                  onPress={() =>
                    navigation.navigate("KinContactForm", {
                      environmentId,
                      orgId,
                      party: editing.key,
                      contact: contact.key,
                    })
                  }
                />
              ))}
              {keepsContacts ? (
                <ListActionRow
                  icon="plus"
                  label={KIN_CLIENTS.addContact}
                  onPress={() =>
                    navigation.navigate("KinContactForm", {
                      environmentId,
                      orgId,
                      party: editing.key,
                    })
                  }
                />
              ) : null}
            </ListSection>
          )}
          {piece("terms")}
          {piece("address")}
          {piece("tax")}
          {piece("notes")}
          {piece("private")}
        </>
      )}
      {member ? (
        <Text className="px-2 text-xs text-foreground-muted">{COPY.party.memberHint}</Text>
      ) : null}
    </FormShell>
  );
}

export type KinContactFormParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly party: string;
  /** The contact being edited; a new one when left out. */
  readonly contact?: string;
};

/** Someone to reach at a client, new or being edited. */
export function KinContactFormScreen({ route }: StaticScreenProps<KinContactFormParams>) {
  const target = targetOf(route.params);
  const client = keyParam(route.params.party);
  const contact = keyParam(route.params.contact);
  const title = route.params.contact === undefined ? COPY.contact.newTitle : COPY.contact.editTitle;
  if (
    target === null ||
    client === null ||
    (route.params.contact !== undefined && contact === null)
  )
    return <FormMessage title={title}>{NO_LINK}</FormMessage>;
  return <ContactFormRead {...target} clientKey={client} contactKey={contact} title={title} />;
}

function ContactFormRead(
  props: KinWorkTarget & {
    readonly clientKey: KinRecordKey;
    readonly contactKey: KinRecordKey | null;
    readonly title: string;
  },
) {
  const { environmentId, orgId, clientKey, contactKey } = props;
  const gate = useKinGate(
    (contactKey === null
      ? kinClient.workContactCreate
      : kinClient.workContactUpdate
    ).permissionStateAtom(environmentId),
    environmentId,
  );
  const atom = kinClient.workClient({ environmentId, input: { orgId, key: clientKey } });
  const state = kinWorkReadState(useAtomValue(atom));
  if (gate !== null)
    return (
      <FormMessage title={props.title}>
        <KinGateView gate={gate} refused={kinWorkOnlyOwner("clients")} label={props.title} />
      </FormMessage>
    );
  if (state._tag !== "ready")
    return (
      <FormMessage title={props.title}>
        {waiting(state, { gone: KIN_CLIENT_GONE, failed: KIN_CLIENT_FAILED }, () =>
          appAtomRegistry.refresh(atom),
        )}
      </FormMessage>
    );
  const { party, contacts } = state.value;
  const editing =
    contactKey === null ? null : (contacts.find((held) => held.key === contactKey) ?? null);
  if (contactKey !== null && editing === null)
    return (
      <FormMessage title={props.title}>
        <EmptyState
          variant="plain"
          title="This contact isn't here any more"
          detail={`Open ${party.name} to see who there is now.`}
        />
      </FormMessage>
    );
  return (
    <ContactForm
      environmentId={environmentId}
      orgId={orgId}
      party={{ key: party.key, title: party.name }}
      editing={editing}
    />
  );
}

function ContactForm(
  props: KinWorkTarget & { readonly party: KinWorkRef; readonly editing: KinContact | null },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, editing, party } = props;
  const create = useAtomCommand(kinClient.workContactCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.workContactUpdate, { reportFailure: false });
  const [requestId] = useState(uuidv4);
  const [aside, setAside] = useState<{
    readonly busy: boolean;
    readonly problem: KinWorkFormProblem | null;
  }>({ busy: false, problem: null });
  const reread = () =>
    appAtomRegistry.refresh(
      kinClient.workClient({ environmentId, input: { orgId, key: party.key } }),
    );
  const { state, form } = useKinWorkForm(environmentId, {
    noun: "contact",
    start: kinContactDraftOf(editing ?? undefined),
    editing: editing === null ? null : { key: editing.key, rev: editing.rev },
    latest: editing === null ? null : kinContactDraftOf(editing),
    nameOf: (draft) => draft.name,
    check: kinContactDraftCheck,
    send: (change) =>
      change.type === "create"
        ? create({
            environmentId,
            input: {
              orgId,
              party: party.key,
              ...kinContactCreateInput(change.draft),
              clientRequestId: requestId,
            },
          })
        : update({
            environmentId,
            input: {
              orgId,
              key: change.key,
              rev: change.rev,
              ...kinContactUpdateInput(change.changed),
            },
          }),
    reread,
  });
  const marketing = useKinMarketing(props);
  const { draft } = state;
  const moved = kinWorkFormMoved(state);
  const busy = state.saving || aside.busy;
  const leave = useKinAskBeforeDiscard(kinFormTyped(state.from, draft));
  const done = () => {
    leave();
    reread();
    navigation.goBack();
  };
  const save = async () => {
    if ((await form.save()).saved) done();
  };
  // Someone who has moved on stays in the history; they just stop being someone to reach.
  const setActive = async (contact: KinContact, active: boolean) => {
    setAside({ busy: true, problem: null });
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        update({ environmentId, input: { orgId, key: contact.key, rev: contact.rev, active } }),
      noun: "contact",
      name: contact.name,
      own: contact.key,
    });
    setAside({ busy: false, problem: outcome.ok ? null : outcome.problem });
    if (outcome.ok) done();
    else if (outcome.problem.kind === "conflict") reread();
  };
  return (
    <FormShell
      title={editing === null ? COPY.contact.newTitle : COPY.contact.editTitle}
      submit={editing === null ? COPY.contact.add : COPY.save}
      saving={busy}
      canSave={draft.name.trim() !== ""}
      problem={state.problem ?? aside.problem}
      // Two people at one client can't share a name; the one there is on the page behind.
      onOpenExisting={() => {
        leave();
        navigation.goBack();
      }}
      onSave={() => void save()}
    >
      <ListSection>
        <KinWorkTextField
          label={COPY.contact.name}
          value={draft.name}
          autoFocus={editing === null}
          disabled={busy}
          maxLength={KIN_WORK_FORM_LIMITS.name}
          moved={moved.name}
          onChangeText={(name) => form.edit({ name })}
        />
        <KinWorkTextField
          label={COPY.contact.role}
          value={draft.role}
          disabled={busy}
          maxLength={KIN_WORK_FORM_LIMITS.short}
          moved={moved.role}
          onChangeText={(role) => form.edit({ role })}
        />
      </ListSection>
      <ListSection footer={COPY.contact.detailsHint}>
        <ContactDetailFields
          kind="email"
          values={draft.emails}
          disabled={busy}
          moved={moved.emails}
          onChange={(emails) => form.edit({ emails })}
        />
        <ContactDetailFields
          kind="phone"
          values={draft.phones}
          disabled={busy}
          moved={moved.phones}
          onChange={(phones) => form.edit({ phones })}
        />
      </ListSection>
      <KinTagFields
        tags={draft.tags ?? []}
        company={marketing.tags}
        disabled={busy}
        onChange={(tags) => form.edit({ tags })}
      />
      <ListSection>
        <KinWorkTextField
          label={COPY.contact.notes}
          value={draft.notes}
          multiline
          disabled={busy}
          maxLength={KIN_WORK_FORM_LIMITS.notes}
          placeholder={COPY.contact.notesPlaceholder}
          moved={moved.notes}
          onChangeText={(notes) => form.edit({ notes })}
        />
      </ListSection>
      {editing === null ? null : (
        <ListSection>
          <ListActionRow
            label={editing.active ? COPY.contact.remove : COPY.contact.restore}
            disabled={busy}
            loading={aside.busy}
            onPress={() => void setActive(editing, !editing.active)}
          />
        </ListSection>
      )}
    </FormShell>
  );
}

/** A contact's emails or phones: the first is the main one, each after it can be taken off. */
function ContactDetailFields(props: {
  readonly kind: "email" | "phone";
  readonly values: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly moved?: ReadonlyArray<string> | undefined;
  readonly onChange: (next: ReadonlyArray<string>) => void;
}) {
  const { values, onChange } = props;
  const email = props.kind === "email";
  const label = email ? COPY.contact.email : COPY.contact.phone;
  return (
    <>
      {values.map((value, at) => (
        <KinWorkTextField
          // oxlint-disable-next-line react/no-array-index-key -- typed text has no identity besides its place, and blanks repeat
          key={at}
          label={at === 0 ? label : `${label} ${at + 1}`}
          value={value}
          keyboard={email ? "email" : "phone"}
          isPrivate
          disabled={props.disabled}
          maxLength={KIN_WORK_FORM_LIMITS.short}
          autoFocus={at > 0 && value === "" && at === values.length - 1}
          moved={at === 0 ? props.moved?.join(", ") : undefined}
          onChangeText={(text) => onChange(kinContactDetailSet(values, at, text))}
          {...(at === 0
            ? {}
            : {
                remove: {
                  label: `${email ? COPY.contact.removeEmail : COPY.contact.removePhone}: ${value.trim() || `${label} ${at + 1}`}`,
                  onPress: () => onChange(kinContactDetailRemove(values, at)),
                },
              })}
        />
      ))}
      {kinContactDetailCanAdd(values) ? (
        <ListActionRow
          icon="plus"
          label={email ? COPY.contact.addEmail : COPY.contact.addPhone}
          disabled={props.disabled}
          onPress={() => onChange(kinContactDetailAdd(values))}
        />
      ) : null}
    </>
  );
}

export type KinProjectFormParams = Pick<
  KinWorkParams,
  "environmentId" | "orgId" | "project" | "party" | "partyName"
>;

/** A project, new or being edited. How it is going is worked out, never typed. */
export function KinProjectFormScreen({ route }: StaticScreenProps<KinProjectFormParams>) {
  const target = targetOf(route.params);
  const key = keyParam(route.params.project);
  const title = route.params.project === undefined ? COPY.project.newTitle : COPY.project.editTitle;
  if (target === null || (route.params.project !== undefined && key === null))
    return <FormMessage title={title}>{NO_LINK}</FormMessage>;
  return key === null ? (
    <ProjectFormGate
      {...target}
      editing={null}
      party={kinWorkRefParam(route.params.party, route.params.partyName)}
    />
  ) : (
    <ProjectFormRead {...target} projectKey={key} />
  );
}

type ProjectEditing = { readonly project: KinProjectDetail; readonly targetDay: string | null };

function ProjectFormRead(props: KinWorkTarget & { readonly projectKey: KinRecordKey }) {
  const atom = kinClient.workProject({
    environmentId: props.environmentId,
    input: { orgId: props.orgId, key: props.projectKey },
  });
  const state = kinWorkReadState(useAtomValue(atom));
  const { names } = useKinWorkDirectory(props, true);
  const now = new Date(useNowMinuteMs());
  if (state._tag !== "ready")
    return (
      <FormMessage title={COPY.project.editTitle}>
        {waiting(state, { gone: KIN_PROJECT_GONE, failed: KIN_PROJECT_FAILED }, () =>
          appAtomRegistry.refresh(atom),
        )}
      </FormMessage>
    );
  const { targetDay } = kinProjectPageView(state.value, names, now);
  return (
    <ProjectFormGate
      {...props}
      editing={{ project: state.value.project, targetDay }}
      party={null}
    />
  );
}

function ProjectFormGate(
  props: KinWorkTarget & {
    readonly editing: ProjectEditing | null;
    readonly party: KinWorkRef | null;
  },
) {
  const gate = useKinGate(
    (props.editing === null
      ? kinClient.workProjectCreate
      : kinClient.workProjectUpdate
    ).permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  if (gate !== null)
    return (
      <FormMessage title={props.editing === null ? COPY.project.newTitle : COPY.project.editTitle}>
        <KinGateView
          gate={gate}
          refused={kinWorkOnlyOwner("clients")}
          label={props.editing === null ? COPY.project.newTitle : COPY.project.editTitle}
        />
      </FormMessage>
    );
  return <ProjectForm {...props} />;
}

function ProjectForm(
  props: KinWorkTarget & {
    readonly editing: ProjectEditing | null;
    readonly party: KinWorkRef | null;
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, editing } = props;
  const choices = useKinWorkChoices(props, true);
  const directory = useKinWorkDirectory(props, editing === null);
  const { zone } = useKinWorkZone(props);
  const [members, setMembers] = useState<ReadonlyArray<KinWorkPrincipal>>([]);
  // The form keeps its first `send`, so it reads who was picked from here at save time.
  const picked = useRef(members);
  const create = useAtomCommand(kinClient.workProjectCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.workProjectUpdate, { reportFailure: false });
  const [requestId] = useState(uuidv4);
  const [key] = useState(() => editing?.project.key ?? null);
  const [opened] = useState(() => new Date());
  const marketing = useKinMarketing(props);
  const home = useKinHomeCurrency(props);
  const { state, form } = useKinWorkForm(environmentId, {
    noun: "project",
    start: kinProjectDraftOf(editing?.project, editing?.targetDay, props.party, home),
    editing: editing === null ? null : { key: editing.project.key, rev: editing.project.rev },
    latest:
      editing === null ? null : kinProjectDraftOf(editing.project, editing.targetDay, null, home),
    nameOf: (draft) => draft.name,
    check: kinProjectDraftCheck,
    send: (change) =>
      change.type === "create"
        ? create({
            environmentId,
            input: {
              orgId,
              ...kinProjectCreateInput(change.draft),
              ...(picked.current.length === 0 ? {} : { members: picked.current }),
              clientRequestId: requestId,
            },
          })
        : update({
            environmentId,
            input: {
              orgId,
              key: change.key,
              rev: change.rev,
              ...kinProjectUpdateInput(change.changed, change.draft.currency),
            },
          }),
    reread: () => {
      if (key !== null)
        appAtomRegistry.refresh(kinClient.workProject({ environmentId, input: { orgId, key } }));
    },
  });
  const { draft } = state;
  const moved = kinWorkFormMoved(state);
  const leave = useKinAskBeforeDiscard(kinFormTyped(state.from, draft) || members.length > 0);
  const openProject = (project: KinRecordKey) => {
    leave();
    navigation.goBack();
    navigation.navigate("KinProject", { environmentId, orgId, project });
  };
  const save = async () => {
    const outcome = await form.save();
    if (!outcome.saved) return;
    leave();
    appAtomRegistry.refresh(kinWorkChoicesAtom(props));
    if (key !== null) {
      appAtomRegistry.refresh(kinClient.workProject({ environmentId, input: { orgId, key } }));
      return navigation.goBack();
    }
    const added = outcome.value?.key;
    if (added === undefined) navigation.goBack();
    else openProject(added);
  };
  return (
    <FormShell
      title={editing === null ? COPY.project.newTitle : COPY.project.editTitle}
      submit={editing === null ? COPY.project.add : COPY.save}
      saving={state.saving}
      canSave={draft.name.trim() !== ""}
      problem={state.problem}
      onOpenExisting={openProject}
      onSave={() => void save()}
    >
      <ListSection>
        <KinWorkTextField
          label={COPY.project.name}
          value={draft.name}
          autoFocus={editing === null}
          disabled={state.saving}
          maxLength={KIN_WORK_FORM_LIMITS.name}
          moved={moved.name}
          onChangeText={(name) => form.edit({ name })}
        />
      </ListSection>
      <ListSection>
        <KinWorkPlacePicker
          target={{ environmentId, orgId }}
          noun="client"
          icon="person.2"
          label={COPY.project.party}
          none={COPY.project.noClient}
          held={draft.party}
          choices={choices.clients}
          disabled={state.saving}
          onPick={(party) => form.edit({ party })}
        />
        <KinDayField
          label={COPY.project.target}
          day={draft.target}
          zone={zone}
          now={opened}
          none={KIN_PROJECTS.noTarget}
          hint={kinProjectTargetHint(draft.target)}
          disabled={state.saving}
          onPick={(target) => form.edit({ target })}
        />
      </ListSection>
      {editing === null ? (
        <KinProjectPeoplePicker
          people={directory.people}
          names={directory.names}
          on={[]}
          picked={members}
          disabled={state.saving}
          onChange={(next) => {
            picked.current = next;
            setMembers(next);
          }}
          footer={draft.private ? KIN_PROJECT_PEOPLE.privateDetail : KIN_PROJECT_PEOPLE.detail}
        />
      ) : null}
      <ListSection title={COPY.project.billing}>
        {([null, "fixed", "hourly", "retainer"] as const).map((kind) => (
          <ListChoiceRow
            key={kind ?? "none"}
            label={kind === null ? COPY.project.noBilling : KIN_PROJECT_BILLING_LABELS[kind]}
            selected={draft.billing === kind}
            disabled={state.saving}
            onPress={() => form.edit({ billing: kind })}
          />
        ))}
      </ListSection>
      <ListSection>
        <KinCountryFirstField target={props} label={COPY.project.value}>
          <KinWorkTextField
            label={COPY.project.value}
            value={draft.value}
            keyboard="numbers"
            disabled={state.saving}
            maxLength={40}
            placeholder={COPY.project.valuePlaceholder}
            moved={moved.value}
            onChangeText={(value) => form.edit({ value })}
          />
        </KinCountryFirstField>
        <KinDayField
          label={COPY.project.startsOn}
          day={draft.startsOn}
          zone={zone}
          now={opened}
          disabled={state.saving}
          onPick={(startsOn) => form.edit({ startsOn })}
        />
        {draft.billing === "retainer" || draft.renewsOn !== null ? (
          <KinDayField
            label={COPY.project.renewsOn}
            day={draft.renewsOn}
            zone={zone}
            now={opened}
            disabled={state.saving}
            onPick={(renewsOn) => form.edit({ renewsOn })}
          />
        ) : null}
        {draft.renewsOn === null ? null : (
          <KinWorkTextField
            label={KIN_PROMISES.noticeDays}
            value={draft.noticeDays}
            keyboard="numbers"
            disabled={state.saving}
            maxLength={3}
            placeholder={KIN_PROMISES.noticeDaysHint}
            onChangeText={(noticeDays) => form.edit({ noticeDays })}
          />
        )}
      </ListSection>
      <ListSection footer={draft.campaign ? KIN_MARKETING.audienceHint : undefined}>
        <KinWorkToggleRow
          icon="tag"
          label={KIN_MARKETING.campaign}
          description={KIN_MARKETING.campaignHint}
          value={draft.campaign}
          disabled={state.saving}
          onValueChange={(campaign) => form.edit({ campaign })}
        />
        {draft.campaign ? (
          <>
            <KinWorkTextField
              label={KIN_MARKETING.audience}
              value={draft.audience}
              disabled={state.saving}
              maxLength={60}
              placeholder={KIN_MARKETING.audiencePlaceholder}
              moved={moved.audience}
              onChangeText={(audience) => form.edit({ audience })}
            />
            {marketing.tags.length === 0 ? null : (
              <View className="flex-row flex-wrap gap-2 px-4 pb-3">
                {marketing.tags.slice(0, 12).map((tag) => (
                  <Chip
                    key={tag}
                    label={tag}
                    size="small"
                    selected={draft.audience === tag}
                    disabled={state.saving}
                    onPress={() => form.edit({ audience: tag })}
                  />
                ))}
              </View>
            )}
          </>
        ) : null}
      </ListSection>
      <ListSection>
        <KinWorkTextField
          label={COPY.project.repos}
          value={draft.repos}
          multiline
          keyboard="plain"
          disabled={state.saving}
          placeholder={COPY.project.reposPlaceholder}
          moved={moved.repos}
          onChangeText={(repos) => form.edit({ repos })}
        />
      </ListSection>
      <ListSection>
        <KinWorkTextField
          label={COPY.project.notes}
          value={draft.notes}
          multiline
          disabled={state.saving}
          maxLength={KIN_WORK_FORM_LIMITS.notes}
          moved={moved.notes}
          onChangeText={(notes) => form.edit({ notes })}
        />
      </ListSection>
      <ListSection>
        <KinWorkToggleRow
          icon="lock"
          label={KIN_PROJECTS.privateLabel}
          description={draft.private ? KIN_PROJECTS.privateOn : KIN_PROJECTS.privateOff}
          value={draft.private}
          disabled={state.saving}
          onValueChange={(on) => form.edit({ private: on })}
        />
      </ListSection>
    </FormShell>
  );
}

export type KinMilestoneFormParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly project: string;
};

/** Add a milestone to a project, as a sheet over it. */
export function KinMilestoneFormScreen({ route }: StaticScreenProps<KinMilestoneFormParams>) {
  const target = targetOf(route.params);
  const project = keyParam(route.params.project);
  if (target === null || project === null)
    return <FormMessage title={KIN_PROJECTS.addMilestone}>{NO_LINK}</FormMessage>;
  return <MilestoneForm {...target} project={project} />;
}

function MilestoneForm(props: KinWorkTarget & { readonly project: KinRecordKey }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const create = useAtomCommand(kinClient.workCreate, { reportFailure: false });
  const [requestId] = useState(uuidv4);
  const { zone } = useKinWorkZone(props);
  const [opened] = useState(() => new Date());
  const [name, setName] = useState("");
  const [due, setDue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const canSave = name.trim() !== "";
  const leave = useKinAskBeforeDiscard(canSave || due !== null);
  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    setProblem(null);
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        create({
          environmentId,
          input: {
            orgId,
            list: "milestones",
            title: name.trim(),
            project: props.project,
            ...(due === null ? {} : { dueAt: due, dueAllDay: true }),
            clientRequestId: requestId,
          },
        }),
      noun: "project",
      name: name.trim(),
      own: null,
    });
    setSaving(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    leave();
    navigation.goBack();
  };
  return (
    <FormShell
      title={KIN_PROJECTS.addMilestone}
      submit={KIN_PROJECTS.addMilestone}
      saving={saving}
      canSave={canSave}
      problem={problem}
      onOpenExisting={(task) => navigation.navigate("KinWorkItem", { environmentId, orgId, task })}
      onSave={() => void save()}
    >
      <ListSection>
        <KinWorkTextField
          label={COPY.project.name}
          value={name}
          autoFocus
          disabled={saving}
          maxLength={KIN_WORK_FORM_LIMITS.name}
          onChangeText={setName}
        />
        <KinDayField
          label="Due"
          day={due}
          zone={zone}
          now={opened}
          disabled={saving}
          onPick={setDue}
        />
      </ListSection>
    </FormShell>
  );
}
