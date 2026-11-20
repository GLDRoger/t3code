import {
  useKinClientsStart,
  useKinOwnerLevel,
  useKinSeesClients,
  useKinViewerScope,
} from "./useKinOwnerLevel";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  kinWorkDraftFor,
  kinWorkPrincipalKey,
  type KinWorkDraft,
  type KinWorkRef,
  type KinWorkRowView,
} from "@t3tools/client-runtime/kin/kinWork";
import { kinWorkApplied, type KinWorkAction } from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_CLIENTS,
  KIN_CLIENT_FAILED,
  KIN_CLIENT_REFUSED,
  KIN_CLIENT_GONE,
  KIN_PROJECTS,
  KIN_PROJECTS_DEFAULT_FILTER,
  KIN_PROJECT_VIEWS,
  KIN_CLIENTS_DEFAULT_FILTER,
  KIN_CLIENTS_SHOW,
  kinClientsShowChoices,
  kinClientsQuery,
  type KinClientsFilter,
  kinClientPageView,
  kinClientRow,
  kinClientsLookedAfterChoices,
  kinClientsLookedAfterLabel,
  kinClientsNothing,
  kinProjectsByClient,
  kinProjectsNothing,
  kinWorkTimeline,
  type KinClientNextView,
  type KinClientRowView,
  type KinContactView,
  type KinOwedView,
  type KinProjectRowView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_FORM_COPY,
  kinWorkSend,
  type KinClientDraftKind,
  type KinWorkFormProblem,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import type { KinListOpen } from "@t3tools/client-runtime/kin/kinMoney";
