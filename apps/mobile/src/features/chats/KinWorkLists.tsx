import { KIN_MARKETING, kinContactListOfClients } from "@t3tools/client-runtime/kin/kinMarketing";
import type { KinMarketing } from "@t3tools/contracts";
import { KIN_IMPORT } from "@t3tools/client-runtime/kin/kinImport";
import { useKinClientsStart, useKinSeesClients, useKinViewerScope } from "./state/kinChatOnly";
import { KIN_MORE_FAILED, KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  KIN_CLIENTS,
  kinClientsShowChoices,
  kinClientsTabs,
  kinClientsTabShown,
  KIN_PROJECTS,
  KIN_PROJECT_VIEWS,
  kinClientRow,
  kinClientsLookedAfterChoices,
  kinClientsQuery,
  kinClientsNothing,
  type KinClientsFilter,
  kinProjectsByClient,
  kinProjectsNothing,
  type KinClientsTab,
  type KinHealthView,
  type KinProjectsFilter,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { KIN_WORK_HOME, kinWorkAskDraft } from "@t3tools/client-runtime/kin/kinWorkHome";
import { kinHostLink } from "@t3tools/client-runtime/kin/kinHost";
import { kinListShown } from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import {
  kinWorkOffline,
  kinWorkPrincipalKey,
  kinWorkSamePrincipal,
  type KinWorkNames,
} from "@t3tools/client-runtime/kin/kinWork";
import type { EnvironmentId, KinRecordKey } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { appAtomRegistry } from "../../state/atom-registry";
import { kinTabBar, useKinTab, kinTabFoot } from "./components/KinTab";
import { KinWorkLoading, KinWorkPrivateMark, KinWorkStaleNotice } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import { useKinAskAgent } from "./state/useKinMoney";
import {
  refreshKinWorkLive,
  useKinClientsList,
  useKinProjectsList,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { useKinHostAt } from "./state/useKinHost";
import { KinDealsView } from "./KinDealsList";
import { useKinExportList, useKinMarketing } from "./KinMarketing";
import { kinLines, useKinTextGrows } from "./components/kinTextGrows";

const HEALTH_TONE: Record<KinHealthView["tone"], string> = {
  good: "text-foreground-muted",
  warning: "text-foreground",
  bad: "text-danger-foreground",
};

/** How a project is going, in a word. Computed by the server, never set here. */
export function KinWorkHealthWord(props: { readonly health: KinHealthView }) {
  return (
    <Text textRole="footnote" className={cn("font-t3-medium", HEALTH_TONE[props.health.tone])}>
      {props.health.label}
    </Text>
  );
}

interface NamedRow {
  readonly key: KinRecordKey;
  readonly name: string;
  /** "Prospect", in the accent colour ahead of the line. */
  readonly mark?: string | null;
  readonly line: string;
  readonly next?: string | null;
  /** `next` says there is no next step: amber. */
  readonly noNext?: boolean;
  readonly late?: boolean;
  readonly health?: KinHealthView | null;
  readonly private: boolean;
  readonly accessibilityLabel: string;
}

/** A client or a project as a row that opens it. */
export function KinWorkNamedRow(props: {
  readonly row: NamedRow;
  readonly onPress: () => void;
  /** Inside a rounded section the divider keeps to the section's edges. */
  readonly inset?: boolean;
}) {
  const grows = useKinTextGrows();
  const { row } = props;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.accessibilityLabel}
        onPress={props.onPress}
        className={cn(
          "min-h-16 flex-row items-start gap-3 py-3 active:opacity-60",
          props.inset ? "px-4" : "px-5",
        )}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text
              textRole="body"
              numberOfLines={kinLines(2, grows)}
              className="min-w-0 shrink text-foreground"
            >
              {row.name}
            </Text>
            {row.private ? <KinWorkPrivateMark label="" /> : null}
          </View>
          {row.mark == null && row.line === "" ? null : (
            <Text
              textRole="footnote"
              numberOfLines={kinLines(1, grows)}
              className="text-foreground-muted"
            >
              {row.mark == null ? null : (
                <Text textRole="footnote" className="font-t3-medium text-primary-text">
                  {row.mark}
                </Text>
              )}
              {row.mark != null && row.line !== "" ? " · " : null}
              {row.line}
            </Text>
          )}
          {row.next == null ? null : (
            <Text
              textRole="footnote"
              numberOfLines={kinLines(1, grows)}
              className={row.noNext ? "text-warning-foreground" : "text-foreground-muted"}
            >
              {row.next}
            </Text>
          )}
        </View>
        {row.health != null ? (
          <KinWorkHealthWord health={row.health} />
        ) : row.late ? (
          <Text textRole="footnote" className="font-t3-medium text-danger-foreground">
            Late
          </Text>
        ) : null}
      </Pressable>
      <View className={cn("h-px bg-border-subtle", props.inset ? "ml-4" : "ml-5")} />
    </>
  );
}

