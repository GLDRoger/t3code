import { useAtomValue } from "@effect/atom-react";
import {
  KIN_FIELD_FILES_MAX,
  KIN_LISTS,
  kinAmountCheck,
  kinFieldCheck,
  kinListEntryView,
  kinPaymentCheck,
  type KinListEntryView,
  type KinListFieldView,
  type KinPaymentDraft,
} from "@t3tools/client-runtime/kin/kinLists";
import {
  kinWorkDayOf,
  kinWorkDueChoices,
  type KinWorkItemView,
} from "@t3tools/client-runtime/kin/kinWork";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinFieldValue, KinFileRef, KinRecordDetail, KinRecordKey } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  CheckIcon,
  ChevronDownIcon,
  FileIcon,
  MessageSquareIcon,
  PlusIcon,
  RepeatIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { useAssetUrls } from "../assets/assetUrls";
import {
  ExpandedImageDialogHost,
  openExpandedImagePreview,
} from "../components/chat/ExpandedImageDialog";
import { AttachmentImage } from "../components/media/AttachmentImage";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Calendar } from "../components/ui/calendar";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../components/ui/menu";
import { SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { cn, randomUUID } from "../lib/utils";
import { KinEntryFilePicker, KinEntryPick, KinEntryText } from "./KinWorkEntryEdit";
import { KinWorkPrivateMark, KinWorkSection as Section } from "./KinWorkParts";
import { KinWorkStateIcon } from "./KinWorkStateIcon";
import { kinClient } from "./kinClient";
import {
  kinListsOf,
  useKinAskAgent,
  useKinEntryChanges,
  useKinListContext,
  useKinLists,
} from "./useKinMoney";
import { kinWorkChoicesAtom, type KinWorkDirectory, type KinWorkTarget } from "./useKinWork";

const isImage = (file: KinFileRef) => file.mimeType.startsWith("image/");

/** An entry's files: a photo opens large, anything else downloads. */
function EntryFiles(
  props: KinWorkTarget & {
    readonly files: ReadonlyArray<KinFileRef>;
    readonly previewKey: string;
    /** Takes the file off the entry; the file itself stays in its chat. */
    readonly onRemove?: ((file: KinFileRef) => void) | undefined;
  },
) {
  const { files } = props;
  const urls = useAssetUrls(
    props.environmentId,
    files.map((file) => ({
      _tag: "attachment" as const,
      attachmentId: file.attachmentId,
      fileName: file.name,
      mimeType: file.mimeType,
    })),
  );
  const images = files.flatMap((file, index) => {
    const src = urls[index];
    return isImage(file) && src != null
      ? [{ id: file.attachmentId, src, name: file.name, mimeType: file.mimeType }]
      : [];
  });
  return (
    <ul className="flex flex-wrap gap-2">
      {files.map((file, index) => {
        const src = urls[index] ?? null;
        const at = images.findIndex((image) => image.id === file.attachmentId);
        return (
          <li key={file.attachmentId} className="relative min-w-0">
            {props.onRemove === undefined ? null : (
              <div className="absolute -end-2 -top-2 z-10">
                <Button
                  size="icon-xs"
                  variant="outline"
                  aria-label={`${KIN_LISTS.entry.removeFile} ${file.name}`}
                  onClick={() => props.onRemove?.(file)}
                >
                  <XIcon />
                </Button>
              </div>
            )}
            {isImage(file) && src !== null ? (
              <button
                type="button"
                aria-label={`Open ${file.name}`}
                onClick={() =>
                  openExpandedImagePreview(props.previewKey, {
                    images: images.map(({ id: _id, ...image }) => image),
                    index: Math.max(at, 0),
                  })
                }
                className="block size-24 cursor-zoom-in overflow-hidden rounded-lg border border-border/80 outline-none ring-ring focus-visible:ring-2 focus-visible:ring-inset"
              >
                <AttachmentImage
                  name={file.name}
                  mimeType={file.mimeType}
                  src={src}
                  alt={file.name}
                  decoding="async"
                  className="block size-full object-cover"
                />
              </button>
            ) : (
              <a
                {...(src === null ? {} : { href: src, download: file.name })}
                aria-disabled={src === null}
                className="flex max-w-56 items-center gap-2 rounded-md border border-border/80 px-2 py-1.5 text-sm text-foreground outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
              >
                <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{file.name}</span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One of the entry's two dates as its own control: the days people pick, any other day, or none. */
function DayMenu(props: {
  readonly label: string;
  readonly text: string | null;
  readonly day: string | null;
  readonly now: Date;
  readonly disabled: boolean;
  readonly onPick: (day: string | null) => void;
}) {
  const picked = props.day === null ? undefined : new Date(`${props.day}T00:00:00`);
  const shown = props.text ?? KIN_LISTS.entry.noDate;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled}
            aria-label={`${props.label}: ${shown}. Change`}
          />
        }
      >
        {shown}
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        {kinWorkDueChoices(props.now).map((choice) => (
          <MenuItem
            key={choice.day}
            disabled={choice.day === props.day}
            onClick={() => props.onPick(choice.day)}
          >
            {choice.label}
          </MenuItem>
        ))}
        <MenuSub>
          <MenuSubTrigger>{KIN_WORK_COPY.pickDate}</MenuSubTrigger>
          <MenuSubPopup>
            <Calendar
              mode="single"
              selected={picked}
              defaultMonth={picked ?? props.now}
              onSelect={(date) => {
                if (date !== undefined) props.onPick(kinWorkDayOf(date));
              }}
            />
          </MenuSubPopup>
        </MenuSub>
        {props.text === null ? null : (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => props.onPick(null)}>{KIN_LISTS.entry.noDate}</MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

/** Money that came in against the entry: how much, when, and a word about how. */
function PaymentForm(props: {
  readonly entry: KinListEntryView;
  readonly today: string;
  readonly busy: boolean;
  readonly onSave: (draft: KinPaymentDraft) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const left = props.entry.balance?.left ?? null;
  const [draft, setDraft] = useState<KinPaymentDraft>({
    amount: "",
    paidOn: props.today,
    note: "",
  });
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { amount: useId(), day: useId(), note: useId() };
  if (left === null) return null;
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const checked = kinPaymentCheck(draft, left);
        if (!checked.ok) return setProblem(checked.problem);
        setProblem(null);
        void props.onSave(draft).then((saved) => {
          if (saved) props.onCancel();
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.amount}>{KIN_LISTS.entry.payAmount}</Label>
          <Input
            id={ids.amount}
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            placeholder={props.entry.balance?.leftText}
            value={draft.amount}
            onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.day}>{KIN_LISTS.entry.payDay}</Label>
          <Input
            id={ids.day}
            type="date"
            max={props.today}
            value={draft.paidOn}
            onChange={(event) => setDraft({ ...draft, paidOn: event.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.note}>{KIN_LISTS.entry.payNote}</Label>
        <Input
          id={ids.note}
          maxLength={500}
          autoComplete="off"
          placeholder={KIN_LISTS.entry.payNotePlaceholder}
          value={draft.note}
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        />
      </div>
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          {KIN_WORK_COPY.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={props.busy} aria-busy={props.busy}>
          {KIN_LISTS.entry.paySave}
        </Button>
      </div>
    </form>
  );
}

type Choice = { readonly value: string; readonly label: string };
type Ref = { readonly recordId: string; readonly key: KinRecordKey; readonly name: string };

/** One of the list's own details with the control its type calls for, saved as it is changed. */
function FieldEdit(
  props: KinWorkTarget & {
    readonly field: KinListFieldView;
    readonly currency: string;
    readonly busy: boolean;
    readonly now: Date;
    readonly previewKey: string;
    readonly people: ReadonlyArray<Choice>;
    readonly clients: ReadonlyArray<Ref>;
    readonly projects: ReadonlyArray<Ref>;
    readonly onSet: (value: KinFieldValue | null) => Promise<boolean>;
    readonly onEdit: (value: KinFieldValue | null) => Promise<string | null>;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onOpenProject: (key: KinRecordKey) => void;
  },
) {
  const { field, busy } = props;
  const [picking, setPicking] = useState(false);
  const current = typeof field.value === "string" ? field.value : null;
  switch (field.type) {
    case "text":
    case "money":
      return (
        <KinEntryText
          label={field.label}
          shown={field.text}
          draft={field.draft}
          numeric={field.type === "money"}
          {...(field.type === "money" ? { placeholder: KIN_LISTS.entry.amountPlaceholder } : {})}
          disabled={busy}
          onSave={async (text) => {
            const checked = kinFieldCheck(field, text, props.currency);
            return checked.ok ? props.onEdit(checked.value) : checked.problem;
          }}
        />
      );
    case "date":
      return (
        <DayMenu
          label={field.label}
          text={field.text}
          day={current}
          now={props.now}
          disabled={busy}
          onPick={(day) => void props.onSet(day)}
        />
      );
    case "choice":
    case "person":
      return (
        <KinEntryPick
          label={field.label}
          shown={field.text}
          current={current}
          disabled={busy}
          choices={
            field.type === "person"
              ? props.people
              : field.choices.map((choice) => ({ value: choice, label: choice }))
          }
          onPick={(value) => void props.onSet(value)}
        />
      );
    case "link": {
      const { opens } = field;
      return (
        <div className="flex flex-wrap items-center gap-1">
          <KinEntryPick
            label={field.label}
            shown={field.text}
            current={current}
            disabled={busy}
            choices={(field.link === "projects" ? props.projects : props.clients).map((row) => ({
              value: row.recordId,
              label: row.name,
            }))}
            onPick={(value) => void props.onSet(value)}
          />
          {opens === null ? null : (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                opens.list === "projects"
                  ? props.onOpenProject(opens.key)
                  : props.onOpenClient(opens.key)
              }
            >
              Open
            </Button>
          )}
        </div>
      );
    }
    case "file": {
      const ids = field.files.map((file) => file.attachmentId);
      return (
        <>
          {field.files.length === 0 ? null : (
            <EntryFiles
              {...props}
              files={field.files}
              onRemove={(file) =>
                void props.onSet(
                  ids.length === 1 ? null : ids.filter((id) => id !== file.attachmentId),
                )
              }
            />
          )}
          {ids.length >= KIN_FIELD_FILES_MAX ? null : (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => setPicking(true)}>
              <PlusIcon />
              {KIN_LISTS.entry.addFile}
            </Button>
          )}
          {picking ? (
            <KinEntryFilePicker
              environmentId={props.environmentId}
              orgId={props.orgId}
              label={field.label}
              held={ids}
              onClose={() => setPicking(false)}
              onPick={(file) => {
                setPicking(false);
                void props.onSet([...ids, file.attachmentId]);
              }}
            />
          ) : null}
        </>
      );
    }
  }
}

/**
 * An entry of any list beside the page: every field by its type, its files, what repeats, and
 * for an entry that takes payments, what came in and what is left. The quick taps are here;
 * anything else is a message to an agent.
 */
export function KinListEntry(
  props: KinWorkTarget & {
    readonly item: KinRecordDetail;
    /** The same entry as a task reads it: its notes, links, history and privacy. */
    readonly view: KinWorkItemView;
    readonly directory: KinWorkDirectory;
    readonly now: Date;
    readonly links: React.ReactNode;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onOpenProject: (key: KinRecordKey) => void;
  },
) {
  const { item, view, environmentId } = props;
  const lists = useKinLists(props, { enabled: true, archived: true, seq: null });
  const context = useKinListContext(props, props.directory);
  const def = kinListsOf(lists).find((one) => one.list === item.list) ?? null;
  const entry = kinListEntryView(item, def, context);
  const changes = useKinEntryChanges(props, item.key);
  const agent = useKinAskAgent(props);
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId));
  const canPay = useAtomValue(kinClient.workPaymentRecord.permissionAtom(environmentId));
  const [paying, setPaying] = useState(false);
  const [takingBack, setTakingBack] = useState<string | null>(null);
  const today = kinWorkDayOf(props.now);
  const previewKey = `kin-entry:${environmentId}:${item.key}`;
  const { busy } = changes;
  const pay = (draft: KinPaymentDraft) => {
    const checked = entry.balance === null ? null : kinPaymentCheck(draft, entry.balance.left);
    if (checked === null || !checked.ok) return Promise.resolve(false);
    return changes.pay({
      amount: checked.amount,
      paidOn: draft.paidOn,
      ...(draft.note.trim() === "" ? {} : { note: draft.note.trim() }),
      clientRequestId: randomUUID(),
    });
  };
  const { finish, amountEdit } = entry;
  const held = Option.getOrNull(AsyncResult.value(useAtomValue(kinWorkChoicesAtom(props))));
  const clients = held?.clients ?? [];
  const projects = held?.projects ?? [];
  const { names } = props.directory;
  const people = [
    ...[...names.people].map(([id, name]) => ({ value: `person:${id}`, label: name })),
    ...[...names.agents]
      .filter(([id]) => names.retired?.has(id) !== true)
      .map(([id, name]) => ({ value: `agent:${id}`, label: name })),
  ];
  const open = (fact: KinListEntryView["facts"][number]) =>
    fact.opens === null
      ? null
      : fact.id === "project"
        ? () => props.onOpenProject(fact.opens!)
        : () => props.onOpenClient(fact.opens!);
  return (
    <>
      <SheetHeader>
        <div className="flex flex-col gap-1 pe-8">
          <SheetDescription>{entry.heading}</SheetDescription>
          <SheetTitle>{item.title}</SheetTitle>
        </div>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
        <div className="flex flex-col gap-3">
          {amountEdit !== null && canChange ? (
            <div>
              <KinEntryText
                headline
                numeric
                label={KIN_LISTS.entry.amount}
                shown={entry.amount}
                draft={amountEdit.draft}
                placeholder={KIN_LISTS.entry.amountPlaceholder}
                disabled={busy}
                onSave={async (text) => {
                  const checked = kinAmountCheck(text, amountEdit.currency, amountEdit.received);
                  return checked.ok
                    ? changes.edit(item.rev, { amount: checked.value })
                    : checked.problem;
                }}
              />
            </div>
          ) : entry.amount === null ? null : (
            <p className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">
              {entry.amount}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <KinWorkStateIcon state={entry.state} />
            <span>{entry.stateLabel}</span>
            {entry.late ? (
              <Badge size="sm" variant="error">
                {KIN_LISTS.late}
              </Badge>
            ) : null}
            {busy ? (
              <span role="status" className="text-xs text-muted-foreground">
                {KIN_WORK_COPY.saving}
              </span>
            ) : null}
          </div>
          {entry.balance === null ? null : (
            <dl className="grid grid-cols-2 gap-x-6 text-sm">
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">{KIN_LISTS.entry.left}</dt>
                <dd className="text-foreground tabular-nums">
                  {entry.balance.settled ? KIN_LISTS.entry.paidInFull : entry.balance.leftText}
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">{KIN_LISTS.entry.received}</dt>
                <dd className="text-foreground tabular-nums">{entry.balance.receivedText}</dd>
              </div>
            </dl>
          )}
          {!canChange ? null : (
            <div className="flex flex-wrap items-center gap-2">
              {finish === null ? null : (
                <Button
                  size="sm"
                  disabled={busy || (finish.pays !== null && !canPay)}
                  onClick={() =>
                    void (finish.pays === null
                      ? changes.update(item.rev, { state: "done" })
                      : changes.pay({
                          amount: finish.pays,
                          paidOn: today,
                          clientRequestId: randomUUID(),
                        }))
                  }
                >
                  <CheckIcon />
                  {finish.label}
                </Button>
              )}
              {finish?.pays == null || !canPay || paying ? null : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setPaying(true)}>
                  {KIN_LISTS.entry.recordPayment}
                </Button>
              )}
              <Menu>
                <MenuTrigger render={<Button size="sm" variant="outline" disabled={busy} />}>
                  {KIN_LISTS.entry.status}
                  <ChevronDownIcon />
                </MenuTrigger>
                <MenuPopup align="start">
                  {entry.states.map((choice) => (
                    <MenuItem
                      key={choice.state}
                      disabled={choice.current}
                      onClick={() => void changes.update(item.rev, { state: choice.state })}
                    >
                      <KinWorkStateIcon state={choice.state} />
                      {choice.label}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            </div>
          )}
          {paying ? (
            <PaymentForm
              entry={entry}
              today={today}
              busy={busy}
              onSave={pay}
              onCancel={() => setPaying(false)}
            />
          ) : null}
          {changes.problem === null ? null : (
            <Alert variant="error">
              <AlertDescription>{changes.problem}</AlertDescription>
            </Alert>
          )}
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
            {entry.dateLabel === null ? null : (
              <>
                <dt className="text-muted-foreground">{entry.dateLabel}</dt>
                <dd className="flex min-w-0 items-center text-foreground">
                  {canChange ? (
                    <DayMenu
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
                    (entry.date ?? KIN_LISTS.entry.noDate)
                  )}
                </dd>
              </>
            )}
            {entry.dueLabel === null ? null : (
              <>
                <dt className="text-muted-foreground">{entry.dueLabel}</dt>
                <dd className="flex min-w-0 items-center text-foreground">
                  {canChange && !entry.closed ? (
                    <DayMenu
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
                    (entry.due ?? KIN_LISTS.entry.noDate)
                  )}
                </dd>
              </>
            )}
            {entry.facts.map((fact) => {
              const opens = open(fact);
              const picks = canChange && fact.id !== "owner";
              if (!picks && fact.value === null) return null;
              return (
                <div key={fact.id} className="contents">
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd className="flex min-w-0 flex-wrap items-center gap-1 text-foreground">
                    {picks ? (
                      <KinEntryPick
                        label={fact.label}
                        shown={fact.value}
                        current={fact.current}
                        disabled={busy}
                        choices={
                          fact.id === "category"
                            ? fact.choices
                            : (fact.id === "project" ? projects : clients).map((row) => ({
                                value: row.key,
                                label: row.name,
                              }))
                        }
                        onPick={(value) =>
                          void changes.update(
                            item.rev,
                            fact.id === "category"
                              ? { listCategory: value as never }
                              : fact.id === "project"
                                ? { project: value }
                                : { party: value },
                          )
                        }
                      />
                    ) : opens === null ? (
                      <span className="truncate">{fact.value}</span>
                    ) : null}
                    {opens === null ? null : (
                      <Button size="xs" variant="ghost" onClick={opens}>
                        {picks ? "Open" : fact.value}
                      </Button>
                    )}
                  </dd>
                </div>
              );
            })}
            {entry.repeat === null ? null : (
              <>
                <dt className="text-muted-foreground">{KIN_LISTS.entry.repeats}</dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-2 text-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <RepeatIcon aria-hidden className="size-3.5 text-muted-foreground" />
                    {entry.repeat}
                  </span>
                  {canChange ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void changes.update(item.rev, { repeat: null })}
                    >
                      {KIN_LISTS.entry.stopRepeat}
                    </Button>
                  ) : null}
                </dd>
              </>
            )}
            {entry.fields.map((field) => (
              <div key={field.key} className="contents">
                <dt className="flex items-center gap-1.5 self-start pt-0.5 text-muted-foreground">
                  {field.label}
                  {field.private ? <KinWorkPrivateMark /> : null}
                </dt>
                <dd className="flex min-w-0 flex-col items-start gap-1.5 text-foreground">
                  {canChange && !field.retired ? (
                    <FieldEdit
                      {...props}
                      field={field}
                      currency={amountEdit?.currency ?? def?.currency ?? "INR"}
                      busy={busy}
                      previewKey={previewKey}
                      people={people}
                      clients={clients}
                      projects={projects}
                      onSet={(value) =>
                        changes.update(item.rev, { fields: { [field.key]: value } })
                      }
                      onEdit={(value) => changes.edit(item.rev, { fields: { [field.key]: value } })}
                    />
                  ) : field.files.length > 0 ? (
                    <EntryFiles {...props} files={field.files} previewKey={previewKey} />
                  ) : field.opens !== null ? (
                    <div>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          field.opens?.list === "projects"
                            ? props.onOpenProject(field.opens.key)
                            : field.opens === null
                              ? undefined
                              : props.onOpenClient(field.opens.key)
                        }
                      >
                        {field.text}
                      </Button>
                    </div>
                  ) : (
                    <span
                      className={cn(
                        "whitespace-pre-wrap",
                        field.text === null && "text-muted-foreground",
                      )}
                    >
                      {field.text ?? "–"}
                    </span>
                  )}
                  {field.retired ? (
                    <span className="text-xs text-muted-foreground">
                      {KIN_LISTS.entry.retiredField}
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          {view.privacy.private ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <KinWorkPrivateMark />
              {KIN_LISTS.entry.private}
            </p>
          ) : null}
        </div>
        {entry.otherFiles.length === 0 ? null : (
          <Section title={KIN_LISTS.entry.files}>
            <EntryFiles {...props} files={entry.otherFiles} previewKey={previewKey} />
          </Section>
        )}
        {entry.balance === null ? null : (
          <Section title={KIN_LISTS.entry.payments}>
            {entry.payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">{KIN_LISTS.entry.noPayments}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {entry.payments.map((payment) => (
                  <li key={payment.paymentId} className="flex items-start gap-3 text-sm">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cn(
                          "tabular-nums",
                          payment.voided ? "text-muted-foreground line-through" : "text-foreground",
                        )}
                      >
                        {payment.amount}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {[
                          payment.when,
                          payment.note,
                          payment.voided ? KIN_LISTS.entry.takenBack : null,
                        ]
                          .filter((part) => part !== null)
                          .join(" · ")}
                      </span>
                    </span>
                    {payment.voided || !canPay ? null : (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`${KIN_LISTS.entry.takeBack}: ${payment.amount}`}
                        onClick={() => setTakingBack(payment.paymentId)}
                      >
                        {KIN_LISTS.entry.takeBack}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
        {view.notes === null ? null : (
          <Section title={KIN_LISTS.entry.notes}>
            <p className="whitespace-pre-wrap text-sm text-foreground">{view.notes}</p>
          </Section>
        )}
        {props.links}
        <Section title={KIN_LISTS.entry.history}>
          <ol className="flex flex-col gap-1.5">
            {view.history.map((line) => (
              <li key={line.key} className="flex gap-3 text-sm">
                <span className="w-14 shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">
                  {line.when}
                </span>
                <span className="min-w-0 flex-1 text-foreground">{line.text}</span>
              </li>
            ))}
          </ol>
          {view.historyNote === null ? null : (
            <p className="text-xs text-muted-foreground">{view.historyNote}</p>
          )}
        </Section>
        {agent === null ? null : (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => agent.ask(`About ${item.key} (${item.title}): `)}
            >
              <MessageSquareIcon />
              {KIN_LISTS.entry.askChange}
            </Button>
          </div>
        )}
      </div>
      <ExpandedImageDialogHost threadKey={previewKey} />
      <AlertDialog
        open={takingBack !== null}
        onOpenChange={(next) => {
          if (!next) setTakingBack(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{KIN_LISTS.entry.takeBackTitle}</AlertDialogTitle>
            <AlertDialogDescription>{KIN_LISTS.entry.takeBackDetail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {KIN_WORK_COPY.cancel}
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const paymentId = takingBack;
                setTakingBack(null);
                if (paymentId !== null) void changes.takeBack(paymentId);
              }}
            >
              {KIN_LISTS.entry.takeBack}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
