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
import { KIN_WORK_STALE } from "@t3tools/client-runtime/kin/kinWork";
import type { KinDocRow, KinRecordKey } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import {
  KinWorkNotice,
  KinWorkPrivateMark,
  KinWorkRowSkeletons,
  KinWorkSection,
} from "./KinWorkParts";
import { useNowMinuteMs } from "./useKinClock";
import { useKinDocsList, useKinDocsLive, useKinDocsUnder, useKinSearch } from "./useKinDocs";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const ROW =
  "flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";

/** A doc as a row that opens it: its name, then when it last changed, by whom and how. */
function KinDocRowButton(props: {
  readonly row: KinDocRowView;
  /** Under its own client or project the row needn't name them again. */
  readonly bare?: boolean;
  readonly onOpen: () => void;
}) {
  const { row } = props;
  return (
    <button
      type="button"
      aria-label={row.accessibilityLabel}
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
  | { readonly type: "group"; readonly id: string; readonly title: string; readonly count: number }
  | { readonly type: "doc"; readonly id: string; readonly row: KinDocRow };

const DOCS_ONLY = ["docs"] as const;

/** Every doc under its client, project or keeper, with a search over what they say. */
export function KinDocsList(
  props: KinWorkTarget & {
    readonly directory: KinWorkDirectory;
    readonly stale: boolean;
    readonly onOpen: (key: KinRecordKey, section?: string) => void;
  },
) {
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const { refused, live } = useKinDocsLive(props);
  const { state, list } = useKinDocsList(props, props.stale ? null : (live?.seq ?? null));
  const { state: found, search } = useKinSearch(props, DOCS_ONLY);
  const [by, setBy] = useState<KinDocGrouping>("client");
  const { filter } = state;
  const searching = filter.text.trim() !== "";
  // Typed words narrow the list on the host, so every doc is looked through, not just these rows.
  const items: ReadonlyArray<Item> = kinDocGroups(state.records, by, names).flatMap(
    (group): ReadonlyArray<Item> => [
      { type: "group", id: `group:${group.id}`, title: group.title, count: group.rows.length },
      ...group.rows.map((row): Item => ({ type: "doc", id: row.recordId, row })),
    ],
  );
  const footer = kinDocsFooter(state.records.length, state.total, state.more);

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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <ToggleGroup
              variant="pill"
              size="sm"
              aria-label="Show"
              value={[filter.archived ? "archived" : "current"]}
              onValueChange={(value) => {
                if (value[0] === undefined) return;
                const archived = value[0] === "archived";
                list.setFilter({ ...filter, archived });
                search.setClosed(archived);
              }}
            >
              <Toggle value="current">{KIN_DOCS.current}</Toggle>
              <Toggle value="archived">{KIN_DOCS.archived}</Toggle>
            </ToggleGroup>
            <ToggleGroup
              variant="pill"
              size="sm"
              aria-label="Group by"
              value={[by]}
              onValueChange={(value) => {
                const next = KIN_DOC_GROUPINGS.find((held) => held.id === value[0]);
                if (next !== undefined) setBy(next.id);
              }}
            >
              {KIN_DOC_GROUPINGS.map((held) => (
                <Toggle key={held.id} value={held.id}>
                  {held.label}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
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
        item.type === "group" ? (
          <div className="mx-auto w-full max-w-3xl px-6 pt-4 pb-1">
            <h2 className="text-xs font-medium text-muted-foreground">
              {item.title} · {item.count}
            </h2>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4 py-1">
            <KinDocRowButton
              row={kinDocRow(item.row, names, now)}
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
