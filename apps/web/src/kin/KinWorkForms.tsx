import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import { KIN_MARKETING } from "@t3tools/client-runtime/kin/kinMarketing";
import {
  KIN_CLIENTS,
  KIN_PROJECT_PEOPLE,
  KIN_PROJECTS,
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
  KIN_PROJECT_BILLING_LABELS,
  kinProjectCreateInput,
  kinProjectDraftCheck,
  kinProjectDraftOf,
  kinProjectUpdateInput,
  kinWorkFormMoved,
  kinWorkSend,
  type KinClientDraftKind,
  type KinWorkFormProblem,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import type {
  KinContact,
  KinPartyDetail,
  KinProjectDetail,
  KinRecordKey,
  KinWorkPrincipal,
} from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
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
import { KinCountryFirstField } from "./KinCountryFirst";
import { KinCameFromField, KinTagEditor, useKinMarketing } from "./KinMarketing";
import { useKinCompanyCountry, useKinHomeCurrency } from "./useKinMoney.ts";
import { KinProjectPeoplePicker } from "./KinProjectPeople";
import { KinWorkPrivateMark, KinWorkProblem } from "./KinWorkParts";
import { kinClient } from "./kinClient";
import { KinPlaceCombobox } from "./KinPlaceCombobox";
import { kinHostConnected } from "./useKinHost";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import {
  kinWorkChoicesAtom,
  useKinWorkForm,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

const COPY = KIN_WORK_FORM_COPY;

export function FormShell(props: {
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
  /** The field whose hint says why Save waits, read with the button. */
  readonly waitsOn?: string | undefined;
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
              aria-describedby={
                props.waitsOn === undefined ? undefined : fieldHintId(props.waitsOn)
              }
            >
              {props.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const fieldHintId = (id: string) => `${id}-hint`;

/** One labelled field, with what someone else changed it to while the owner was typing. */
export function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly isPrivate?: boolean;
  readonly hint?: string | undefined;
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
        <p id={fieldHintId(props.id)} className="text-xs text-muted-foreground">
          {props.hint}
        </p>
      )}
      {props.moved === undefined ? null : (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
          {KIN_WORK_COPY.nowSays(props.moved.trim() || "nothing")}
        </p>
      )}
    </div>
  );
}

/** A contact's emails or phones: the first is the main one, each after it can be taken off. */
function ContactDetails(props: {
  readonly id: string;
  readonly kind: "email" | "phone";
  readonly values: ReadonlyArray<string>;
  readonly moved?: ReadonlyArray<string> | undefined;
  readonly onChange: (next: ReadonlyArray<string>) => void;
}) {
  const { values, onChange } = props;
  const email = props.kind === "email";
  const label = email ? COPY.contact.email : COPY.contact.phone;
  return (
    <Field id={props.id} label={label} isPrivate moved={props.moved?.join(", ")}>
      {values.map((value, at) => (
        // oxlint-disable-next-line react/no-array-index-key -- typed text has no identity besides its place, and blanks repeat
        <div key={at} className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <Input
              id={at === 0 ? props.id : undefined}
              aria-label={at === 0 ? undefined : `${label} ${at + 1}`}
              type={email ? "email" : "tel"}
              value={value}
              maxLength={KIN_WORK_FORM_LIMITS.short}
              autoComplete="off"
              autoFocus={at > 0 && value === "" && at === values.length - 1}
              onChange={(event) => onChange(kinContactDetailSet(values, at, event.target.value))}
            />
          </div>
          {at === 0 ? null : (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`${email ? COPY.contact.removeEmail : COPY.contact.removePhone}: ${value.trim() || `${label} ${at + 1}`}`}
              onClick={() => onChange(kinContactDetailRemove(values, at))}
            >
              <XIcon />
            </Button>
          )}
        </div>
      ))}
      {kinContactDetailCanAdd(values) ? (
        <div>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onChange(kinContactDetailAdd(values))}
          >
            <PlusIcon />
            {email ? COPY.contact.addEmail : COPY.contact.addPhone}
          </Button>
        </div>
      ) : null}
    </Field>
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

const NO_PLACE = "none";
const ABROAD = "abroad";

/**
 * A prospect, client or vendor, new or being edited. A teammate (Clients on) adds prospects and
 * changes the name, notes, where it came from and tags; terms, tax and Keep private stay the owner
 * level's, and the host checks the same.
 */
export function KinClientDialog(
  props: KinWorkTarget & {
    readonly editing: KinPartyDetail | null;
    /** What a new one starts as. */
    readonly start?: KinClientDraftKind;
    /** Leaves out what only the owner level changes; a teammate's by default. */
    readonly member?: boolean;
    readonly onSaved: (key: KinRecordKey) => void;
    readonly onOpenExisting: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, editing } = props;
  const ownerLevel = useKinOwnerLevel(environmentId);
  const member = props.member ?? !ownerLevel;
  const create = useAtomCommand(kinClient.workClientCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.workClientUpdate, { reportFailure: false });
  // One id for the form's life: trying again after a dropped answer never adds a second client.
  const [requestId] = useState(randomUUID);
  const [key] = useState(() => editing?.key ?? null);
  const { state, form } = useKinWorkForm(environmentId, {
    noun: "client",
    start: kinClientDraftOf(editing ?? undefined, member ? "prospect" : (props.start ?? "client")),
    editing: editing === null ? null : { key: editing.key, rev: editing.rev },
    latest: editing === null ? null : kinClientDraftOf(editing),
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
  const { draft } = state;
  const moved = kinWorkFormMoved(state);
  const ids = {
    name: useId(),
    terms: useId(),
    address: useId(),
    gstin: useId(),
    place: useId(),
    country: useId(),
    notes: useId(),
    source: useId(),
    tags: useId(),
    contactName: useId(),
    contactRole: useId(),
    contactEmail: useId(),
    contactPhone: useId(),
  };
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
  // Said on the field itself: on the owner's long form the problem line sits below the fold.
  const nameMissing = state.problem?.text === COPY.party.contactNameMissing;
  const india = kinIndiaFields(useKinCompanyCountry(props));
  const marketing = useKinMarketing(props);
  const gstinNote = kinClientGstinNote(draft);
  const place = draft.abroad ? ABROAD : draft.placeOfSupply || NO_PLACE;
  const save = async () => {
    const outcome = await form.save();
    if (!outcome.saved) return;
    appAtomRegistry.refresh(kinWorkChoicesAtom(props));
    const saved = outcome.value?.key ?? key;
    if (saved !== null) props.onSaved(saved);
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
      canSave={draft.name.trim() !== ""}
      problem={nameMissing ? null : state.problem}
      onOpenExisting={props.onOpenExisting}
      onSave={() => void save()}
      onClose={props.onClose}
    >
      <Field id={ids.name} label={COPY.party.name} moved={moved.name}>
        <Input
          id={ids.name}
          value={draft.name}
          maxLength={KIN_WORK_FORM_LIMITS.name}
          autoComplete="off"
          autoFocus
          onChange={(event) => form.edit({ name: event.target.value })}
        />
      </Field>
      {kinds.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <Label>{COPY.party.kind}</Label>
          <ToggleGroup
            aria-label={COPY.party.kind}
            value={[draft.kind]}
            onValueChange={(value) => {
              const kind = kinds.find((one) => one === value[0]);
              if (kind !== undefined) form.edit({ kind });
            }}
          >
            {kinds.map((kind) => (
              <Toggle key={kind} value={kind}>
                {kindLabel[kind]}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={ids.source} label={COPY.party.source} moved={moved.source}>
          <KinCameFromField
            id={ids.source}
            value={draft.source}
            choices={marketing.cameFrom}
            placeholder={COPY.party.sourcePlaceholder}
            onChange={(source) => form.edit({ source })}
          />
        </Field>
        <Field id={ids.tags} label={COPY.party.tags} moved={moved.tags}>
          <Input
            id={ids.tags}
            value={draft.tags}
            placeholder={COPY.party.tagsPlaceholder}
            autoComplete="off"
            onChange={(event) => form.edit({ tags: event.target.value })}
          />
        </Field>
      </div>
      {editing !== null ? null : (
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-1 text-base/4.5 font-medium text-foreground sm:text-sm/4">
            {COPY.party.contact}
          </legend>
          <p className="text-xs text-muted-foreground">{COPY.party.contactHint}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={ids.contactName} label={COPY.party.contactName}>
              <Input
                id={ids.contactName}
                value={draft.contactName}
                maxLength={KIN_WORK_FORM_LIMITS.name}
                autoComplete="off"
                aria-invalid={nameMissing || undefined}
                aria-describedby={nameMissing ? `${ids.contactName}-problem` : undefined}
                onChange={(event) => form.edit({ contactName: event.target.value })}
              />
              {nameMissing ? (
                <p
                  id={`${ids.contactName}-problem`}
                  role="alert"
                  className="text-xs text-destructive-foreground"
                >
                  {COPY.party.contactNameMissing}
                </p>
              ) : null}
            </Field>
            <Field id={ids.contactRole} label={COPY.contact.role}>
              <Input
                id={ids.contactRole}
                value={draft.contactRole}
                maxLength={KIN_WORK_FORM_LIMITS.short}
                autoComplete="off"
                onChange={(event) => form.edit({ contactRole: event.target.value })}
              />
            </Field>
            <ContactDetails
              id={ids.contactEmail}
              kind="email"
              values={draft.contactEmails}
              onChange={(contactEmails) => form.edit({ contactEmails })}
            />
            <ContactDetails
              id={ids.contactPhone}
              kind="phone"
              values={draft.contactPhones}
              onChange={(contactPhones) => form.edit({ contactPhones })}
            />
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">{COPY.contact.detailsHint}</p>
        </fieldset>
      )}
      {member ? null : (
        <>
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
          <Field
            id={ids.address}
            label={COPY.party.address}
            hint={COPY.party.addressHint}
            moved={moved.address}
          >
            <Textarea
              id={ids.address}
              rows={3}
              value={draft.address}
              maxLength={500}
              placeholder={COPY.party.addressPlaceholder}
              onChange={(event) => form.edit({ address: event.target.value })}
            />
          </Field>
          {india ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id={ids.gstin}
                  label={COPY.party.gstin}
                  hint={COPY.party.gstinHint}
                  moved={moved.gstin}
                >
                  <Input
                    id={ids.gstin}
                    value={draft.gstin}
                    maxLength={20}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    onChange={(event) => {
                      const next = kinClientDraftWithGstin(draft, event.target.value);
                      form.edit({ gstin: next.gstin, placeOfSupply: next.placeOfSupply });
                    }}
                  />
                </Field>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.place}>{COPY.party.place}</Label>
                  <Select
                    value={place}
                    onValueChange={(value) =>
                      form.edit(
                        value === ABROAD
                          ? { abroad: true, placeOfSupply: "" }
                          : {
                              abroad: false,
                              placeOfSupply: value === NO_PLACE ? "" : String(value),
                            },
                      )
                    }
                  >
                    <SelectTrigger id={ids.place} className="w-full min-w-0">
                      <SelectValue>
                        {draft.abroad
                          ? COPY.party.placeAbroad
                          : draft.placeOfSupply || COPY.party.placeNone}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      <SelectItem value={NO_PLACE}>{COPY.party.placeNone}</SelectItem>
                      {KIN_GST_STATE_NAMES.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                      <SelectItem value={ABROAD}>{COPY.party.placeAbroad}</SelectItem>
                    </SelectPopup>
                  </Select>
                  {moved.placeOfSupply === undefined ? null : (
                    <p className="text-xs text-muted-foreground">
                      {KIN_WORK_COPY.nowSays(moved.placeOfSupply.trim() || COPY.party.placeNone)}
                    </p>
                  )}
                </div>
              </div>
              {draft.abroad ? (
                <Field id={ids.country} label={COPY.party.country}>
                  <Input
                    id={ids.country}
                    value={draft.placeOfSupply}
                    maxLength={60}
                    autoComplete="off"
                    onChange={(event) => form.edit({ placeOfSupply: event.target.value })}
                  />
                </Field>
              ) : null}
              {gstinNote === null ? (
                <p className="-mt-2 text-xs text-muted-foreground">{COPY.party.placeHint}</p>
              ) : (
                <Alert variant="warning">
                  <AlertDescription>{gstinNote}</AlertDescription>
                </Alert>
              )}
            </>
          ) : null}
        </>
      )}
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
      {member ? (
        <p className="text-xs text-muted-foreground">{COPY.party.memberHint}</p>
      ) : (
        <PrivateSwitch
          label={KIN_CLIENTS.privateLabel}
          note={draft.private ? KIN_CLIENTS.privateOn : KIN_CLIENTS.privateOff}
          checked={draft.private}
          disabled={state.saving}
          onChange={(checked) => form.edit({ private: checked })}
        />
      )}
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
    reread: () =>
      appAtomRegistry.refresh(
        kinClient.workClient({ environmentId, input: { orgId, key: party.key } }),
      ),
  });
  const { draft } = state;
  const moved = kinWorkFormMoved(state);
  const ids = {
    name: useId(),
    role: useId(),
    email: useId(),
    phone: useId(),
    tags: useId(),
    notes: useId(),
  };
  const marketing = useKinMarketing(props);
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
          autoComplete="off"
          onChange={(event) => form.edit({ role: event.target.value })}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <ContactDetails
          id={ids.email}
          kind="email"
          values={draft.emails}
          moved={moved.emails}
          onChange={(emails) => form.edit({ emails })}
        />
        <ContactDetails
          id={ids.phone}
          kind="phone"
          values={draft.phones}
          moved={moved.phones}
          onChange={(phones) => form.edit({ phones })}
        />
      </div>
      <p className="text-xs text-muted-foreground">{COPY.contact.detailsHint}</p>
      <Field
        id={ids.tags}
        label={KIN_MARKETING.tags}
        moved={moved.tags === undefined ? undefined : moved.tags.join(", ")}
      >
        <KinTagEditor
          id={ids.tags}
          tags={draft.tags ?? []}
          company={marketing.tags}
          disabled={state.saving}
          onChange={(tags) => form.edit({ tags })}
        />
      </Field>
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

const NO_BILLING = "none";

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
    /** Who a new project can have on it; its page changes them after. */
    readonly directory?: KinWorkDirectory;
    readonly onSaved: (key: KinRecordKey) => void;
    readonly onOpenExisting: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, editing } = props;
  const [members, setMembers] = useState<ReadonlyArray<KinWorkPrincipal>>([]);
  // The form keeps the `send` it was made with, so it reads who is picked at save time.
  const picked = useRef<ReadonlyArray<KinWorkPrincipal>>([]);
  const pick = (next: ReadonlyArray<KinWorkPrincipal>) => {
    picked.current = next;
    setMembers(next);
  };
  const create = useAtomCommand(kinClient.workProjectCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.workProjectUpdate, { reportFailure: false });
  const [requestId] = useState(randomUUID);
  const [key] = useState(() => editing?.project.key ?? null);
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
  const ids = {
    name: useId(),
    target: useId(),
    repos: useId(),
    notes: useId(),
    value: useId(),
    startsOn: useId(),
    renewsOn: useId(),
    audience: useId(),
  };
  const marketing = useKinMarketing(props);
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
          autoComplete="off"
          autoFocus
          onChange={(event) => form.edit({ name: event.target.value })}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <KinPlaceCombobox
            target={{ environmentId, orgId }}
            noun="client"
            label={COPY.project.party}
            placeholder={COPY.project.noClient}
            value={draft.party}
            choices={props.choices.clients}
            onChange={(party) => form.edit({ party })}
          />
          {moved.party === undefined ? null : (
            <p className="text-xs text-muted-foreground">
              {KIN_WORK_COPY.nowSays(moved.party?.title ?? COPY.project.noClient)}
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>{COPY.project.billing}</Label>
          <Select
            value={draft.billing ?? NO_BILLING}
            onValueChange={(value) =>
              form.edit({
                billing:
                  value === "fixed" || value === "hourly" || value === "retainer" ? value : null,
              })
            }
          >
            <SelectTrigger className="w-full min-w-0" aria-label={COPY.project.billing}>
              <SelectValue>
                {draft.billing === null
                  ? COPY.project.noBilling
                  : KIN_PROJECT_BILLING_LABELS[draft.billing]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem value={NO_BILLING}>{COPY.project.noBilling}</SelectItem>
              {(["fixed", "hourly", "retainer"] as const).map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {KIN_PROJECT_BILLING_LABELS[kind]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <KinCountryFirstField environmentId={environmentId} label={COPY.project.value}>
          <Field id={ids.value} label={COPY.project.value} moved={moved.value}>
            <Input
              id={ids.value}
              value={draft.value}
              inputMode="decimal"
              placeholder={COPY.project.valuePlaceholder}
              autoComplete="off"
              onChange={(event) => form.edit({ value: event.target.value })}
            />
          </Field>
        </KinCountryFirstField>
        <Field id={ids.startsOn} label={COPY.project.startsOn} moved={moved.startsOn ?? undefined}>
          <Input
            id={ids.startsOn}
            type="date"
            value={draft.startsOn ?? ""}
            onChange={(event) =>
              form.edit({ startsOn: event.target.value === "" ? null : event.target.value })
            }
          />
        </Field>
        {draft.billing === "retainer" || draft.renewsOn !== null ? (
          <Field
            id={ids.renewsOn}
            label={COPY.project.renewsOn}
            moved={moved.renewsOn ?? undefined}
          >
            <Input
              id={ids.renewsOn}
              type="date"
              value={draft.renewsOn ?? ""}
              onChange={(event) =>
                form.edit({ renewsOn: event.target.value === "" ? null : event.target.value })
              }
            />
          </Field>
        ) : null}
      </div>
      {editing === null && props.directory !== undefined ? (
        <div className="flex flex-col gap-1.5">
          <Label>{KIN_PROJECT_PEOPLE.choose}</Label>
          <p className="text-xs text-muted-foreground">
            {draft.private ? KIN_PROJECT_PEOPLE.privateDetail : KIN_PROJECT_PEOPLE.detail}
          </p>
          <div className="max-h-64 overflow-y-auto rounded-md border border-border p-1">
            <KinProjectPeoplePicker
              people={props.directory.people}
              names={props.directory.names}
              on={[]}
              picked={members}
              disabled={state.saving}
              onChange={pick}
            />
          </div>
        </div>
      ) : null}
      <PrivateSwitch
        label={KIN_MARKETING.campaign}
        note={KIN_MARKETING.campaignHint}
        checked={draft.campaign}
        disabled={state.saving}
        onChange={(campaign) => form.edit({ campaign })}
      />
      {draft.campaign ? (
        <Field
          id={ids.audience}
          label={KIN_MARKETING.audience}
          hint={KIN_MARKETING.audienceHint}
          moved={moved.audience}
        >
          <Input
            id={ids.audience}
            list={`${ids.audience}-tags`}
            value={draft.audience}
            maxLength={60}
            placeholder={KIN_MARKETING.audiencePlaceholder}
            autoComplete="off"
            onChange={(event) => form.edit({ audience: event.target.value })}
          />
          <datalist id={`${ids.audience}-tags`}>
            {marketing.tags.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </Field>
      ) : null}
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

/** A milestone on a project: a name and the day it is due. Its tasks are given to it in chat. */
export function KinMilestoneDialog(
  props: KinWorkTarget & {
    readonly project: KinRecordKey;
    readonly onSaved: (key: KinRecordKey) => void;
    readonly onOpenExisting: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId } = props;
  const create = useAtomCommand(kinClient.workCreate, { reportFailure: false });
  const [requestId] = useState(randomUUID);
  const [name, setName] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const ids = { name: useId(), due: useId() };
  const save = async () => {
    if (saving || name.trim() === "") return;
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
            ...(due === "" ? {} : { dueAt: due, dueAllDay: true }),
            clientRequestId: requestId,
          },
        }),
      noun: "project",
      name: name.trim(),
      own: null,
    });
    setSaving(false);
    if (outcome.ok) props.onSaved(outcome.value.key);
    else setProblem(outcome.problem);
  };
  return (
    <FormShell
      title={KIN_PROJECTS.addMilestone}
      submit={KIN_PROJECTS.addMilestone}
      saving={saving}
      canSave={name.trim() !== ""}
      problem={problem}
      onOpenExisting={props.onOpenExisting}
      onSave={() => void save()}
      onClose={props.onClose}
    >
      <Field id={ids.name} label={COPY.project.name}>
        <Input
          id={ids.name}
          value={name}
          maxLength={KIN_WORK_FORM_LIMITS.name}
          autoComplete="off"
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field id={ids.due} label="Due">
        <Input
          id={ids.due}
          type="date"
          value={due}
          onChange={(event) => setDue(event.target.value)}
        />
      </Field>
    </FormShell>
  );
}
