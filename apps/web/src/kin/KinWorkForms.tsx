import type { KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import { KIN_CLIENTS, KIN_PROJECTS } from "@t3tools/client-runtime/kin/kinWorkClients";
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
  kinProjectUpdateInput,
  kinWorkFormMoved,
  kinWorkSend,
  type KinWorkFormProblem,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import type {
  KinContact,
  KinPartyDetail,
  KinProjectDetail,
  KinRecordKey,
} from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinWorkPrivateMark, KinWorkProblem } from "./KinWorkParts";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import {
  kinWorkChoicesAtom,
  useKinWorkForm,
  type KinWorkChoices,
  type KinWorkTarget,
} from "./useKinWork";

const COPY = KIN_WORK_FORM_COPY;

function FormShell(props: {
  readonly title: string;
  readonly submit: string;
  readonly saving: boolean;
  readonly canSave: boolean;
  readonly problem: KinWorkFormProblem | null;
  readonly onOpenExisting: (key: KinRecordKey) => void;
  readonly onSave: () => void;
  readonly onClose: () => void;
  /** Something else the form can do, on the far side from Save. */
  readonly aside?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.saving) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              {props.children}
              {props.problem === null ? null : (
                <KinWorkProblem problem={props.problem} onOpenExisting={props.onOpenExisting} />
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            {props.aside === undefined ? null : <div className="me-auto">{props.aside}</div>}
            <Button type="button" variant="outline" disabled={props.saving} onClick={props.onClose}>
              {COPY.cancel}
            </Button>
            <Button
              type="submit"
              disabled={!props.canSave || props.saving}
              aria-busy={props.saving}
            >
              {props.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** One labelled field, with what someone else changed it to while the owner was typing. */
function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly isPrivate?: boolean;
  readonly hint?: string;
  readonly moved?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={props.id}>{props.label}</Label>
        {props.isPrivate ? <KinWorkPrivateMark /> : null}
      </div>
      {props.children}
      {props.hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      )}
      {props.moved === undefined ? null : (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
          It now says: {props.moved.trim() || "nothing"}
        </p>
      )}
    </div>
  );
}

function PrivateSwitch(props: {
  readonly label: string;
  readonly note: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id}>{props.label}</Label>
        <p className="text-xs text-muted-foreground">{props.note}</p>
      </div>
      <Switch
        id={id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
    </div>
  );
}

/** A client or vendor, new or being edited. */
export function KinClientDialog(
  props: KinWorkTarget & {
    readonly editing: KinPartyDetail | null;
    readonly onSaved: (key: KinRecordKey) => void;
    readonly onOpenExisting: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, editing } = props;
  const create = useAtomCommand(kinClient.workClientCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.workClientUpdate, { reportFailure: false });
  // One id for the form's life: trying again after a dropped answer never adds a second client.
  const [requestId] = useState(randomUUID);
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
  const ids = { name: useId(), terms: useId(), notes: useId() };
  const save = async () => {
    const outcome = await form.save();
    if (!outcome.saved) return;
    appAtomRegistry.refresh(kinWorkChoicesAtom(props));
    const saved = outcome.value?.key ?? key;
    if (saved !== null) props.onSaved(saved);
  };
  return (
    <FormShell
      title={editing === null ? COPY.party.newTitle : COPY.party.editTitle}
      submit={editing === null ? COPY.party.add : COPY.save}
      saving={state.saving}
      canSave={draft.name.trim() !== ""}
      problem={state.problem}
      onOpenExisting={props.onOpenExisting}
      onSave={() => void save()}
      onClose={props.onClose}
    >
      <Field id={ids.name} label={COPY.party.name} moved={moved.name}>
        <Input
          id={ids.name}
          value={draft.name}
          maxLength={KIN_WORK_FORM_LIMITS.name}
          placeholder={COPY.party.namePlaceholder}
          autoComplete="off"
          autoFocus
          onChange={(event) => form.edit({ name: event.target.value })}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <Label>{COPY.party.kind}</Label>
        <ToggleGroup
          aria-label={COPY.party.kind}
          value={[draft.vendor ? "vendor" : "client"]}
          onValueChange={(value) => {
            if (value[0] !== undefined) form.edit({ vendor: value[0] === "vendor" });
          }}
        >
          <Toggle value="client">{COPY.party.kindClient}</Toggle>
          <Toggle value="vendor">{COPY.party.kindVendor}</Toggle>
        </ToggleGroup>
      </div>
      <Field
        id={ids.terms}
        label={COPY.party.terms}
        isPrivate
        hint={COPY.party.termsHint}
        moved={moved.terms}
      >
        <Textarea
          id={ids.terms}
          rows={2}
          value={draft.terms}
          maxLength={KIN_WORK_FORM_LIMITS.notes}
          placeholder={COPY.party.termsPlaceholder}
          onChange={(event) => form.edit({ terms: event.target.value })}
        />
      </Field>
      <Field id={ids.notes} label={COPY.party.notes} moved={moved.notes}>
        <Textarea
          id={ids.notes}
          rows={3}
          value={draft.notes}
          maxLength={KIN_WORK_FORM_LIMITS.notes}
          placeholder={COPY.party.notesPlaceholder}
          onChange={(event) => form.edit({ notes: event.target.value })}
        />
      </Field>
      <PrivateSwitch
        label={KIN_CLIENTS.privateLabel}
        note={draft.private ? KIN_CLIENTS.privateOn : KIN_CLIENTS.privateOff}
        checked={draft.private}
        disabled={state.saving}
        onChange={(checked) => form.edit({ private: checked })}
      />
    </FormShell>
  );
}

/** Someone to reach at a client, new or being edited. */
export function KinContactDialog(
  props: KinWorkTarget & {
    readonly party: KinWorkRef;
    readonly editing: KinContact | null;
    readonly onSaved: () => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, editing, party } = props;
  const create = useAtomCommand(kinClient.workContactCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.workContactUpdate, { reportFailure: false });
  const [requestId] = useState(randomUUID);
  const [aside, setAside] = useState<{
    readonly busy: boolean;
    readonly problem: KinWorkFormProblem | null;
  }>({ busy: false, problem: null });
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
    reread: () =>
      appAtomRegistry.refresh(
        kinClient.workClient({ environmentId, input: { orgId, key: party.key } }),
      ),
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the form a newer read of the contact being edited, so saving again goes against it
  useEffect(() => {
    if (editing !== null) form.latest(kinContactDraftOf(editing), editing.rev);
  }, [form, editing]);
  const { draft } = state;
  const moved = kinWorkFormMoved(state);
  const ids = { name: useId(), role: useId(), email: useId(), phone: useId(), notes: useId() };
  const save = async () => {
    if ((await form.save()).saved) props.onSaved();
  };
  // Someone who has moved on stays in the history; they just stop being someone to reach.
  const setActive = async (contact: KinContact, active: boolean) => {
    setAside({ busy: true, problem: null });
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        update({
          environmentId,
          input: { orgId, key: contact.key, rev: contact.rev, active },
        }),
      noun: "contact",
      name: contact.name,
      own: contact.key,
    });
    setAside({ busy: false, problem: outcome.ok ? null : outcome.problem });
    if (outcome.ok) props.onSaved();
  };
  return (
    <FormShell
      title={editing === null ? COPY.contact.newTitle : COPY.contact.editTitle}
      submit={editing === null ? COPY.contact.add : COPY.save}
      saving={state.saving || aside.busy}
      canSave={draft.name.trim() !== ""}
      problem={state.problem ?? aside.problem}
      // Two people at one client can't share a name; the one there is on this same page.
      onOpenExisting={props.onClose}
      {...(editing === null
        ? {}
        : {
            aside: (
              <Button
                type="button"
                variant="ghost"
                disabled={state.saving || aside.busy}
                onClick={() => void setActive(editing, !editing.active)}
              >
                {editing.active ? COPY.contact.remove : COPY.contact.restore}
              </Button>
            ),
          })}
      onSave={() => void save()}
      onClose={props.onClose}
    >
      <Field id={ids.name} label={COPY.contact.name} moved={moved.name}>
        <Input
          id={ids.name}
          value={draft.name}
          maxLength={KIN_WORK_FORM_LIMITS.name}
          placeholder={COPY.contact.namePlaceholder}
          autoComplete="off"
          autoFocus
          onChange={(event) => form.edit({ name: event.target.value })}
        />
      </Field>
      <Field id={ids.role} label={COPY.contact.role} moved={moved.role}>
        <Input
          id={ids.role}
          value={draft.role}
          maxLength={KIN_WORK_FORM_LIMITS.short}
          placeholder={COPY.contact.rolePlaceholder}
          autoComplete="off"
          onChange={(event) => form.edit({ role: event.target.value })}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={ids.email} label={COPY.contact.email} isPrivate moved={moved.email}>
          <Input
            id={ids.email}
            type="email"
            value={draft.email}
            maxLength={KIN_WORK_FORM_LIMITS.short}
            autoComplete="off"
            onChange={(event) => form.edit({ email: event.target.value })}
          />
        </Field>
        <Field id={ids.phone} label={COPY.contact.phone} isPrivate moved={moved.phone}>
          <Input
            id={ids.phone}
            type="tel"
            value={draft.phone}
            maxLength={KIN_WORK_FORM_LIMITS.short}
            autoComplete="off"
            onChange={(event) => form.edit({ phone: event.target.value })}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{COPY.contact.detailsHint}</p>
      <Field id={ids.notes} label={COPY.contact.notes} moved={moved.notes}>
        <Textarea
          id={ids.notes}
          rows={2}
          value={draft.notes}
          maxLength={KIN_WORK_FORM_LIMITS.notes}
          placeholder={COPY.contact.notesPlaceholder}
          onChange={(event) => form.edit({ notes: event.target.value })}
        />
      </Field>
    </FormShell>
  );
}

