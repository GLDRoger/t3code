import { useAtomValue } from "@effect/atom-react";
import { KIN_DATES } from "@t3tools/client-runtime/kin/kinDates";
import {
  KIN_LISTS,
  KIN_LIST_LABEL_MAX,
  kinListChips,
  kinListColumns,
  kinListEditDraftOf,
  kinListEditInput,
  kinListFooter,
  kinListGroupings,
  kinListHeader,
  kinListNarrowings,
  kinListNothing,
  kinListRow,
  kinListStateLabel,
  kinListsIndex,
  type KinListFilter,
  type KinListRowView,
} from "@t3tools/client-runtime/kin/kinLists";
import { KIN_WORK_STALE } from "@t3tools/client-runtime/kin/kinWork";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type {
  KinListDefinition,
  KinListGroupBy,
  KinListId,
  KinRecordKey,
} from "@t3tools/contracts";
import {
  CalendarDaysIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  Settings2Icon,
  TableIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import { KinWorkNotice, KinWorkRowSkeletons, KinWorkSection } from "./KinWorkParts";
import { KinWorkStateIcon } from "./KinWorkStateIcon";
import { kinClient } from "./kinClient";
import {
  kinListsOf,
  useKinAskAgent,
  useKinListChanges,
  useKinListContext,
  useKinListEntries,
  useKinLists,
  type KinListsHandle,
} from "./useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const ROW =
  "flex w-full items-center gap-3 rounded-md px-2 py-2 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";

/** Every list an agent set up, and the one view that looks across all of them by date. */
export function KinWorkListsIndex(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly lists: KinListsHandle;
    readonly onOpenList: (list: KinListId) => void;
    readonly onDates: () => void;
  },
) {
  const [showArchived, setShowArchived] = useState(false);
  const all = useKinLists(props, {
    enabled: showArchived,
    archived: true,
    seq: props.stale ? null : props.live.seq,
  });
  const agent = useKinAskAgent(props);
  const { state } = props.lists;
  if (state._tag === "refused") return <KinWorkNotice {...KIN_LISTS.onlyOwner} />;
  if (state._tag === "failed" || state._tag === "gone") {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 p-4">
        <Alert variant="error">
          <AlertDescription>{KIN_LISTS.loadFailed}. Check your connection.</AlertDescription>
        </Alert>
        <Button size="sm" variant="outline" onClick={props.lists.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  if (state._tag === "loading") {
    return (
      <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label="Loading lists">
        <KinWorkRowSkeletons />
      </div>
    );
  }
  const index = kinListsIndex(state.value.lists);
  const archived = showArchived ? kinListsIndex(kinListsOf(all)).archived : [];
  const ask =
    agent === null ? null : (
      <Button variant="outline" size="sm" onClick={() => agent.ask(KIN_LISTS.askMessage)}>
        <MessageSquareIcon />
        {KIN_LISTS.ask}
      </Button>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-3">
        {props.stale ? (
          <p role="status" className="text-xs text-muted-foreground">
            {KIN_WORK_STALE}
          </p>
        ) : null}
        <button type="button" onClick={props.onDates} className={ROW}>
          <CalendarDaysIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm text-foreground">{KIN_DATES.title}</span>
            <span className="truncate text-xs text-muted-foreground">{KIN_DATES.summary}</span>
          </span>
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
        {index.active.length === 0 ? (
          <KinWorkNotice {...KIN_LISTS.none} {...(ask === null ? {} : { action: ask })} />
        ) : (
          <KinWorkSection title={KIN_LISTS.title} action={ask}>
            <ul className="flex flex-col">
              {index.active.map((row) => (
                <li key={row.list}>
                  <button type="button" onClick={() => props.onOpenList(row.list)} className={ROW}>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {row.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {row.line}
                    </span>
                    <ChevronRightIcon
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  </button>
                </li>
              ))}
            </ul>
          </KinWorkSection>
        )}
        {showArchived ? (
          <KinWorkSection title={KIN_LISTS.archived}>
            {all.state._tag === "loading" ? (
              <KinWorkRowSkeletons />
            ) : archived.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">Nothing has been put away.</p>
            ) : (
              <ul className="flex flex-col">
                {archived.map((row) => (
                  <li key={row.list}>
                    <button
                      type="button"
                      onClick={() => props.onOpenList(row.list)}
                      className={ROW}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                        {row.name}
                      </span>
                      <ChevronRightIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </KinWorkSection>
        ) : (
          <div>
            <Button size="xs" variant="ghost" onClick={() => setShowArchived(true)}>
              {KIN_LISTS.showArchived}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** One list, found among all of them: its page once it is known, or why there isn't one. */
export function KinWorkListPage(
  props: KinWorkTarget & {
    readonly list: KinListId;
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly initial: KinListFilter;
    readonly openKey: KinRecordKey | null;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onGone: () => void;
  },
) {
  // A list that was put away is still a page: that is where it is brought back.
  const lists = useKinLists(props, {
    enabled: true,
    archived: true,
    seq: props.stale ? null : props.live.seq,
  });
  const { state } = lists;
  if (state._tag === "refused") return <KinWorkNotice {...KIN_LISTS.onlyOwner} />;
  if (state._tag === "loading") {
    return (
      <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label="Loading list">
        <KinWorkRowSkeletons />
      </div>
    );
  }
  const def =
    state._tag === "ready" ? state.value.lists.find((one) => one.list === props.list) : undefined;
  if (def === undefined) {
    return (
      <KinWorkNotice
        title={state._tag === "ready" ? "This list isn't here" : KIN_LISTS.loadFailed}
        detail={
          state._tag === "ready"
            ? "It may have been renamed. Open Lists to see what there is."
            : "Check your connection and try again."
        }
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={state._tag === "ready" ? props.onGone : lists.refresh}
          >
            {state._tag === "ready" ? "Open Lists" : "Retry"}
          </Button>
        }
      />
    );
  }
  return <KinListEntries {...props} def={def} />;
}

type Layout = "rows" | "table";
const GROUP_NONE: KinListGroupBy = "none";

function KinListEntries(
  props: KinWorkTarget & {
    readonly def: KinListDefinition;
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly initial: KinListFilter;
    readonly openKey: KinRecordKey | null;
    readonly onOpenKey: (key: KinRecordKey) => void;
  },
) {
  const { def } = props;
  const context = useKinListContext(props, props.directory);
  const canEdit = useAtomValue(kinClient.workListUpdate.permissionAtom(props.environmentId));
  const { state, entries, totals } = useKinListEntries(
    props,
    def.list,
    props.initial,
    props.stale ? null : props.live.seq,
  );
  const [layout, setLayout] = useState<Layout>("rows");
  const [editing, setEditing] = useState(false);
  const { filter } = state;
  const header = kinListHeader(def, filter, totals, state.total);
  const rows = state.records.map((record) =>
    kinListRow(record, def, context, { party: filter.party?.key ?? null }),
  );
  const columns = kinListColumns(def, state.records);
  const narrowings = kinListNarrowings(filter);
  const groupings = kinListGroupings(def);
  const nothing = kinListNothing(def, filter);
  const footer = kinListFooter(rows.length, state.total, state.more);
  const searchId = useId();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 scrollbar-gutter-both">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-3 px-4 pt-3",
          layout === "table" ? "max-w-6xl" : "max-w-3xl",
        )}
      >
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="truncate text-base font-medium text-foreground">{def.name}</h2>
            {def.archivedAt === null ? null : (
              <p className="text-xs text-muted-foreground">
                {KIN_LISTS.archived}. {KIN_LISTS.edit.archiveDetail}
              </p>
            )}
          </div>
          {canEdit ? (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Settings2Icon />
              {KIN_LISTS.edit.title}
            </Button>
          ) : null}
        </div>
        {props.stale || state.stale ? (
          <p role="status" className="text-xs text-muted-foreground">
            {KIN_WORK_STALE}
          </p>
        ) : null}
        <div className="-mx-1 overflow-x-auto px-1 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ToggleGroup
            variant="pill"
            size="sm"
            aria-label={KIN_LISTS.entry.status}
            value={[kinListChips(def, filter).find((chip) => chip.selected)?.id ?? "all"]}
            onValueChange={(value) => {
              const chip = kinListChips(def, filter).find((held) => held.id === value[0]);
              if (chip !== undefined) entries.setFilter(chip.filter);
            }}
          >
            {kinListChips(def, filter).map((chip) => (
              <Toggle key={chip.id} value={chip.id}>
                {chip.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <Input
              id={searchId}
              type="search"
              aria-label={KIN_LISTS.search}
              placeholder={KIN_LISTS.search}
              value={filter.text}
              onChange={(event) =>
                entries.setFilter({ ...filter, text: event.currentTarget.value })
              }
            />
          </div>
          {groupings.length > 1 ? (
            <Select
              value={filter.groupBy}
              onValueChange={(value) => {
                const groupBy = groupings.find((held) => held === value) ?? GROUP_NONE;
                entries.setFilter({ ...filter, groupBy });
              }}
            >
              <SelectTrigger className="w-full min-w-0 sm:w-52" aria-label={KIN_LISTS.groupBy}>
                <SelectValue>
                  {filter.groupBy === "none"
                    ? KIN_LISTS.groupBy
                    : `By ${KIN_LISTS.group[filter.groupBy].toLowerCase()}`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {groupings.map((groupBy) => (
                  <SelectItem key={groupBy} value={groupBy}>
                    {groupBy === "none" ? "No grouping" : KIN_LISTS.group[groupBy]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          {/* A table needs width; a narrow window keeps rows. */}
          <div className="hidden md:block">
            <ToggleGroup
              aria-label="Layout"
              value={[layout]}
              onValueChange={(value) => {
                if (value[0] === "rows" || value[0] === "table") setLayout(value[0]);
              }}
            >
              <Toggle value="rows">{KIN_LISTS.rows}</Toggle>
              <Toggle value="table">
                <TableIcon />
                {KIN_LISTS.table}
              </Toggle>
            </ToggleGroup>
          </div>
        </div>
        {narrowings.length === 0 ? null : (
          <div className="flex flex-wrap gap-1.5">
            {narrowings.map((narrowing) => (
              <Button
                key={narrowing.id}
                size="xs"
                variant="outline"
                aria-label={`${narrowing.label}. Clear`}
                onClick={() => entries.setFilter(narrowing.cleared)}
              >
                {narrowing.label}
                <XIcon />
              </Button>
            ))}
          </div>
        )}
        {state.loading || state.failed !== null ? null : (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-2">
            {header.totals.map((line) => (
              <span
                key={line}
                className="text-lg font-semibold tracking-tight text-foreground tabular-nums"
              >
                {line}
              </span>
            ))}
            {header.count === null ? null : (
              <span className="text-xs text-muted-foreground tabular-nums">{header.count}</span>
            )}
          </div>
        )}
        {header.groups.length === 0 ? null : (
          <ul aria-label={KIN_LISTS.group[filter.groupBy]} className="flex flex-col">
            {header.groups.map((group) => {
              const { narrowed } = group;
              const body = (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {group.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {group.count}
                  </span>
                  <span className="flex w-32 shrink-0 flex-col items-end text-sm text-foreground tabular-nums">
                    {group.totals.map((line) => (
                      <span key={line}>{line}</span>
                    ))}
                  </span>
                </>
              );
              return (
                <li key={group.key} className="border-b border-border/60 last:border-b-0">
                  {narrowed === null ? (
                    <div className="flex items-start gap-3 px-2 py-1.5">{body}</div>
                  ) : (
                    <button
                      type="button"
                      aria-pressed={group.selected}
                      onClick={() => entries.setFilter(narrowed)}
                      className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset aria-pressed:bg-accent"
                    >
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className={cn(state.refreshing && "opacity-70")}>
          {state.loading ? (
            <div role="status" aria-label="Loading entries">
              <KinWorkRowSkeletons />
            </div>
          ) : state.failed !== null ? (
            <div className="flex flex-col items-start gap-3 py-4">
              <Alert variant="error">
                <AlertDescription>
                  {KIN_LISTS.entriesFailed}. Check your connection.
                </AlertDescription>
              </Alert>
              <Button size="sm" variant="outline" onClick={entries.refresh}>
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <KinWorkNotice {...nothing} />
          ) : layout === "table" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead key={column.id} className={cn(column.numeric && "text-right")}>
                      {column.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.key}
                    data-state={row.key === props.openKey ? "selected" : undefined}
                  >
                    {columns.map((column) => (
                      <TableCell key={column.id}>
                        <div
                          className={cn(
                            "max-w-64 truncate",
                            column.numeric && "text-right tabular-nums",
                          )}
                        >
                          {column.id === "title" ? (
                            <button
                              type="button"
                              aria-label={row.accessibilityLabel}
                              onClick={() => props.onOpenKey(row.key)}
                              className="flex max-w-full items-center gap-2 rounded-sm text-start outline-none ring-ring hover:underline focus-visible:ring-2 focus-visible:ring-inset"
                            >
                              <span className="truncate text-foreground">{row.title}</span>
                              <span className="shrink-0 text-muted-foreground">{row.key}</span>
                            </button>
                          ) : column.id === "due" && row.late ? (
                            <span className="text-destructive-foreground">
                              {row.cells[column.id]}
                            </span>
                          ) : (
                            (row.cells[column.id] ?? "")
                          )}
                        </div>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <ul className="flex flex-col">
              {rows.map((row) => (
                <li key={row.key} className="border-b border-border/60 last:border-b-0">
                  <KinListRow row={row} onOpen={() => props.onOpenKey(row.key)} />
                </li>
              ))}
            </ul>
          )}
        </div>
        {footer === null ? null : (
          <div className="flex items-center gap-3 px-2">
            <p className="text-xs text-muted-foreground" role="status">
              {state.moreFailed ? "Couldn't load more." : footer}
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={state.loadingMore}
              aria-busy={state.loadingMore}
              onClick={() => void entries.loadMore()}
            >
              {state.moreFailed ? "Try again" : "Show more"}
            </Button>
          </div>
        )}
      </div>
      {editing ? <KinListSettings {...props} def={def} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

/** An entry of any list as a row: what it is, where it stands, and its amount when it has one. */
export function KinListRow(props: { readonly row: KinListRowView; readonly onOpen: () => void }) {
  const { row } = props;
  return (
    <button
      type="button"
      aria-label={row.accessibilityLabel}
      onClick={props.onOpen}
      className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
    >
      <span className="pt-0.5">
        <KinWorkStateIcon state={row.state} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "line-clamp-2 text-sm",
            row.state === "dropped" ? "text-muted-foreground line-through" : "text-foreground",
          )}
        >
          {row.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">{row.line}</span>
      </span>
      {row.late ? (
        <Badge size="sm" variant="error">
          {KIN_LISTS.late}
        </Badge>
      ) : null}
      {row.amount === null ? null : (
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="text-sm text-foreground tabular-nums">{row.amount}</span>
          {row.owed === null ? null : (
            <span className="text-xs text-muted-foreground tabular-nums">{row.owed}</span>
          )}
        </span>
      )}
    </button>
  );
}

/** A list's own settings: what it and its statuses are called, which details it keeps, and putting it away. */
function KinListSettings(
  props: KinWorkTarget & { readonly def: KinListDefinition; readonly onClose: () => void },
) {
  const { def, orgId } = props;
  const changes = useKinListChanges(props);
  const [draft, setDraft] = useState(() => kinListEditDraftOf(def));
  const ids = { name: useId(), states: useId() };
  const locked = def.builtIn;
  const save = async () => {
    const checked = kinListEditInput(orgId, def, draft);
    if (!checked.ok) return changes.setProblem(checked.problem);
    if (checked.input === null || (await changes.send(checked.input))) props.onClose();
  };
  const change = (patch: {
    readonly archived?: boolean;
    readonly retireFields?: ReadonlyArray<string>;
    readonly restoreFields?: ReadonlyArray<string>;
  }) => changes.send({ orgId, list: def.list, rev: def.rev, ...patch });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !changes.busy) props.onClose();
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
            <DialogTitle>{KIN_LISTS.edit.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-5">
              {locked ? (
                <p className="text-sm text-muted-foreground">{KIN_LISTS.edit.builtIn}</p>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.name}>{KIN_LISTS.edit.name}</Label>
                <Input
                  id={ids.name}
                  value={draft.name}
                  maxLength={KIN_LIST_LABEL_MAX}
                  disabled={locked || changes.busy}
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </div>
              <fieldset className="flex flex-col gap-2" aria-labelledby={ids.states}>
                <legend id={ids.states} className="text-sm font-medium text-foreground">
                  {KIN_LISTS.edit.states}
                </legend>
                {def.states.map((state) => (
                  <div key={state} className="flex items-center gap-2">
                    <KinWorkStateIcon state={state} />
                    <Input
                      aria-label={`Name for ${kinListStateLabel(null, state).toLowerCase()}`}
                      value={draft.stateLabels[state] ?? ""}
                      maxLength={KIN_LIST_LABEL_MAX}
                      disabled={locked || changes.busy}
                      autoComplete="off"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          stateLabels: { ...draft.stateLabels, [state]: event.target.value },
                        })
                      }
                    />
                  </div>
                ))}
              </fieldset>
              {def.fields.length === 0 ? null : (
                <KinWorkSection title={KIN_LISTS.edit.fields}>
                  <ul className="flex flex-col gap-1">
                    {def.fields.map((field) => (
                      <li key={field.key} className="flex items-center gap-3">
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span
                            className={cn(
                              "truncate text-sm",
                              field.retired ? "text-muted-foreground" : "text-foreground",
                            )}
                          >
                            {field.label}
                          </span>
                          {field.retired ? (
                            <span className="text-xs text-muted-foreground">
                              {KIN_LISTS.edit.retired}
                            </span>
                          ) : null}
                        </span>
                        {locked ? null : (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={changes.busy}
                            onClick={() =>
                              void change(
                                field.retired
                                  ? { restoreFields: [field.key] }
                                  : { retireFields: [field.key] },
                              )
                            }
                          >
                            {field.retired ? KIN_LISTS.edit.restore : KIN_LISTS.edit.retire}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </KinWorkSection>
              )}
              {changes.problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{changes.problem}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            {locked ? null : (
              <div className="me-auto">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={changes.busy}
                  title={def.archivedAt === null ? KIN_LISTS.edit.archiveDetail : undefined}
                  onClick={() =>
                    void change({ archived: def.archivedAt === null }).then((ok) => {
                      if (ok) props.onClose();
                    })
                  }
                >
                  {def.archivedAt === null ? KIN_LISTS.edit.archive : KIN_LISTS.edit.restoreList}
                </Button>
              </div>
            )}
            <Button type="button" variant="outline" disabled={changes.busy} onClick={props.onClose}>
              {KIN_LISTS.edit.cancel}
            </Button>
            <Button type="submit" disabled={locked || changes.busy} aria-busy={changes.busy}>
              {KIN_LISTS.edit.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
