import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  KIN_CLIENTS,
  KIN_PROJECTS,
  KIN_PROJECT_VIEWS,
  kinClientRow,
  kinClientsNothing,
  kinProjectRow,
  kinProjectsNothing,
  type KinHealthView,
  type KinProjectsFilter,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { KIN_WORK_HOME, kinWorkAskDraft } from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { EnvironmentId, KinRecordKey } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { kinTabBar, useKinTab } from "./components/KinTab";
import { KinWorkLoading, KinWorkPrivateMark, KinWorkStaleNotice } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import { useKinAskAgent } from "./state/useKinMoney";
import { useKinChoicesLive } from "./state/useKinWorkHome";
import {
  refreshKinWorkLive,
  useKinClientsList,
  useKinProjectsList,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";

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
  readonly line: string;
  readonly next?: string | null;
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
  /** A project drawn under its client in the clients list. */
  readonly nested?: boolean;
}) {
  const { row } = props;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.accessibilityLabel}
        onPress={props.onPress}
        className={cn(
          "min-h-16 flex-row items-start gap-3 py-3 active:opacity-60",
          props.inset ? "px-4" : props.nested ? "pl-10 pr-5" : "px-5",
        )}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text textRole="body" numberOfLines={1} className="min-w-0 shrink text-foreground">
              {row.name}
            </Text>
            {row.private ? <KinWorkPrivateMark label="" /> : null}
          </View>
          <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
            {row.line}
          </Text>
          {row.next == null ? null : (
            <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
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
      <View
        className={cn(
          "h-px bg-border-subtle",
          props.inset ? "ml-4" : props.nested ? "ml-10" : "ml-5",
        )}
      />
    </>
  );
}

type ListProps = KinWorkTarget & {
  readonly live: KinWorkLive;
  readonly stale: boolean;
  readonly directory: KinWorkDirectory;
};

