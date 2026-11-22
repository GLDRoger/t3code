import type { KinViewerScope } from "@t3tools/client-runtime/kin/kinViewerScope";
import { kinNothingShown } from "@t3tools/client-runtime/kin/kinViewerScope";
import { useKinViewerScope } from "./useKinOwnerLevel";
import { KIN_MORE_FAILED, KIN_RETRY, kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_DOCS,
  KIN_DOCS_ALL,
  KIN_DOCS_SHOWS,
  KIN_DOC_HOMES,
  KIN_DOC_SHELVES,
  KIN_SEARCH,
  KIN_WHAT_WE_SELL,
  kinDocLibrary,
  kinDocRow,
  kinDocUnfiled,
  kinDocsChip,
  kinDocsFooter,
  kinDocsSameShow,
  kinSearchHit,
  kinSearchNothing,
  kinWhatWeSellShown,
  kinWhatWeSellWays,
  type KinDocRowView,
  type KinWhatWeSellWay,
  type KinDocsShow,
  type KinSearchHitView,
  type KinSearchState,
} from "@t3tools/client-runtime/kin/kinDocs";
import {
  KIN_LISTS,
  kinListsIndex,
  type KinListIndexRow,
} from "@t3tools/client-runtime/kin/kinLists";
import { KIN_WORK_HOME, kinPlaceLists } from "@t3tools/client-runtime/kin/kinWorkHome";
import { kinHostLink } from "@t3tools/client-runtime/kin/kinHost";
import { kinWorkOffline } from "@t3tools/client-runtime/kin/kinWork";
import { kinListShown } from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinDocListRow, KinListDefinition, KinListId, KinRecordKey } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import {
  ArrowRightIcon,
  BookOpenIcon,
  Building2Icon,
  ChevronDownIcon,
  FileTextIcon,
  FolderInputIcon,
  MessageSquareIcon,
  TableIcon,
  Undo2Icon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import {
  KinFilter,
  KinWorkNotice,
  KinWorkPrivateMark,
  KinWorkRowSkeletons,
  KinWorkSection,
  KinLoadFailed,
  KinWorkStaleLine,
} from "./KinWorkParts";
import { KinDocFileDialog } from "./KinDocFileDialog";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { useKinHostAt } from "./useKinHost";
import { useKinDocDelete } from "./useKinDocDelete";
import {
  useKinDocsList,
  useKinDocsLive,
  useKinDocsUnder,
  useKinSearch,
  useKinWhatWeSell,
  useKinWhatWeSellStart,
} from "./useKinDocs";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const ROW =
  "flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset aria-[current=true]:bg-accent";

/** A doc as a row that opens it: its name, its kind and last change, and where it is filed. */
function KinDocRowButton(props: {
  readonly row: KinDocRowView;
  /** Under its own home the row needn't name it again. */
  readonly bare?: boolean;
  /** The one showing beside the list. */
  readonly selected?: boolean;
  readonly onOpen: () => void;
  /** An unfiled doc's one-click way to file it. */
  readonly onFile?: () => void;
  /** A deleted doc's way back, for whoever may. */
  readonly onRestore?: () => void;
  readonly restoring?: boolean;
}) {
  const { row, onFile, onRestore } = props;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        aria-label={row.accessibilityLabel}
        aria-current={props.selected === true ? true : undefined}
        onClick={props.onOpen}
        className={cn(ROW, "min-w-0")}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm text-foreground">{row.title}</span>
            {row.pinned ? (
              <Badge size="sm" variant="info">
                {KIN_WHAT_WE_SELL.pinned}
              </Badge>
            ) : null}
            {row.private ? <KinWorkPrivateMark /> : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">{row.line}</span>
          {props.bare || row.under === null ? null : (
            <span className="truncate text-xs text-muted-foreground">{row.under}</span>
          )}
          {row.deletedLine === null ? null : (
            <span className="truncate text-xs text-muted-foreground">{row.deletedLine}</span>
          )}
        </span>
        {row.archived && row.deletedLine === null ? (
          <Badge size="sm" variant="outline">
            {KIN_DOCS.archived}
          </Badge>
        ) : null}
      </button>
      {onFile === undefined ? null : (
        <Button
          size="xs"
          variant="outline"
          aria-label={`${KIN_DOC_HOMES.file} ${row.title}`}
          onClick={onFile}
        >
          <FolderInputIcon />
          {KIN_DOC_HOMES.file}
        </Button>
      )}
      {onRestore === undefined ? null : (
        <Button
          size="xs"
          variant="outline"
          aria-label={`${KIN_DOCS.restoreDoc} ${row.title}`}
          disabled={props.restoring === true}
          aria-busy={props.restoring === true}
          onClick={onRestore}
        >
          <Undo2Icon />
          {props.restoring === true ? KIN_DOCS.restoringDoc : KIN_DOCS.restoreDoc}
        </Button>
      )}
    </div>
  );
}

const WAY_ICON: Record<KinWhatWeSellWay, typeof ArrowRightIcon> = {
  website: ArrowRightIcon,
  brochure: FileTextIcon,
  talk: MessageSquareIcon,
};

/** No What we sell yet: three ways in, each starting it and opening the sales agent's chat. */
function KinWhatWeSellEmpty(props: {
  readonly agent: string;
  readonly start: (draft: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <section
      aria-label={KIN_WHAT_WE_SELL.empty.title}
      className="flex flex-col gap-2 rounded-lg bg-muted/60 px-4 py-3"
    >
      <h2 className="text-sm font-medium text-foreground">{KIN_WHAT_WE_SELL.empty.title}</h2>
      <p className="text-xs text-muted-foreground">{KIN_WHAT_WE_SELL.empty.detail}</p>
      <ul className="flex flex-col">
        {kinWhatWeSellWays(props.agent).map((way) => {
          const Icon = WAY_ICON[way.way];
          return (
            <li key={way.way}>
              <button
                type="button"
                disabled={busy}
                aria-busy={busy}
                onClick={async () => {
                  setBusy(true);
                  setFailed(false);
                  const started = await props.start(way.draft);
                  setBusy(false);
                  setFailed(!started);
                }}
                className={ROW}
              >
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm text-foreground">{way.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {failed ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {KIN_WHAT_WE_SELL.startFailed}
        </p>
      ) : null}
    </section>
  );
}

/** What a search found: each hit opens the task, client, project or doc, a doc at the section. */
export function KinSearchHits(props: {
  readonly state: KinSearchState;
  readonly onRetry: () => void;
  readonly onOpen: (hit: KinSearchHitView) => void;
  /** Hits are all docs, so none needs to say what it is. */
  readonly docsOnly?: boolean;
  readonly scope?: KinViewerScope;
}) {
  const { state } = props;
  if (state.hits === null) {
    return state.failed ? (
      <KinLoadFailed
        what={KIN_SEARCH.failed}
        cause={state.failed.cause}
        onRetry={props.onRetry}
        className="py-4"
      />
    ) : (
      <div role="status" aria-label="Searching">
        <KinWorkRowSkeletons />
      </div>
    );
  }
  const hits = state.hits.map(kinSearchHit);
  if (hits.length === 0)
    return <KinWorkNotice {...kinSearchNothing(state.answered, props.scope)} />;
  return (
    <ul className={cn("flex flex-col", state.loading && "opacity-70")} aria-label="Results">
      {state.failed ? (
        <li>
          <p role="alert" className="px-2 pb-2 text-xs text-destructive-foreground">
            {kinFailureText(state.failed.cause, `${KIN_SEARCH.failed}.`)}
          </p>
        </li>
      ) : null}
      {hits.map((hit) => (
        <li key={hit.id} className="border-b border-border/60 py-1">
          <button
            type="button"
            aria-label={hit.accessibilityLabel}
            onClick={() => props.onOpen(hit)}
            className={ROW}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm text-foreground">{hit.title}</span>
                {hit.section === null ? null : (
                  <span className="truncate text-sm text-muted-foreground">
                    › {hit.section.title}
                  </span>
                )}
                {hit.private ? <KinWorkPrivateMark /> : null}
              </span>
              {hit.snippet === null ? null : (
                <span className="line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</span>
              )}
            </span>
            {hit.closed === null ? null : (
              <Badge size="sm" variant="outline">
                {hit.closed}
              </Badge>
            )}
            {props.docsOnly ? null : (
              <span className="shrink-0 text-xs text-muted-foreground">{hit.kindLabel}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

type Item =
  | {
      readonly type: "group";
      readonly id: string;
      readonly title: string;
      readonly count: number;
      readonly lists?: true;
      readonly unfiled?: true;
    }
  | { readonly type: "recent"; readonly id: string; readonly rows: ReadonlyArray<KinDocListRow> }
  | { readonly type: "whatWeSell"; readonly id: string }
  | {
      readonly type: "doc";
      readonly id: string;
      readonly row: KinDocListRow;
      readonly bare: boolean;
    }
  | { readonly type: "list"; readonly id: string; readonly row: KinListIndexRow }
  | { readonly type: "moreLists"; readonly id: string; readonly hidden: number }
  | { readonly type: "playbooks"; readonly id: string; readonly count: number };

const DOCS_ONLY = ["docs"] as const;
const LISTS_FOLDED = 3;
const CURRENT = "current";
const ARCHIVED = "archived";
const SHOW_VALUES = KIN_DOCS_SHOWS.map((_, index) => String(index));
const showValue = (show: KinDocsShow) =>
  String(
    Math.max(
      0,
      KIN_DOCS_SHOWS.findIndex((one) => kinDocsSameShow(one.show, show)),
    ),
  );

/**
 * Docs as a library: the last few changed, the lists people keep in a section of their own, then
 * every doc under its home (each client with its projects, the company, and the unfiled), with a
 * search over what the docs say.
 */
export function KinDocsList(
  props: KinWorkTarget & {
    readonly directory: KinWorkDirectory;
    readonly stale: boolean;
    readonly onOpen: (key: KinRecordKey, section?: string) => void;
    /** Every list there is, put-away ones included; null where lists can't be read. */
    readonly lists: ReadonlyArray<KinListDefinition> | null;
    readonly onOpenList: (list: KinListId) => void;
    /** Opens the agent's chat with a message ready; null with no agent to ask. */
    readonly onAsk: ((message: string) => void) | null;
    /** The doc or list showing beside the list, marked in it. */
    readonly selected?: string | null;
  },
) {
  const { names } = props.directory;
  const { onAsk } = props;
  const now = new Date(useNowMinuteMs());
  const { refused, live } = useKinDocsLive(props);
  const { state, list } = useKinDocsList(props, props.stale ? null : (live?.seq ?? null));
  const { state: found, search } = useKinSearch(props, DOCS_ONLY);
  const [allLists, setAllLists] = useState(false);
  const [playbooksOpen, setPlaybooksOpen] = useState(false);
  const [filing, setFiling] = useState<KinDocListRow | null>(null);
  const canFile = useAtomValue(kinClient.docFile.permissionAtom(props.environmentId));
  const deleting = useKinDocDelete(props);
  const scope = useKinViewerScope(props.environmentId);
  const { filter } = state;
  const shown = kinListShown(state, kinHostLink(useKinHostAt(props.environmentId)));
  const text = filter.text.trim().toLowerCase();
  const searching = text !== "";
  const everything = filter.show._tag === "all";
  const index = kinListsIndex(kinPlaceLists(props.lists ?? []));
  const lists = (filter.archived ? index.archived : index.active).filter((row) =>
    row.name.toLowerCase().includes(text),
  );
  const shownLists = allLists ? lists : lists.slice(0, LISTS_FOLDED);
  // Lists sit beside every doc, not inside a narrowed view of them.
  const listItems: ReadonlyArray<Item> =
    !everything || props.lists === null || (lists.length === 0 && (onAsk === null || searching))
      ? []
      : [
          {
            type: "group",
            id: "group:lists",
            title: KIN_DOC_HOMES.lists,
            count: lists.length,
            lists: true,
          },
          ...shownLists.map((row): Item => ({ type: "list", id: `list:${row.list}`, row })),
          ...(lists.length > LISTS_FOLDED
            ? [
                {
                  type: "moreLists" as const,
                  id: "lists:more",
                  hidden: lists.length - LISTS_FOLDED,
                },
              ]
            : []),
        ];
  // What we sell is read on its own: pinned whatever page holds it, or its empty state's ways in.
  const pinShown = kinWhatWeSellShown(filter);
  const pinned = useKinWhatWeSell(props, pinShown);
  const starter = useKinWhatWeSellStart(props);
  const library = kinDocLibrary(state.records, pinShown ? (pinned ?? null) : null);
  const whatWeSell: ReadonlyArray<Item> =
    shown === "rows" && pinShown && pinned === null && starter !== null
      ? [{ type: "whatWeSell", id: "what-we-sell" }]
      : [];
  // Typed words narrow the list on the host, so every doc is looked through, not just these rows.
  const docItems: ReadonlyArray<Item> = library.homes.flatMap((home): ReadonlyArray<Item> => [
    {
      type: "group",
      id: `group:${home.id}`,
      title: home.title,
      count: home.rows.length,
      ...(home.kind === "unfiled" ? { unfiled: true as const } : {}),
    },
    ...home.rows.map((row): Item => ({
      type: "doc",
      id: row.recordId,
      row,
      bare: home.kind !== "client",
    })),
  ]);
  // Folded to one row on the whole library; asked for by name or words, they show as found.
  const folded = everything && !searching;
  const playbookItems: ReadonlyArray<Item> =
    library.playbooks.length === 0
      ? []
      : [
          folded
            ? { type: "playbooks", id: "playbooks", count: library.playbooks.length }
            : {
                type: "group",
                id: "group:playbooks",
                title: KIN_DOC_HOMES.playbooks,
                count: library.playbooks.length,
              },
          ...(folded && !playbooksOpen
            ? []
            : library.playbooks.map((row): Item => ({
                type: "doc",
                id: row.recordId,
                row,
                bare: true,
              }))),
        ];
  const recent: ReadonlyArray<Item> =
    everything && !searching && !filter.archived && library.recent.length > 0
      ? [{ type: "recent", id: "recent", rows: library.recent }]
      : [];
  const items = [...whatWeSell, ...recent, ...listItems, ...docItems, ...playbookItems];
  const footer = kinDocsFooter(state.records.length, state.total, state.more);
  const chip = kinDocsChip(filter);
  const show = (next: KinDocsShow) => list.setFilter({ ...filter, show: next });

  if (refused) return <KinWorkNotice {...KIN_DOCS.unavailable} />;
  return (
    <>
      <LegendList<Item>
        data={items}
        keyExtractor={(item) => item.id}
        extraData={[
          state,
          found,
          allLists,
          playbooksOpen,
          canFile,
          deleting.busy,
          props.selected,
          starter?.agent,
          pinned,
        ]}
        recycleItems
        onEndReached={() => void list.loadMore()}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-1">
            {shown === "rows" && (props.stale || state.stale) ? (
              <KinWorkStaleLine
                environmentId={props.environmentId}
                onRetry={list.refresh}
                readAt={state.readAt}
              />
            ) : null}
            <Input
              type="search"
              aria-label={KIN_DOCS.search}
              placeholder={KIN_DOCS.search}
              value={filter.text}
              onChange={(event) => {
                list.setFilter({ ...filter, text: event.currentTarget.value });
                search.setText(event.currentTarget.value);
              }}
            />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <KinFilter
                chip={chip}
                onClear={() => {
                  list.setFilter({ ...filter, show: KIN_DOCS_ALL, archived: false });
                  search.setClosed(false);
                }}
                groups={[
                  {
                    label: KIN_WORK_HOME.show,
                    value: showValue(filter.show),
                    options: KIN_DOCS_SHOWS.map((one, at) => ({
                      value: SHOW_VALUES[at] ?? "0",
                      label: one.label,
                    })),
                    onChange: (value) => {
                      const next = KIN_DOCS_SHOWS[Number(value)];
                      if (next !== undefined) show(next.show);
                    },
                  },
                  {
                    label: "Which",
                    value: filter.archived ? ARCHIVED : CURRENT,
                    options: [
                      { value: CURRENT, label: KIN_DOCS.current },
                      { value: ARCHIVED, label: KIN_DOCS.archived },
                    ],
                    onChange: (value) => {
                      const archived = value === ARCHIVED;
                      list.setFilter({ ...filter, archived });
                      search.setClosed(archived);
                    },
                  },
                ]}
              />
              {chip === null
                ? KIN_DOC_SHELVES.map((shelf) => (
                    <Button
                      key={shelf.label}
                      size="sm"
                      variant="ghost"
                      onClick={() => show(shelf.show)}
                    >
                      <Building2Icon />
                      {shelf.label}
                    </Button>
                  ))
                : null}
            </div>
            {filter.show._tag === "files" ? (
              <p className="text-xs text-muted-foreground">{KIN_DOC_HOMES.filesDetail}</p>
            ) : null}
          </div>
        }
        ListEmptyComponent={
          <div className="mx-auto w-full max-w-3xl px-4">
            {shown === "offline" ? (
              <KinWorkNotice {...kinWorkOffline("docs")} />
            ) : shown === "loading" ? (
              <div role="status" aria-label={KIN_DOCS.loading}>
                <KinWorkRowSkeletons />
              </div>
            ) : shown === "failed" ? (
              <KinLoadFailed
                what={KIN_DOCS.loadFailed}
                cause={state.failed}
                onRetry={list.refresh}
                className="py-4"
              />
            ) : (
              <KinWorkNotice
                {...(searching
                  ? KIN_DOCS.noMatch
                  : filter.archived
                    ? KIN_DOCS.emptyArchived
                    : (kinNothingShown("docs", scope) ?? KIN_DOCS.empty))}
              />
            )}
          </div>
        }
        ListFooterComponent={
          <>
            {items.length > 0 &&
            docItems.length === 0 &&
            playbookItems.length === 0 &&
            shown !== "loading" ? (
              <div className="mx-auto w-full max-w-3xl px-4 pt-4">
                {shown === "failed" ? (
                  <KinLoadFailed
                    what={KIN_DOCS.loadFailed}
                    cause={state.failed}
                    onRetry={list.refresh}
                  />
                ) : (
                  <KinWorkNotice
                    {...(shown === "offline"
                      ? kinWorkOffline("docs")
                      : searching
                        ? KIN_DOCS.noMatch
                        : filter.archived
                          ? KIN_DOCS.emptyArchived
                          : (kinNothingShown("docs", scope) ?? KIN_DOCS.empty))}
                  />
                )}
              </div>
            ) : null}
            {footer === null ? null : (
              <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3">
                <p className="text-xs text-muted-foreground" role="status">
                  {state.moreFailed ? KIN_MORE_FAILED : footer}
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={state.loadingMore}
                  aria-busy={state.loadingMore}
                  onClick={() => void list.loadMore()}
                >
                  {state.moreFailed ? KIN_RETRY : "Show more"}
                </Button>
              </div>
            )}
            {/* The passages that match, each opening its doc at that section. */}
            {searching && found.hits !== null && found.hits.length > 0 ? (
              <div className="mx-auto w-full max-w-3xl px-4 pt-4">
                <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                  {KIN_DOCS.passages}
                </h2>
                <KinSearchHits
                  state={found}
                  docsOnly
                  onRetry={search.retry}
                  onOpen={(hit) => props.onOpen(hit.key, hit.section?.id)}
                />
              </div>
            ) : null}
          </>
        }
        renderItem={({ item }) =>
          item.type === "whatWeSell" ? (
            starter === null ? null : (
              <div className="mx-auto w-full max-w-3xl px-4 pt-3">
                <KinWhatWeSellEmpty agent={starter.agent} start={starter.start} />
              </div>
            )
          ) : item.type === "recent" ? (
            <div className="mx-auto w-full max-w-3xl px-4 pt-3">
              <h2 className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
                {KIN_DOC_HOMES.recent}
              </h2>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {item.rows.map((doc) => {
                  const row = kinDocRow(doc, names, now);
                  return (
                    <li key={doc.recordId} className="min-w-0">
                      <button
                        type="button"
                        aria-label={row.accessibilityLabel}
                        aria-current={props.selected === doc.key ? true : undefined}
                        onClick={() => props.onOpen(doc.key)}
                        className="flex h-full w-full min-w-0 flex-col gap-1 rounded-lg border border-border/70 px-3 py-2 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset aria-[current=true]:bg-accent"
                      >
                        <span className="line-clamp-2 text-sm text-foreground">{row.title}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {row.under ?? KIN_DOC_HOMES.unfiled}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : item.type === "group" ? (
            <div className="mx-auto flex min-h-10 w-full max-w-3xl items-end justify-between gap-2 px-6 pt-4 pb-1">
              <h2 className="text-xs font-medium text-muted-foreground">
                {item.title} · {item.count}
              </h2>
              {item.lists === true && onAsk !== null ? (
                <Button size="xs" variant="ghost" onClick={() => onAsk(KIN_LISTS.askMessage)}>
                  <MessageSquareIcon />
                  {KIN_LISTS.ask}
                </Button>
              ) : item.unfiled === true && onAsk !== null && canFile ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onAsk(KIN_DOC_HOMES.fileAllMessage)}
                >
                  <MessageSquareIcon />
                  {KIN_DOC_HOMES.fileAll}
                </Button>
              ) : null}
            </div>
          ) : item.type === "playbooks" ? (
            <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4 py-1">
              <button
                type="button"
                aria-expanded={playbooksOpen}
                onClick={() => setPlaybooksOpen(!playbooksOpen)}
                className={ROW}
              >
                <BookOpenIcon
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-foreground">
                    {KIN_DOC_HOMES.playbooks}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {KIN_DOC_HOMES.playbooksLine(item.count)}
                  </span>
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className={
                    playbooksOpen
                      ? "mt-0.5 size-4 shrink-0 rotate-180 text-muted-foreground"
                      : "mt-0.5 size-4 shrink-0 text-muted-foreground"
                  }
                />
              </button>
            </div>
          ) : item.type === "moreLists" ? (
            <div className="mx-auto w-full max-w-3xl px-4 py-1">
              <Button size="xs" variant="ghost" onClick={() => setAllLists(!allLists)}>
                {allLists
                  ? KIN_DOC_HOMES.fewerLists
                  : `${KIN_DOC_HOMES.seeAllLists} · ${item.hidden} more`}
              </Button>
            </div>
          ) : item.type === "list" ? (
            <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4 py-1">
              <button
                type="button"
                aria-current={props.selected === item.row.list ? true : undefined}
                onClick={() => props.onOpenList(item.row.list)}
                className={ROW}
              >
                <TableIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-foreground">{item.row.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{item.row.line}</span>
                </span>
              </button>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4 py-1">
              <KinDocRowButton
                row={kinDocRow(item.row, names, now)}
                bare={item.bare}
                selected={props.selected === item.row.key}
                onOpen={() => props.onOpen(item.row.key)}
                {...(canFile && kinDocUnfiled(item.row) && filter.show._tag !== "files"
                  ? { onFile: () => setFiling(item.row) }
                  : {})}
                {...(deleting.allowed && item.row.archived && item.row.deletable === true
                  ? {
                      onRestore: () =>
                        void deleting.restore(item.row).then((ok) => ok && list.refresh()),
                      restoring: deleting.busy === item.row.key,
                    }
                  : {})}
              />
            </div>
          )
        }
        estimatedItemSize={56}
        drawDistance={640}
        className={cn("min-h-0 flex-1 overscroll-contain pb-6", state.refreshing && "opacity-70")}
      />
      {filing === null ? null : (
        <KinDocFileDialog {...props} doc={filing} onClose={() => setFiling(null)} />
      )}
    </>
  );
}

/** The docs linked to a client or a project, on its page. Nothing shows until there is one. */
export function KinDocsUnder(
  props: KinWorkTarget & {
    readonly under: Parameters<typeof useKinDocsUnder>[1];
    readonly directory: KinWorkDirectory;
    readonly onOpen: (key: KinRecordKey) => void;
  },
) {
  const now = new Date(useNowMinuteMs());
  const docs = useKinDocsUnder(props, props.under);
  if (docs === null || docs.length === 0) return null;
  return (
    <KinWorkSection title={`${KIN_DOCS.title} · ${docs.length}`}>
      <ul className="-mx-2 flex flex-col">
        {docs.map((doc) => (
          <li key={doc.recordId}>
            <KinDocRowButton
              bare
              row={kinDocRow(doc, props.directory.names, now)}
              onOpen={() => props.onOpen(doc.key)}
            />
          </li>
        ))}
      </ul>
    </KinWorkSection>
  );
}