type ListProps = KinWorkTarget & {
  readonly live: KinWorkLive;
  readonly stale: boolean;
  readonly directory: KinWorkDirectory;
};

type ListItem =
  | { readonly type: "row"; readonly id: string; readonly row: NamedRow }
  | {
      readonly type: "group";
      readonly id: string;
      readonly title: string;
      /** The client the heading opens; null for projects not for a client. */
      readonly party: KinRecordKey | null;
    };

/** Clients or projects as a list: only the rows in view mount, and more load at the foot. */
function NamedList(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  /** What the list shows, as one menu in the bar. */
  readonly menu: AppBarMenu;
  readonly ask: AppBarAction | null;
  readonly stale: boolean;
  /** Above the rows: which of Clients and Projects shows. */
  readonly header: React.ReactNode;
  readonly items: ReadonlyArray<ListItem>;
  readonly shown: number;
  readonly state: {
    readonly seq: number | null;
    readonly loading: boolean;
    readonly failed: unknown;
    readonly more: boolean;
    readonly moreFailed: boolean;
    readonly loadingMore: boolean;
    readonly total: number | null;
  };
  readonly list: { readonly refresh: () => void; readonly loadMore: () => Promise<void> | void };
  readonly search: { readonly text: string; readonly placeholder: string };
  readonly onSearch: (text: string) => void;
  readonly nothing: React.ReactNode;
  readonly add: { readonly label: string; readonly onPress: () => void } | null;
  /** Beside Add: Clients' Import a file, for the owner level. */
  readonly bring?: AppBarAction | null;
  readonly loading: string;
  readonly loadFailed: string;
  readonly extra: unknown;
  readonly onOpen: (key: KinRecordKey) => void;
  readonly onOpenClient: (key: KinRecordKey) => void;
}) {
  const navigation = useNavigation();
  const tab = useKinTab();
  const { state, list, add, items } = props;
  const shown = kinListShown(state, kinHostLink(useKinHostAt(props.environmentId)));
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={props.title}
        refresh={{ accessibilityLabel: "Refresh", onPress: list.refresh }}
        actions={[
          ...(props.ask === null ? [] : [props.ask]),
          ...(props.bring === undefined || props.bring === null ? [] : [props.bring]),
          ...(add === null
            ? []
            : [{ accessibilityLabel: add.label, icon: "plus" as const, onPress: add.onPress }]),
        ]}
        menus={[props.menu]}
        {...kinTabBar(tab, {
          onBack: () => navigation.goBack(),
          search: {
            value: props.search.text,
            onChangeText: props.onSearch,
            placeholder: props.search.placeholder,
            closeAccessibilityLabel: "Close search",
            clearAccessibilityLabel: "Clear search",
          },
        })}
      />
      <ScreenContent surface="screen">
        <LegendList<ListItem>
          renderScrollComponent={NativeScrollView}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field, or the dock, floats over the foot of the list.
          contentContainerStyle={{
            paddingBottom: tab === null ? 96 : kinTabFoot(tab.bottomClearance),
          }}
          data={items}
          keyExtractor={(item) => item.id}
          getItemType={(item) => item.type}
          extraData={props.extra}
          estimatedItemSize={72}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View className="gap-2 px-4 pt-2">
              {props.header}
              {shown === "rows" && props.stale ? (
                <KinWorkStaleNotice environmentId={props.environmentId} onRetry={list.refresh} />
              ) : null}
            </View>
          }
          ListEmptyComponent={
            <View className="px-4 pt-4">
              {shown === "offline" ? (
                <EmptyState variant="plain" {...kinWorkOffline("clients")} />
              ) : shown === "loading" ? (
                <KinWorkLoading label={props.loading} />
              ) : shown === "failed" ? (
                <KinLoadFailed
                  title={props.loadFailed}
                  cause={state.failed}
                  onRetry={list.refresh}
                />
              ) : (
                props.nothing
              )}
            </View>
          }
          ListFooterComponent={
            !state.more ? null : (
              <View className="items-start gap-2 px-5 py-4">
                <Text textRole="footnote" className="text-foreground-muted">
                  {state.moreFailed
                    ? KIN_MORE_FAILED
                    : `Showing ${props.shown} of ${state.total ?? props.shown}`}
                </Text>
                <Button
                  tone="secondary"
                  size="compact"
                  label={state.moreFailed ? KIN_RETRY : "Show more"}
                  loading={state.loadingMore}
                  disabled={state.loadingMore}
                  onPress={() => void list.loadMore()}
                />
              </View>
            )
          }
          renderItem={({ item }) =>
            item.type === "group" ? (
              <KinProjectsGroupHeading item={item} onOpen={props.onOpenClient} />
            ) : (
              <KinWorkNamedRow row={item.row} onPress={() => props.onOpen(item.row.key)} />
            )
          }
        />
      </ScreenContent>
    </View>
  );
}

