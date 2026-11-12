import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
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
import { KIN_WORK_STALE, KIN_WORK_TITLE } from "@t3tools/client-runtime/kin/kinWork";
import type { KinDocRow, KinRecordKey } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { kinTabBar, useKinTab } from "./components/KinTab";
import {
  KinWorkAreaSwitch,
  KinWorkLoading,
  KinWorkPrivateMark,
  type KinWorkAreas,
} from "./components/KinWorkPieces";
import { useKinDocsList, useKinDocsLive, useKinDocsUnder, useKinSearch } from "./state/useKinDocs";
import type { KinWorkDirectory, KinWorkTarget } from "./state/useKinWork";

/** A doc as a row that opens it: its name, then when it last changed, by whom and how. */
function KinDocRowButton(props: {
  readonly row: KinDocRowView;
  /** Under its own client or project the row needn't name them again. */
  readonly bare?: boolean;
  /** Inside a rounded section the divider keeps to the section's edges. */
  readonly inset?: boolean;
  readonly onPress: () => void;
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
              {row.title}
            </Text>
            {row.private ? <KinWorkPrivateMark label="" /> : null}
          </View>
          <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
            {row.line}
          </Text>
          {props.bare || row.under === null ? null : (
            <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
              {row.under}
            </Text>
          )}
        </View>
        {row.archived ? (
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            {KIN_DOCS.archived}
          </Text>
        ) : null}
      </Pressable>
      <View className={cn("h-px bg-border-subtle", props.inset ? "ml-4" : "ml-5")} />
    </>
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
      <EmptyState
        variant="plain"
        title="Couldn't search"
        detail="Check your connection to the server and try again."
        action={<Button tone="secondary" label="Try again" onPress={props.onRetry} />}
      />
    ) : (
      <KinWorkLoading label="Searching" />
    );
  }
  if (state.hits.length === 0)
    return <EmptyState variant="plain" {...kinSearchNothing(state.answered)} />;
  return (
    <View className={cn(state.loading && "opacity-60")}>
      {state.failed ? (
        <View className="px-4 pb-2">
          <Notice tone="danger" message={KIN_SEARCH.failed} />
        </View>
      ) : null}
      {state.hits.map(kinSearchHit).map((hit) => (
        <View key={hit.id}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hit.accessibilityLabel}
            onPress={() => props.onOpen(hit)}
            className="min-h-16 flex-row items-start gap-3 px-5 py-3 active:opacity-60"
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <View className="flex-row items-center gap-2">
                <Text textRole="body" numberOfLines={1} className="min-w-0 shrink text-foreground">
                  {hit.section === null ? hit.title : `${hit.title} › ${hit.section.title}`}
                </Text>
                {hit.private ? <KinWorkPrivateMark label="" /> : null}
              </View>
              {hit.snippet === null ? null : (
                <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
                  {hit.snippet}
                </Text>
              )}
            </View>
            <Text textRole="footnote" className="text-foreground-muted">
              {[props.docsOnly ? null : hit.kindLabel, hit.closed].filter(Boolean).join(" · ")}
            </Text>
          </Pressable>
          <View className="ml-5 h-px bg-border-subtle" />
        </View>
      ))}
    </View>
  );
}

type Item =
  | { readonly type: "group"; readonly id: string; readonly title: string }
  | { readonly type: "doc"; readonly id: string; readonly row: KinDocRow };

const DOCS_ONLY = ["docs"] as const;

