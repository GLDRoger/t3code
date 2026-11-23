import { useAtomValue } from "@effect/atom-react";
import { kinFailure, kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_TASK_LINK,
  KIN_TASK_NOTE_COPY,
  KIN_TASK_RECORD,
  KIN_TASK_WITH,
  type KinActivityIcon,
  type KinActivityLine,
  type KinNextStepView,
  type KinRecordChipTone,
  type kinTaskWith,
  kinProjectNoteLine,
  kinTaskActivity,
  kinTaskLinkProblem,
} from "@t3tools/client-runtime/kin/kinTaskRecord";
import {
  kinWorkActorName,
  kinWorkAvatar,
  type KinWorkNames,
} from "@t3tools/client-runtime/kin/kinWork";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  KIN_RECORD_COMMENT_FILES_MAX,
  KIN_RECORD_COMMENT_MAX,
  type KinRecordComment,
  type KinRecordDetail,
  type KinRecordKey,
} from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import {
  ArrowUpIcon,
  CalendarIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  ClockIcon,
  FileTextIcon,
  FolderIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useId, useRef, useState } from "react";

import { ComposerAttachButton } from "../components/chat/ComposerAttachmentStrip";
import { shouldHandleComposerAttachmentPaste } from "../components/chat/composerAttachmentFiles";
import { ComposerSurface } from "../components/chat/ComposerSurface";
import { ExpandedImageDialogHost } from "../components/chat/ExpandedImageDialog";
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
import { Input } from "../components/ui/input";
import { Menu, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { KinComposerAttachmentStrip, useKinComposerAttachments } from "./KinComposerAttachments";
import { KinMessageAttachments } from "./KinMessageAttachments";
import { kinClient } from "./kinClient";
import { kinDraftAtom, kinDraftKey } from "./kinDraft";
import { type KinNoteSend, kinTaskNoteThread } from "./kinTaskNotes";
import { useKinHostAt } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

type TaskTarget = KinWorkTarget & { readonly itemKey: KinRecordKey };

const WAITING = { send: KIN_TASK_RECORD.waitingSend, question: KIN_TASK_RECORD.waitingQuestion };

/**
 * What this browser holds for one task's notes: sends the host hasn't taken, notes posted since
 * the sheet was read, and removals it answered. Kept per task so closing the sheet loses nothing.
 */
interface TaskNotes {
  readonly sending: ReadonlyArray<KinNoteSend>;
  readonly posted: ReadonlyArray<KinRecordComment>;
  readonly answers: ReadonlyArray<KinRecordComment>;
}
const NO_NOTES: TaskNotes = { sending: [], posted: [], answers: [] };
const taskNotesAtom = Atom.family((_key: string) =>
  Atom.make<TaskNotes>(NO_NOTES).pipe(Atom.keepAlive, Atom.withLabel("kin:task-notes")),
);
const notesKey = (target: TaskTarget) =>
  `${target.environmentId}:${target.orgId}:${target.itemKey}`;
const updateNotes = (target: TaskTarget, change: (notes: TaskNotes) => TaskNotes) => {
  const atom = taskNotesAtom(notesKey(target));
  appAtomRegistry.set(atom, change(appAtomRegistry.get(atom)));
};
const itemAtomOf = (target: TaskTarget) =>
  kinClient.workItem({
    environmentId: target.environmentId,
    input: { orgId: target.orgId, key: target.itemKey },
  });

/** Posts a note, or posts it again under the same id after a failure, so it lands once. */
function useKinTaskNotePost(target: TaskTarget) {
  const comment = useAtomCommand(kinClient.workComment, { reportFailure: false });
  return async (note: KinNoteSend) => {
    const sending = { ...note, status: "sending" as const, problem: null, retry: false };
    updateNotes(target, (notes) => ({
      ...notes,
      sending: notes.sending.some((one) => one.clientRequestId === note.clientRequestId)
        ? notes.sending.map((one) => (one.clientRequestId === note.clientRequestId ? sending : one))
        : [...notes.sending, sending],
    }));
    const outcome = await comment({
      environmentId: target.environmentId,
      input: {
        orgId: target.orgId,
        key: target.itemKey,
        clientRequestId: note.clientRequestId,
        body: note.body,
        ...(note.attachments.length === 0 ? {} : { attachments: note.attachments }),
      },
    });
    if (AsyncResult.isFailure(outcome)) {
      const failure = kinFailure(squashAtomCommandFailure(outcome), KIN_TASK_NOTE_COPY.notAdded);
      updateNotes(target, (notes) => ({
        ...notes,
        sending: notes.sending.map((one) =>
          one.clientRequestId === note.clientRequestId
            ? { ...one, status: "failed", problem: failure.text, retry: failure.retry }
            : one,
        ),
      }));
      return;
    }
    updateNotes(target, (notes) => ({
      ...notes,
      sending: notes.sending.filter((one) => one.clientRequestId !== note.clientRequestId),
      posted: [...notes.posted, outcome.value.comment],
    }));
    appAtomRegistry.refresh(itemAtomOf(target));
  };
}

const CHIP: Record<
  KinRecordChipTone,
  {
    readonly variant: "warning" | "info" | "error" | "success" | "secondary";
    readonly Icon: typeof ClockIcon;
  }
> = {
  wait: { variant: "warning", Icon: ClockIcon },
  doing: { variant: "info", Icon: CircleDotIcon },
  late: { variant: "error", Icon: CircleAlertIcon },
  done: { variant: "success", Icon: CircleCheckIcon },
  plain: { variant: "secondary", Icon: CircleDotIcon },
};

/** Where the task stands for this viewer, in a word or two, above its title. */
export function KinRecordChip(props: { readonly tone: KinRecordChipTone; readonly label: string }) {
  const { variant, Icon } = CHIP[props.tone];
  return (
    <Badge variant={variant}>
      <Icon aria-hidden />
      {props.label}
    </Badge>
  );
}

/**
 * The one thing that moves the task for this viewer, under its title: who has the move, their
 * latest words, the draft or question waiting on it, and its actions (`children`).
 */
export function KinNextStepCard(props: {
  readonly step: KinNextStepView;
  readonly footnote: string | null;
  readonly children: React.ReactNode;
}) {
  const { step } = props;
  return (
    <section
      aria-label="Next step"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        {step.who === null ? null : <KinAvatar avatar={step.who.avatar} size="xs" />}
        <span className="min-w-0">
          {step.who === null ? null : (
            <span className="font-medium text-foreground">{step.who.name} </span>
          )}
          {step.line}
          {step.when === null ? null : ` · ${step.when}`}
        </span>
      </p>
      {step.words === null ? null : (
        <p className="whitespace-pre-wrap text-sm text-foreground">“{step.words}”</p>
      )}
      {step.waiting === null ? null : (
        <div className="flex flex-col gap-1 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
          <p className="text-xs text-muted-foreground">{WAITING[step.waiting.kind]}</p>
          <p className="line-clamp-3 text-foreground">{step.waiting.preview}</p>
          {step.waiting.files.map((file) => (
            <p
              key={file.name}
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            >
              <FileTextIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{file.name}</span>
            </p>
          ))}
        </div>
      )}
      {props.children}
      {[step.note, props.footnote].map((line) =>
        line === null ? null : (
          <p key={line} className="text-xs text-muted-foreground">
            {line}
          </p>
        ),
      )}
    </section>
  );
}

const ACTIVITY_ICON: Record<KinActivityIcon, typeof ClockIcon> = {
  made: PlusIcon,
  gave: UserIcon,
  due: CalendarIcon,
  brief: PencilIcon,
  title: PencilIcon,
  state: CircleCheckIcon,
  link: LinkIcon,
  change: PencilIcon,
};

/** What follows the name: "gave it to Zoya, via Chief of staff · 3 Nov", or a note's time alone. */
const activityTail = (line: KinActivityLine) => {
  const said = [line.text, line.via === null ? "" : `via ${line.via}`]
    .filter((part) => part !== "")
    .join(", ");
  return said === "" ? `· ${line.when}` : `${said} · ${line.when}`;
};

/**
 * A task's Activity: changes and notes in one thread, oldest first, with earlier notes read on
 * asking, notes still sending or that failed, and Remove where the host allows it. It reads its
 * own notes, so typing in the note box below never redraws it.
 */
export function KinTaskActivity(
  props: TaskTarget & {
    readonly item: Pick<KinRecordDetail, "changes" | "comments" | "olderComments" | "projectNote">;
    readonly names: KinWorkNames;
    readonly now: Date;
    readonly note: string | null;
    readonly onOpenProject: (key: KinRecordKey) => void;
  },
) {
  const { environmentId, orgId, itemKey, names } = props;
  const local = useAtomValue(taskNotesAtom(notesKey(props)));
  const [earlier, setEarlier] = useState<{
    readonly comments: ReadonlyArray<KinRecordComment>;
    readonly more: boolean;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const readOlder = useAtomCommand(kinClient.workComments, { reportFailure: false });
  const remove = useAtomCommand(kinClient.workCommentRemove, { reportFailure: false });
  const post = useKinTaskNotePost(props);
  const host = useKinHostAt(environmentId);
  const connected = host._tag === "host" && host.connected;
  const thread = kinTaskNoteThread({
    sheet: props.item.comments ?? [],
    sheetOlder: props.item.olderComments === true,
    earlier,
    posted: local.posted,
    answers: local.answers,
  });
  const authors = new Map(thread.comments.map((one) => [one.commentId, one.by]));
  const lines = kinTaskActivity(
    { changes: props.item.changes, comments: thread.comments },
    names,
    props.now,
  );
  const previewKey = `kin-task:${environmentId}:${itemKey}`;
  const me = names.me === null ? null : ({ _tag: "person", personId: names.me } as const);

  const loadOlder = async () => {
    const before = thread.comments[0]?.seq;
    if (before === undefined) return;
    setLoadingOlder(true);
    setProblem(null);
    const outcome = await readOlder({
      environmentId,
      input: { orgId, key: itemKey, beforeSeq: before },
    });
    setLoadingOlder(false);
    if (AsyncResult.isFailure(outcome))
      return setProblem(
        kinFailureText(squashAtomCommandFailure(outcome), KIN_TASK_NOTE_COPY.olderFailed),
      );
    setEarlier({
      comments: [...outcome.value.comments, ...thread.comments.filter((one) => one.seq > before)],
      more: outcome.value.older,
    });
  };

  const confirmRemove = async (commentId: string) => {
    setRemoving(null);
    setProblem(null);
    const outcome = await remove({ environmentId, input: { orgId, key: itemKey, commentId } });
    if (AsyncResult.isFailure(outcome))
      return setProblem(
        kinFailureText(squashAtomCommandFailure(outcome), KIN_TASK_NOTE_COPY.notRemoved),
      );
    updateNotes(props, (notes) => ({
      ...notes,
      answers: [...notes.answers, outcome.value.comment],
    }));
    appAtomRegistry.refresh(itemAtomOf(props));
  };

  return (
    <section aria-label={KIN_TASK_RECORD.activity} className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-muted-foreground">{KIN_TASK_RECORD.activity}</h3>
      {props.note === null ? null : <p className="text-xs text-muted-foreground">{props.note}</p>}
      {props.item.projectNote === undefined ? null : (
        <KinProjectNoteRow
          line={kinProjectNoteLine(props.item.projectNote, names, props.now)}
          onOpenProject={props.onOpenProject}
        />
      )}
      {!thread.more ? null : (
        <div>
          <Button
            size="xs"
            variant="ghost"
            disabled={loadingOlder || !connected}
            aria-busy={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {KIN_TASK_RECORD.older}
          </Button>
        </div>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      {lines.length === 0 && local.sending.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_TASK_RECORD.noActivity}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {lines.map((line) => {
            const author = line.comment === null ? undefined : authors.get(line.comment.commentId);
            const Icon = line.icon === "comment" ? null : ACTIVITY_ICON[line.icon];
            const { comment } = line;
            return (
              <li key={line.key} className="flex gap-2.5 text-sm">
                <span className="flex w-5 shrink-0 justify-center pt-0.5">
                  {author === undefined ? (
                    Icon === null ? null : (
                      <Icon aria-hidden className="size-3.5 text-muted-foreground" />
                    )
                  ) : (
                    <KinAvatar avatar={kinWorkAvatar(author)} size="xs" />
                  )}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <p className="text-muted-foreground">
                    {line.who === null ? null : (
                      <span className="font-medium text-foreground">{line.who} </span>
                    )}
                    {activityTail(line)}
                  </p>
                  {comment === null || comment.removed ? null : (
                    <>
                      {comment.body === "" ? null : (
                        <p className="whitespace-pre-wrap wrap-break-word text-foreground">
                          {comment.body}
                        </p>
                      )}
                      {comment.files.length === 0 ? null : (
                        <KinMessageAttachments
                          environmentId={environmentId}
                          attachments={comment.files}
                          previewKey={previewKey}
                        />
                      )}
                      {!comment.canRemove ? null : (
                        <div>
                          <Button
                            size="xs"
                            variant="ghost-muted"
                            aria-label={KIN_TASK_NOTE_COPY.removeLabel}
                            onClick={() => setRemoving(comment.commentId)}
                          >
                            {KIN_TASK_NOTE_COPY.remove}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                  {line.before === null && line.after === null ? null : (
                    <div className="flex flex-col gap-1 rounded-lg bg-muted/60 px-2.5 py-2 text-xs">
                      {line.before === null ? null : (
                        <p className="line-clamp-2 whitespace-pre-wrap text-muted-foreground line-through">
                          <span className="sr-only">Before: </span>
                          {line.before}
                        </p>
                      )}
                      {line.after === null ? null : (
                        <p className="line-clamp-2 whitespace-pre-wrap text-foreground">
                          <span className="sr-only">After: </span>
                          {line.after}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
          {local.sending.map((note) => (
            <li key={note.clientRequestId} className="flex gap-2.5 text-sm">
              <span className="flex w-5 shrink-0 justify-center pt-0.5">
                {me === null ? null : <KinAvatar avatar={kinWorkAvatar(me)} size="xs" />}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <p className="text-muted-foreground">
                  {me === null ? null : (
                    <span className="font-medium text-foreground">
                      {kinWorkActorName(me, names)}{" "}
                    </span>
                  )}
                  {note.status === "sending" ? (
                    <span role="status">· {KIN_TASK_NOTE_COPY.sending}</span>
                  ) : null}
                </p>
                {note.body === "" ? null : (
                  <p className="whitespace-pre-wrap wrap-break-word text-foreground">{note.body}</p>
                )}
                {note.attachments.length === 0 ? null : (
                  <KinMessageAttachments
                    environmentId={environmentId}
                    attachments={note.attachments}
                    previewKey={previewKey}
                    unposted
                  />
                )}
                {note.status !== "failed" ? null : (
                  <div className="flex flex-wrap items-center gap-2">
                    <p role="alert" className="text-xs text-destructive-foreground">
                      {note.problem}
                    </p>
                    {!note.retry ? null : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!connected}
                        onClick={() => void post(note)}
                      >
                        {KIN_TASK_NOTE_COPY.retry}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() =>
                        updateNotes(props, (notes) => ({
                          ...notes,
                          sending: notes.sending.filter(
                            (one) => one.clientRequestId !== note.clientRequestId,
                          ),
                        }))
                      }
                    >
                      {KIN_TASK_NOTE_COPY.discard}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      <ExpandedImageDialogHost threadKey={previewKey} />
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{KIN_TASK_NOTE_COPY.removeTitle}</AlertDialogTitle>
            <AlertDialogDescription>{KIN_TASK_RECORD.removeDetail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) void confirmRemove(removing);
              }}
            >
              {KIN_TASK_NOTE_COPY.remove}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

/** "From the project" pinned first in a task's Activity: its project's note, read-only here. */
function KinProjectNoteRow(props: {
  readonly line: ReturnType<typeof kinProjectNoteLine>;
  readonly onOpenProject: (key: KinRecordKey) => void;
}) {
  const { line } = props;
  return (
    <div aria-label={KIN_TASK_RECORD.fromProject} className="flex gap-2.5 text-sm">
      <span className="flex w-5 shrink-0 justify-center pt-0.5">
        <FolderIcon aria-hidden className="size-3.5 text-muted-foreground" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-muted-foreground">
          <span className="font-medium text-foreground">{KIN_TASK_RECORD.fromProject}</span>
          <Button size="xs" variant="link" onClick={() => props.onOpenProject(line.project.key)}>
            {line.project.title}
          </Button>
          <span>
            · {line.who}, {line.when}
          </span>
        </p>
        <p className="whitespace-pre-wrap wrap-break-word text-foreground">{line.body}</p>
      </div>
    </div>
  );
}

/** "Add a link" under a task's Linked: a web address and an optional name, by whoever may edit it. */
export function KinTaskLinkAdd(props: TaskTarget) {
  const add = useAtomCommand(kinClient.workLinkAdd, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const urlId = useId();
  const nameId = useId();
  const problem = kinTaskLinkProblem(url) ?? failed;
  const close = () => {
    setOpen(false);
    setUrl("");
    setName("");
    setFailed(null);
  };
  const save = async () => {
    if (url.trim() === "" || kinTaskLinkProblem(url) !== null) return;
    setBusy(true);
    setFailed(null);
    const outcome = await add({
      environmentId: props.environmentId,
      input: {
        orgId: props.orgId,
        key: props.itemKey,
        url: url.trim(),
        ...(name.trim() === "" ? {} : { name: name.trim() }),
      },
    });
    setBusy(false);
    if (AsyncResult.isFailure(outcome))
      return setFailed(kinFailureText(squashAtomCommandFailure(outcome), KIN_TASK_LINK.notAdded));
    close();
    appAtomRegistry.refresh(itemAtomOf(props));
  };
  if (!open)
    return (
      <div>
        <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
          <PlusIcon />
          {KIN_TASK_LINK.add}
        </Button>
      </div>
    );
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor={urlId} className="text-xs text-muted-foreground">
        {KIN_TASK_LINK.url}
      </label>
      <Input
        id={urlId}
        type="url"
        size="sm"
        autoFocus
        value={url}
        placeholder={KIN_TASK_LINK.urlPlaceholder}
        aria-invalid={problem !== null}
        onChange={(event) => setUrl(event.target.value)}
      />
      <label htmlFor={nameId} className="text-xs text-muted-foreground">
        {KIN_TASK_LINK.name}
      </label>
      <Input
        id={nameId}
        size="sm"
        value={name}
        maxLength={200}
        onChange={(event) => setName(event.target.value)}
      />
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="xs"
          disabled={busy || url.trim() === "" || kinTaskLinkProblem(url) !== null}
          aria-busy={busy}
        >
          {KIN_TASK_LINK.save}
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={close}>
          {KIN_TASK_LINK.cancel}
        </Button>
      </div>
    </form>
  );
}

/** Takes a web link off a task, by whoever may edit it. */
export function KinTaskLinkRemove(
  props: TaskTarget & { readonly url: string; readonly label: string },
) {
  const remove = useAtomCommand(kinClient.workLinkRemove, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setFailed(null);
    const outcome = await remove({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, key: props.itemKey, url: props.url },
    });
    setBusy(false);
    if (AsyncResult.isFailure(outcome))
      return setFailed(kinFailureText(squashAtomCommandFailure(outcome), KIN_TASK_LINK.notRemoved));
    appAtomRegistry.refresh(itemAtomOf(props));
  };
  return (
    <>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        disabled={busy}
        aria-busy={busy}
        aria-label={failed ?? KIN_TASK_LINK.remove(props.label)}
        onClick={() => void run()}
      >
        <XIcon />
      </Button>
      {failed === null ? null : (
        <span role="alert" className="shrink-0 text-xs text-destructive-foreground">
          {failed}
        </span>
      )}
    </>
  );
}

/**
 * "Add a note…" pinned under a task: words and files for everyone who sees it. The words and
 * files are kept like a chat's draft, so closing the task loses nothing. Enter adds the note.
 */
export function KinTaskNoteComposer(props: TaskTarget) {
  const { environmentId, orgId, itemKey } = props;
  const draftKey = kinDraftKey(environmentId, orgId, `task-${itemKey}`);
  const atom = kinDraftAtom(draftKey);
  const text = useAtomValue(atom);
  const files = useKinComposerAttachments({ environmentId, draftKey });
  const post = useKinTaskNotePost(props);
  const host = useKinHostAt(environmentId);
  const connected = host._tag === "host" && host.connected;
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const body = text.trim();
  const hasContent = body.length > 0 || files.count > 0;
  const hint =
    body.length > KIN_RECORD_COMMENT_MAX
      ? KIN_TASK_RECORD.noteTooLong(KIN_RECORD_COMMENT_MAX)
      : files.count > KIN_RECORD_COMMENT_FILES_MAX
        ? KIN_TASK_NOTE_COPY.tooMany
        : !connected && hasContent
          ? KIN_TASK_NOTE_COPY.offline
          : files.blockReason;
  const canSend = hasContent && hint === null && !uploading;
  const notice = hint ?? files.refusal;

  const send = async () => {
    const drafted = appAtomRegistry.get(atom);
    setUploading(true);
    // The words stay in the box while files upload, so a failed upload loses nothing.
    const settled = await files.settle().catch(() => null);
    setUploading(false);
    if (settled === null || settled._tag === "blocked") return;
    const note = drafted.trim();
    if (note === "" && settled.attachments.length === 0) return;
    const typed = appAtomRegistry.get(atom);
    appAtomRegistry.set(atom, typed.startsWith(drafted) ? typed.slice(drafted.length) : typed);
    files.clear();
    await post({
      clientRequestId: randomUUID(),
      body: note,
      attachments: settled.attachments,
      status: "sending",
      problem: null,
      retry: false,
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) void send();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    if (!files.canAttach || pasted.length === 0) return;
    const plainText = event.clipboardData.getData("text/plain");
    if (!shouldHandleComposerAttachmentPaste({ files: pasted, plainText })) return;
    event.preventDefault();
    void files.add(pasted);
  };

  return (
    <div className="flex flex-col gap-1">
      {notice === null ? null : (
        <p role="alert" className="px-1 text-xs text-destructive-foreground">
          {notice}
        </p>
      )}
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (canSend) void send();
              }}
            >
              <KinComposerAttachmentStrip
                environmentId={environmentId}
                draftKey={draftKey}
                state={files}
              />
              <div className="flex items-end gap-1 p-1.5">
                {files.canAttach ? (
                  <ComposerAttachButton
                    addComposerAttachments={(picked) => files.add(picked)}
                    focusComposer={() => textareaRef.current?.focus()}
                  />
                ) : null}
                <textarea
                  ref={textareaRef}
                  className="block field-sizing-content max-h-40 min-h-8 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1.5 py-1.5 text-sm leading-relaxed wrap-break-word text-foreground outline-none placeholder:text-placeholder"
                  value={text}
                  rows={1}
                  aria-label={KIN_TASK_RECORD.addNote}
                  placeholder={KIN_TASK_RECORD.addNote}
                  onChange={(event) => appAtomRegistry.set(atom, event.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                />
                <Button
                  type="submit"
                  size="icon-sm-pill"
                  disabled={!canSend}
                  aria-busy={uploading}
                  aria-label={hint ?? KIN_TASK_NOTE_COPY.send}
                >
                  <ArrowUpIcon />
                </Button>
              </div>
            </form>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}

/**
 * The With line under "Who has it": each person's picture and first name, × for a reader who may
 * change the task and Leave on their own name, and + to put someone on it (`picker`, the holder's
 * people-and-agents list), absent once the task holds as many as it takes.
 */
export function KinTaskWithLine(props: {
  readonly with: ReturnType<typeof kinTaskWith>;
  readonly saving: boolean;
  /** The menu's items: whoever can still be put on it. */
  readonly picker: React.ReactNode;
  readonly onRemove: (key: string) => void;
  readonly onLeave: () => void;
}) {
  const { people, add, full } = props.with;
  return (
    <>
      <dt className="text-muted-foreground">{KIN_TASK_WITH.label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        {people.map((who) => (
          <span key={who.key} className="flex min-w-0 items-center gap-1.5">
            <KinAvatar avatar={who.avatar} size="xs" />
            <span className="truncate text-foreground">{who.name}</span>
            {who.status === null ? null : (
              <span className="shrink-0 text-xs text-muted-foreground">{who.status}</span>
            )}
            {who.act === "remove" ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={props.saving}
                aria-label={KIN_TASK_WITH.remove(who.name)}
                onClick={() => props.onRemove(who.key)}
              >
                <XIcon />
              </Button>
            ) : who.act === "leave" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={props.saving}
                aria-label={KIN_TASK_WITH.leaveLabel}
                onClick={props.onLeave}
              >
                {KIN_TASK_WITH.leave}
              </Button>
            ) : null}
          </span>
        ))}
        {!add ? null : (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={props.saving}
                  aria-label={KIN_TASK_WITH.add}
                />
              }
            >
              <PlusIcon />
            </MenuTrigger>
            <MenuPopup align="start">{props.picker}</MenuPopup>
          </Menu>
        )}
      </dd>
      {full === null ? null : (
        <dd className="col-start-2 -mt-1 text-xs text-muted-foreground">{full}</dd>
      )}
    </>
  );
}