/** Clients or projects as a list: only the rows in view mount, and more load at the foot. */
function NamedList(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  /** What the list shows, as one menu in the bar. */
  readonly menu: AppBarMenu;
  readonly ask: AppBarAction | null;
  readonly stale: boolean;
  readonly rows: ReadonlyArray<NamedRow>;
  readonly state: {
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
  /** Below the rows: the projects with no client, under the clients. */
  readonly after?: React.ReactNode;
  readonly nothing: {
    readonly title: string;
    readonly detail: string;
    readonly offerNew: boolean;
  };
  readonly add: { readonly label: string; readonly onPress: () => void } | null;
  readonly loading: string;
  readonly loadFailed: string;
  readonly extra: unknown;
  readonly onOpen: (key: KinRecordKey) => void;
  /** The rows drawn under a row, such as a client's open projects, and where one opens. */
  readonly under?: {
    readonly rows: (key: KinRecordKey) => ReadonlyArray<NamedRow>;
    readonly onOpen: (key: KinRecordKey) => void;
  };
}) {
  const navigation = useNavigation();
  const tab = useKinTab();
  const { state, list, add, nothing, rows, under } = props;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={props.title}
        refresh={{ accessibilityLabel: "Refresh", onPress: list.refresh }}
        actions={[
          ...(props.ask === null ? [] : [props.ask]),
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
        <LegendList<NamedRow>
          renderScrollComponent={NativeScrollView}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field, or the dock, floats over the foot of the list.
          contentContainerStyle={{ paddingBottom: tab === null ? 96 : 32 + tab.bottomClearance }}
          data={rows}
          keyExtractor={(row) => row.key}
          extraData={props.extra}
          estimatedItemSize={72}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            props.stale ? (
              <View className="px-4 pt-2">
                <KinWorkStaleNotice environmentId={props.environmentId} onRetry={list.refresh} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View className="px-4 pt-4">
              {state.loading ? (
                <KinWorkLoading label={props.loading} />
              ) : state.failed !== null ? (
                <EmptyState
                  variant="plain"
                  title={props.loadFailed}
                  detail="Check your connection to the server and try again."
                  action={<Button tone="secondary" label="Try again" onPress={list.refresh} />}
                />
              ) : (
                <EmptyState
                  variant="plain"
                  title={nothing.title}
                  detail={nothing.detail}
                  {...(nothing.offerNew && add !== null
                    ? { action: <Button tone="primary" label={add.label} onPress={add.onPress} /> }
                    : {})}
                />
              )}
            </View>
          }
          ListFooterComponent={
            <>
              {!state.more ? null : (
                <View className="items-start gap-2 px-5 py-4">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {state.moreFailed
                      ? "Couldn't load more."
                      : `Showing ${rows.length} of ${state.total ?? rows.length}`}
                  </Text>
                  <Button
                    tone="secondary"
                    size="compact"
                    label={state.moreFailed ? "Try again" : "Show more"}
                    loading={state.loadingMore}
                    disabled={state.loadingMore}
                    onPress={() => void list.loadMore()}
                  />
                </View>
              )}
              {props.after}
            </>
          }
          renderItem={({ item: row }) => (
            <>
              <KinWorkNamedRow row={row} onPress={() => props.onOpen(row.key)} />
              {under?.rows(row.key).map((child) => (
                <KinWorkNamedRow
                  key={child.key}
                  nested
                  row={child}
                  onPress={() => under.onOpen(child.key)}
                />
              ))}
            </>
          )}
        />
      </ScreenContent>
    </View>
  );
}

type Showing = "clients" | "closed" | KinProjectsFilter["view"];

/** Clients' one menu: active or closed clients, or projects by how far along they are. */
function showMenu(showing: Showing, onShow: (showing: Showing) => void): AppBarMenu {
  return {
    title: KIN_WORK_HOME.show,
    icon: "line.3.horizontal.decrease.circle",
    items: [
      {
        id: "clients",
        title: KIN_CLIENTS.title,
        inline: true,
        items: [
          {
            id: "clients",
            title: "Active",
            selected: showing === "clients",
            onPress: () => onShow("clients"),
          },
          {
            id: "closed",
            title: KIN_CLIENTS.closed,
            selected: showing === "closed",
            onPress: () => onShow("closed"),
          },
        ],
      },
      {
        id: "projects",
        title: KIN_PROJECTS.title,
        inline: true,
        items: KIN_PROJECT_VIEWS.map((view) => ({
          id: `projects:${view.id}`,
          title: `${KIN_PROJECTS.title}: ${view.label.toLowerCase()}`,
          selected: showing === view.id,
          onPress: () => onShow(view.id),
        })),
      },
    ],
  };
}

/**
 * Clients, with each one's projects on its own page. Projects with no client sit under the list,
 * and the menu turns the list into projects by how far along they are.
 */
export function KinClientsList(props: ListProps & { readonly projects: boolean }) {
  const [showing, setShowing] = useState<Showing>(props.projects ? "open" : "clients");
  const agent = useKinAskAgent(props, "clients");
  const ask =
    agent === null
      ? null
      : {
          accessibilityLabel: `Ask ${agent.name}`,
          icon: "bubble.left" as const,
          onPress: () => agent.ask(kinWorkAskDraft("clients")),
        };
  const menu = showMenu(showing, setShowing);
  return showing === "clients" || showing === "closed" ? (
    <ClientsView key={showing} {...props} closed={showing === "closed"} menu={menu} ask={ask} />
  ) : (
    <ProjectsView key={showing} {...props} view={showing} menu={menu} ask={ask} />
  );
}

type ViewProps = ListProps & { readonly menu: AppBarMenu; readonly ask: AppBarAction | null };

function ClientsView(props: ViewProps & { readonly closed: boolean }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const canAdd = useAtomValue(kinClient.workClientCreate.permissionAtom(environmentId));
  const now = new Date(useNowMinuteMs());
  const seq = props.stale ? null : props.live.seq;
  const { state, list } = useKinClientsList(props, seq, props.closed);
  const { filter } = state;
  // Open projects sit under their client, and those with no client after the clients.
  const choices = useKinChoicesLive(props, !props.closed, seq);
  const projects = choices?.projects ?? [];
  const noClient = filter.text.trim() === "" ? projects.filter((row) => row.party === null) : [];
  const openProject = (project: KinRecordKey) =>
    navigation.navigate("KinProject", { environmentId, orgId, project });
  return (
    <NamedList
      environmentId={environmentId}
      title={KIN_CLIENTS.title}
      menu={props.menu}
      ask={props.ask}
      stale={props.stale || state.stale}
      rows={state.records.map((row) => kinClientRow(row, props.directory.names, now))}
      state={state}
      list={{
        loadMore: list.loadMore,
        // The counts are read again too: they may be what failed.
        refresh: () => {
          refreshKinWorkLive(props);
          list.refresh();
        },
      }}
      extra={[state, projects]}
      under={{
        rows: (client) =>
          projects
            .filter((row) => row.party?.key === client)
            .map((row) => kinProjectRow(row, props.directory.names, now)),
        onOpen: openProject,
      }}
      search={{ text: filter.text, placeholder: KIN_CLIENTS.search }}
      onSearch={(text) => list.setFilter({ ...filter, text })}
      after={
        noClient.length === 0 ? null : (
          <View className="pt-4">
            <View className="px-5 pb-1">
              <Text
                textRole="footnote"
                accessibilityRole="header"
                className="font-t3-medium text-foreground-muted"
              >
                {`${KIN_WORK_HOME.noClient} · ${noClient.length}`}
              </Text>
            </View>
            {noClient.map((row) => (
              <KinWorkNamedRow
                key={row.key}
                row={kinProjectRow(row, props.directory.names, now)}
                onPress={() => openProject(row.key)}
              />
            ))}
          </View>
        )
      }
      nothing={kinClientsNothing(filter)}
      add={
        canAdd
          ? {
              label: KIN_CLIENTS.add,
              onPress: () => navigation.navigate("KinClientForm", { environmentId, orgId }),
            }
          : null
      }
      loading="Loading clients"
      loadFailed={KIN_CLIENTS.loadFailed}
      onOpen={(to) => navigation.navigate("KinClient", { environmentId, orgId, party: to })}
    />
  );
}

function ProjectsView(props: ViewProps & { readonly view: KinProjectsFilter["view"] }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const canAdd = useAtomValue(kinClient.workProjectCreate.permissionAtom(environmentId));
  const now = new Date(useNowMinuteMs());
  const { state, list } = useKinProjectsList(
    props,
    props.stale ? null : props.live.seq,
    props.view,
  );
  const { filter } = state;
  return (
    <NamedList
      environmentId={environmentId}
      title={KIN_PROJECTS.title}
      menu={props.menu}
      ask={props.ask}
      stale={props.stale || state.stale}
      rows={state.records.map((row) => kinProjectRow(row, props.directory.names, now))}
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
      nothing={kinProjectsNothing(filter)}
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
    />
  );
}
