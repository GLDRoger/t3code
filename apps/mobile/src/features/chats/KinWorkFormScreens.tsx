import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_WORK_ONLY_OWNER, type KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_CLIENTS,
  KIN_CLIENT_FAILED,
  KIN_CLIENT_GONE,
  KIN_PROJECTS,
  KIN_PROJECT_FAILED,
  KIN_PROJECT_GONE,
  kinProjectPageView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_FORM_COPY,
  KIN_WORK_FORM_LIMITS,
  kinClientCreateInput,
  kinClientDraftCheck,
  kinClientDraftOf,
  kinClientUpdateInput,
  kinContactCreateInput,
  kinContactDraftCheck,
  kinContactDraftOf,
  kinContactUpdateInput,
  kinProjectCreateInput,
  kinProjectDraftCheck,
  kinProjectDraftOf,
  kinProjectTargetHint,
  kinProjectUpdateInput,
  kinWorkFormMoved,
  kinWorkReadState,
  kinWorkSend,
  type KinWorkFormProblem,
  type KinWorkReadState,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import {
  EnvironmentId,
  KinOrgId,
  KinRecordKey,
  type KinContact,
  type KinPartyDetail,
  type KinProjectDetail,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  KinWorkFrame,
  KinWorkLoading,
  KinWorkProblemNotice,
  KinWorkTextField,
} from "./components/KinWorkPieces";
import { KinWorkPlaceRow } from "./components/KinWorkTaskMenus";
import { kinWorkRefParam, type KinWorkParams } from "./KinWorkScreen";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import {
  kinWorkChoicesAtom,
  useKinWorkChoices,
  useKinWorkDirectory,
  useKinWorkForm,
  type KinWorkTarget,
} from "./state/useKinWork";

const COPY = KIN_WORK_FORM_COPY;

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

function targetOf(params: { readonly environmentId: string; readonly orgId: string }) {
  const environmentId = Option.getOrNull(decodeEnvironmentId(params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(params.orgId));
  return environmentId === null || orgId === null ? null : { environmentId, orgId };
}

const keyParam = (key: string | undefined) => Option.getOrNull(decodeKey(key));

/** Everything a form shows before it has what it edits. */
function FormMessage(props: { readonly title: string; readonly children: React.ReactNode }) {
  const navigation = useNavigation();
  return (
    <KinWorkFrame title={props.title} onClose={() => navigation.goBack()}>
      {props.children}
    </KinWorkFrame>
  );
}

const NO_LINK = (
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
    <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
  ) : (
    <EmptyState
      variant="plain"
      {...copy.failed}
      action={<Button tone="secondary" label="Try again" onPress={retry} />}
    />
  );
}

