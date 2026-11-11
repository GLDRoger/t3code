import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { KIN_WORK_STALE, KIN_WORK_TITLE } from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_CLIENTS,
  KIN_PROJECTS,
  KIN_PROJECT_VIEWS,
  kinClientRow,
  kinClientsNothing,
  kinProjectRow,
  kinProjectsNothing,
  type KinHealthView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinRecordKey } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import {
  KinWorkAreaSwitch,
  KinWorkLoading,
  KinWorkPrivateMark,
  type KinWorkAreas,
} from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import {
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
          props.inset ? "px-4" : "px-5",
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
      <View className={cn("h-px bg-border-subtle", props.inset ? "ml-4" : "ml-5")} />
    </>
  );
}

type ListProps = KinWorkTarget & {
  readonly live: KinWorkLive;
  readonly stale: boolean;
  readonly directory: KinWorkDirectory;
  readonly areas: KinWorkAreas;
};

/** One of Work's two named lists: only the rows in view mount, and more load at the foot. */
function NamedList(props: {
  readonly areas: KinWorkAreas;
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
  readonly views: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly selected: boolean;
    readonly onPress: () => void;
  }>;
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
}) {
  const navigation = useNavigation();
  const { state, list, add, nothing, rows } = props;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={KIN_WORK_TITLE}
        onBack={() => navigation.goBack()}
        refresh={{ accessibilityLabel: "Refresh", onPress: list.refresh }}
        {...(add === null
          ? {}
          : { actions: [{ accessibilityLabel: add.label, icon: "plus", onPress: add.onPress }] })}
        search={{
          value: props.search.text,
          onChangeText: props.onSearch,
          placeholder: props.search.placeholder,
          closeAccessibilityLabel: "Close search",
          clearAccessibilityLabel: "Clear search",
        }}
      />
      <ScreenContent surface="screen">
        <LegendList<NamedRow>
          renderScrollComponent={NativeScrollView}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field floats over the foot of the list.
          contentContainerStyle={{ paddingBottom: 96 }}
          data={rows}
          keyExtractor={(row) => row.key}
          extraData={props.extra}
          estimatedItemSize={72}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View className="gap-3 pb-1 pt-2">
              <KinWorkAreaSwitch {...props.areas} />
              {props.stale ? (
                <View className="px-4">
                  <Notice message={KIN_WORK_STALE} />
                </View>
              ) : null}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
              >
                {props.views.map((view) => (
                  <Chip
                    key={view.id}
                    label={view.label}
                    selected={view.selected}
                    onPress={view.onPress}
                  />
                ))}
              </ScrollView>
            </View>
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
            !state.more ? null : (
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
            )
          }
          renderItem={({ item: row }) => (
            <KinWorkNamedRow row={row} onPress={() => props.onOpen(row.key)} />
          )}
        />
      </ScreenContent>
    </View>
  );
}

/** Every client and vendor: what is owed each way, and what is late. */
export function KinClientsList(props: ListProps) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const canAdd = useAtomValue(kinClient.workClientCreate.permissionAtom(environmentId));
  const now = new Date(useNowMinuteMs());
  const { state, list } = useKinClientsList(props, props.stale ? null : props.live.seq);
  const { filter } = state;
  return (
    <NamedList
      areas={props.areas}
      stale={props.stale || state.stale}
      rows={state.records.map((row) => kinClientRow(row, props.directory.names, now))}
      state={state}
      list={list}
      extra={state}
      search={{ text: filter.text, placeholder: KIN_CLIENTS.search }}
      onSearch={(text) => list.setFilter({ ...filter, text })}
      views={[
        {
          id: "active",
          label: "Active",
          selected: !filter.closed,
          onPress: () => list.setFilter({ ...filter, closed: false }),
        },
        {
          id: "closed",
          label: KIN_CLIENTS.closed,
          selected: filter.closed,
          onPress: () => list.setFilter({ ...filter, closed: true }),
        },
      ]}
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

/** Every project: how each is going, worked out by the server. */
export function KinProjectsList(props: ListProps) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const canAdd = useAtomValue(kinClient.workProjectCreate.permissionAtom(environmentId));
  const now = new Date(useNowMinuteMs());
  const { state, list } = useKinProjectsList(props, props.stale ? null : props.live.seq);
  const { filter } = state;
  return (
    <NamedList
      areas={props.areas}
      stale={props.stale || state.stale}
      rows={state.records.map((row) => kinProjectRow(row, props.directory.names, now))}
      state={state}
      list={list}
      extra={state}
      search={{ text: filter.text, placeholder: KIN_PROJECTS.search }}
      onSearch={(text) => list.setFilter({ ...filter, text })}
      views={KIN_PROJECT_VIEWS.map((view) => ({
        id: view.id,
        label: view.label,
        selected: filter.view === view.id,
        onPress: () => list.setFilter({ ...filter, view: view.id }),
      }))}
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