/** A client's heading over its projects opens the client; "Not for a client" opens nothing. */
function KinProjectsGroupHeading(props: {
  readonly item: Extract<ListItem, { readonly type: "group" }>;
  readonly onOpen: (key: KinRecordKey) => void;
}) {
  const { title, party } = props.item;
  const text = (
    <Text
      textRole="footnote"
      accessibilityRole="header"
      numberOfLines={2}
      className="min-w-0 shrink font-t3-medium text-foreground-muted"
    >
      {title}
    </Text>
  );
  return party === null ? (
    <View className="px-5 pt-5 pb-1">{text}</View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint="Opens the client"
      onPress={() => props.onOpen(party)}
      className="flex-row items-center gap-1.5 px-5 pt-5 pb-1 active:opacity-60"
    >
      {text}
      <SymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    </Pressable>
  );
}

/**
 * Kept while the app stays open, so Clients opens on the side last chosen: by each person on each
 * Kin, so someone signing in after another on this phone starts on their own.
 */
const kinClientsTabAtom = Atom.family((_viewer: string) =>
  Atom.make<KinClientsTab>("clients").pipe(Atom.keepAlive),
);

type Showing = {
  readonly clients: Omit<KinClientsFilter, "text">;
  readonly view: KinProjectsFilter["view"];
};