function FormShell(props: {
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

export type KinClientFormParams = Pick<KinWorkParams, "environmentId" | "orgId" | "party">;

/** A client or vendor, new or being edited. */
export function KinClientFormScreen({ route }: StaticScreenProps<KinClientFormParams>) {
  const target = targetOf(route.params);
  const key = keyParam(route.params.party);
  const title = route.params.party === undefined ? COPY.party.newTitle : COPY.party.editTitle;
  if (target === null || (route.params.party !== undefined && key === null))
    return <FormMessage title={title}>{NO_LINK}</FormMessage>;
  return key === null ? (
    <ClientFormGate {...target} editing={null} />
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
  return <ClientFormGate {...props} editing={state.value.party} />;
}

function ClientFormGate(props: KinWorkTarget & { readonly editing: KinPartyDetail | null }) {
  const allowed = useAtomValue(
    (props.editing === null
      ? kinClient.workClientCreate
      : kinClient.workClientUpdate
    ).permissionAtom(props.environmentId),
  );
  if (!allowed)
    return (
      <FormMessage title={props.editing === null ? COPY.party.newTitle : COPY.party.editTitle}>
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      </FormMessage>
    );
  return <ClientForm {...props} />;
}

function ClientForm(props: KinWorkTarget & { readonly editing: KinPartyDetail | null }) {
  const navigation = useNavigation();
  const { environmentId, orgId, editing } = props;
  const create = useAtomCommand(kinClient.workClientCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.workClientUpdate, { reportFailure: false });
  // One id for the form's life: trying again after a dropped answer never adds a second client.
  const [requestId] = useState(uuidv4);
  const [key] = useState(() => editing?.key ?? null);
  const { state, form } = useKinWorkForm(environmentId, {
    noun: "client",
    start: kinClientDraftOf(editing ?? undefined),
    editing: editing === null ? null : { key: editing.key, rev: editing.rev },
    nameOf: (draft) => draft.name,
    check: kinClientDraftCheck,
    send: (change) =>
      change.type === "create"
        ? create({
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
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the form a newer read of the client being edited, so saving again goes against it
  useEffect(() => {
    if (editing !== null) form.latest(kinClientDraftOf(editing), editing.rev);
  }, [form, editing]);
  const { draft } = state;
  const moved = kinWorkFormMoved(state);
  const openClient = (to: KinRecordKey) => {
    navigation.goBack();
    navigation.navigate("KinClient", { environmentId, orgId, party: to });
  };
  const save = async () => {
    const outcome = await form.save();
    if (!outcome.saved) return;
    appAtomRegistry.refresh(kinWorkChoicesAtom(props));
    if (key !== null) {
      appAtomRegistry.refresh(kinClient.workClient({ environmentId, input: { orgId, key } }));
      return navigation.goBack();
    }
    const added = outcome.value?.key;
    if (added === undefined) navigation.goBack();
    else openClient(added);
  };
  return (
    <FormShell
      title={editing === null ? COPY.party.newTitle : COPY.party.editTitle}
      submit={editing === null ? COPY.party.add : COPY.save}
      saving={state.saving}
      canSave={draft.name.trim() !== ""}
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
          placeholder={COPY.party.namePlaceholder}
          moved={moved.name}
          onChangeText={(name) => form.edit({ name })}
        />
      </ListSection>
      <View className="gap-2">
        <Text className="px-2 text-sm text-foreground-muted">{COPY.party.kind}</Text>
        <View className="flex-row flex-wrap gap-2">
          <Chip
            label={COPY.party.kindClient}
            selected={!draft.vendor}
            disabled={state.saving}
            onPress={() => form.edit({ vendor: false })}
          />
          <Chip
            label={COPY.party.kindVendor}
            selected={draft.vendor}
            disabled={state.saving}
            onPress={() => form.edit({ vendor: true })}
          />
        </View>
      </View>
      <ListSection>
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
      <ListSection>
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
      <ListSection>
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
      <ListSection>
        <ListToggleRow
          icon="lock"
          label={KIN_CLIENTS.privateLabel}
          description={draft.private ? KIN_CLIENTS.privateOn : KIN_CLIENTS.privateOff}
          value={draft.private}
          disabled={state.saving}
          onValueChange={(on) => form.edit({ private: on })}
        />
      </ListSection>
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
  const allowed = useAtomValue(
    (contactKey === null
      ? kinClient.workContactCreate
      : kinClient.workContactUpdate
    ).permissionAtom(environmentId),
  );
  const atom = kinClient.workClient({ environmentId, input: { orgId, key: clientKey } });
  const state = kinWorkReadState(useAtomValue(atom));
  if (!allowed)
    return (
      <FormMessage title={props.title}>
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the form a newer read of the contact being edited, so saving again goes against it
  useEffect(() => {
    if (editing !== null) form.latest(kinContactDraftOf(editing), editing.rev);
  }, [form, editing]);
  const { draft } = state;
  const moved = kinWorkFormMoved(state);
  const busy = state.saving || aside.busy;
  const done = () => {
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
      onOpenExisting={() => navigation.goBack()}
      onSave={() => void save()}
    >
      <ListSection>
        <KinWorkTextField
          label={COPY.contact.name}
          value={draft.name}
          autoFocus={editing === null}
          disabled={busy}
          maxLength={KIN_WORK_FORM_LIMITS.name}
          placeholder={COPY.contact.namePlaceholder}
          moved={moved.name}
          onChangeText={(name) => form.edit({ name })}
        />
        <KinWorkTextField
          label={COPY.contact.role}
          value={draft.role}
          disabled={busy}
          maxLength={KIN_WORK_FORM_LIMITS.short}
          placeholder={COPY.contact.rolePlaceholder}
          moved={moved.role}
          onChangeText={(role) => form.edit({ role })}
        />
      </ListSection>
      <ListSection footer={COPY.contact.detailsHint}>
        <KinWorkTextField
          label={COPY.contact.email}
          value={draft.email}
          keyboard="email"
          isPrivate
          disabled={busy}
          maxLength={KIN_WORK_FORM_LIMITS.short}
          moved={moved.email}
          onChangeText={(email) => form.edit({ email })}
        />
        <KinWorkTextField
          label={COPY.contact.phone}
          value={draft.phone}
          keyboard="phone"
          isPrivate
          disabled={busy}
          maxLength={KIN_WORK_FORM_LIMITS.short}
          moved={moved.phone}
          onChangeText={(phone) => form.edit({ phone })}
        />
      </ListSection>
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
  const allowed = useAtomValue(
    (props.editing === null
      ? kinClient.workProjectCreate
      : kinClient.workProjectUpdate
    ).permissionAtom(props.environmentId),
  );
  if (!allowed)
    return (
      <FormMessage title={props.editing === null ? COPY.project.newTitle : COPY.project.editTitle}>
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
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
  const create = useAtomCommand(kinClient.workProjectCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.workProjectUpdate, { reportFailure: false });
  const [requestId] = useState(uuidv4);
  const [key] = useState(() => editing?.project.key ?? null);
  const [opened] = useState(() => new Date());
  const { state, form } = useKinWorkForm(environmentId, {
    noun: "project",
    start: kinProjectDraftOf(editing?.project, editing?.targetDay, props.party),
    editing: editing === null ? null : { key: editing.project.key, rev: editing.project.rev },
    nameOf: (draft) => draft.name,
    check: kinProjectDraftCheck,
    send: (change) =>
      change.type === "create"
        ? create({
            environmentId,
            input: { orgId, ...kinProjectCreateInput(change.draft), clientRequestId: requestId },
          })
        : update({
            environmentId,
            input: {
              orgId,
              key: change.key,
              rev: change.rev,
              ...kinProjectUpdateInput(change.changed),
            },
          }),
    reread: () => {
      if (key !== null)
        appAtomRegistry.refresh(kinClient.workProject({ environmentId, input: { orgId, key } }));
    },
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the form a newer read of the project being edited, so saving again goes against it
  useEffect(() => {
    if (editing !== null)
      form.latest(kinProjectDraftOf(editing.project, editing.targetDay), editing.project.rev);
  }, [form, editing]);
  const { draft } = state;
  const moved = kinWorkFormMoved(state);
  const target = draft.target ?? "";
  const openProject = (project: KinRecordKey) => {
    navigation.goBack();
    navigation.navigate("KinProject", { environmentId, orgId, project });
  };
  const save = async () => {
    const outcome = await form.save();
    if (!outcome.saved) return;
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
          placeholder={COPY.project.namePlaceholder}
          moved={moved.name}
          onChangeText={(name) => form.edit({ name })}
        />
      </ListSection>
      <ListSection>
        <KinWorkPlaceRow
          icon="person.2"
          label={COPY.project.party}
          none={COPY.project.noClient}
          held={draft.party}
          choices={choices.clients}
          disabled={state.saving}
          onPick={(party) => form.edit({ party })}
        />
        <KinWorkTextField
          label={COPY.project.target}
          value={target}
          keyboard="numbers"
          disabled={state.saving}
          maxLength={10}
          placeholder="2026-12-31"
          hint={kinProjectTargetHint(target, opened)}
          onChangeText={(text) => form.edit({ target: text.trim() === "" ? null : text.trim() })}
        />
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
        <ListToggleRow
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
