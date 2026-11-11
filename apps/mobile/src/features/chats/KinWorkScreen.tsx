import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_NEW,
  KIN_WORK_OFFLINE,
  KIN_WORK_ONLY_OWNER,
  KIN_WORK_SEARCH_PLACEHOLDER,
  KIN_WORK_STALE,
  KIN_WORK_TITLE,
  kinWorkEntrySummary,
  kinWorkListFooter,
  kinWorkNothing,
  kinWorkOverview,
  kinWorkRow,
  kinWorkShown,
  type KinWorkFilter,
  type KinWorkOverview,
  type KinWorkRowView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_LIST_INITIAL,
  createKinWorkList,
  type KinWorkListState,
} from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { appAtomRegistry } from "../../state/atom-registry";
import { KinListBanner } from "./components/KinListBanner";
import { KinWorkStateSymbol } from "./components/KinWorkStateSymbol";
import { kinClient } from "./state/kinClient";
import {
  kinWorkLiveAtom,
  useKinWork,
  useKinWorkDirectory,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";

export type KinWorkParams = { readonly environmentId: string; readonly orgId: string };

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** The way in from the chat list, for the owner only. Its second line says what needs a look. */
export function KinWorkEntry(target: KinWorkTarget) {
  const navigation = useNavigation();
  const state = useKinWork(target);
  // A teammate, or a host that couldn't be read: no way in rather than a dead one.
  if (state._tag === "refused" || state._tag === "failed") return null;
  return (
    <KinWorkEntryRow
      summary={kinWorkEntrySummary(state._tag === "ready" ? state.live.summary : null)}
      onPress={() => navigation.navigate("KinWork", target)}
    />
  );
}

/** Also drawn from fixtures in the component catalog. */
export function KinWorkEntryRow(props: { readonly summary: string; readonly onPress: () => void }) {
  return (
    <>
      <KinListBanner
        title={KIN_WORK_TITLE}
        summary={props.summary}
        symbol="checkmark.circle"
        accessibilityLabel={`${KIN_WORK_TITLE}. ${props.summary}`}
        accessibilityHint="Opens what is open and who has it"
        onPress={props.onPress}
      />
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}

/** Everything someone owes someone: what is open, who has it, and the way to hand it on. */
export function KinWorkScreen({ route }: StaticScreenProps<KinWorkParams>) {
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <KinWorkMessage>
        <EmptyState
          variant="plain"
          title="This link doesn't open anything"
          detail="Open Work from your Kin chats."
        />
      </KinWorkMessage>
    );
  }
  return <KinWorkStates environmentId={environmentId} orgId={orgId} />;
}

/** Every state that isn't the list, inside the scroll view that clears the floating bar. */
function KinWorkMessage(props: { readonly children: React.ReactNode }) {
  const navigation = useNavigation();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_WORK_TITLE} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function KinWorkStates(target: KinWorkTarget) {
  const state = useKinWork(target);
  const directory = useKinWorkDirectory(target, state._tag === "ready");
  if (state._tag === "ready") {
    return <KinWorkBody {...target} live={state.live} stale={state.stale} directory={directory} />;
  }
  return (
    <KinWorkMessage>
      {state._tag === "refused" ? (
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      ) : state._tag === "offline" ? (
        <EmptyState variant="plain" {...KIN_WORK_OFFLINE} />
      ) : state._tag === "failed" ? (
        <EmptyState
          variant="plain"
          title={KIN_WORK_LOAD_FAILED}
          detail="Check your connection to the server and try again."
          action={
            <Button
              tone="secondary"
              label="Try again"
              onPress={() => appAtomRegistry.refresh(kinWorkLiveAtom(target))}
            />
          }
        />
      ) : (
        <View
          className="items-center py-12"
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Loading Work"
        >
          <AppActivityIndicator />
        </View>
      )}
    </KinWorkMessage>
  );
}