/** Which clients, and for someone who sees them all, who looks after them. */
function clientsMenu(
  showing: Showing,
  onShow: (showing: Showing) => void,
  names: KinWorkNames,
  seesClients: boolean,
  marketing: KinMarketing,
  onExport: () => void,
): AppBarMenu["items"] {
  const { clients } = showing;
  const pick = (lookedAfter: KinClientsFilter["lookedAfter"]) =>
    onShow({ ...showing, clients: { ...clients, lookedAfter } });
  const picked = (who: KinClientsFilter["lookedAfter"]) =>
    who === "anyone" || clients.lookedAfter === "anyone"
      ? who === clients.lookedAfter
      : kinWorkSamePrincipal(who, clients.lookedAfter);
  const me = names.me === null ? null : ({ _tag: "person", personId: names.me } as const);
  const someone = kinClientsLookedAfterChoices(names);
  return [
    {
      id: "show",
      title: KIN_CLIENTS.show,
      inline: true,
      items: [
        ...kinClientsShowChoices(seesClients).map((one) => ({
          id: `show:${one.id}`,
          title: one.label,
          selected: clients.show === one.id,
          onPress: () => onShow({ ...showing, clients: { ...clients, show: one.id } }),
        })),
        // Said once, here: the order never changes.
        { id: "show:order", title: KIN_CLIENTS.order, disabled: true, onPress: () => {} },
      ],
    },
    ...(!seesClients
      ? []
      : [
          {
            id: "lookedAfter",
            title: KIN_CLIENTS.lookedAfterBy,
            inline: true,
            items: [
              {
                id: "lookedAfter:anyone",
                title: KIN_CLIENTS.anyone,
                selected: picked("anyone"),
                onPress: () => pick("anyone"),
              },
              ...(me === null
                ? []
                : [
                    {
                      id: "lookedAfter:me",
                      title: KIN_CLIENTS.me,
                      selected: picked(me),
                      onPress: () => pick(me),
                    },
                  ]),
              ...(someone.length === 0
                ? []
                : [
                    {
                      id: "lookedAfter:someone",
                      title: KIN_CLIENTS.someone,
                      items: someone.map((one) => ({
                        id: `lookedAfter:${one.key}`,
                        title: one.name,
                        selected: picked(one.who),
                        onPress: () => pick(one.who),
                      })),
                    },
                  ]),
            ],
          },
          {
            id: "cameFrom",
            title: KIN_MARKETING.cameFrom,
            items: [
              {
                id: "cameFrom:anywhere",
                title: KIN_MARKETING.cameFromAnywhere,
                selected: clients.cameFrom == null,
                onPress: () => onShow({ ...showing, clients: { ...clients, cameFrom: null } }),
              },
              ...marketing.cameFrom.map((one) => ({
                id: `cameFrom:${one.source}`,
                title: one.campaign ? `${one.label} (${KIN_MARKETING.campaign})` : one.label,
                selected: clients.cameFrom === one.source,
                onPress: () =>
                  onShow({ ...showing, clients: { ...clients, cameFrom: one.source } }),
              })),
            ],
          },
          {
            id: "tag",
            title: KIN_MARKETING.tag,
            items: [
              {
                id: "tag:any",
                title: KIN_MARKETING.anyTag,
                selected: clients.tag == null,
                onPress: () => onShow({ ...showing, clients: { ...clients, tag: null } }),
              },
              ...marketing.tags.map((tag) => ({
                id: `tag:${tag}`,
                title: tag,
                selected: clients.tag === tag,
                onPress: () => onShow({ ...showing, clients: { ...clients, tag } }),
              })),
            ],
          },
        ]),
    { id: "export", title: KIN_MARKETING.exportList, onPress: onExport },
  ];
}

/** The Show menu holds the states of whichever of Clients and Projects is showing. */
function showMenu(
  tab: KinClientsTab,
  showing: Showing,
  onShow: (showing: Showing) => void,
  names: KinWorkNames,
  seesClients: boolean,
  marketing: KinMarketing,
  onExport: () => void,
): AppBarMenu {
  return {
    title: KIN_WORK_HOME.show,
    icon: "line.3.horizontal.decrease.circle",
    items:
      tab === "clients"
        ? clientsMenu(showing, onShow, names, seesClients, marketing, onExport)
        : KIN_PROJECT_VIEWS.map((view) => ({
            id: view.id,
            title: view.label,
            selected: showing.view === view.id,
            onPress: () => onShow({ ...showing, view: view.id }),
          })),
  };
}

