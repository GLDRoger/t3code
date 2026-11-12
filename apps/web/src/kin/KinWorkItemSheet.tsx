import { KIN_RETIRED_LABEL } from "@t3tools/client-runtime/kin/kinAgentRetire";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_ASSIGN,
  KIN_WORK_GONE,
  KIN_WORK_ITEM_FAILED,
  KIN_WORK_NEW_COPY,
  KIN_WORK_NOTES_MAX,
  KIN_WORK_PRIVATE,
  KIN_WORK_TITLE_MAX,
  kinWorkAssignees,
  kinWorkDayOf,
  kinWorkDueChoices,
  kinWorkItemState,
  kinWorkItemView,
  type KinWorkAssignee,
  type KinWorkItemView,
  type KinWorkLinkView,
  type KinWorkRef,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_COPY,
  KIN_WORK_STATE_CHOICES,
  kinWorkApplied,
  kinWorkEditMoved,
  type KinWorkAction,
  type KinWorkEdit,
  type KinWorkNotice,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_RECORD_CHANGES_CAP,
  type KinRecordDetail,
  type KinRecordKey,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  LinkIcon,
  ListChecksIcon,
  MessageSquareIcon,
  NotebookTextIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useId } from "react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Calendar } from "../components/ui/calendar";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
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
import { Textarea } from "../components/ui/textarea";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { KinAvatar } from "./KinAvatar";
import { KinListEntry } from "./KinWorkEntry";
import { KinWorkSection as Section } from "./KinWorkParts";
import { KinWorkStateIcon } from "./KinWorkStateIcon";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import {
  useKinWorkItemWatch,
  useKinWorkPlace,
  type KinWorkChangesHandle,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

const LINK_ICON: Record<KinWorkLinkView["kind"], typeof LinkIcon> = {
  pull_request: PullRequestGlyph.pullRequest,
  worker: PlayIcon,
  message: MessageSquareIcon,
  task: ListChecksIcon,
  note: NotebookTextIcon,
  link: LinkIcon,
};

/** One task beside the list: where it stands, who has it, what it links to and how it got here. */
export function KinWorkItemSheet(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly directory: KinWorkDirectory;
    readonly changes: KinWorkChangesHandle;
    /** The clients and projects it can go under; null on a host without them. */
    readonly choices: KinWorkChoices | null;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onOpenProject: (key: KinRecordKey) => void;
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
  const place = useKinWorkPlace(environmentId);
  const now = new Date(useNowMinuteMs());
  const state = kinWorkItemState(result, changed.answers[itemKey] ?? null);
  useKinWorkItemWatch(props, itemKey, state._tag === "ready" ? state.item.seq : null);
  const saving = changed.pending[itemKey] !== undefined;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <SheetPopup side="right">
        {state._tag === "ready" && state.item.list !== undefined ? (
          <KinListEntry
            {...props}
            item={state.item}
            view={kinWorkItemView(state.item, names, now, KIN_RECORD_CHANGES_CAP, place)}
            now={now}
            links={
              <KinWorkLinks
                {...props}
                links={kinWorkItemView(state.item, names, now, KIN_RECORD_CHANGES_CAP, place).links}
              />
            }
          />
        ) : state._tag === "ready" ? (
          <KinWorkItem
            {...props}
            item={state.item}
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
            onAct={(action) => void changes.run(state.item, action, names)}
            onUndo={() => void changes.undo(names, state.item)}
            onStartEdit={() => changes.startEdit(state.item)}
            onEdit={changes.setEdit}
            onCancelEdit={changes.cancelEdit}
            onSaveEdit={() => void changes.saveEdit(state.item, names)}
          />
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>
                {state._tag === "gone"
                  ? KIN_WORK_GONE.title
                  : state._tag === "failed"
                    ? KIN_WORK_ITEM_FAILED.title
                    : itemKey}
              </SheetTitle>
              <SheetDescription>
                {state._tag === "gone"
                  ? KIN_WORK_GONE.detail
                  : state._tag === "failed"
                    ? KIN_WORK_ITEM_FAILED.detail
                    : "Loading…"}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col items-start gap-3 px-6 pb-6">
              {state._tag === "loading" ? (
                <div className="flex w-full flex-col gap-2" role="status" aria-label="Loading task">
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-3.5 w-3/5" />
                  <Skeleton className="h-3.5 w-2/5" />
                </div>
              ) : state._tag === "failed" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => appAtomRegistry.refresh(itemAtom)}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          </>
        )}
      </SheetPopup>
    </Sheet>
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

function KinWorkItem(
  props: KinWorkTarget & {
    readonly item: KinRecordDetail;
    readonly view: KinWorkItemView;
    readonly directory: KinWorkDirectory;
    readonly now: Date;
    readonly saving: boolean;
    readonly notice: KinWorkNotice | null;
    readonly edit: KinWorkEdit | null;
    readonly canChange: boolean;
    readonly canGive: boolean;
    readonly onAct: (action: KinWorkAction) => void;
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
  const { view, environmentId, orgId, saving, edit } = props;
  const { orgs, people, names } = props.directory;
  // An older host reads and hands over; everything else needs one that takes changes.
  const change = props.canChange && view.editable ? props.onAct : null;
  const give = props.canGive ? props.onAct : null;
  const assignees = kinWorkAssignees({
    orgs,
    orgId,
    people,
    names,
    current: view.owner.principal,
  });
  const waitingOn = kinWorkAssignees({ orgs, orgId, people, names, current: view.waitingOn });
  const moved = edit === null ? null : kinWorkEditMoved(edit, props.item);
  const titleId = useId();
  const notesId = useId();
  const privateId = useId();
  const { choices } = props;
  return (
    <>
      <SheetHeader>
        <div className="flex flex-col gap-1 pe-8">
          <SheetDescription>{view.heading}</SheetDescription>
          <SheetTitle>{view.title}</SheetTitle>
        </div>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
        <div className="flex flex-col gap-3">
          {view.suggestion === null || change === null ? null : (
            <Alert variant="info">
              <AlertDescription>{view.suggestion} Keep it?</AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={() => change({ type: "decline" })}
                >
                  {KIN_WORK_COPY.decline}
                </Button>
                <Button size="xs" disabled={saving} onClick={() => change({ type: "confirm" })}>
                  {KIN_WORK_COPY.keep}
                </Button>
              </AlertAction>
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <KinWorkStateIcon state={view.state} />
            <span>{view.status}</span>
            {view.late ? (
              <Badge size="sm" variant="error">
                Late
              </Badge>
            ) : null}
            {saving ? (
              <span role="status" className="text-xs text-muted-foreground">
                {KIN_WORK_COPY.saving}
              </span>
            ) : null}
          </div>
          {change === null ? null : (
            <div className="flex flex-wrap items-center gap-2">
              {view.closed ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => change({ type: "state", state: "open" })}
                >
                  <RotateCcwIcon />
                  {KIN_WORK_COPY.reopen}
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={saving}
                    onClick={() => change({ type: "state", state: "done" })}
                  >
                    <CheckIcon />
                    {KIN_WORK_COPY.done}
                  </Button>
                  <StatusMenu view={view} waitingOn={waitingOn} saving={saving} onAct={change} />
                </>
              )}
            </div>
          )}
          {change === null || view.leadNote === null ? null : (
            <p className="text-xs text-muted-foreground">{view.leadNote}</p>
          )}
          {props.notice === null || edit !== null ? null : (
            <KinWorkNoticeLine notice={props.notice} saving={saving} onUndo={props.onUndo} />
          )}
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">With</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <KinAvatar avatar={view.owner.avatar} size="sm" />
              <span className="truncate text-foreground">{view.owner.name}</span>
              {view.owner.retired ? (
                <span className="shrink-0 text-xs text-muted-foreground">{KIN_RETIRED_LABEL}</span>
              ) : null}
            </dd>
            <dt className="text-muted-foreground">Due</dt>
            <dd className="flex min-w-0 items-center gap-2 text-foreground">
              {change === null || view.closed ? (
                <span className="first-letter:uppercase">{view.due ?? KIN_WORK_COPY.noDate}</span>
              ) : (
                <DueMenu view={view} now={props.now} saving={saving} onAct={change} />
              )}
            </dd>
            {choices === null || (change === null && view.party === null) ? null : (
              <>
                <dt className="text-muted-foreground">{KIN_WORK_NEW_COPY.clientLabel}</dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-2 text-foreground">
                  <PlaceMenu
                    label={KIN_WORK_NEW_COPY.clientLabel}
                    value={view.party}
                    choices={choices.clients}
                    saving={saving}
                    onPick={change === null ? null : (party) => change({ type: "place", party })}
                    onOpen={() => {
                      if (view.party !== null) props.onOpenClient(view.party.key);
                    }}
                  />
                  {view.party === null ? null : change === null || view.closed ? (
                    <span className="text-xs text-muted-foreground">
                      {view.side === "theirs"
                        ? KIN_WORK_NEW_COPY.sideTheirs
                        : KIN_WORK_NEW_COPY.sideOurs}
                    </span>
                  ) : (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={saving}
                            aria-label={`${KIN_WORK_NEW_COPY.sideLabel}. Change`}
                          />
                        }
                      >
                        {view.side === "theirs"
                          ? KIN_WORK_NEW_COPY.sideTheirs
                          : KIN_WORK_NEW_COPY.sideOurs}
                        <ChevronDownIcon />
                      </MenuTrigger>
                      <MenuPopup align="start">
                        <MenuItem
                          disabled={view.side === "ours"}
                          onClick={() => change({ type: "place", side: "ours" })}
                        >
                          {KIN_WORK_NEW_COPY.sideOurs}
                        </MenuItem>
                        <MenuItem
                          disabled={view.side === "theirs"}
                          onClick={() => change({ type: "place", side: "theirs" })}
                        >
                          {KIN_WORK_NEW_COPY.sideTheirs}
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  )}
                </dd>
              </>
            )}
            {choices === null || (change === null && view.project === null) ? null : (
              <>
                <dt className="text-muted-foreground">{KIN_WORK_NEW_COPY.projectLabel}</dt>
                <dd className="flex min-w-0 items-center gap-2 text-foreground">
                  <PlaceMenu
                    label={KIN_WORK_NEW_COPY.projectLabel}
                    value={view.project}
                    choices={choices.projects}
                    saving={saving}
                    onPick={
                      change === null ? null : (project) => change({ type: "place", project })
                    }
                    onOpen={() => {
                      if (view.project !== null) props.onOpenProject(view.project.key);
                    }}
                  />
                </dd>
              </>
            )}
          </dl>
          {change === null && !view.privacy.private ? null : (
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Label htmlFor={privateId}>{KIN_WORK_PRIVATE}</Label>
                <p className="text-xs text-muted-foreground">{view.privacy.note}</p>
              </div>
              <Switch
                id={privateId}
                size="sm"
                checked={view.privacy.private}
                // Its client or project keeps it private whatever its own label says.
                disabled={change === null || saving || view.privacy.inherited}
                onCheckedChange={(checked) => change?.({ type: "private", private: checked })}
              />
            </div>
          )}
          {view.given === null ? null : (
            <p className="text-xs text-muted-foreground">{view.given}</p>
          )}
          {view.remarks.map((remark) => (
            <p key={remark} className="text-xs text-muted-foreground">
              {remark}
            </p>
          ))}
        </div>
        {give === null && view.owner.principal._tag !== "agent" ? null : (
          <div className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap gap-2">
              {give === null || view.assignLabel === null ? null : (
                <GiveMenu
                  label={view.assignLabel}
                  assignees={assignees}
                  busy={saving}
                  onGive={(to) => give({ type: "give", to: to.principal })}
                />
              )}
              {give === null || !view.takeBack ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => give({ type: "takeBack" })}
                >
                  {KIN_WORK_COPY.takeBack}
                </Button>
              )}
              {view.owner.principal._tag === "agent" ? (
                <KinWorkLeadChat
                  environmentId={environmentId}
                  orgId={orgId}
                  agentId={view.owner.principal.agentId}
                  name={view.owner.name}
                  onOpen={props.onClose}
                />
              ) : null}
            </div>
            {give === null || view.assignLabel === null ? null : (
              <p className="text-xs text-muted-foreground">{KIN_WORK_ASSIGN.leadsHint}</p>
            )}
          </div>
        )}
        {edit !== null ? (
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
                maxLength={KIN_WORK_TITLE_MAX}
                autoComplete="off"
                autoFocus
                onChange={(event) => props.onEdit({ title: event.target.value })}
              />
              {moved?.title == null ? null : (
                <p className="text-xs text-muted-foreground">It now says: {moved.title}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={notesId}>Notes</Label>
              <Textarea
                id={notesId}
                rows={4}
                value={edit.notes}
                maxLength={KIN_WORK_NOTES_MAX}
                onChange={(event) => props.onEdit({ notes: event.target.value })}
              />
              {moved?.notes == null ? null : (
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                  They now say: {moved.notes}
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
        ) : view.notes === null && change === null ? null : (
          <Section
            title="Notes"
            action={
              change === null ? null : (
                <Button size="xs" variant="ghost" disabled={saving} onClick={props.onStartEdit}>
                  <PencilIcon />
                  {KIN_WORK_COPY.edit}
                </Button>
              )
            }
          >
            {view.notes === null ? (
              <p className="text-sm text-muted-foreground">No notes.</p>
            ) : (
              <p className="whitespace-pre-wrap text-sm text-foreground">{view.notes}</p>
            )}
          </Section>
        )}
        <KinWorkLinks {...props} links={view.links} />
        <Section title="History">
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
      </div>
    </>
  );
}

/** What an entry points at: the message it came from, a pull request, another entry. */
function KinWorkLinks(
  props: KinWorkTarget & {
    readonly links: ReadonlyArray<KinWorkLinkView>;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  if (props.links.length === 0) return null;
  return (
    <Section title="Links">
      <ul className="flex flex-col">
        {props.links.map((link) => (
          <li key={link.key}>
            <KinWorkLink
              link={link}
              environmentId={props.environmentId}
              orgId={props.orgId}
              onOpen={props.onClose}
              onOpenKey={props.onOpenKey}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}

const PLACE_ROW = "flex min-w-0 flex-1 truncate";

/** The client or project a task is under: pick another, take it off, or open the one it has. */
function PlaceMenu(props: {
  readonly label: string;
  readonly value: KinWorkRef | null;
  readonly choices: ReadonlyArray<KinWorkRef>;
  readonly saving: boolean;
  /** Null where the task can't be changed, which leaves only opening it. */
  readonly onPick: ((value: KinWorkRef | null) => void) | null;
  readonly onOpen: () => void;
}) {
  const { value, onPick } = props;
  if (onPick === null) {
    return value === null ? null : (
      <Button size="xs" variant="ghost" onClick={props.onOpen}>
        {value.title}
      </Button>
    );
  }
  return (
    <Menu>
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
      <MenuPopup align="start">
        {value === null ? null : (
          <>
            <MenuItem onClick={props.onOpen}>Open {value.title}</MenuItem>
            <MenuSeparator />
          </>
        )}
        {props.choices.map((choice) => (
          <MenuItem
            key={choice.key}
            disabled={choice.key === value?.key}
            onClick={() => onPick(choice)}
          >
            <span className={PLACE_ROW}>{choice.title}</span>
          </MenuItem>
        ))}
        {value === null ? null : (
          <>
            {props.choices.length === 0 ? null : <MenuSeparator />}
            <MenuItem onClick={() => onPick(null)}>{KIN_WORK_NEW_COPY.none}</MenuItem>
          </>
        )}
        {value === null && props.choices.length === 0 ? (
          <MenuItem disabled>Nothing to pick yet</MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** Where the task stands, other than done: started, waiting on someone, or not worth doing. */
function StatusMenu(props: {
  readonly view: KinWorkItemView;
  readonly waitingOn: ReturnType<typeof kinWorkAssignees>;
  readonly saving: boolean;
  readonly onAct: (action: KinWorkAction) => void;
}) {
  const { view } = props;
  const people = [...props.waitingOn.people, ...props.waitingOn.leads];
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" disabled={props.saving} />}>
        {KIN_WORK_COPY.status}
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        {KIN_WORK_STATE_CHOICES.map((choice) => (
          <MenuItem
            key={choice.state}
            disabled={view.state === choice.state}
            onClick={() => props.onAct({ type: "state", state: choice.state })}
          >
            <KinWorkStateIcon state={choice.state} />
            {choice.label}
          </MenuItem>
        ))}
        <MenuSub>
          <MenuSubTrigger>
            <KinWorkStateIcon state="waiting" />
            {KIN_WORK_COPY.waitingOn}
          </MenuSubTrigger>
          <MenuSubPopup>
            {people.map((row) => (
              <MenuItem
                key={row.key}
                disabled={row.current}
                onClick={() =>
                  props.onAct({ type: "state", state: "waiting", waitingOn: row.principal })
                }
              >
                <KinAvatar avatar={row.avatar} size="xs" />
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
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
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          onClick={() => props.onAct({ type: "state", state: "dropped" })}
        >
          <KinWorkStateIcon state="dropped" />
          {KIN_WORK_COPY.drop}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** The due date as its own control: the days people pick, any other day, or none. */
function DueMenu(props: {
  readonly view: KinWorkItemView;
  readonly now: Date;
  readonly saving: boolean;
  readonly onAct: (action: KinWorkAction) => void;
}) {
  const { view } = props;
  const picked = view.dueDay === null ? undefined : new Date(`${view.dueDay}T00:00:00`);
  return (
    <Menu>
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
        {kinWorkDueChoices(props.now).map((choice) => (
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
                if (date !== undefined) props.onAct({ type: "due", day: kinWorkDayOf(date) });
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

function GiveMenu(props: {
  readonly label: string;
  readonly assignees: ReturnType<typeof kinWorkAssignees>;
  readonly busy: boolean;
  readonly onGive: (to: KinWorkAssignee) => void;
}) {
  const { assignees } = props;
  const group = (title: string, rows: ReadonlyArray<KinWorkAssignee>) =>
    rows.length === 0 ? null : (
      <MenuGroup>
        <MenuGroupLabel>{title}</MenuGroupLabel>
        {rows.map((row) => (
          <MenuItem key={row.key} disabled={row.current} onClick={() => props.onGive(row)}>
            <KinAvatar avatar={row.avatar} size="xs" />
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            {row.current ? <span className="text-xs text-muted-foreground">Has it</span> : null}
          </MenuItem>
        ))}
      </MenuGroup>
    );
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" variant="outline" disabled={props.busy} aria-busy={props.busy} />}
      >
        {props.label}
      </MenuTrigger>
      <MenuPopup align="start">
        {group(KIN_WORK_ASSIGN.leads, assignees.leads)}
        {group(KIN_WORK_ASSIGN.people, assignees.people)}
      </MenuPopup>
    </Menu>
  );
}

/** The owner's chat with the lead that has the task, which is where it reports back. */
function KinWorkLeadChat(
  props: KinWorkTarget & {
    readonly agentId: string;
    readonly name: string;
    readonly onOpen: () => void;
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
      onClick={props.onOpen}
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
    readonly onOpen: () => void;
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
  // A lead's work opens its thread the way its task card does, beside whatever the row opens.
  const thread =
    link.thread === null ? null : (
      <Button
        size="xs"
        variant="ghost"
        onClick={props.onOpen}
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
        onClick={props.onOpen}
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
  return thread === null ? (
    row
  ) : (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">{row}</div>
      {thread}
    </div>
  );
}
