import { useKinOpensClients, useKinOwnerLevel } from "./useKinOwnerLevel";
import { KIN_DOCS } from "@t3tools/client-runtime/kin/kinDocs";
import { KIN_RETIRED_LABEL } from "@t3tools/client-runtime/kin/kinAgentRetire";
import { useAtomValue } from "@effect/atom-react";
import { kinAccessMeAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinTaskProjectsAllowed } from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_ASSIGN,
  KIN_WORK_GONE,
  KIN_WORK_HAND_BACK,
  KIN_WORK_ITEM_FAILED,
  KIN_WORK_MILESTONE,
  KIN_WORK_NEW_COPY,
  KIN_WORK_NOTES_MAX,
  KIN_WORK_REPEAT,
  KIN_WORK_STEPS,
  KIN_WORK_URGENT,
  kinSameRepeat,
  kinWorkStepProblem,
  kinWorkAssignees,
  kinWorkClientStays,
  kinWorkDayOf,
  kinWorkDueChoices,
  kinWorkItemState,
  kinWorkItemView,
  kinWorkTitleCount,
  kinWorkTitleTooLong,
  type KinWorkAssignee,
  type KinWorkItemView,
  type KinWorkLinkView,
  type KinWorkRef,
  type KinWorkStepsView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_LINKED,
  kinLinked,
  kinLinkedRest,
  type KinLinkedGroupName,
} from "@t3tools/client-runtime/kin/kinLinked";
import type { KinNotificationDestination } from "@t3tools/client-runtime/kin/kinNotificationDestination";
import {
  KIN_TASK_RECORD,
  kinBriefBy,
  kinNextStep,
  kinRecordChip,
  kinRecordHeld,
  kinTaskOrigin,
  kinTaskControls,
  kinTaskWith,
  kinTaskWithChoices,
  kinTaskWithout,
  type KinNextStepAct,
  type KinRecordWho,
} from "@t3tools/client-runtime/kin/kinTaskRecord";
import {
  KIN_WORK_COPY,
  kinWorkApplied,
  kinWorkStatusOffer,
  kinWorkEditMoved,
  kinWorkTakeLabel,
  type KinWorkAction,
  type KinWorkEdit,
  type KinWorkNotice,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_RECORD_CHANGES_CAP,
  type KinRecordDetail,
  type KinRecordKey,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import { kinTaskProjectMenu } from "@t3tools/client-runtime/kin/kinWorkForms";
import { KIN_PICKER_COPY, kinPickerSearchView } from "@t3tools/client-runtime/kin/kinWorkList";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import {
  CheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  Undo2Icon,
  ExternalLinkIcon,
  LinkIcon,
  ListChecksIcon,
  MessageSquareIcon,
  NotebookTextIcon,
  PencilIcon,
  PlayIcon,
  RepeatIcon,
  RotateCcwIcon,
  FlagIcon,
  XIcon,
} from "lucide-react";
import { useId, useState, type ComponentProps } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Calendar } from "../components/ui/calendar";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSearchInput,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../components/ui/menu";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import { Textarea } from "../components/ui/textarea";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { KinNotesVersions } from "./KinConfirm";
import {
  KinNextStepCard,
  KinRecordChip,
  KinTaskActivity,
  KinTaskLinkAdd,
  KinTaskLinkRemove,
  KinTaskNoteComposer,
  KinTaskWithLine,
} from "./KinTaskRecord";
import { KinListEntry } from "./KinWorkEntry";
import { KinWorkAudienceRow } from "./KinWorkShareRow";
import { KinWorkRow } from "./KinWorkTasks";
import { KinWorkSection as Section } from "./KinWorkParts";
import { KinWorkStateIcon } from "./KinWorkStateIcon";
import { KinAskRecord } from "./KinAskRecord";
import { kinClient } from "./kinClient";
import { openDestination } from "./KinNotifications";
import { KinWatchLine } from "./KinWatchLine";
import { useNowMinuteMs } from "./useKinClock";
import { KIN_WEB_ONLY } from "./kinWebOnly";
import {
  useKinPickerSearch,
  useKinWorkItemWatch,
  useKinWorkPlace,
  type KinWorkChangesHandle,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";
import { useKinShell } from "./useKinShell";
import {
  kinPickerNamed,
  kinSectionNoun,
  kinSectionOf,
  kinSectionOffLine,
} from "@t3tools/client-runtime/kin/kinShell";

const LINK_ICON: Record<KinWorkLinkView["kind"], typeof LinkIcon> = {
  pull_request: PullRequestGlyph.pullRequest,
  worker: PlayIcon,
  message: MessageSquareIcon,
  task: ListChecksIcon,
  note: NotebookTextIcon,
  link: LinkIcon,
};

const SHEET_FRAME = { Header: SheetHeader, Title: SheetTitle, Description: SheetDescription };
// The same header outside a dialog, where the sheet's title and description have no dialog to name.
const PAGE_FRAME = {
  Header: (props: ComponentProps<"div">) => (
    <div className="flex flex-col gap-2 p-6 max-sm:pb-4" {...props} />
  ),
  Title: (props: ComponentProps<"h2">) => (
    <h2 className="text-xl leading-snug font-semibold" {...props} />
  ),
  Description: (props: ComponentProps<"p">) => (
    <p className="text-sm text-muted-foreground" {...props} />
  ),
};
type KinItemFrame = typeof SHEET_FRAME | typeof PAGE_FRAME;

const NO_ITEM: ReturnType<typeof kinClient.workItem> = Atom.make(AsyncResult.initial());

/** Whether the record open by key is a task or a list entry, once its read has answered. */
export function useKinOpenedKind(target: KinWorkTarget, key: KinRecordKey | null) {
  const { environmentId, orgId } = target;
  const result = useAtomValue(
    key === null ? NO_ITEM : kinClient.workItem({ environmentId, input: { orgId, key } }),
  );
  const item = Option.getOrNull(AsyncResult.value(result));
  return item === null ? "unknown" : item.list === undefined ? "task" : "entry";
}

const focusOnMount = (node: HTMLElement | null) => node?.focus({ preventScroll: true });

/**
 * One task: where it stands, its next step, who has it, and what happened to it. It opens in the
 * record pane beside the list (`pane`), as the whole page on a narrow window (`page`), or over the
 * place (`sheet`); a list entry always opens over the place.
 */
export function KinWorkItemSheet(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly frame: "sheet" | "pane" | "page";
    readonly directory: KinWorkDirectory;
    readonly changes: KinWorkChangesHandle;
    /** The clients and projects it can go under; null on a host without them. */
    readonly choices: KinWorkChoices | null;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onOpenProject: (key: KinRecordKey) => void;
    readonly onOpenDoc: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, itemKey } = props;
  const { state: changed, changes } = props.changes;
  const { names } = props.directory;
  const itemAtom = kinClient.workItem({ environmentId, input: { orgId, key: itemKey } });
  const result = useAtomValue(itemAtom);
  const canChange = useAtomValue(kinClient.workUpdate.permissionAtom(environmentId));
  const canGive = useAtomValue(kinClient.workAssign.permissionAtom(environmentId));
  const canComment = useAtomValue(kinClient.workComment.permissionAtom(environmentId));
  const place = useKinWorkPlace(environmentId);
  const shell = useKinShell(environmentId);
  const ownerLevel = useKinOwnerLevel(environmentId);
  const now = new Date(useNowMinuteMs());
  const state = kinWorkItemState(result, changed.answers[itemKey] ?? null);
  useKinWorkItemWatch(
    props,
    itemKey,
    state._tag === "ready" ? state.item.seq : null,
    state._tag === "ready" ? state.item.tasks?.map((task) => task.key) : undefined,
  );
  const saving = changed.pending[itemKey] !== undefined;
  const close = () => {
    if (!saving) props.onClose();
  };
  const entry = state._tag === "ready" && state.item.list !== undefined;
  const sheet = props.frame === "sheet" || entry;
  const Frame = sheet ? SHEET_FRAME : PAGE_FRAME;
  // An entry of a section that is off, opened by its link, says so, as its page on the phone does.
  const section =
    state._tag === "ready" && state.item.list !== undefined
      ? kinSectionOf({ list: state.item.list })
      : null;
  const offLine = section === null ? null : kinSectionOffLine(shell, section, ownerLevel);

  const entryView =
    state._tag === "ready" && state.item.list !== undefined
      ? kinWorkItemView(state.item, names, now, KIN_RECORD_CHANGES_CAP, place)
      : null;
  const content =
    state._tag === "ready" && state.item.list !== undefined && entryView !== null ? (
      <KinListEntry
        {...props}
        item={state.item}
        view={entryView}
        now={now}
        give={
          !kinRecordHeld({ item: state.item, view: entryView, names, give: canGive })
            .opens ? null : (
            <Menu>
              <MenuTrigger render={<Button size="sm" variant="outline" disabled={saving} />}>
                {entryView.assignLabel}
                <ChevronDownIcon />
              </MenuTrigger>
              <MenuPopup align="start">
                <GiveItems
                  assignees={kinWorkAssignees({
                    ...props.directory,
                    orgId,
                    current: entryView.owner.principal,
                  })}
                  onGive={(to) =>
                    void changes.run(state.item, { type: "give", to: to.principal }, names)
                  }
                />
              </MenuPopup>
            </Menu>
          )
        }
        links={
          <KinWorkLinks
            {...props}
            item={state.item}
            links={kinWorkItemView(state.item, names, now, KIN_RECORD_CHANGES_CAP, place).links}
          />
        }
        offLine={offLine}
      />
    ) : state._tag === "ready" ? (
      <KinWorkItem
        {...props}
        frame={Frame}
        item={state.item}
        shown={kinWorkApplied(state.item, changed)}
        view={kinWorkItemView(
          kinWorkApplied(state.item, changed),
          names,
          now,
          KIN_RECORD_CHANGES_CAP,
          place,
        )}
        now={now}
        saving={saving}
        notice={changed.notice?.key === itemKey ? changed.notice : null}
        edit={changed.edit?.key === itemKey ? changed.edit : null}
        canChange={canChange}
        canGive={canGive}
        canComment={canComment}
        onAct={(action) => void changes.run(state.item, action, names)}
        onLeave={(action) =>
          void changes.run(state.item, action, names).then((left) => {
            // They may no longer see it: the list says so, with its Undo.
            if (left) props.onClose();
          })
        }
        onUndo={() => void changes.undo(names, state.item)}
        onStartEdit={() => changes.startEdit(state.item)}
        onEdit={changes.setEdit}
        onCancelEdit={changes.cancelEdit}
        onSaveEdit={() => void changes.saveEdit(state.item, names)}
      />
    ) : (
      <>
        <Frame.Header>
          <Frame.Title>
            {state._tag === "gone"
              ? KIN_WORK_GONE.title
              : state._tag === "failed"
                ? KIN_WORK_ITEM_FAILED.title
                : itemKey}
          </Frame.Title>
          <Frame.Description>
            {state._tag === "gone"
              ? KIN_WORK_GONE.detail
              : state._tag === "failed"
                ? KIN_WORK_ITEM_FAILED.detail
                : "Loading…"}
          </Frame.Description>
        </Frame.Header>
        <div className="flex flex-col items-start gap-3 px-6 pb-6">
          {state._tag === "loading" ? (
            <div className="flex w-full flex-col gap-2" role="status" aria-label="Loading task">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-3.5 w-2/5" />
            </div>
          ) : state._tag === "failed" ? (
            <Button size="sm" variant="outline" onClick={() => appAtomRegistry.refresh(itemAtom)}>
              Retry
            </Button>
          ) : null}
        </div>
      </>
    );

  if (sheet)
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <SheetPopup side="right">{content}</SheetPopup>
      </Sheet>
    );
  return (
    <div
      ref={focusOnMount}
      tabIndex={-1}
      aria-label={itemKey}
      role="region"
      className="relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col outline-none"
      onKeyDown={(event) => {
        // Escape inside a menu or dialog it opened is theirs: those render outside this element.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        event.preventDefault();
        close();
      }}
    >
      {content}
      {props.frame === "page" ? null : (
        <div className="absolute end-2 top-2">
          <Button size="icon" variant="ghost" aria-label="Close task" onClick={close}>
            <XIcon />
          </Button>
        </div>
      )}
    </div>
  );
}
/** The holder gives the task back to whoever gave it, saying why if they like. */
function KinWorkHandBack(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly to: string;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly onDone: () => void;
  },
) {
  const { environmentId, orgId, itemKey } = props;
  const handBack = useAtomCommand(kinClient.workHandBack, { reportFailure: false });
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const noteId = useId();
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(next) => {
        if (!pending) props.onOpenChange(next);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{KIN_WORK_HAND_BACK.title}</AlertDialogTitle>
          <AlertDialogDescription>{KIN_WORK_HAND_BACK.detail(props.to)}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1.5 px-6">
          <Label htmlFor={noteId}>{KIN_WORK_HAND_BACK.reasonLabel}</Label>
          <Textarea
            id={noteId}
            value={note}
            maxLength={280}
            onChange={(event) => setNote(event.target.value)}
          />
          {failed ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {KIN_WORK_HAND_BACK.failed}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
            {KIN_WORK_COPY.cancel}
          </AlertDialogClose>
          <Button
            disabled={pending}
            onClick={() => {
              setPending(true);
              setFailed(false);
              const trimmed = note.trim();
              void handBack({
                environmentId,
                input: { orgId, key: itemKey, ...(trimmed === "" ? {} : { note: trimmed }) },
              }).then((outcome) => {
                setPending(false);
                if (AsyncResult.isFailure(outcome)) {
                  setFailed(true);
                  return;
                }
                props.onOpenChange(false);
                appAtomRegistry.refresh(
                  kinClient.workItem({ environmentId, input: { orgId, key: itemKey } }),
                );
                props.onDone();
              });
            }}
          >
            {KIN_WORK_HAND_BACK.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** What just happened to the task: said quietly when it worked, plainly when it didn't. */
function KinWorkNoticeLine(props: {
  readonly notice: KinWorkNotice;
  readonly saving: boolean;
  readonly onUndo: () => void;
}) {
  const { notice } = props;
  if (notice.kind !== "saved") {
    return (
      <Alert variant={notice.kind === "failed" ? "error" : "warning"}>
        <AlertDescription>{notice.text}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="success">
      <AlertDescription>{notice.text}</AlertDescription>
      {notice.undo === null ? null : (
        <AlertAction>
          <Button size="xs" variant="outline" disabled={props.saving} onClick={props.onUndo}>
            {KIN_WORK_COPY.undo}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

/**
 * A task's checklist: a box ticks a step, the field at the foot adds one (Enter), the cross takes
 * one off. Ticking every step leaves the task open: done is still the top card's to say.
 */
function KinTaskSteps(props: {
  readonly steps: KinWorkStepsView;
  readonly saving: boolean;
  readonly onAct: ((action: KinWorkAction) => void) | null;
}) {
  const { steps, onAct } = props;
  const [draft, setDraft] = useState("");
  const fieldId = useId();
  const held = steps.items.map((item) => ({ title: item.title, done: item.done }));
  const problem = draft.trim() === "" ? null : kinWorkStepProblem(draft, held.length);
  const add = () => {
    const title = draft.trim();
    if (onAct === null || title === "" || problem !== null) return;
    onAct({ type: "steps", steps: [...held, { title, done: false }], said: "added" });
    setDraft("");
  };
  return (
    <Section
      title={
        steps.count === null ? KIN_WORK_STEPS.title : `${KIN_WORK_STEPS.title} · ${steps.count}`
      }
    >
      <ul className="flex flex-col">
        {steps.items.map((item) => (
          <li key={`${item.index}:${item.title}`} className="group flex min-h-8 items-center gap-2">
            <Checkbox
              checked={item.done}
              disabled={onAct === null || props.saving}
              aria-label={onAct === null ? item.title : item.label}
              onCheckedChange={(checked) =>
                onAct?.({ type: "tick", index: item.index, title: item.title, done: checked })
              }
            />
            <span
              className={cn(
                "min-w-0 flex-1 text-sm wrap-break-word",
                item.done ? "text-muted-foreground line-through" : "text-foreground",
              )}
            >
              {item.title}
            </span>
            {onAct === null ? null : (
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={props.saving}
                aria-label={`${KIN_WORK_STEPS.remove}: ${item.title}`}
                title={KIN_WORK_STEPS.remove}
                onClick={() =>
                  onAct({
                    type: "steps",
                    steps: held.filter((_, index) => index !== item.index),
                    said: "removed",
                  })
                }
              >
                <XIcon />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {onAct === null ? null : (
        <div className="flex flex-col gap-1">
          <Input
            id={fieldId}
            value={draft}
            disabled={props.saving}
            placeholder={KIN_WORK_STEPS.placeholder}
            aria-label={KIN_WORK_STEPS.add}
            aria-invalid={problem !== null}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          {problem === null ? null : (
            <p role="alert" className="text-xs text-destructive-foreground">
              {problem}
            </p>
          )}
        </div>
      )}
      {steps.allDone === null ? null : (
        <p className="text-xs text-muted-foreground">{steps.allDone}</p>
      )}
    </Section>
  );
}

/** A person or agent in Details, with their picture so an agent reads as one at a glance. */
function DetailPerson(props: {
  readonly label: string;
  readonly who: KinRecordWho;
  readonly extra?: string | null;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <KinAvatar avatar={props.who.avatar} size="sm" />
        <span className="truncate text-foreground">{props.who.name}</span>
        {props.extra == null ? null : (
          <span className="shrink-0 text-xs text-muted-foreground">{props.extra}</span>
        )}
      </dd>
    </>
  );
}

/**
 * A task as one page, in the order the phone draws it: where it stands and its title, the next
 * step with its one action, Details, the Brief, Activity with notes, and what it links to. The
 * less-used moves sit in the More menu; "Add a note…" is pinned at the foot.
 */
function KinWorkItem(
  props: KinWorkTarget & {
    readonly frame: KinItemFrame;
    readonly item: KinRecordDetail;
    /** The task with this browser's unsaved changes applied, as `view` reads it. */
    readonly shown: KinRecordDetail;
    readonly view: KinWorkItemView;
    readonly directory: KinWorkDirectory;
    readonly now: Date;
    readonly saving: boolean;
    readonly notice: KinWorkNotice | null;
    readonly edit: KinWorkEdit | null;
    readonly canChange: boolean;
    readonly canGive: boolean;
    readonly canComment: boolean;
    readonly onAct: (action: KinWorkAction) => void;
    readonly onLeave: (action: KinWorkAction) => void;
    readonly onUndo: () => void;
    readonly onStartEdit: () => void;
    readonly onEdit: (patch: Partial<Pick<KinWorkEdit, "title" | "notes">>) => void;
    readonly onCancelEdit: () => void;
    readonly onSaveEdit: () => void;
    readonly choices: KinWorkChoices | null;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onOpenProject: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { view, environmentId, orgId, saving, edit, shown, frame: Frame } = props;
  const canAddLink = useAtomValue(kinClient.workLinkAdd.permissionAtom(environmentId));
  const { orgs, people, joined, invited, names } = props.directory;
  const opensClients = useKinOpensClients(environmentId);
  // A teammate moves a task only into a project they lead, as the host takes it.
  const projectsAllowed = kinTaskProjectsAllowed(
    useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId)),
  );
  const [handingBack, setHandingBack] = useState(false);
  // Each control shows only where the host said it takes it (`view.can`).
  const change = props.canChange ? props.onAct : null;
  const give = props.canGive ? props.onAct : null;
  const offer = kinWorkStatusOffer(view);
  const reword = change !== null && view.can.edit ? change : null;
  const assignees = kinWorkAssignees({
    orgs,
    orgId,
    people,
    joined,
    invited,
    names,
    current: view.owner.principal,
  });
  const waitingOn = kinWorkAssignees({
    orgs,
    orgId,
    people,
    joined,
    invited,
    names,
    current: view.waitingOn,
  });
  const withView = kinTaskWith({
    item: shown,
    names,
    edit: view.can.edit,
    change: change !== null,
    joined,
    invited,
  });
  const withChoices = kinTaskWithChoices(
    kinWorkAssignees({ orgs, orgId, people, joined, invited, names, current: null }),
    shown,
  );
  const setWith = (said: "added" | "removed" | "left", who: KinWorkPrincipal) => {
    const action = {
      type: "alsoOn" as const,
      alsoOn: said === "added" ? [...(shown.alsoOn ?? []), who] : kinTaskWithout(shown, who),
      who,
      said,
    };
    if (said === "left") props.onLeave(action);
    else change?.(action);
  };
  const moved = edit === null ? null : kinWorkEditMoved(edit, props.item);
  const titleId = useId();
  const titleCountId = useId();
  const notesId = useId();
  const { choices } = props;
  const titleCount = edit === null ? null : kinWorkTitleCount(edit.title);
  const clientStays = choices === null ? null : kinWorkClientStays(shown, choices.projectClients);
  const step = kinNextStep({
    item: shown,
    view,
    names,
    now: props.now,
    change: change !== null,
    give: give !== null,
  });
  const chip = kinRecordChip(shown, view, names, props.now);
  const origin = kinTaskOrigin(shown, names, props.now);
  const briefBy = kinBriefBy(shown, names, props.now);
  const stepAct = (id: KinNextStepAct) => {
    if (change === null) return;
    if (id === "keep") return change({ type: "confirm" });
    if (id === "decline") return change({ type: "decline" });
    if (id === "done") return change({ type: "state", state: "done" });
    if (id === "reopen") return change({ type: "state", state: "open" });
  };
  const controls = kinTaskControls({
    view,
    change: change !== null,
    give: give !== null,
    step: step.acts,
  });
  const status = change === null ? null : controls.page.status;
  const more = Object.values(controls.menu).some(Boolean);
  return (
    <>
      <Frame.Header>
        <div className="flex flex-col gap-2 pe-8 wrap-break-word">
          <div className="flex flex-wrap items-center gap-2">
            <KinRecordChip tone={chip.tone} label={chip.label} />
            {view.urgent && !view.closed ? (
              <span className="flex items-center gap-1 text-xs font-medium text-warning-foreground">
                <FlagIcon aria-hidden className="size-3 fill-current" />
                {KIN_WORK_URGENT.label}
              </span>
            ) : null}
            <Frame.Description>
              {view.heading === "Task" ? view.key : `${view.key} · ${view.heading}`}
            </Frame.Description>
            {saving ? (
              <span role="status" className="text-xs text-muted-foreground">
                {KIN_WORK_COPY.saving}
              </span>
            ) : null}
            <div className="ms-auto flex items-center gap-1">
              <KinAskRecord
                environmentId={environmentId}
                orgId={orgId}
                record={{ key: view.key, title: view.title }}
                disabled={saving}
              />
              {!more ? null : (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={saving}
                        aria-label={KIN_TASK_RECORD.more}
                      />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {!controls.menu.give || give === null || view.assignLabel === null ? null : (
                      <>
                        <MenuSub>
                          <MenuSubTrigger>{view.assignLabel}</MenuSubTrigger>
                          <MenuSubPopup>
                            <GiveItems
                              assignees={assignees}
                              onGive={(to) => give({ type: "give", to: to.principal })}
                            />
                          </MenuSubPopup>
                        </MenuSub>
                      </>
                    )}
                    {!controls.menu.takeBack || give === null ? null : (
                      <MenuItem onClick={() => give({ type: "takeBack" })}>
                        {kinWorkTakeLabel(props.item, names)}
                      </MenuItem>
                    )}
                    {!controls.menu.handBack ? null : (
                      <MenuItem onClick={() => setHandingBack(true)}>
                        <Undo2Icon />
                        {KIN_WORK_HAND_BACK.button}
                      </MenuItem>
                    )}
                    {!controls.menu.drop || change === null ? null : (
                      <>
                        {controls.menu.give || controls.menu.takeBack || controls.menu.handBack ? (
                          <MenuSeparator />
                        ) : null}
                        <MenuItem
                          variant="destructive"
                          onClick={() => change({ type: "state", state: "dropped" })}
                        >
                          <KinWorkStateIcon state="dropped" />
                          {KIN_WORK_COPY.drop}
                        </MenuItem>
                      </>
                    )}
                  </MenuPopup>
                </Menu>
              )}
            </div>
          </div>
          {edit !== null ? null : <Frame.Title>{view.title}</Frame.Title>}
          {view.remarks.map((remark) => (
            <p key={remark} className="text-xs text-muted-foreground">
              {remark}
            </p>
          ))}
          <KinWatchLine environmentId={environmentId} orgId={orgId} recordKey={view.key} />
        </div>
      </Frame.Header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
        {edit === null ? null : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              props.onSaveEdit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={titleId}>Title</Label>
              <Input
                id={titleId}
                value={edit.title}
                autoComplete="off"
                autoFocus
                aria-describedby={titleCount === null ? undefined : titleCountId}
                aria-invalid={kinWorkTitleTooLong(edit.title) || undefined}
                onChange={(event) => props.onEdit({ title: event.target.value })}
              />
              {titleCount === null ? null : (
                <p
                  id={titleCountId}
                  className={
                    kinWorkTitleTooLong(edit.title)
                      ? "text-xs text-destructive-foreground tabular-nums"
                      : "text-xs text-muted-foreground tabular-nums"
                  }
                >
                  {titleCount}
                </p>
              )}
              {moved?.title == null ? null : (
                <p className="text-xs text-muted-foreground">
                  {KIN_WORK_COPY.nowSays(moved.title)}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={notesId}>{KIN_TASK_RECORD.brief}</Label>
              <Textarea
                id={notesId}
                rows={4}
                value={edit.notes}
                maxLength={KIN_WORK_NOTES_MAX}
                onChange={(event) => props.onEdit({ notes: event.target.value })}
              />
              {moved?.notes == null ? null : (
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                  {KIN_TASK_RECORD.briefMoved} {moved.notes}
                </p>
              )}
            </div>
            {props.notice === null ? null : (
              <KinWorkNoticeLine notice={props.notice} saving={saving} onUndo={props.onUndo} />
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={props.onCancelEdit}
              >
                {KIN_WORK_COPY.cancel}
              </Button>
              <Button type="submit" size="sm" disabled={saving} aria-busy={saving}>
                {KIN_WORK_COPY.save}
              </Button>
            </div>
          </form>
        )}
        <div className="flex flex-col gap-3">
          <KinNextStepCard
            step={step}
            footnote={
              step.acts.some((act) => act.id === "done" || act.id === "reopen")
                ? view.leadNote
                : null
            }
          >
            {step.acts.length === 0 ? null : (
              <div className="flex flex-wrap items-center gap-2">
                {step.acts.map((act, index) => {
                  const variant = index === 0 ? "default" : "outline";
                  if (act.id === "openWaiting")
                    return step.waiting === null ? null : (
                      <Button
                        key={act.id}
                        size="sm"
                        variant={variant}
                        render={
                          <Link
                            to="/kin/$environmentId/$orgId/$chatId"
                            params={{ environmentId, orgId, chatId: step.waiting.chatId }}
                            search={{ message: step.waiting.messageId }}
                          />
                        }
                      >
                        <MessageSquareIcon />
                        {act.label}
                      </Button>
                    );
                  if (act.id === "give")
                    return give === null ? null : (
                      <Menu key={act.id}>
                        <MenuTrigger
                          render={<Button size="sm" variant={variant} disabled={saving} />}
                        >
                          {act.label}
                          <ChevronDownIcon />
                        </MenuTrigger>
                        <MenuPopup align="start">
                          <GiveItems
                            assignees={assignees}
                            onGive={(to) => give({ type: "give", to: to.principal })}
                          />
                        </MenuPopup>
                      </Menu>
                    );
                  if (act.id === "handBack")
                    return (
                      <Button
                        key={act.id}
                        size="sm"
                        variant={variant}
                        disabled={saving}
                        onClick={() => setHandingBack(true)}
                      >
                        <Undo2Icon />
                        {act.label}
                      </Button>
                    );
                  return (
                    <Button
                      key={act.id}
                      size="sm"
                      variant={variant}
                      disabled={saving}
                      aria-busy={saving && index === 0}
                      // A double click's second click would land on Reopen once Mark done lands.
                      onClick={(event) =>
                        event.detail > 1 && (act.id === "done" || act.id === "reopen")
                          ? undefined
                          : stepAct(act.id)
                      }
                    >
                      {act.id === "keep" || act.id === "done" ? <CheckIcon /> : null}
                      {act.id === "reopen" ? <RotateCcwIcon /> : null}
                      {act.label}
                    </Button>
                  );
                })}
              </div>
            )}
          </KinNextStepCard>
          {status === null || change === null ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Menu>
                <MenuTrigger render={<Button size="sm" variant="outline" disabled={saving} />}>
                  {KIN_WORK_COPY.status}
                  <ChevronDownIcon />
                </MenuTrigger>
                <MenuPopup align="start">
                  {status.done ? (
                    <MenuItem onClick={() => change({ type: "state", state: "done" })}>
                      <CheckIcon />
                      {KIN_WORK_COPY.done}
                    </MenuItem>
                  ) : null}
                  {status.reopen ? (
                    <MenuItem onClick={() => change({ type: "state", state: "open" })}>
                      <RotateCcwIcon />
                      {KIN_WORK_COPY.reopen}
                    </MenuItem>
                  ) : null}
                  {status.states || status.waiting ? (
                    <StatusItems view={view} offer={offer} waitingOn={waitingOn} onAct={change} />
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
          )}
          {props.notice === null || edit !== null ? null : (
            <KinWorkNoticeLine notice={props.notice} saving={saving} onUndo={props.onUndo} />
          )}
        </div>
        {view.steps === null ? null : (
          <KinTaskSteps
            steps={view.steps}
            saving={saving}
            onAct={change !== null && view.steps.editable ? change : null}
          />
        )}
        <Section title={KIN_TASK_RECORD.details}>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
            <DetailPerson
              label={KIN_TASK_RECORD.heldBy}
              who={{ name: view.owner.name, avatar: view.owner.avatar }}
              extra={view.owner.retired ? KIN_RETIRED_LABEL : null}
            />
            {view.owner.principal._tag === "agent" ? (
              <dd className="col-start-2 -mt-1">
                <KinWorkLeadChat
                  environmentId={environmentId}
                  orgId={orgId}
                  agentId={view.owner.principal.agentId}
                  name={view.owner.name}
                />
              </dd>
            ) : null}
            {withView.people.length === 0 && !withView.add ? null : (
              <KinTaskWithLine
                with={withView}
                saving={saving}
                picker={
                  <GiveItems
                    assignees={withChoices}
                    leadsHint={null}
                    onGive={(to) => setWith("added", to.principal)}
                  />
                }
                onRemove={(key) => {
                  const who = withView.people.find((one) => one.key === key);
                  if (who !== undefined) setWith("removed", who.principal);
                }}
                onLeave={() => {
                  const me = withView.people.find((one) => one.act === "leave");
                  if (me !== undefined) setWith("left", me.principal);
                }}
              />
            )}
            <dt className="text-muted-foreground">{KIN_TASK_RECORD.due}</dt>
            <dd className="flex min-w-0 items-center gap-2 text-foreground">
              {reword === null || view.closed ? (
                <span
                  className={
                    view.late
                      ? "text-destructive-foreground first-letter:uppercase"
                      : "first-letter:uppercase"
                  }
                >
                  {view.due ?? KIN_WORK_COPY.noDate}
                </span>
              ) : (
                <DueMenu
                  view={view}
                  now={props.now}
                  zone={names.zone}
                  saving={saving}
                  onAct={reword}
                />
              )}
            </dd>
            {choices === null || (!view.can.project && view.project === null) ? null : (
              <>
                <dt className="text-muted-foreground">{KIN_WORK_NEW_COPY.projectLabel}</dt>
                <dd className="flex min-w-0 items-center gap-2 text-foreground">
                  <KinTaskPlaceMenu
                    target={{ environmentId, orgId }}
                    noun="project"
                    label={KIN_WORK_NEW_COPY.projectLabel}
                    value={view.project}
                    choices={choices.projects}
                    done={choices.doneProjects}
                    only={projectsAllowed}
                    saving={saving}
                    clearable={view.can.clearProject}
                    onPick={
                      change === null || !view.can.project
                        ? null
                        : (project) => change({ type: "place", project })
                    }
                    onOpen={() => {
                      if (view.project !== null) props.onOpenProject(view.project.key);
                    }}
                  />
                </dd>
              </>
            )}
            {choices === null || (!view.can.party && view.party === null) ? null : (
              <>
                <dt className="text-muted-foreground">{KIN_WORK_NEW_COPY.clientLabel}</dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-2 text-foreground">
                  <KinTaskPlaceMenu
                    target={{ environmentId, orgId }}
                    noun="client"
                    label={KIN_WORK_NEW_COPY.clientLabel}
                    value={view.party}
                    choices={choices.clients}
                    saving={saving}
                    onPick={
                      change === null || !view.can.party
                        ? null
                        : (party) => change({ type: "place", party })
                    }
                    onOpen={
                      opensClients
                        ? () => {
                            if (view.party !== null) props.onOpenClient(view.party.key);
                          }
                        : null
                    }
                    {...(reword === null || view.closed
                      ? {}
                      : {
                          side: {
                            value: view.side,
                            onPick: (side) => reword({ type: "place", side }),
                          },
                        })}
                  />
                  {view.party === null || view.side !== "theirs" ? null : (
                    <span className="text-xs text-muted-foreground">
                      {KIN_WORK_NEW_COPY.sideTheirs}
                    </span>
                  )}
                </dd>
                {clientStays === null ? null : (
                  <dd className="col-start-2 -mt-1 text-xs text-muted-foreground">{clientStays}</dd>
                )}
              </>
            )}
            {view.milestone === null ? null : (
              <>
                <dt className="text-muted-foreground">{KIN_WORK_MILESTONE.label}</dt>
                <dd className="flex min-w-0 items-center gap-2 text-foreground">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      if (view.milestone !== null) props.onOpenKey(view.milestone.key);
                    }}
                  >
                    <span className="max-w-60 truncate">{view.milestone.title}</span>
                  </Button>
                </dd>
              </>
            )}
            {change === null || view.steps?.editable !== true || view.closed ? null : (
              <>
                <dt className="text-muted-foreground">{KIN_WORK_URGENT.label}</dt>
                <dd className="flex min-w-0 items-center gap-2 text-foreground">
                  <Switch
                    checked={view.urgent}
                    disabled={saving}
                    onCheckedChange={(checked) => change({ type: "urgent", urgent: checked })}
                    aria-label={KIN_WORK_URGENT.label}
                  />
                </dd>
              </>
            )}
            {view.repeat === null && !(change !== null && view.can.repeat === true) ? null : (
              <>
                <dt className="text-muted-foreground">{KIN_WORK_REPEAT.label}</dt>
                <dd className="flex min-w-0 items-center gap-2 text-foreground">
                  {change === null || view.can.repeat !== true || view.closed ? (
                    <span>{view.repeat?.text ?? KIN_WORK_REPEAT.never}</span>
                  ) : (
                    <RepeatMenu view={view} saving={saving} onAct={change} />
                  )}
                </dd>
              </>
            )}
          </dl>
          <KinWorkAudienceRow
            environmentId={environmentId}
            orgId={orgId}
            itemKey={props.item.key}
            view={view}
            names={names}
            disabled={saving}
            onMark={change === null ? null : (on) => change({ type: "private", private: on })}
          />
          {origin === null ? null : <p className="text-xs text-muted-foreground">{origin}</p>}
        </Section>
        {view.tasks === null ? null : (
          <Section title={KIN_WORK_MILESTONE.tasks}>
            {view.tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">{KIN_WORK_MILESTONE.noTasks}</p>
            ) : (
              <ul className="-mx-1 flex flex-col">
                {view.tasks.map((row) => (
                  <li key={row.key}>
                    <KinWorkRow
                      row={row}
                      saving={false}
                      onOpen={() => props.onOpenKey(row.key)}
                      onAct={null}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
        {edit !== null ? null : (
          <Section
            title={KIN_TASK_RECORD.brief}
            action={
              reword === null ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={saving}
                  aria-label={KIN_TASK_RECORD.editBrief}
                  onClick={props.onStartEdit}
                >
                  <PencilIcon />
                  {KIN_TASK_RECORD.edit}
                </Button>
              )
            }
          >
            <p
              className={
                view.notes === null
                  ? "text-sm text-muted-foreground"
                  : "whitespace-pre-wrap wrap-break-word text-sm text-foreground"
              }
            >
              {view.notes ?? KIN_TASK_RECORD.noBrief}
            </p>
            {briefBy === null ? null : (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {briefBy.avatar === null ? null : <KinAvatar avatar={briefBy.avatar} size="xs" />}
                {briefBy.name}, {briefBy.when}
              </p>
            )}
            <KinNotesVersions
              item={props.item}
              names={names}
              now={props.now}
              busy={saving}
              onRestore={change === null ? null : (notes) => change({ type: "edit", notes })}
            />
          </Section>
        )}
        <KinTaskActivity
          environmentId={environmentId}
          orgId={orgId}
          itemKey={props.item.key}
          item={props.item}
          names={names}
          now={props.now}
          note={view.historyNote}
          reason={step.words === view.reason ? null : view.reason}
          onOpenProject={props.onOpenProject}
        />
        <KinWorkLinks
          {...props}
          item={props.shown}
          title={KIN_TASK_RECORD.linked}
          links={view.links}
          itemKey={view.key}
          addLink={canAddLink && view.can.links === true}
        />
      </div>
      {!props.canComment || edit !== null ? null : (
        <div className="px-4 pt-2 pb-4">
          <KinTaskNoteComposer
            environmentId={environmentId}
            orgId={orgId}
            itemKey={props.item.key}
          />
        </div>
      )}
      {view.handBackTo === null || change === null ? null : (
        <KinWorkHandBack
          environmentId={environmentId}
          orgId={orgId}
          itemKey={view.key}
          to={view.handBackTo}
          open={handingBack}
          onOpenChange={setHandingBack}
          onDone={props.onClose}
        />
      )}
    </>
  );
}

/** Everything linked to an entry, both ways, by kind; then its pull requests, workers and pages. */
export function KinWorkLinks(
  props: KinWorkTarget & {
    readonly item: Parameters<typeof kinLinked>[0];
    readonly links: ReadonlyArray<KinWorkLinkView>;
    /** A task's reads "Linked", as the phone's does; a list entry's keeps "Links". */
    readonly title?: string;
    /** The entry the links are on, and whether this viewer may add a web link to it. */
    readonly itemKey?: KinRecordKey;
    readonly addLink?: boolean;
    readonly onOpenKey: (key: KinRecordKey) => void;
  },
) {
  const navigate = useNavigate();
  const rest = kinLinkedRest(props.links);
  return (
    <KinLinkedGroups
      item={props.item}
      title={props.title ?? "Links"}
      // Both panels show the entry's client, project and milestone in their rows already.
      parentsShown
      // A task or list entry opens on this panel; a doc, client or project has its own page.
      onOpen={(to) =>
        to._tag === "record" && (to.kind === "task" || to.kind === "entry")
          ? props.onOpenKey(to.key)
          : void openDestination(navigate, props, to)
      }
    >
      {rest.length === 0 && props.addLink !== true ? null : (
        <>
          {rest.length === 0 ? null : (
            <ul className="flex flex-col">
              {rest.map((link) => (
                <li key={link.key}>
                  <KinWorkLink
                    link={link}
                    environmentId={props.environmentId}
                    orgId={props.orgId}
                    {...(props.itemKey === undefined ? {} : { itemKey: props.itemKey })}
                    onOpenKey={props.onOpenKey}
                  />
                </li>
              ))}
            </ul>
          )}
          {props.addLink !== true || props.itemKey === undefined ? null : (
            <KinTaskLinkAdd
              environmentId={props.environmentId}
              orgId={props.orgId}
              itemKey={props.itemKey}
            />
          )}
        </>
      )}
    </KinLinkedGroups>
  );
}

/** What links to an entry or doc and what it links to, by kind; `children` follow the groups. */
export function KinLinkedGroups(props: {
  readonly item: Parameters<typeof kinLinked>[0];
  readonly title: string;
  readonly parentsShown: boolean;
  readonly onOpen: (to: KinNotificationDestination) => void;
  readonly children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<KinLinkedGroupName>>(new Set());
  const linked = kinLinked(props.item, undefined, { expanded, parentsShown: props.parentsShown });
  const children = props.children ?? null;
  if (linked.groups.length === 0 && children === null && linked.unlisted === 0) return null;
  return (
    <Section title={props.title}>
      {linked.groups.map((group) => (
        <div key={group.group} className="flex flex-col">
          <h4 className="px-1 text-xs text-muted-foreground">{KIN_LINKED.group[group.group]}</h4>
          <ul className="flex flex-col">
            {group.items.map((item) => {
              const { open } = item;
              const content = (
                <>
                  {item.kind === "message" ? null : (
                    <span className="shrink-0 text-xs text-muted-foreground">{item.name}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {item.title ?? KIN_LINKED.message}
                  </span>
                  {item.deleted === true ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {KIN_DOCS.archived}
                    </span>
                  ) : null}
                </>
              );
              return (
                <li key={item.key}>
                  {open === null ? (
                    <div className={LINK_ROW}>{content}</div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => props.onOpen(open)}
                      className={`${LINK_ROW} ${LINK_ROW_OPENS}`}
                    >
                      {content}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {group.more === 0 ? null : (
            <div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setExpanded(new Set([...expanded, group.group]))}
              >
                {KIN_LINKED.more(group.more)}
              </Button>
            </div>
          )}
        </div>
      ))}
      {children}
      {linked.unlisted === 0 ? null : (
        <p className="px-1 text-xs text-muted-foreground">{KIN_LINKED.unlisted(linked.unlisted)}</p>
      )}
    </Section>
  );
}

const PLACE_ROW = "flex min-w-0 flex-1 truncate";

/**
 * The client or project a task is under: pick another, found by typing as the new-task form
 * does, take it off, or open the one it has.
 */
export function KinTaskPlaceMenu(given: {
  readonly target: KinWorkTarget;
  readonly noun: "client" | "project";
  readonly label: string;
  readonly value: KinWorkRef | null;
  readonly choices: ReadonlyArray<KinWorkRef>;
  /** Done projects, under their own heading after the open ones. */
  readonly done?: ReadonlyArray<KinWorkRef>;
  /** The only keys this viewer may pick (`kinTaskProjectsAllowed`); null or absent for any. */
  readonly only?: ReadonlySet<string> | null;
  readonly saving: boolean;
  /** Null where the task can't be changed, which leaves only opening it. */
  readonly onPick: ((value: KinWorkRef | null) => void) | null;
  /** Whether "None" is offered: the host may let a value change but not be cleared. */
  readonly clearable?: boolean;
  /** Null where the viewer can't open it: the name is plain text, never a link that refuses. */
  readonly onOpen: (() => void) | null;
  /** A client's: who owes the task, us or them. */
  readonly side?: {
    readonly value: "ours" | "theirs";
    readonly onPick: (side: "ours" | "theirs") => void;
  };
}) {
  // A client picker says the company's own word for Clients in its label and its own rows.
  const clientShell = useKinShell(given.target.environmentId);
  const props = kinPickerNamed(clientShell, given);
  const { value, onPick, side } = props;
  const clientNoun = kinSectionNoun(clientShell, "clients");
  const search = useKinPickerSearch(
    props.target,
    props.noun === "client" ? "clients" : "projects",
    props.done !== undefined,
  );
  const query = search.state.text;
  const view = kinPickerSearchView({
    noun: props.noun,
    search: search.state,
    loaded: { open: props.choices, done: props.done ?? [] },
    held: value,
    only: props.only ?? null,
    called: props.noun === "client" ? clientNoun : "project",
  });
  const groups = kinTaskProjectMenu({ projects: view.open, doneProjects: view.done });
  const first = groups
    .flatMap((group) => group.choices)
    .find((choice) => choice.key !== value?.key);
  const [open, setOpen] = useState(false);
  if (onPick === null) {
    if (value === null) return null;
    const { onOpen } = props;
    return onOpen === null ? (
      <span className="max-w-60 truncate">{value.title}</span>
    ) : (
      <Button size="xs" variant="ghost" onClick={onOpen}>
        {value.title}
      </Button>
    );
  }
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) search.type("");
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            disabled={props.saving}
            aria-label={`${props.label}: ${value?.title ?? KIN_WORK_NEW_COPY.none}. Change`}
          />
        }
      >
        <span className="max-w-40 truncate">{value?.title ?? KIN_WORK_NEW_COPY.none}</span>
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-80">
        <MenuSearchInput
          autoFocus
          busy={view.loading}
          value={query}
          onChange={(event) => search.type(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || query.trim() === "" || first === undefined) return;
            event.preventDefault();
            setOpen(false);
            search.type("");
            onPick(first);
          }}
          placeholder={`Find a ${props.noun}`}
          aria-label={`Find a ${props.noun}`}
        />
        {value === null || props.onOpen === null ? null : (
          <>
            <MenuItem onClick={props.onOpen}>
              <span className={PLACE_ROW}>Open {value.title}</span>
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {groups.map((group, index) => (
          <MenuGroup key={group.label ?? ""}>
            {index === 0 ? null : <MenuSeparator />}
            {group.label === null ? null : <MenuGroupLabel>{group.label}</MenuGroupLabel>}
            {group.choices.map((choice) => (
              <MenuItem
                key={choice.key}
                disabled={choice.key === value?.key}
                title={choice.title}
                onClick={() => onPick(choice)}
              >
                <span className={PLACE_ROW}>{choice.title}</span>
              </MenuItem>
            ))}
          </MenuGroup>
        ))}
        {view.loading && groups.length === 0 ? (
          <MenuItem disabled>{KIN_PICKER_COPY.searching}</MenuItem>
        ) : view.failure !== null ? (
          <MenuItem
            closeOnClick={false}
            disabled={!view.failure.retry}
            onClick={() => void search.retry()}
          >
            {view.failure.text}
          </MenuItem>
        ) : view.note !== null ? (
          <MenuItem disabled>{view.note}</MenuItem>
        ) : null}
        {value === null || props.clearable === false ? null : (
          <>
            {groups.length === 0 ? null : <MenuSeparator />}
            <MenuItem onClick={() => onPick(null)}>{KIN_WORK_NEW_COPY.none}</MenuItem>
          </>
        )}
        {value === null || side === undefined ? null : (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => side.onPick(side.value === "theirs" ? "ours" : "theirs")}>
              {side.value === "theirs"
                ? KIN_WORK_NEW_COPY.sideOurs
                : `${KIN_WORK_NEW_COPY.sideTheirs}, not us`}
            </MenuItem>
          </>
        )}
        {value === null && props.choices.length === 0 && query.trim() === "" ? (
          <MenuItem disabled>Nothing to pick yet</MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** Where the task stands, other than done: started, waiting on someone, or not worth doing. */
function StatusItems(props: {
  readonly view: KinWorkItemView;
  readonly offer: ReturnType<typeof kinWorkStatusOffer>;
  readonly waitingOn: ReturnType<typeof kinWorkAssignees>;
  readonly onAct: (action: KinWorkAction) => void;
}) {
  const { view, offer } = props;
  const people = [...props.waitingOn.people, ...props.waitingOn.leads];
  return (
    <>
      {offer.states.map((choice) => (
        <MenuItem
          key={choice.state}
          disabled={view.state === choice.state}
          onClick={() => props.onAct({ type: "state", state: choice.state })}
        >
          <KinWorkStateIcon state={choice.state} />
          {choice.label}
        </MenuItem>
      ))}
      {!offer.waiting ? null : (
        <MenuSub>
          <MenuSubTrigger>
            <KinWorkStateIcon state="waiting" />
            {KIN_WORK_COPY.waitingOn}
          </MenuSubTrigger>
          <MenuSubPopup>
            {people.map((row) => (
              <MenuItem
                key={row.key}
                disabled={row.current || row.invited}
                onClick={() =>
                  props.onAct({ type: "state", state: "waiting", waitingOn: row.principal })
                }
              >
                <KinAvatar avatar={row.avatar} size="xs" />
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.invited ? (
                  <span className="text-xs text-muted-foreground">Invited</span>
                ) : null}
              </MenuItem>
            ))}
            {people.length === 0 ? null : <MenuSeparator />}
            <MenuItem
              disabled={view.state === "waiting" && view.waitingOn === null}
              onClick={() => props.onAct({ type: "state", state: "waiting", waitingOn: null })}
            >
              {KIN_WORK_COPY.waitingOnNobody}
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
      )}
    </>
  );
}

/** How the task comes back once closed: the usual rules, or off. It needs a due date to go from. */
function RepeatMenu(props: {
  readonly view: KinWorkItemView;
  readonly saving: boolean;
  readonly onAct: (action: KinWorkAction) => void;
}) {
  const { view } = props;
  const shown = view.repeat?.text ?? KIN_WORK_REPEAT.never;
  const dated = view.due !== null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            disabled={props.saving}
            aria-label={`${KIN_WORK_REPEAT.label}: ${shown}. Change`}
          />
        }
      >
        {view.repeat === null ? null : <RepeatIcon aria-hidden />}
        {shown}
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>{dated ? KIN_WORK_REPEAT.note : KIN_WORK_REPEAT.needsDue}</MenuGroupLabel>
          {KIN_WORK_REPEAT.choices.map((choice) => (
            <MenuItem
              key={choice.label}
              disabled={!dated || kinSameRepeat(choice.rule, view.repeat?.rule ?? null)}
              onClick={() => props.onAct({ type: "repeat", rule: choice.rule })}
            >
              {choice.label}
            </MenuItem>
          ))}
        </MenuGroup>
        {view.repeat === null ? null : (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => props.onAct({ type: "repeat", rule: null })}>
              {KIN_WORK_REPEAT.stop}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

/** The due date as its own control: the days people pick, any other day, or none. */
function DueMenu(props: {
  readonly view: KinWorkItemView;
  readonly now: Date;
  readonly zone: string | null;
  readonly saving: boolean;
  readonly onAct: (action: KinWorkAction) => void;
}) {
  const { view } = props;
  const picked = view.dueDay === null ? undefined : new Date(`${view.dueDay}T00:00:00`);
  // A day picked in the calendar submenu doesn't close the menu the way an item does.
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            disabled={props.saving}
            aria-label={`Due: ${view.due ?? KIN_WORK_COPY.noDate}. Change`}
          />
        }
      >
        <span className="first-letter:uppercase">{view.due ?? KIN_WORK_COPY.noDate}</span>
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        {kinWorkDueChoices(props.now, props.zone).map((choice) => (
          <MenuItem
            key={choice.day}
            disabled={choice.day === view.dueDay}
            onClick={() => props.onAct({ type: "due", day: choice.day })}
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
                if (date === undefined) return;
                setOpen(false);
                props.onAct({ type: "due", day: kinWorkDayOf(date) });
              }}
            />
          </MenuSubPopup>
        </MenuSub>
        {view.due === null ? null : (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => props.onAct({ type: "due", day: null })}>
              {KIN_WORK_COPY.noDate}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

/** Who the task can go to: agents first, then people; giving to an agent starts it at once. */
export function GiveItems(props: {
  readonly assignees: ReturnType<typeof kinWorkAssignees>;
  readonly onGive: (to: KinWorkAssignee) => void;
  /** Under the agents; a task's says giving one starts it. */
  readonly leadsHint?: string | null;
}) {
  const { assignees } = props;
  const group = (title: string, rows: ReadonlyArray<KinWorkAssignee>) =>
    rows.length === 0 ? null : (
      <MenuGroup>
        <MenuGroupLabel>{title}</MenuGroupLabel>
        {rows.map((row) => (
          <MenuItem
            key={row.key}
            disabled={row.current || row.invited}
            onClick={() => props.onGive(row)}
          >
            <KinAvatar avatar={row.avatar} size="xs" />
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            {row.current || row.invited ? (
              <span className="text-xs text-muted-foreground">
                {row.current ? "Has it" : "Invited"}
              </span>
            ) : null}
          </MenuItem>
        ))}
      </MenuGroup>
    );
  return (
    <>
      {group(KIN_WORK_ASSIGN.leads, assignees.leads)}
      {assignees.leads.length === 0 || props.leadsHint === null ? null : (
        <p className="max-w-64 px-2 pb-1.5 text-xs text-muted-foreground">
          {props.leadsHint ?? KIN_WORK_ASSIGN.leadsHint}
        </p>
      )}
      {group(KIN_WORK_ASSIGN.people, assignees.people)}
    </>
  );
}

/**
 * The owner's chat with the lead that has the task, which is where it reports back. This and the
 * other ways from a task to a chat push over the task without closing it: closing is a history
 * step back that can land after the push and leave the person in Tasks.
 */
function KinWorkLeadChat(
  props: KinWorkTarget & {
    readonly agentId: string;
    readonly name: string;
  },
) {
  const { environmentId, orgId } = props;
  // The owner's list keeps a retired agent, whose chat is where it is restored.
  const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
  const result = useAtomValue(
    canRestore
      ? kinClient.agents({ environmentId, orgId })
      : kinClient.leads({ environmentId, input: { orgId } }),
  );
  const lead = Option.getOrNull(AsyncResult.value(result))?.leads.find(
    (held) => held.agentId === props.agentId,
  );
  if (lead === undefined) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      render={
        <Link
          to="/kin/$environmentId/$orgId/$chatId"
          params={{ environmentId, orgId, chatId: lead.ownerChatId }}
        />
      }
    >
      <MessageSquareIcon />
      Chat with {props.name}
    </Button>
  );
}

const LINK_ROW =
  "flex min-h-9 w-full items-center gap-3 rounded-md px-1 py-1.5 text-start text-sm outline-none ring-ring";
const LINK_ROW_OPENS = "hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";

function KinWorkLink(
  props: KinWorkTarget & {
    readonly link: KinWorkLinkView;
    readonly itemKey?: KinRecordKey;
    readonly onOpenKey: (key: KinRecordKey) => void;
  },
) {
  const { link } = props;
  const { open } = link;
  const Icon = LINK_ICON[link.kind];
  const content = (
    <>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">{link.label}</span>
      {link.detail === null ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{link.detail}</span>
      )}
    </>
  );
  // A lead's work opens its thread the way its task card does, beside whatever the row opens;
  // the Kin web app has no threads.
  const thread =
    link.thread === null || KIN_WEB_ONLY ? null : (
      <Button
        size="xs"
        variant="ghost"
        render={<Link to="/$environmentId/$threadId" params={link.thread} />}
      >
        {KIN_WORK_COPY.openThread}
      </Button>
    );
  const row =
    open === null ? (
      <div className={LINK_ROW}>{content}</div>
    ) : open.type === "chat" ? (
      <Link
        to="/kin/$environmentId/$orgId/$chatId"
        params={{ environmentId: props.environmentId, orgId: props.orgId, chatId: open.chatId }}
        className={`${LINK_ROW} ${LINK_ROW_OPENS}`}
      >
        {content}
      </Link>
    ) : open.type === "task" ? (
      <button
        type="button"
        onClick={() => props.onOpenKey(open.key)}
        className={`${LINK_ROW} ${LINK_ROW_OPENS}`}
      >
        {content}
      </button>
    ) : (
      <a
        href={open.href}
        target="_blank"
        rel="noreferrer"
        className={`${LINK_ROW} ${LINK_ROW_OPENS}`}
      >
        {content}
        <ExternalLinkIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </a>
    );
  const remove =
    link.removeUrl === undefined || props.itemKey === undefined ? null : (
      <KinTaskLinkRemove
        environmentId={props.environmentId}
        orgId={props.orgId}
        itemKey={props.itemKey}
        url={link.removeUrl}
        label={link.label}
      />
    );
  return thread === null && remove === null ? (
    row
  ) : (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">{row}</div>
      {thread}
      {remove}
    </div>
  );
}