/** Every doc under its client, project or keeper, with a search over what they say. */
export function KinDocsList(
  props: KinWorkTarget & {
    readonly directory: KinWorkDirectory;
    readonly stale: boolean;
    readonly areas: KinWorkAreas;
    readonly onSearchAll: () => void;
  },
) {
  const navigation = useNavigation();
  const tab = useKinTab();
  const { environmentId, orgId } = props;
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const { refused, live } = useKinDocsLive(props);
  const { state, list } = useKinDocsList(props, props.stale ? null : (live?.seq ?? null));
  const { state: found, search } = useKinSearch(props, DOCS_ONLY);
  const [by, setBy] = useState<KinDocGrouping>("client");
  const { filter } = state;
  const searching = found.text.trim() !== "";
  const items: ReadonlyArray<Item> =
    searching || refused
      ? []
      : kinDocGroups(state.records, by, names).flatMap((group): ReadonlyArray<Item> => [
          {
            type: "group",
            id: `group:${group.id}`,
            title: `${group.title} · ${group.rows.length}`,
          },
          ...group.rows.map((row): Item => ({ type: "doc", id: row.recordId, row })),
        ]);
  const footer = searching ? null : kinDocsFooter(state.records.length, state.total, state.more);
  const open = (doc: KinRecordKey, section?: string) =>
    navigation.navigate("KinDoc", {
      environmentId,
      orgId,
      doc,
      ...(section === undefined ? {} : { section }),
    });
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={KIN_WORK_TITLE}
        refresh={{ accessibilityLabel: "Refresh", onPress: list.refresh }}
        actions={[
          {
            accessibilityLabel: KIN_SEARCH.hint.title,
            icon: "magnifyingglass",
            onPress: props.onSearchAll,
          },
        ]}
        {...kinTabBar(tab, {
          onBack: () => navigation.goBack(),
          search: {
            value: found.text,
            onChangeText: search.setText,
            placeholder: KIN_DOCS.search,
            closeAccessibilityLabel: "Close search",
            clearAccessibilityLabel: "Clear search",
          },
        })}
      />
      <ScreenContent surface="screen">
        <LegendList<Item>
          renderScrollComponent={NativeScrollView}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // The search field, or the tab dock, floats over the foot of the list.
          contentContainerStyle={{ paddingBottom: tab === null ? 96 : 24 + tab.bottomClearance }}
          data={items}
          keyExtractor={(item) => item.id}
          extraData={[state, by, found]}
          estimatedItemSize={72}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View className="gap-3 pb-1 pt-2">
              <KinWorkAreaSwitch {...props.areas} />
              {props.stale || state.stale ? (
                <View className="px-4">
                  <Notice message={KIN_WORK_STALE} />
                </View>
              ) : null}
              {refused ? null : (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
                >
                  <Chip
                    label={KIN_DOCS.current}
                    selected={!filter.archived}
                    onPress={() => {
                      list.setFilter({ ...filter, archived: false });
                      search.setClosed(false);
                    }}
                  />
                  <Chip
                    label={KIN_DOCS.archived}
                    selected={filter.archived}
                    onPress={() => {
                      list.setFilter({ ...filter, archived: true });
                      search.setClosed(true);
                    }}
                  />
                  {searching
                    ? null
                    : KIN_DOC_GROUPINGS.map((held) => (
                        <Chip
                          key={held.id}
                          size="small"
                          label={`By ${held.label.toLowerCase()}`}
                          selected={by === held.id}
                          onPress={() => setBy(held.id)}
                        />
                      ))}
                </ScrollView>
              )}
            </View>
          }
          ListEmptyComponent={
            <View className="pt-4">
              {refused ? (
                <EmptyState variant="plain" {...KIN_DOCS.unavailable} />
              ) : searching ? (
                <KinSearchHits
                  state={found}
                  docsOnly
                  onRetry={search.retry}
                  onOpen={(hit) => open(hit.key, hit.section?.id)}
                />
              ) : state.loading ? (
                <KinWorkLoading label={KIN_DOCS.loading} />
              ) : state.failed !== null ? (
                <EmptyState
                  variant="plain"
                  title={KIN_DOCS.loadFailed}
                  detail="Check your connection to the server and try again."
                  action={<Button tone="secondary" label="Try again" onPress={list.refresh} />}
                />
              ) : (
                <EmptyState
                  variant="plain"
                  {...(filter.archived ? KIN_DOCS.emptyArchived : KIN_DOCS.empty)}
                />
              )}
            </View>
          }
          ListFooterComponent={
            footer === null ? null : (
              <View className="items-start gap-2 px-5 py-4">
                <Text textRole="footnote" className="text-foreground-muted">
                  {state.moreFailed ? "Couldn't load more." : footer}
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
          renderItem={({ item }) =>
            item.type === "group" ? (
              <View className="px-5 pb-1 pt-4">
                <Text
                  textRole="footnote"
                  accessibilityRole="header"
                  className="font-t3-medium text-foreground-muted"
                >
                  {item.title}
                </Text>
              </View>
            ) : (
              <KinDocRowButton
                row={kinDocRow(item.row, names, now)}
                onPress={() => open(item.row.key)}
              />
            )
          }
        />
      </ScreenContent>
    </View>
  );
}

/** The docs linked to a client or a project, on its page. Nothing shows until there is one. */
export function KinDocsUnder(
  props: KinWorkTarget & {
    readonly under: Parameters<typeof useKinDocsUnder>[1];
    readonly names: KinWorkDirectory["names"];
  },
) {
  const navigation = useNavigation();
  const now = new Date(useNowMinuteMs());
  const docs = useKinDocsUnder(props, props.under);
  if (docs === null || docs.length === 0) return null;
  return (
    <ListSection title={`${KIN_DOCS.title} · ${docs.length}`}>
      {docs.map((doc) => (
        <KinDocRowButton
          key={doc.recordId}
          bare
          inset
          row={kinDocRow(doc, props.names, now)}
          onPress={() =>
            navigation.navigate("KinDoc", {
              environmentId: props.environmentId,
              orgId: props.orgId,
              doc: doc.key,
            })
          }
        />
      ))}
    </ListSection>
  );
}