/** Clients, or their projects grouped under them, one segment at a time. */
export function KinClientsList(props: ListProps & { readonly projects: boolean }) {
  const remembered = kinClientsTabAtom(`${props.environmentId}:${props.directory.names.me ?? ""}`);
  const [asked, setTab] = useState<KinClientsTab>(() =>
    props.projects ? "projects" : appAtomRegistry.get(remembered),
  );
  const start = useKinClientsStart(props.environmentId);
  const seesClients = useKinSeesClients(props.environmentId) === true;
  // Deals are for someone with Clients on; the segment they last chose may no longer be theirs.
  const tab = kinClientsTabShown(asked, seesClients);
  const [showing, setShowing] = useState<Showing>(() => ({
    clients: { show: start.show, lookedAfter: start.lookedAfter },
    view: "open",
  }));
  const marketing = useKinMarketing(props);
  const exporter = useKinExportList(props);
  const agent = useKinAskAgent(props, "clients");
  const ask =
    agent === null
      ? null
      : {
          accessibilityLabel: `Ask ${agent.name}`,
          icon: "bubble.left" as const,
          onPress: () => agent.ask(kinWorkAskDraft("clients")),
        };
  const view = {
    menu: showMenu(
      tab,
      showing,
      setShowing,
      props.directory.names,
      seesClients,
      marketing,
      () =>
        void exporter.run(
          kinContactListOfClients(kinClientsQuery(props.orgId, { ...showing.clients, text: "" })),
        ),
    ),
    ask,
    header: (
      <SegmentedControl
        options={kinClientsTabs(seesClients).map((held) => ({ value: held.id, label: held.label }))}
        selected={tab}
        onSelect={(next) => {
          appAtomRegistry.set(remembered, next);
          setTab(next);
        }}
        role="tab"
      />
    ),
  };
  if (tab === "deals")
    return (
      <KinDealsView
        environmentId={props.environmentId}
        orgId={props.orgId}
        directory={props.directory}
        stale={props.stale}
        header={view.header}
        ask={ask}
      />
    );
  return tab === "clients" ? (
    <ClientsView
      key={`clients:${showing.clients.show}:${
        showing.clients.lookedAfter === "anyone"
          ? "anyone"
          : kinWorkPrincipalKey(showing.clients.lookedAfter)
      }:${showing.clients.cameFrom ?? ""}:${showing.clients.tag ?? ""}`}
      {...props}
      {...view}
      showing={showing.clients}
      canAdd={seesClients}
    />
  ) : (
    <ProjectsView key={`projects:${showing.view}`} {...props} {...view} view={showing.view} />
  );
}

type ViewProps = ListProps & {
  readonly menu: AppBarMenu;
  readonly ask: AppBarAction | null;
  readonly header: React.ReactNode;
};