import {
  KIN_MARKETING,
  kinCameFromLabel,
  kinContactListOfClients,
  kinContactListOfTag,
} from "@t3tools/client-runtime/kin/kinMarketing";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type {
  KinContact,
  KinPartyPage,
  KinPartyRow,
  KinRecord,
  KinRecordKey,
} from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { EllipsisIcon, MailIcon, PencilIcon, PhoneIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { KinClientContact } from "./KinClientTouches";
import { KinAsideNote, KinAttentionSection } from "./KinAttention";
import { KinDocsUnder } from "./KinDocsList";
import { KinClientDialog, KinContactDialog, KinProjectDialog } from "./KinWorkForms";
import { KinContactListDialog, KinExportListButton, useKinMarketing } from "./KinMarketing";
import { KinWorkPlaceLists } from "./KinWorkPlaceLists";
import {
  KinFilter,
  KinWorkHealthBadge,
  KinWorkNotice,
  KinLoadFailed,
  KinWorkPrivateMark,
  KinWorkProblem,
  KinWorkRowSkeletons,
  KinWorkSection,
  KinWorkTimeline,
  KinWorkStaleLine,
} from "./KinWorkParts";
import { KinWorkRow } from "./KinWorkTasks";
import { kinClient } from "./kinClient";
import { KinClientDeals } from "./KinDeals";
import { useNowMinuteMs } from "./useKinClock";
import { kinHostConnected } from "./useKinHost";
import {
  useKinClientPage,
  useKinClientsList,
  useKinProjectsList,
  useKinWorkHistory,
  type KinWorkChangesHandle,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

const ANYONE = "anyone";
const ANYWHERE = "";
const ME = "me";

/** Everyone the company sells to, works for or buys from. The Filter picks which, and whose. */
export function KinWorkClientsList(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly onOpen: (key: KinRecordKey) => void;
    /** Adds a client, or (from an empty list) a prospect. */
    readonly onAdd: ((start: KinClientDraftKind) => void) | null;
    /** The client showing beside the list, marked in it. */
    readonly selected?: KinRecordKey | null;
    /** Where it starts instead of the viewer's own start, such as a campaign's prospects. */
    readonly start?: KinClientsFilter;
  },
) {
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const scope = useKinViewerScope(props.environmentId);
  const seesClients = useKinSeesClients(props.environmentId);
  const viewerStart = useKinClientsStart(props.environmentId);
  const { state, list } = useKinClientsList(
    props,
    props.stale ? null : props.live.seq,
    props.start ?? viewerStart,
  );
  const marketing = useKinMarketing(props);
  const { filter } = state;
  const nothing = kinClientsNothing(filter, scope, names.me);
  const mine =
    filter.lookedAfter !== "anyone" &&
    filter.lookedAfter._tag === "person" &&
    filter.lookedAfter.personId === names.me;
  const someone = kinClientsLookedAfterChoices(names);
  const shown = KIN_CLIENTS_SHOW.find((one) => one.id === filter.show);
  const chip = [
    filter.show === "open" ? null : (shown?.label ?? null),
    filter.lookedAfter === "anyone"
      ? null
      : mine
        ? KIN_CLIENTS.lookedAfterMe
        : `${KIN_CLIENTS.lookedAfterBy} ${kinClientsLookedAfterLabel(filter.lookedAfter, names)}`,
    filter.cameFrom == null
      ? null
      : `${KIN_MARKETING.cameFrom}: ${kinCameFromLabel(filter.cameFrom, marketing.cameFrom)}`,
    filter.tag == null ? null : `${KIN_MARKETING.tag}: ${filter.tag}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const lookedAfterValue =
    filter.lookedAfter === "anyone" ? ANYONE : mine ? ME : kinWorkPrincipalKey(filter.lookedAfter);
  const pickLookedAfter = (value: string) =>
    list.setFilter({
      ...filter,
      lookedAfter:
        value === ANYONE || (value === ME && names.me === null)
          ? "anyone"
          : value === ME
            ? { _tag: "person", personId: names.me! }
            : (someone.find((one) => one.key === value)?.who ?? "anyone"),
    });
  return (
    <LegendList<KinPartyRow>
      data={state.records}
      keyExtractor={(row) => row.recordId}
      extraData={state}
      recycleItems
      onEndReached={() => {
        if (state.more) void list.loadMore();
      }}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-1">
          {props.stale || state.stale ? (
            <KinWorkStaleLine environmentId={props.environmentId} onRetry={list.refresh} />
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <Input
                type="search"
                aria-label={KIN_CLIENTS.search}
                placeholder={KIN_CLIENTS.search}
                value={filter.text}
                onChange={(event) => list.setFilter({ ...filter, text: event.currentTarget.value })}
              />
            </div>
            <KinFilter
              chip={chip === "" ? null : chip}
              onClear={() => list.setFilter({ ...KIN_CLIENTS_DEFAULT_FILTER, text: filter.text })}
              groups={[
                {
                  label: KIN_CLIENTS.show,
                  value: filter.show,
                  options: kinClientsShowChoices(seesClients).map((one) => ({
                    value: one.id,
                    label: one.label,
                  })),
                  onChange: (value) =>
                    list.setFilter({
                      ...filter,
                      show:
                        kinClientsShowChoices(seesClients).find((one) => one.id === value)?.id ??
                        "open",
                    }),
                  note: KIN_CLIENTS.order,
                },
                ...(seesClients
                  ? [
                      {
                        label: KIN_CLIENTS.lookedAfterBy,
                        value: lookedAfterValue,
                        options: [
                          { value: ANYONE, label: KIN_CLIENTS.anyone },
                          ...(names.me === null ? [] : [{ value: ME, label: KIN_CLIENTS.me }]),
                        ],
                        onChange: pickLookedAfter,
                      },
                      {
                        label: KIN_CLIENTS.someone,
                        value: lookedAfterValue,
                        options: [
                          { value: ANYONE, label: KIN_CLIENTS.anyone },
                          ...someone.map((one) => ({ value: one.key, label: one.name })),
                        ],
                        onChange: pickLookedAfter,
                        long: true,
                      },
                      {
                        label: KIN_MARKETING.cameFrom,
                        value: filter.cameFrom ?? ANYWHERE,
                        options: [
                          { value: ANYWHERE, label: KIN_MARKETING.cameFromAnywhere },
                          ...marketing.cameFrom.map((one) => ({
                            value: one.source,
                            label: one.label,
                            detail: one.campaign ? KIN_MARKETING.campaign : null,
                          })),
                        ],
                        onChange: (value: string) =>
                          list.setFilter({
                            ...filter,
                            cameFrom: value === ANYWHERE ? null : value,
                          }),
                        long: true,
                      },
                      {
                        label: KIN_MARKETING.tag,
                        value: filter.tag ?? ANYWHERE,
                        options: [
                          { value: ANYWHERE, label: KIN_MARKETING.anyTag },
                          ...marketing.tags.map((tag) => ({ value: tag, label: tag })),
                        ],
                        onChange: (value: string) =>
                          list.setFilter({ ...filter, tag: value === ANYWHERE ? null : value }),
                        long: true,
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        </div>
      }
      ListEmptyComponent={
        <div className="mx-auto w-full max-w-3xl px-4">
          {state.loading ? (
            <div role="status" aria-label="Loading clients">
              <KinWorkRowSkeletons />
            </div>
          ) : state.failed !== null ? (
            <KinLoadFailed
              what={KIN_CLIENTS.loadFailed}
              cause={state.failed}
              onRetry={list.refresh}
              className="py-4"
            />
          ) : (
            <KinWorkNotice
              title={nothing.title}
              detail={nothing.detail}
              {...(nothing.offerNew && props.onAdd !== null
                ? {
                    action: (
                      <Button onClick={() => props.onAdd?.("prospect")}>
                        <PlusIcon />
                        {KIN_CLIENTS.addProspect}
                      </Button>
                    ),
                  }
                : {})}
            />
          )}
        </div>
      }
      ListFooterComponent={
        <>
          {!state.more ? null : (
            <KinListMore
              failed={state.moreFailed}
              loading={state.loadingMore}
              shown={`Showing ${state.records.length} of ${state.total ?? state.records.length} clients`}
              onMore={() => void list.loadMore()}
            />
          )}
          {state.records.length === 0 ? null : (
            <div className="mx-auto w-full max-w-3xl px-4 pt-3">
              <KinExportListButton
                environmentId={props.environmentId}
                orgId={props.orgId}
                input={kinContactListOfClients(kinClientsQuery(props.orgId, filter))}
              />
            </div>
          )}
        </>
      }
      renderItem={({ item }) => {
        const row = kinClientRow(item, names, now);
        return (
          <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4 py-1">
            <button
              type="button"
              aria-label={row.accessibilityLabel}
              aria-current={props.selected === row.key ? true : undefined}
              onClick={() => props.onOpen(row.key)}
              className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset aria-[current=true]:bg-accent"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm text-foreground">{row.name}</span>
                  {row.private ? <KinWorkPrivateMark /> : null}
                </span>
                <KinClientRowLine row={row} />
                {row.next === null ? null : (
                  <span
                    className={cn(
                      "truncate text-xs",
                      row.noNext ? "text-warning-foreground" : "text-muted-foreground",
                    )}
                  >
                    {row.next}
                  </span>
                )}
              </span>
              {row.late ? (
                <Badge size="sm" variant="error">
                  Late
                </Badge>
              ) : null}
            </button>
          </div>
        );
      }}
      estimatedItemSize={60}
      drawDistance={640}
      className={cn("min-h-0 flex-1 overscroll-contain pb-6", state.refreshing && "opacity-70")}
    />
  );
}

/** "Prospect · Zoya": the mark in the accent colour, then the rest of the line. */
function KinClientRowLine(props: { readonly row: KinClientRowView }) {
  const { mark, line } = props.row;
  if (mark === null && line === "") return null;
  return (
    <span className="truncate text-xs text-muted-foreground">
      {mark === null ? null : <span className="font-medium text-primary">{mark}</span>}
      {mark !== null && line !== "" ? " · " : null}
      {line}
    </span>
  );
}

type ProjectsItem =
  | { readonly type: "project"; readonly id: string; readonly row: KinProjectRowView }
  | {
      readonly type: "group";
      readonly id: string;
      readonly title: string;
      /** The client the heading opens; null for projects not for a client. */
      readonly party: KinRecordKey | null;
    };

/** The Clients place's Projects tab: projects under their client, then those not for a client. */
export function KinWorkProjectsTab(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onOpenProject: (key: KinRecordKey) => void;
    readonly onAdd: (() => void) | null;
    /** The project showing beside the list, marked in it. */
    readonly selected?: KinRecordKey | null;
  },
) {
  const now = new Date(useNowMinuteMs());
  const scope = useKinViewerScope(props.environmentId);
  const { state, list } = useKinProjectsList(props, props.stale ? null : props.live.seq);
  const { filter } = state;
  const items = kinProjectsByClient(state.records, props.directory.names, now).flatMap(
    (group): ReadonlyArray<ProjectsItem> => [
      { type: "group", id: `group:${group.id}`, title: group.title, party: group.party },
      ...group.rows.map((row): ProjectsItem => ({ type: "project", id: row.key, row })),
    ],
  );
  const nothing = kinProjectsNothing(filter, scope);
  const view = KIN_PROJECT_VIEWS.find((held) => held.id === filter.view);
  return (
    <LegendList<ProjectsItem>
      data={items}
      keyExtractor={(item) => item.id}
      extraData={state}
      recycleItems
      onEndReached={() => {
        if (state.more) void list.loadMore();
      }}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-1">
          {props.stale || state.stale ? (
            <KinWorkStaleLine environmentId={props.environmentId} onRetry={list.refresh} />
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <Input
                type="search"
                aria-label={KIN_PROJECTS.search}
                placeholder={KIN_PROJECTS.search}
                value={filter.text}
                onChange={(event) => list.setFilter({ ...filter, text: event.currentTarget.value })}
              />
            </div>
            <KinFilter
              chip={filter.view === KIN_PROJECTS_DEFAULT_FILTER.view ? null : (view?.label ?? null)}
              onClear={() => list.setFilter({ ...filter, view: KIN_PROJECTS_DEFAULT_FILTER.view })}
              groups={[
                {
                  label: KIN_PROJECTS.title,
                  value: filter.view,
                  options: KIN_PROJECT_VIEWS.map((held) => ({ value: held.id, label: held.label })),
                  onChange: (value) => {
                    const next = KIN_PROJECT_VIEWS.find((held) => held.id === value);
                    if (next !== undefined) list.setFilter({ ...filter, view: next.id });
                  },
                },
              ]}
            />
          </div>
        </div>
      }
      ListEmptyComponent={
        <div className="mx-auto w-full max-w-3xl px-4">
          {state.loading ? (
            <div role="status" aria-label="Loading projects">
              <KinWorkRowSkeletons />
            </div>
          ) : state.failed !== null ? (
            <KinLoadFailed
              what={KIN_PROJECTS.loadFailed}
              cause={state.failed}
              onRetry={list.refresh}
              className="py-4"
            />
          ) : (
            <KinWorkNotice
              title={nothing.title}
              detail={nothing.detail}
              {...(nothing.offerNew && props.onAdd !== null
                ? {
                    action: (
                      <Button onClick={props.onAdd}>
                        <PlusIcon />
                        {KIN_PROJECTS.add}
                      </Button>
                    ),
                  }
                : {})}
            />
          )}
        </div>
      }
      ListFooterComponent={
        !state.more ? null : (
          <KinListMore
            failed={state.moreFailed}
            loading={state.loadingMore}
            shown={`Showing ${state.records.length} of ${state.total ?? state.records.length} projects`}
            onMore={() => void list.loadMore()}
          />
        )
      }
      renderItem={({ item }) =>
        item.type === "group" ? (
          <KinClientsGroup title={item.title} party={item.party} onOpen={props.onOpenClient} />
        ) : (
          <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4 py-0.5">
            <KinWorkProjectRow
              row={item.row}
              selected={props.selected === item.row.key}
              onOpen={() => props.onOpenProject(item.row.key)}
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

function KinListMore(props: {
  readonly failed: boolean;
  readonly loading: boolean;
  readonly shown: string;
  readonly onMore: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3">
      <p className="text-xs text-muted-foreground" role="status">
        {props.failed ? "Couldn't load more." : props.shown}
      </p>
      <Button
        size="xs"
        variant="outline"
        disabled={props.loading}
        aria-busy={props.loading}
        onClick={props.onMore}
      >
        {props.failed ? KIN_RETRY : "Show more"}
      </Button>
    </div>
  );
}

function KinClientsGroup(props: {
  readonly title: string;
  readonly party: KinRecordKey | null;
  readonly onOpen: (key: KinRecordKey) => void;
}) {
  const { party } = props;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-4 pb-1">
      {party === null ? (
        <h2 className="px-2 text-xs font-medium text-muted-foreground">{props.title}</h2>
      ) : (
        <h2>
          <Button size="xs" variant="ghost" onClick={() => props.onOpen(party)}>
            {props.title}
          </Button>
        </h2>
      )}
    </div>
  );
}

/** A project as a row that opens it, on a client's page and under its client. */
function KinWorkProjectRow(props: {
  readonly row: KinProjectRowView;
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
      className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset aria-[current=true]:bg-accent"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm text-foreground">{row.name}</span>
          {row.private ? <KinWorkPrivateMark /> : null}
        </span>
        {row.line === "" ? null : (
          <span className="truncate text-xs text-muted-foreground">{row.line}</span>
        )}
      </span>
      {row.health === null ? null : <KinWorkHealthBadge health={row.health} />}
    </button>
  );
}

type ClientDialog =
  | { readonly type: "edit" }
  | { readonly type: "contact"; readonly key: KinRecordKey | null }
  | { readonly type: "project" }
  | null;

/** One client: what is owed each way, who to reach, its projects, terms, notes and history. */
export function KinWorkClientPage(
  props: KinWorkTarget & {
    readonly clientKey: KinRecordKey;
    readonly directory: KinWorkDirectory;
    readonly changes: KinWorkChangesHandle;
    readonly choices: KinWorkChoices;
    readonly canChangeTasks: boolean;
    readonly onOpenTask: (key: KinRecordKey) => void;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onOpenProject: (key: KinRecordKey) => void;
    readonly onOpenDoc: (key: KinRecordKey) => void;
    /** Opens the task list narrowed to this client. */
    readonly onSeeAll: (party: KinWorkRef) => void;
    /** Opens the new-task form already about this client; null where tasks can't be added. */
    readonly onAddTask: ((draft: KinWorkDraft) => void) | null;
    /** Opens one of the lists agents set up, narrowed to this client. */
    readonly onOpenList: (open: KinListOpen) => void;
    /** Opens New deal already for this client; null where deals can't be added. */
    readonly onNewDeal?: ((party: KinWorkRef) => void) | null;
  },
) {
  const { state, refresh } = useKinClientPage(props, props.clientKey);
  if (state._tag === "loading")
    return (
      <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label="Loading client">
        <KinWorkRowSkeletons />
      </div>
    );
  if (state._tag === "gone") return <KinWorkNotice {...KIN_CLIENT_GONE} />;
  if (state._tag === "refused") return <KinWorkNotice {...KIN_CLIENT_REFUSED} />;
  if (state._tag === "failed")
    return (
      <KinLoadFailed
        what={KIN_CLIENT_FAILED.title}
        cause={state.cause}
        onRetry={refresh}
        className="mx-auto w-full max-w-3xl p-4"
      />
    );
  return <ClientPage {...props} page={state.value} stale={state.stale} onRefresh={refresh} />;
}

function ClientPage(
  props: Parameters<typeof KinWorkClientPage>[0] & {
    readonly page: KinPartyPage;
    readonly stale: boolean;
    readonly onRefresh: () => void;
  },
) {
  const { environmentId, orgId, page } = props;
  const { names } = props.directory;
  const { state: changed, changes } = props.changes;
  const ownerLevel = useKinOwnerLevel(environmentId);
  const update = useAtomCommand(kinClient.workClientUpdate, { reportFailure: false });
  const now = new Date(useNowMinuteMs());
  const [dialog, setDialog] = useState<ClientDialog>(null);
  const [tagList, setTagList] = useState<string | null>(null);
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const history = useKinWorkHistory(props, props.clientKey, page.seq);
  const privateId = useId();

  const applied = (records: ReadonlyArray<KinRecord>) =>
    records.map((record) => kinWorkApplied(record, changed));
  const view = kinClientPageView(
    {
      ...page,
      weOwe: { ...page.weOwe, records: applied(page.weOwe.records) },
      theyOwe: { ...page.theyOwe, records: applied(page.theyOwe.records) },
    },
    names,
    now,
    ownerLevel,
  );
  const { can } = view;
  // Clients on, or the owner level: what's owed, the contact log, notes and history show.
  const full = can.log;
  const act = (key: KinRecordKey, action: KinWorkAction) => {
    const record = [...page.weOwe.records, ...page.theyOwe.records].find(
      (held) => held.key === key,
    );
    if (record !== undefined) void changes.run(kinWorkApplied(record, changed), action, names);
  };
  const change = async (input: {
    readonly active?: boolean;
    readonly sensitive?: boolean;
    readonly prospect?: boolean;
  }) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        update({ environmentId, input: { orgId, key: view.key, rev: view.rev, ...input } }),
      noun: "client",
      name: view.name,
      own: view.key,
    });
    setBusy(false);
    if (outcome.ok) props.onRefresh();
    else {
      setProblem(outcome.problem);
      if (outcome.problem.kind === "conflict") props.onRefresh();
    }
  };
  const editingContact: KinContact | null =
    dialog?.type === "contact" && dialog.key !== null
      ? (page.contacts.find((contact) => contact.key === dialog.key) ?? null)
      : null;
  const owed = (title: string, side: KinOwedView, empty: string, add: React.ReactNode) => (
    <KinWorkSection title={side.total === 0 ? title : `${title} · ${side.total}`} action={add}>
      {side.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col">
          {side.rows.map((row: KinWorkRowView) => (
            <li key={row.key} className="border-b border-border/60 last:border-b-0">
              <KinWorkRow
                row={row}
                saving={changed.pending[row.key] !== undefined}
                onOpen={() => props.onOpenTask(row.key)}
                onAct={props.canChangeTasks ? (action) => act(row.key, action) : null}
              />
            </li>
          ))}
        </ul>
      )}
      {side.more === null ? null : (
        <div>
          <Button size="xs" variant="ghost" onClick={() => props.onSeeAll(view.ref)}>
            {side.more}
          </Button>
        </div>
      )}
    </KinWorkSection>
  );
  const addTask = (side: "ours" | "theirs", label: string) =>
    props.onAddTask === null || view.closed ? undefined : (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => props.onAddTask?.(kinWorkDraftFor({ party: view.ref, side }))}
      >
        <PlusIcon />
        {label}
      </Button>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-3 pb-8">
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-lg font-medium text-foreground">{view.name}</h2>
                {view.privacy.private ? <KinWorkPrivateMark /> : null}
              </div>
              <p className="text-sm text-muted-foreground">
                <span className={cn(view.prospect && "font-medium text-primary")}>{view.line}</span>
              </p>
              <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                {KIN_CLIENTS.lookedAfterBy}
                <KinAvatar avatar={view.lookedAfter.avatar} size="xs" />
                <span className="truncate text-foreground">{view.lookedAfter.name}</span>
              </p>
            </div>
            {can.edit || can.owner ? (
              <div className="flex shrink-0 items-center gap-1">
                {can.edit ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setDialog({ type: "edit" })}
                  >
                    <PencilIcon />
                    {KIN_CLIENTS.edit}
                  </Button>
                ) : null}
                <Menu>
                  <MenuTrigger
                    render={
                      <Button size="icon-sm" variant="ghost" aria-label="More" disabled={busy} />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {can.edit && !view.vendor ? (
                      <MenuItem onClick={() => void change({ prospect: !view.prospect })}>
                        {view.prospect ? KIN_CLIENTS.makeClient : KIN_CLIENTS.makeProspect}
                      </MenuItem>
                    ) : null}
                    {can.owner ? (
                      <MenuItem onClick={() => void change({ active: view.closed })}>
                        {view.closed ? KIN_CLIENTS.reopen : KIN_CLIENTS.close}
                      </MenuItem>
                    ) : null}
                  </MenuPopup>
                </Menu>
              </div>
            ) : null}
          </div>
          {props.stale ? (
            <KinWorkStaleLine environmentId={environmentId} onRetry={props.onRefresh} />
          ) : null}
          {problem === null ? null : (
            <KinWorkProblem problem={problem} onOpenExisting={props.onOpenClient} />
          )}
          <KinAsideNote
            environmentId={environmentId}
            orgId={orgId}
            record={view.key}
            names={names}
          />
        </div>
        <KinAttentionSection
          environmentId={environmentId}
          orgId={orgId}
          scope={{ type: "client", key: view.key }}
          names={names}
          onOpen={(to) => {
            if (to.type === "record") props.onOpenTask(to.key);
          }}
        />
        {view.nextStep === null || !full ? null : (
          <KinClientNextStep
            next={view.nextStep.next}
            onOpen={props.onOpenTask}
            add={view.closed ? null : addTask("ours", KIN_CLIENTS.addNextStep)}
          />
        )}
        {/* Tax, terms, Keep private and closing stay the owner level's. */}
        {full
          ? owed(
              KIN_CLIENTS.weOwe,
              view.weOwe,
              KIN_CLIENTS.nothingOwed,
              <span className="flex flex-wrap items-center justify-end gap-1">
                {addTask("ours", KIN_CLIENTS.addWeOwe)}
                {view.theyOwe.total === 0 ? addTask("theirs", KIN_CLIENTS.addTheyOwe) : null}
              </span>,
            )
          : null}
        {!full || view.theyOwe.total === 0
          ? null
          : owed(
              KIN_CLIENTS.theyOwe,
              view.theyOwe,
              KIN_CLIENTS.nothingOwing,
              addTask("theirs", KIN_CLIENTS.addTheyOwe),
            )}
        {!full && view.projects.length === 0 ? null : (
          <KinWorkSection
            title={KIN_CLIENTS.projects}
            action={
              can.owner && !view.closed ? (
                <Button size="xs" variant="ghost" onClick={() => setDialog({ type: "project" })}>
                  <PlusIcon />
                  {KIN_PROJECTS.add}
                </Button>
              ) : undefined
            }
          >
            {view.projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">{KIN_CLIENTS.noProjects}</p>
            ) : (
              <ul className="-mx-2 flex flex-col">
                {view.projects.map((row) => (
                  <li key={row.key}>
                    <KinWorkProjectRow row={row} onOpen={() => props.onOpenProject(row.key)} />
                  </li>
                ))}
              </ul>
            )}
          </KinWorkSection>
        )}
        {view.vendor ? null : (
          <KinClientDeals
            {...props}
            party={{ key: view.key, title: view.name }}
            closed={view.closed}
            onOpen={props.onOpenTask}
            onNew={
              props.onNewDeal == null
                ? null
                : () => props.onNewDeal?.({ key: view.key, title: view.name })
            }
          />
        )}
        <KinWorkSection
          title={KIN_CLIENTS.contacts}
          action={
            can.edit ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setDialog({ type: "contact", key: null })}
              >
                <PlusIcon />
                {KIN_CLIENTS.addContact}
              </Button>
            ) : undefined
          }
        >
          {view.contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {can.edit ? KIN_CLIENTS.noContacts : KIN_CLIENTS.noContactsYet}
            </p>
          ) : (
            <>
              <ul className="flex flex-col gap-3">
                {view.contacts.map((contact) => (
                  <li key={contact.key}>
                    <ContactRow
                      contact={contact}
                      onEdit={
                        can.edit ? () => setDialog({ type: "contact", key: contact.key }) : null
                      }
                      onTag={setTagList}
                    />
                  </li>
                ))}
              </ul>
              {full ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <KinWorkPrivateMark />
                  {KIN_CLIENTS.detailsPrivate}
                </p>
              ) : null}
            </>
          )}
        </KinWorkSection>
        <KinWorkPlaceLists
          environmentId={environmentId}
          orgId={orgId}
          place={{ party: { key: view.key, title: view.name } }}
          seq={props.stale ? null : page.seq}
          directory={props.directory}
          onOpenList={props.onOpenList}
          onOpenKey={props.onOpenTask}
        />
        <KinDocsUnder
          environmentId={props.environmentId}
          orgId={props.orgId}
          directory={props.directory}
          under={{ party: props.clientKey }}
          onOpen={props.onOpenDoc}
        />
        {view.touches === null || !full ? null : (
          <KinClientContact
            environmentId={environmentId}
            orgId={orgId}
            clientKey={view.key}
            touches={view.touches}
            lastContact={view.lastContact}
            canChange={!view.closed}
            onChanged={props.onRefresh}
          />
        )}
        {!full && view.address === null ? null : (
          <KinWorkSection
            title={KIN_CLIENTS.details}
            fold={{ summary: can.owner ? KIN_CLIENTS.detailsSummary : null }}
          >
            <div className="flex flex-col gap-6">
              {!full || view.source === null ? null : (
                <KinWorkSection title={KIN_CLIENTS.cameFrom}>
                  <p className="text-sm text-foreground">{view.source}</p>
                </KinWorkSection>
              )}
              {!full || view.tags.length === 0 ? null : (
                <KinWorkSection title={KIN_CLIENTS.tags}>
                  <p className="flex flex-wrap gap-1.5">
                    {view.tags.map((tag) => (
                      <Badge key={tag} size="sm" variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </p>
                </KinWorkSection>
              )}
              {view.address === null ? null : (
                <KinWorkSection title={KIN_WORK_FORM_COPY.party.address}>
                  <p className="whitespace-pre-wrap text-sm text-foreground">{view.address}</p>
                </KinWorkSection>
              )}
              {!can.owner || (view.vendor && view.tax === null) ? null : (
                <KinWorkSection title={KIN_CLIENTS.tax}>
                  <p
                    className={cn(
                      "text-sm",
                      view.tax === null ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {view.tax ?? KIN_CLIENTS.noTax}
                  </p>
                </KinWorkSection>
              )}
              {can.owner ? (
                <KinWorkSection title={KIN_CLIENTS.terms} action={<KinWorkPrivateMark />}>
                  {view.terms === null ? (
                    <p className="text-sm text-muted-foreground">{KIN_CLIENTS.noTerms}</p>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-foreground">{view.terms}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{KIN_CLIENTS.termsPrivate}</p>
                </KinWorkSection>
              ) : null}
              {full ? (
                <KinWorkSection title={KIN_CLIENTS.notes}>
                  {view.notes === null ? (
                    <p className="text-sm text-muted-foreground">{KIN_CLIENTS.noNotes}</p>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-foreground">{view.notes}</p>
                  )}
                </KinWorkSection>
              ) : null}
              {can.owner ? (
                <>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <Label htmlFor={privateId}>{KIN_CLIENTS.privateLabel}</Label>
                      <p className="text-xs text-muted-foreground">{view.privacy.note}</p>
                    </div>
                    <Switch
                      id={privateId}
                      checked={view.privacy.private}
                      disabled={busy}
                      onCheckedChange={(checked) => void change({ sensitive: checked })}
                    />
                  </div>
                </>
              ) : null}
            </div>
          </KinWorkSection>
        )}
        {full ? (
          <KinWorkSection title={KIN_CLIENTS.history} fold={{ summary: null }}>
            {history.state.loading ? (
              <div role="status" aria-label="Loading history">
                <KinWorkRowSkeletons />
              </div>
            ) : history.state.failed !== null ? (
              <div>
                <Button size="xs" variant="outline" onClick={history.list.refresh}>
                  Retry
                </Button>
              </div>
            ) : history.state.records.length === 0 ? (
              <p className="text-sm text-muted-foreground">{KIN_CLIENTS.noHistory}</p>
            ) : (
              <KinWorkTimeline
                lines={kinWorkTimeline(history.state.records, names, now, view.key)}
                onOpenTask={props.onOpenTask}
              />
            )}
            {history.state.more ? (
              <div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={history.state.loadingMore}
                  aria-busy={history.state.loadingMore}
                  onClick={() => void history.list.loadMore()}
                >
                  {history.state.moreFailed ? KIN_RETRY : KIN_CLIENTS.earlier}
                </Button>
              </div>
            ) : null}
          </KinWorkSection>
        ) : null}
      </div>
      {dialog?.type === "edit" ? (
        <KinClientDialog
          environmentId={environmentId}
          orgId={orgId}
          editing={page.party}
          member={!can.owner}
          onSaved={() => {
            setDialog(null);
            props.onRefresh();
          }}
          onOpenExisting={(key) => {
            setDialog(null);
            props.onOpenClient(key);
          }}
          onClose={() => setDialog(null)}
        />
      ) : tagList !== null ? (
        <KinContactListDialog
          environmentId={environmentId}
          orgId={orgId}
          input={kinContactListOfTag(orgId, tagList)}
          title={tagList}
          onOpenClient={(key) => {
            setTagList(null);
            props.onOpenClient(key);
          }}
          onClose={() => setTagList(null)}
        />
      ) : dialog?.type === "contact" ? (
        <KinContactDialog
          environmentId={environmentId}
          orgId={orgId}
          party={view.ref}
          editing={editingContact}
          onSaved={() => {
            setDialog(null);
            props.onRefresh();
          }}
          onClose={() => setDialog(null)}
        />
      ) : dialog?.type === "project" ? (
        <KinProjectDialog
          environmentId={environmentId}
          orgId={orgId}
          editing={null}
          party={view.ref}
          choices={props.choices}
          directory={props.directory}
          onSaved={(key) => {
            setDialog(null);
            props.onOpenProject(key);
          }}
          onOpenExisting={(key) => {
            setDialog(null);
            props.onOpenProject(key);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/** The page's first row: the soonest thing owed them, or that there is none, said in amber. */
function KinClientNextStep(props: {
  readonly next: KinClientNextView | null;
  readonly onOpen: (key: KinRecordKey) => void;
  readonly add: React.ReactNode;
}) {
  const { next } = props;
  return (
    <KinWorkSection title={KIN_CLIENTS.nextStep} action={next === null ? props.add : undefined}>
      {next === null ? (
        <p className="text-sm text-warning-foreground">{KIN_CLIENTS.noNextStep}</p>
      ) : (
        <button
          type="button"
          onClick={() => props.onOpen(next.key)}
          className="-mx-2 flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
        >
          <span className="text-sm text-foreground">{next.title}</span>
          <span
            className={cn(
              "text-xs",
              next.late ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {next.line}
          </span>
        </button>
      )}
    </KinWorkSection>
  );
}

const DETAIL_LINK =
  "inline-flex min-w-0 items-center gap-1.5 rounded-sm text-sm text-foreground underline-offset-2 outline-none ring-ring hover:underline focus-visible:ring-2 focus-visible:ring-inset";

/** Someone to reach: a tap on the email or the number hands it to the device's own app. */
function ContactRow(props: {
  readonly contact: KinContactView;
  readonly onEdit: (() => void) | null;
  readonly onTag: (tag: string) => void;
}) {
  const { contact } = props;
  const detail = (
    Icon: typeof MailIcon,
    value: KinContactView["emails"][number],
    label: string,
    at: number,
  ): React.ReactNode =>
    value.href === null ? (
      <span
        key={`${label}-${at}`}
        className="inline-flex min-w-0 items-center gap-1.5 text-sm text-foreground"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{value.text}</span>
      </span>
    ) : (
      <a
        key={`${label}-${at}`}
        href={value.href}
        // The main one reads as it always has; the others say which one they are.
        aria-label={`${label} ${contact.name}${at === 0 ? "" : ` at ${value.text}`}`}
        className={DETAIL_LINK}
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{value.text}</span>
      </a>
    );
  return (
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm text-foreground">
          {contact.name}
          {contact.role === null ? null : (
            <span className="text-muted-foreground"> · {contact.role}</span>
          )}
          {contact.closed ? (
            <span className="text-muted-foreground"> · No longer a contact</span>
          ) : null}
        </p>
        {contact.emails.length === 0 && contact.phones.length === 0 ? null : (
          <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
            {contact.emails.map((one, at) => detail(MailIcon, one, "Email", at))}
            {contact.phones.map((one, at) => detail(PhoneIcon, one, "Call", at))}
          </div>
        )}
        {contact.tags.length === 0 ? null : (
          <div className="flex flex-wrap gap-1.5" aria-label={KIN_MARKETING.tags}>
            {contact.tags.map((tag) => (
              <Button
                key={tag}
                type="button"
                size="micro"
                variant="outline"
                onClick={() => props.onTag(tag)}
              >
                {tag}
              </Button>
            ))}
          </div>
        )}
        {contact.notes === null ? null : (
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{contact.notes}</p>
        )}
      </div>
      {props.onEdit === null ? null : (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`${KIN_WORK_FORM_COPY.contact.editTitle}: ${contact.name}`}
          onClick={props.onEdit}
        >
          <PencilIcon />
        </Button>
      )}
    </div>
  );
}