const NO_CLIENT = "none";

/** A project, new or being edited. Its health is worked out by the host, so there is none here. */
export function KinProjectDialog(
  props: KinWorkTarget & {
    readonly editing: {
      readonly project: KinProjectDetail;
      readonly targetDay: string | null;
    } | null;
    /** The client a new project is opened from. */
    readonly party: KinWorkRef | null;
    readonly choices: KinWorkChoices;
    readonly onSaved: (key: KinRecordKey) => void;
    readonly onOpenExisting: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, editing } = props;
  const create = useAtomCommand(kinClient.workProjectCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.workProjectUpdate, { reportFailure: false });
  const [requestId] = useState(randomUUID);
  const [key] = useState(() => editing?.project.key ?? null);
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
  const ids = { name: useId(), target: useId(), repos: useId(), notes: useId() };
  // The client it already has stays pickable after that client closes.
  const clients =
    draft.party === null || props.choices.clients.some((row) => row.key === draft.party?.key)
      ? props.choices.clients
      : [draft.party, ...props.choices.clients];
  const save = async () => {
    const outcome = await form.save();
    if (!outcome.saved) return;
    appAtomRegistry.refresh(kinWorkChoicesAtom(props));
    const saved = outcome.value?.key ?? key;
    if (saved !== null) props.onSaved(saved);
  };
  return (
    <FormShell
      title={editing === null ? COPY.project.newTitle : COPY.project.editTitle}
      submit={editing === null ? COPY.project.add : COPY.save}
      saving={state.saving}
      canSave={draft.name.trim() !== ""}
      problem={state.problem}
      onOpenExisting={props.onOpenExisting}
      onSave={() => void save()}
      onClose={props.onClose}
    >
      <Field id={ids.name} label={COPY.project.name} moved={moved.name}>
        <Input
          id={ids.name}
          value={draft.name}
          maxLength={KIN_WORK_FORM_LIMITS.name}
          placeholder={COPY.project.namePlaceholder}
          autoComplete="off"
          autoFocus
          onChange={(event) => form.edit({ name: event.target.value })}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>{COPY.project.party}</Label>
          <Select
            value={draft.party?.key ?? NO_CLIENT}
            onValueChange={(value) =>
              form.edit({ party: clients.find((row) => row.key === value) ?? null })
            }
          >
            <SelectTrigger className="w-full min-w-0" aria-label={COPY.project.party}>
              <SelectValue>{draft.party?.title ?? COPY.project.noClient}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem value={NO_CLIENT}>{COPY.project.noClient}</SelectItem>
              {clients.map((row) => (
                <SelectItem key={row.key} value={row.key}>
                  {row.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {moved.party === undefined ? null : (
            <p className="text-xs text-muted-foreground">
              It now says: {moved.party?.title ?? COPY.project.noClient}
            </p>
          )}
        </div>
        <Field id={ids.target} label={COPY.project.target} moved={moved.target ?? undefined}>
          <Input
            id={ids.target}
            type="date"
            value={draft.target ?? ""}
            onChange={(event) =>
              form.edit({ target: event.target.value === "" ? null : event.target.value })
            }
          />
        </Field>
      </div>
      <Field id={ids.repos} label={COPY.project.repos} moved={moved.repos}>
        <Textarea
          id={ids.repos}
          rows={2}
          value={draft.repos}
          placeholder={COPY.project.reposPlaceholder}
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => form.edit({ repos: event.target.value })}
        />
      </Field>
      <Field id={ids.notes} label={COPY.project.notes} moved={moved.notes}>
        <Textarea
          id={ids.notes}
          rows={3}
          value={draft.notes}
          maxLength={KIN_WORK_FORM_LIMITS.notes}
          placeholder={COPY.project.notesPlaceholder}
          onChange={(event) => form.edit({ notes: event.target.value })}
        />
      </Field>
      <PrivateSwitch
        label={KIN_PROJECTS.privateLabel}
        note={draft.private ? KIN_PROJECTS.privateOn : KIN_PROJECTS.privateOff}
        checked={draft.private}
        disabled={state.saving}
        onChange={(checked) => form.edit({ private: checked })}
      />
    </FormShell>
  );
}
