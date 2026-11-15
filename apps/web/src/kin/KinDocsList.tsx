import {
  KIN_DOCS,
  KIN_DOC_GROUPINGS,
  KIN_SEARCH,
  kinDocGroups,
  kinDocRow,
  kinDocsFooter,
  kinSearchHit,
  kinSearchNothing,
  type KinDocGrouping,
  type KinDocRowView,
  type KinSearchHitView,
  type KinSearchState,
} from "@t3tools/client-runtime/kin/kinDocs";
import {
  KIN_LISTS,
  kinListsIndex,
  type KinListIndexRow,
} from "@t3tools/client-runtime/kin/kinLists";
import { KIN_WORK_STALE } from "@t3tools/client-runtime/kin/kinWork";
import { KIN_WORK_HOME, kinPlaceLists } from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinDocRow, KinListDefinition, KinListId, KinRecordKey } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { MessageSquareIcon, TableIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
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
} from "./KinWorkParts";
import { useNowMinuteMs } from "./useKinClock";
import { useKinDocsList, useKinDocsLive, useKinDocsUnder, useKinSearch } from "./useKinDocs";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const ROW =
  "flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset aria-[current=true]:bg-accent";

/** A doc as a row that opens it: its name, then when it last changed, by whom and how. */
function KinDocRowButton(props: {
  readonly row: KinDocRowView;
  /** Under its own client or project the row needn't name them again. */
  readonly bare?: boolean;
  /** The one showing beside the list. */
  readonly selected?: boolean;
  readonly onOpen: () => void;
}) {
  const { row } = props;
  return (
    <button
      type="button"
      aria-label={row.accessibilityLabel}
      aria-current={props.selected === true ? true : undefined}
      onClick={props.onOpen}
      className={ROW}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm text-foreground">{row.title}</span>
          {row.private ? <KinWorkPrivateMark /> : null}
        </span>
        <span className="truncate text-xs text-muted-foreground">{row.line}</span>
        {props.bare || row.under === null ? null : (
          <span className="truncate text-xs text-muted-foreground">{row.under}</span>
        )}
      </span>
      {row.archived ? (
        <Badge size="sm" variant="outline">
          {KIN_DOCS.archived}
        </Badge>
      ) : null}
    </button>
  );
}

