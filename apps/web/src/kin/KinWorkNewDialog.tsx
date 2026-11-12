import {
  KIN_WORK_ASSIGN,
  KIN_WORK_NEW_COPY,
  KIN_WORK_NOTES_MAX,
  KIN_WORK_TITLE_MAX,
  createKinWorkActions,
  kinWorkAssignees,
  kinWorkDayOf,
  kinWorkDraftCheck,
  kinWorkDraftHint,
  kinWorkDraftWords,
  kinWorkPrincipalKey,
  type KinWorkDraft,
  type KinWorkRef,
} from "@t3tools/client-runtime/kin/kinWork";
import type { KinRecordKey } from "@t3tools/contracts";
import { useId, useState } from "react";

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
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import type { KinWorkChoices, KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const NONE = "none";

/** A client or a project to put the task under, or neither. */
function PlaceSelect(props: {
  readonly label: string;
  readonly value: KinWorkRef | null;
  readonly choices: ReadonlyArray<KinWorkRef>;
  readonly onChange: (value: KinWorkRef | null) => void;
}) {
  // What the form opened about stays pickable whatever the list of choices holds.
  const choices =
    props.value === null || props.choices.some((choice) => choice.key === props.value?.key)
      ? props.choices
      : [props.value, ...props.choices];
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{props.label}</Label>
      <Select
        value={props.value?.key ?? NONE}
        onValueChange={(value) =>
          props.onChange(choices.find((choice) => choice.key === value) ?? null)
        }
      >
        <SelectTrigger className="w-full min-w-0" aria-label={props.label}>
          <SelectValue>{props.value?.title ?? KIN_WORK_NEW_COPY.none}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value={NONE}>{KIN_WORK_NEW_COPY.none}</SelectItem>
          {choices.map((choice) => (
            <SelectItem key={choice.key} value={choice.key}>
              {choice.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
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
  const { choices } = props;

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
                  maxLength={KIN_WORK_TITLE_MAX}
                  placeholder={words.titlePlaceholder}
                  autoComplete="off"
                  autoFocus
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
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
              </div>
              {hint === null ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
              {choices === null ? null : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <PlaceSelect
                    label={KIN_WORK_NEW_COPY.clientLabel}
                    value={draft.party}
                    choices={choices.clients}
                    onChange={(party) => setDraft({ ...draft, party })}
                  />
                  <PlaceSelect
                    label={KIN_WORK_NEW_COPY.projectLabel}
                    value={draft.project}
                    choices={choices.projects}
                    onChange={(project) => setDraft({ ...draft, project })}
                  />
                </div>
              )}
              {choices === null || draft.party === null ? null : (
                <div className="flex flex-col gap-1.5">
                  <Label>{KIN_WORK_NEW_COPY.sideLabel}</Label>
                  <ToggleGroup
                    aria-label={KIN_WORK_NEW_COPY.sideLabel}
                    value={[draft.side]}
                    onValueChange={(value) => {
                      if (value[0] === "ours" || value[0] === "theirs")
                        setDraft({ ...draft, side: value[0] });
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
