import {
  KIN_WORK_ASSIGN,
  KIN_WORK_NEW_COPY,
  KIN_WORK_NOTES_MAX,
  createKinWorkActions,
  KIN_WORK_REPEAT,
  kinRepeatText,
  kinSameRepeat,
  kinWorkAssignees,
  kinWorkDayOf,
  kinWorkDraftCheck,
  kinWorkDraftHint,
  kinWorkDraftWords,
  kinWorkPrincipalKey,
  kinWorkTitleCount,
  kinWorkTitleTooLong,
  type KinWorkDraft,
  type KinWorkRef,
} from "@t3tools/client-runtime/kin/kinWork";
import { useAtomValue } from "@effect/atom-react";
import { kinAccessMeAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinNewTaskChoices } from "@t3tools/client-runtime/kin/kinWorkClients";
import { KIN_PICKER_COPY, kinPickerSearchView } from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinRecordKey } from "@t3tools/contracts";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
} from "../components/ui/combobox";
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
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { randomUUID } from "../lib/utils";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import {
  useKinPickerSearch,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

const NONE = "none";

/**
 * A client or a project to put the task under, or neither, found by typing part of its name: the
 * first page shows at once, and typing asks the host about every one the person may see.
 */
function PlaceCombobox(props: {
  readonly target: KinWorkTarget;
  readonly noun: "client" | "project";
  readonly label: string;
  readonly value: KinWorkRef | null;
  readonly choices: ReadonlyArray<KinWorkRef>;
  readonly onChange: (value: KinWorkRef | null) => void;
}) {
  const id = useId();
  const search = useKinPickerSearch(
    props.target,
    props.noun === "client" ? "clients" : "projects",
    false,
  );
  const view = kinPickerSearchView({
    noun: props.noun,
    search: search.state,
    loaded: { open: props.choices, done: [] },
    held: props.value,
  });
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{props.label}</Label>
      <Combobox
        items={view.open}
        filteredItems={view.open}
        filter={null}
        value={props.value}
        autoHighlight
        itemToStringLabel={(choice: KinWorkRef) => choice.title}
        isItemEqualToValue={(a: KinWorkRef, b: KinWorkRef) => a.key === b.key}
        onInputValueChange={(text, details) => {
          if (details.reason === "input-change" || details.reason === "input-clear")
            search.type(text);
        }}
        onOpenChange={(open) => {
          if (!open) search.type("");
        }}
        onValueChange={(choice: KinWorkRef | null) => {
          search.type("");
          props.onChange(choice);
        }}
      >
        <ComboboxInput
          id={id}
          aria-label={props.label}
          placeholder={KIN_WORK_NEW_COPY.none}
          showClear={props.value !== null}
        />
        <ComboboxPopup>
          <ComboboxEmpty>
            {view.failure !== null
              ? null
              : view.loading
                ? KIN_PICKER_COPY.searching
                : (view.note ?? KIN_WORK_NEW_COPY.noMatch)}
          </ComboboxEmpty>
          <ComboboxList>
            {(choice: KinWorkRef) => (
              <ComboboxItem key={choice.key} value={choice} title={choice.title}>
                <span className="min-w-0 flex-1 truncate">{choice.title}</span>
              </ComboboxItem>
            )}
          </ComboboxList>
          {view.failure !== null ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              {view.failure.text}
              {!view.failure.retry ? null : (
                <Button size="xs" variant="outline" onClick={() => void search.retry()}>
                  {KIN_RETRY}
                </Button>
              )}
            </div>
          ) : (
            <ComboboxStatus>
              {view.open.length === 0 ? null : view.loading ? KIN_PICKER_COPY.searching : view.note}
            </ComboboxStatus>
          )}
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}