function KinWorkBody(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, live } = props;
  const { names } = props.directory;
  const canAdd = useAtomValue(kinClient.workCreate.permissionAtom(environmentId));
  const now = new Date(useNowMinuteMs());
  const [listState, setListState] = useState<KinWorkListState>(KIN_WORK_LIST_INITIAL);
  const [list] = useState(() =>
    createKinWorkList({
      orgId,
      read: (input) => kinClient.workList.run(appAtomRegistry, { environmentId, input }),
      onChange: setListState,
      now: Date.now,
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the list's reads from the host when the screen shows, and abandons what is in flight when it leaves
  useEffect(() => {
    list.start();
    return list.dispose;
  }, [list]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list's reader the host's latest change number, so it reads again only when the rows are behind
  useEffect(() => {
    list.changed(live.seq);
  }, [list, live.seq]);

  const { filter } = listState;
  const overview = kinWorkOverview(live.summary, filter, names);
  const rows = kinWorkShown(filter, listState.records).map((record) =>
    kinWorkRow(record, names, now),
  );
  const nothing = kinWorkNothing(filter);
  const footer = kinWorkListFooter(filter, rows.length, listState.total, listState.more);
  const add = canAdd ? () => navigation.navigate("KinWorkNew", { environmentId, orgId }) : null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={KIN_WORK_TITLE}
        onBack={() => navigation.goBack()}
        refresh={{ accessibilityLabel: "Refresh", onPress: list.refresh }}
        {...(add === null
          ? {}
          : { actions: [{ accessibilityLabel: KIN_WORK_NEW, icon: "plus", onPress: add }] })}
        search={{
          value: filter.text,
          onChangeText: (text) => list.setFilter({ ...filter, text }),
          placeholder: KIN_WORK_SEARCH_PLACEHOLDER,
          closeAccessibilityLabel: "Close search",
          clearAccessibilityLabel: "Clear search",
        }}
      />
      <ScreenContent surface="screen">
        {/* Hundreds of tasks stay cheap: only the rows in view mount. */}
        <LegendList<KinWorkRowView>
          renderScrollComponent={NativeScrollView}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field floats over the foot of the list.
          contentContainerStyle={{ paddingBottom: 96 }}
          data={rows}
          keyExtractor={(row) => row.key}
          extraData={listState}
          estimatedItemSize={68}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View className="gap-3 pb-1 pt-2">
              {props.stale || listState.stale ? (
                <View className="px-4">
                  <Notice message={KIN_WORK_STALE} />
                </View>
              ) : null}
              <KinWorkFilters
                overview={overview}
                filter={filter}
                onChange={(next) => list.setFilter(next)}
              />
            </View>
          }
          ListEmptyComponent={
            <View className="px-4 pt-4">
              {listState.loading ? (
                <View
                  className="items-center py-12"
                  accessible
                  accessibilityRole="progressbar"
                  accessibilityLabel="Loading tasks"
                >
                  <AppActivityIndicator />
                </View>
              ) : listState.failed !== null ? (
                <EmptyState
                  variant="plain"
                  title={KIN_WORK_LOAD_FAILED}
                  detail="Check your connection to the server and try again."
                  action={<Button tone="secondary" label="Try again" onPress={list.refresh} />}
                />
              ) : (
                <EmptyState
                  variant="plain"
                  title={nothing.title}
                  detail={nothing.detail}
                  {...(nothing.offerNew && add !== null
                    ? { action: <Button tone="primary" label={KIN_WORK_NEW} onPress={add} /> }
                    : {})}
                />
              )}
            </View>
          }
          ListFooterComponent={
            footer === null ? null : (
              <View className="items-start gap-2 px-5 py-4">
                <Text textRole="footnote" className="text-foreground-muted">
                  {listState.moreFailed ? "Couldn't load more." : footer}
                </Text>
                <Button
                  tone="secondary"
                  size="compact"
                  label={listState.moreFailed ? "Try again" : "Show more"}
                  loading={listState.loadingMore}
                  disabled={listState.loadingMore}
                  onPress={() => void list.loadMore()}
                />
              </View>
            )
          }
          renderItem={({ item: row }) => (
            <KinWorkRow
              row={row}
              onPress={() =>
                navigation.navigate("KinWorkItem", { environmentId, orgId, task: row.key })
              }
            />
          )}
        />
      </ScreenContent>
    </View>
  );
}

/** The overview and the filters in one: every count narrows the list to what it counts. */
function KinWorkFilters(props: {
  readonly overview: KinWorkOverview;
  readonly filter: KinWorkFilter;
  readonly onChange: (filter: KinWorkFilter) => void;
}) {
  const { overview, filter } = props;
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
      >
        {overview.chips.map((chip) => (
          <Chip
            key={chip.id}
            label={chip.count === null ? chip.label : `${chip.label} ${chip.count}`}
            accessibilityLabel={chip.accessibilityLabel}
            selected={chip.selected}
            onPress={() => props.onChange({ ...filter, view: chip.id })}
          />
        ))}
      </ScrollView>
      {overview.owners.length === 0 ? null : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        >
          {overview.owners.map((owner) => (
            <Chip
              key={owner.key}
              size="small"
              label={`${owner.name} ${owner.open}`}
              accessibilityLabel={`${owner.name}. ${owner.line}`}
              selected={owner.selected}
              onPress={() =>
                props.onChange({ ...filter, owner: owner.selected ? null : owner.owner })
              }
            />
          ))}
        </ScrollView>
      )}
    </>
  );
}

function KinWorkRow(props: { readonly row: KinWorkRowView; readonly onPress: () => void }) {
  const { row } = props;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.accessibilityLabel}
        onPress={props.onPress}
        className="min-h-16 flex-row items-start gap-3 px-5 py-3 active:opacity-60"
      >
        <View className="h-6 justify-center">
          <KinWorkStateSymbol state={row.state} />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" numberOfLines={2} className="text-foreground">
            {row.title}
          </Text>
          <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
            {row.line}
          </Text>
        </View>
        {row.late ? (
          <Text textRole="footnote" className="font-t3-medium text-danger-foreground">
            Late
          </Text>
        ) : null}
      </Pressable>
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}