function ClientsView(
  props: ViewProps & {
    readonly showing: Omit<KinClientsFilter, "text">;
    /** The owner level adds clients; a teammate with Clients on adds prospects. */
    readonly canAdd: boolean;
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const scope = useKinViewerScope(environmentId);
  const now = new Date(useNowMinuteMs());
  const seq = props.stale ? null : props.live.seq;
  const { state, list } = useKinClientsList(props, seq, { ...props.showing, text: "" });
  const { filter } = state;
  const nothing = kinClientsNothing(filter, scope, props.directory.names.me);
  const add = props.canAdd
    ? {
        label: scope.all ? KIN_CLIENTS.add : KIN_CLIENTS.addProspect,
        onPress: () => navigation.navigate("KinClientForm", { environmentId, orgId }),
      }
    : null;
  const addProspect =
    add === null
      ? null
      : {
          label: KIN_CLIENTS.addProspect,
          onPress: () =>
            navigation.navigate("KinClientForm", { environmentId, orgId, prospect: true }),
        };
  const openClient = (to: KinRecordKey) =>
    navigation.navigate("KinClient", { environmentId, orgId, party: to });
  // The owner level's, as the host has it: the host applies the same gate to the call.
  const canImport = useAtomValue(kinClient.importApply.permissionAtom(environmentId));
  return (
    <NamedList
      environmentId={environmentId}
      title={KIN_CLIENTS.title}
      menu={props.menu}
      ask={props.ask}
      header={props.header}
      stale={props.stale || state.stale}
      items={state.records.map((row) => ({
        type: "row" as const,
        id: row.key,
        row: kinClientRow(row, props.directory.names, now),
      }))}
      shown={state.records.length}
      state={state}
      list={{
        loadMore: list.loadMore,
        // The counts are read again too: they may be what failed.
        refresh: () => {
          refreshKinWorkLive(props);
          list.refresh();
        },
      }}
      extra={state}
      search={{ text: filter.text, placeholder: KIN_CLIENTS.search }}
      onSearch={(text) => list.setFilter({ ...filter, text })}
      nothing={
        <EmptyState
          variant="plain"
          title={nothing.title}
          detail={nothing.detail}
          {...(nothing.offerNew && addProspect !== null
            ? {
                action: (
                  <Button tone="primary" label={addProspect.label} onPress={addProspect.onPress} />
                ),
              }
            : {})}
        />
      }
      add={add}
      bring={
        canImport
          ? {
              accessibilityLabel: KIN_IMPORT.entry,
              icon: "tray.and.arrow.down" as const,
              onPress: () => navigation.navigate("KinImport", { environmentId, orgId }),
            }
          : null
      }
      loading="Loading clients"
      loadFailed={KIN_CLIENTS.loadFailed}
      onOpen={openClient}
      onOpenClient={openClient}
    />
  );
}

function ProjectsView(props: ViewProps & { readonly view: KinProjectsFilter["view"] }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const canAdd = useAtomValue(kinClient.workProjectCreate.permissionAtom(environmentId));
  const scope = useKinViewerScope(environmentId);
  const now = new Date(useNowMinuteMs());
  const { state, list } = useKinProjectsList(
    props,
    props.stale ? null : props.live.seq,
    props.view,
  );
  const { filter } = state;
  const items = kinProjectsByClient(state.records, props.directory.names, now).flatMap(
    (group): ReadonlyArray<ListItem> => [
      { type: "group", id: `group:${group.id}`, title: group.title, party: group.party },
      ...group.rows.map((row): ListItem => ({ type: "row", id: row.key, row })),
    ],
  );
  return (
    <NamedList
      environmentId={environmentId}
      title={KIN_CLIENTS.title}
      menu={props.menu}
      ask={props.ask}
      header={props.header}
      stale={props.stale || state.stale}
      items={items}
      shown={state.records.length}
      state={state}
      list={{
        loadMore: list.loadMore,
        // The counts are read again too: they may be what failed.
        refresh: () => {
          refreshKinWorkLive(props);
          list.refresh();
        },
      }}
      extra={state}
      search={{ text: filter.text, placeholder: KIN_PROJECTS.search }}
      onSearch={(text) => list.setFilter({ ...filter, text })}
      nothing={
        <Text textRole="body" className="px-1 text-foreground-muted">
          {kinProjectsNothing(filter, scope).title}
        </Text>
      }
      add={
        canAdd
          ? {
              label: KIN_PROJECTS.add,
              onPress: () => navigation.navigate("KinProjectForm", { environmentId, orgId }),
            }
          : null
      }
      loading="Loading projects"
      loadFailed={KIN_PROJECTS.loadFailed}
      onOpen={(project) => navigation.navigate("KinProject", { environmentId, orgId, project })}
      onOpenClient={(party) => navigation.navigate("KinClient", { environmentId, orgId, party })}
    />
  );
}