/** A short form: what, who and when. Anything longer is better said to a lead in chat. */
export function KinWorkNewDialog(
  props: KinWorkTarget & {
    readonly directory: KinWorkDirectory;
    /** The clients and projects it can go under; null on a host without them. */
    readonly choices: KinWorkChoices | null;
    /** Where the form starts: blank, or already about a client or a project. */
    readonly start: KinWorkDraft;
    readonly onAdded: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId } = props;
  const { orgs, people, joined, invited, names } = props.directory;
  const create = useAtomCommand(kinClient.workCreate, { reportFailure: false });
  const assign = useAtomCommand(kinClient.workAssign, { reportFailure: false });
  const [actions] = useState(() =>
    createKinWorkActions({
      orgId,
      create: (input) => create({ environmentId, input }),
      assign: (input) => assign({ environmentId, input }),
      reread: () => undefined,
    }),
  );
  // One id for the form's life: trying again after a dropped answer never adds a second task.
  const [requestId] = useState(randomUUID);
  const [today] = useState(() => kinWorkDayOf(new Date()));
  const [draft, setDraft] = useState<KinWorkDraft>(props.start);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const titleId = useId();
  const titleCountId = useId();
  const dueId = useId();
  const notesId = useId();
  const assignees = kinWorkAssignees({
    orgs,
    orgId,
    people,
    joined,
    invited,
    names,
    current: null,
  });
  const everyone = [...assignees.people, ...assignees.leads];
  const mine = assignees.people[0]?.key ?? "";
  const ownerKey = draft.owner === null ? mine : kinWorkPrincipalKey(draft.owner);
  const checked = kinWorkDraftCheck(draft);
  const hint = kinWorkDraftHint(draft, names);
  const words = kinWorkDraftWords(draft);
  const titleCount = kinWorkTitleCount(draft.title);
  const me = useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId));
  const choices = props.choices === null ? null : kinNewTaskChoices(props.choices, me);

  const save = async () => {
    if (busy) return;
    if (!checked.ok) return setProblem(checked.problem);
    setBusy(true);
    setProblem(null);
    const outcome = await actions.add(checked.input, requestId);
    setBusy(false);
    if (outcome.ok) props.onAdded(outcome.item.key);
    else setProblem(outcome.problem);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{words.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={titleId}>{words.titleLabel}</Label>
                <Input
                  id={titleId}
                  value={draft.title}
                  placeholder={words.titlePlaceholder}
                  autoComplete="off"
                  autoFocus
                  aria-describedby={titleCount === null ? undefined : titleCountId}
                  aria-invalid={kinWorkTitleTooLong(draft.title) || undefined}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
                {titleCount === null ? null : (
                  <p
                    id={titleCountId}
                    className={
                      kinWorkTitleTooLong(draft.title)
                        ? "text-xs text-destructive-foreground tabular-nums"
                        : "text-xs text-muted-foreground tabular-nums"
                    }
                  >
                    {titleCount}
                  </p>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label>{KIN_WORK_NEW_COPY.ownerLabel}</Label>
                  <Select
                    value={ownerKey}
                    onValueChange={(value) => {
                      const picked = everyone.find((row) => row.key === value);
                      if (picked === undefined) return;
                      setDraft({
                        ...draft,
                        owner: picked.key === mine ? null : picked.principal,
                      });
                    }}
                  >
                    <SelectTrigger
                      className="w-full min-w-0"
                      aria-label={KIN_WORK_NEW_COPY.ownerLabel}
                    >
                      <SelectValue>
                        {everyone.find((row) => row.key === ownerKey)?.name ?? "You"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {assignees.people.length === 0 ? null : (
                        <SelectGroup>
                          <SelectGroupLabel>{KIN_WORK_ASSIGN.people}</SelectGroupLabel>
                          {assignees.people.map((row) => (
                            <SelectItem key={row.key} value={row.key} disabled={row.invited}>
                              {row.invited ? `${row.name}, invited` : row.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      {assignees.leads.length === 0 ? null : (
                        <SelectGroup>
                          <SelectGroupLabel>{KIN_WORK_ASSIGN.leads}</SelectGroupLabel>
                          {assignees.leads.map((row) => (
                            <SelectItem key={row.key} value={row.key}>
                              {row.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={dueId}>{KIN_WORK_NEW_COPY.dueLabel}</Label>
                  <Input
                    id={dueId}
                    type="date"
                    min={today}
                    value={draft.due ?? ""}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        due: event.target.value === "" ? null : event.target.value,
                      })
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>{KIN_WORK_REPEAT.label}</Label>
                  <Select
                    value={
                      KIN_WORK_REPEAT.choices.find((choice) =>
                        kinSameRepeat(choice.rule, draft.repeat),
                      )?.label ?? NONE
                    }
                    onValueChange={(value) =>
                      setDraft({
                        ...draft,
                        repeat:
                          KIN_WORK_REPEAT.choices.find((choice) => choice.label === value)?.rule ??
                          null,
                      })
                    }
                  >
                    <SelectTrigger className="w-full min-w-0" aria-label={KIN_WORK_REPEAT.label}>
                      <SelectValue>
                        {draft.repeat === null
                          ? KIN_WORK_REPEAT.never
                          : kinRepeatText(draft.repeat)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      <SelectItem value={NONE}>{KIN_WORK_REPEAT.never}</SelectItem>
                      {KIN_WORK_REPEAT.choices.map((choice) => (
                        <SelectItem key={choice.label} value={choice.label}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
              {draft.repeat === null || problem !== null ? null : (
                <p className="text-xs text-muted-foreground">
                  {draft.due === null ? KIN_WORK_REPEAT.needsDue : KIN_WORK_REPEAT.note}
                </p>
              )}
              {hint === null ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
              {choices === null ? null : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {choices.clients.length === 0 && draft.party === null ? null : (
                    <PlaceCombobox
                      target={{ environmentId, orgId }}
                      noun="client"
                      label={KIN_WORK_NEW_COPY.clientLabel}
                      value={draft.party}
                      choices={choices.clients}
                      onChange={(party) => setDraft({ ...draft, party })}
                    />
                  )}
                  {choices.projects.length === 0 && draft.project === null ? null : (
                    <PlaceCombobox
                      target={{ environmentId, orgId }}
                      noun="project"
                      label={KIN_WORK_NEW_COPY.projectLabel}
                      value={draft.project}
                      choices={choices.projects}
                      onChange={(project) => setDraft({ ...draft, project })}
                    />
                  )}
                </div>
              )}
              {choices === null || draft.party === null ? null : (
                <div className="flex flex-col gap-1.5">
                  <Label>{KIN_WORK_NEW_COPY.sideLabel}</Label>
                  <ToggleGroup
                    aria-label={KIN_WORK_NEW_COPY.sideLabel}
                    value={draft.side === null ? [] : [draft.side]}
                    onValueChange={(value) => {
                      // Neither pressed is a plain task about the client, not an obligation.
                      const side = value[0];
                      setDraft({
                        ...draft,
                        side: side === "ours" || side === "theirs" ? side : null,
                      });
                    }}
                  >
                    <Toggle value="ours">{KIN_WORK_NEW_COPY.sideOurs}</Toggle>
                    <Toggle value="theirs">{KIN_WORK_NEW_COPY.sideTheirs}</Toggle>
                  </ToggleGroup>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={notesId}>{KIN_WORK_NEW_COPY.notesLabel}</Label>
                <Textarea
                  id={notesId}
                  rows={3}
                  value={draft.notes}
                  maxLength={KIN_WORK_NOTES_MAX}
                  placeholder={KIN_WORK_NEW_COPY.notesPlaceholder}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </div>
              {problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={draft.title.trim() === "" || busy} aria-busy={busy}>
              {KIN_WORK_NEW_COPY.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