/** What a search found: each hit opens the task, client, project or doc, a doc at the section. */
export function KinSearchHits(props: {
  readonly state: KinSearchState;
  readonly onRetry: () => void;
  readonly onOpen: (hit: KinSearchHitView) => void;
  /** Hits are all docs, so none needs to say what it is. */
  readonly docsOnly?: boolean;
}) {
  const { state } = props;
  if (state.hits === null) {
    return state.failed ? (
      <div className="flex flex-col items-start gap-3 py-4">
        <Alert variant="error">
          <AlertDescription>{KIN_SEARCH.failed}</AlertDescription>
        </Alert>
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    ) : (
      <div role="status" aria-label="Searching">
        <KinWorkRowSkeletons />
      </div>
    );
  }
  const hits = state.hits.map(kinSearchHit);
  if (hits.length === 0) return <KinWorkNotice {...kinSearchNothing(state.answered)} />;
  return (
    <ul className={cn("flex flex-col", state.loading && "opacity-70")} aria-label="Results">
      {state.failed ? (
        <li>
          <p role="alert" className="px-2 pb-2 text-xs text-destructive-foreground">
            {KIN_SEARCH.failed}
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
    }
  | { readonly type: "doc"; readonly id: string; readonly row: KinDocRow }
  | { readonly type: "list"; readonly id: string; readonly row: KinListIndexRow };

const DOCS_ONLY = ["docs"] as const;
type Shown = "all" | "docs" | "lists";
const SHOWN: ReadonlyArray<{ readonly value: Shown; readonly label: string }> = [
  { value: "all", label: "Docs and lists" },
  { value: "docs", label: KIN_DOCS.title },
  { value: "lists", label: KIN_LISTS.title },
];
const CURRENT = "current";
const ARCHIVED = "archived";

/**
 * Every doc under its client, project or keeper, with the lists people keep (renewals, hiring,
 * equipment) among them, and a search over what the docs say.
 */
export function KinDocsList(
  props: KinWorkTarget & {
    readonly directory: KinWorkDirectory;
    readonly stale: boolean;
    readonly onOpen: (key: KinRecordKey, section?: string) => void;
    /** Every list there is, put-away ones included; null where lists can't be read. */
    readonly lists: ReadonlyArray<KinListDefinition> | null;
    readonly onOpenList: (list: KinListId) => void;
    readonly onAskList: (() => void) | null;
    /** The doc or list showing beside the list, marked in it. */
    readonly selected?: string | null;
  },
) {
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const { refused, live } = useKinDocsLive(props);
  const { state, list } = useKinDocsList(props, props.stale ? null : (live?.seq ?? null));
  const { state: found, search } = useKinSearch(props, DOCS_ONLY);
  const [by, setBy] = useState<KinDocGrouping>("client");
  const [shown, setShown] = useState<Shown>("all");
  const { filter } = state;
  const text = filter.text.trim().toLowerCase();
  const searching = text !== "";
  const index = kinListsIndex(kinPlaceLists(props.lists ?? []));
  const lists = (filter.archived ? index.archived : index.active).filter((row) =>
    row.name.toLowerCase().includes(text),
  );
  const listItems: ReadonlyArray<Item> =
    shown === "docs" || props.lists === null || (lists.length === 0 && props.onAskList === null)
      ? []
      : [
          {
            type: "group",
            id: "group:lists",
            title: KIN_LISTS.title,
            count: lists.length,
            lists: true,
          },
          ...lists.map((row): Item => ({ type: "list", id: `list:${row.list}`, row })),
        ];
  // Typed words narrow the list on the host, so every doc is looked through, not just these rows.
  const docItems: ReadonlyArray<Item> =
    shown === "lists"
      ? []
      : kinDocGroups(state.records, by, names).flatMap((group): ReadonlyArray<Item> => [
          { type: "group", id: `group:${group.id}`, title: group.title, count: group.rows.length },
          ...group.rows.map((row): Item => ({ type: "doc", id: row.recordId, row })),
        ]);
  const items = [...listItems, ...docItems];
  const footer =
    shown === "lists" ? null : kinDocsFooter(state.records.length, state.total, state.more);
  const chip = [
    shown === "all" ? null : SHOWN.find((held) => held.value === shown)?.label,
    filter.archived ? KIN_DOCS.archived : null,
    by === "client"
      ? null
      : `By ${KIN_DOC_GROUPINGS.find((held) => held.id === by)?.label.toLowerCase()}`,
  ].filter((part) => part != null);

  if (refused) return <KinWorkNotice {...KIN_DOCS.unavailable} />;
  return (
    <LegendList<Item>
      data={items}
      keyExtractor={(item) => item.id}
      extraData={[state, by, found]}
      recycleItems
      onEndReached={() => void list.loadMore()}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-1">
          {props.stale || state.stale ? (
            <p role="status" className="text-xs text-muted-foreground">
              {KIN_WORK_STALE}
            </p>
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
          <KinFilter
            chip={chip.length === 0 ? null : chip.join(" · ")}
            onClear={() => {
              setShown("all");
              setBy("client");
              list.setFilter({ ...filter, archived: false });
              search.setClosed(false);
            }}
            groups={[
              ...(props.lists === null
                ? []
                : [
                    {
                      label: KIN_WORK_HOME.show,
                      value: shown,
                      options: SHOWN,
                      onChange: (value: string) =>
                        setShown(SHOWN.find((held) => held.value === value)?.value ?? "all"),
                    },
                  ]),
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
              {
                label: "Group docs by",
                value: by,
                options: KIN_DOC_GROUPINGS.map((held) => ({ value: held.id, label: held.label })),
                onChange: (value) => {
                  const next = KIN_DOC_GROUPINGS.find((held) => held.id === value);
                  if (next !== undefined) setBy(next.id);
                },
              },
            ]}
          />
        </div>
      }
      ListEmptyComponent={
        <div className="mx-auto w-full max-w-3xl px-4">
          {state.loading ? (
            <div role="status" aria-label={KIN_DOCS.loading}>
              <KinWorkRowSkeletons />
            </div>
          ) : state.failed !== null ? (
            <div className="flex flex-col items-start gap-3 py-4">
              <Alert variant="error">
                <AlertDescription>{KIN_DOCS.loadFailed}. Check your connection.</AlertDescription>
              </Alert>
              <Button size="sm" variant="outline" onClick={list.refresh}>
                Retry
              </Button>
            </div>
          ) : (
            <KinWorkNotice
              {...(searching
                ? KIN_DOCS.noMatch
                : shown === "lists"
                  ? KIN_LISTS.none
                  : filter.archived
                    ? KIN_DOCS.emptyArchived
                    : KIN_DOCS.empty)}
            />
          )}
        </div>
      }
      ListFooterComponent={
        <>
          {footer === null ? null : (
            <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3">
              <p className="text-xs text-muted-foreground" role="status">
                {state.moreFailed ? "Couldn't load more." : footer}
              </p>
              <Button
                size="xs"
                variant="outline"
                disabled={state.loadingMore}
                aria-busy={state.loadingMore}
                onClick={() => void list.loadMore()}
              >
                {state.moreFailed ? "Try again" : "Show more"}
              </Button>
            </div>
          )}
          {/* The passages that match, each opening its doc at that section. */}
          {searching && shown !== "lists" && found.hits !== null && found.hits.length > 0 ? (
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
        item.type === "group" ? (
          <div className="mx-auto flex min-h-10 w-full max-w-3xl items-end justify-between gap-2 px-6 pt-4 pb-1">
            <h2 className="text-xs font-medium text-muted-foreground">
              {item.title} · {item.count}
            </h2>
            {item.lists === true && props.onAskList !== null ? (
              <Button size="xs" variant="ghost" onClick={props.onAskList}>
                <MessageSquareIcon />
                {KIN_LISTS.ask}
              </Button>
            ) : null}
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
              selected={props.selected === item.row.key}
              onOpen={() => props.onOpen(item.row.key)}
            />
          </div>
        )
      }
      estimatedItemSize={56}
      drawDistance={640}
      className={cn("min-h-0 flex-1 overscroll-contain pb-6", state.refreshing && "opacity-70")}
    />
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
