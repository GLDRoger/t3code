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
import {
  KIN_LISTS,
  kinListsIndex,
  type KinListIndexRow,
} from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_WORK_HOME,
  kinPlaceLists,
  kinWorkAskDraft,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinDocRow, KinRecordKey } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { kinTabBar, useKinTab } from "./components/KinTab";
import { KinWorkLoading, KinWorkPrivateMark, KinWorkStaleNotice } from "./components/KinWorkPieces";
import { useKinDocsList, useKinDocsLive, useKinDocsUnder, useKinSearch } from "./state/useKinDocs";
import { useKinAskAgent, useKinLists } from "./state/useKinMoney";
import { refreshKinWorkLive, type KinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";
import { useKinWorkLink } from "./state/kinWorkLink";

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

/** A list kept beside the docs, as a row that opens it. */
function KinListRowButton(props: { readonly row: KinListIndexRow; readonly onPress: () => void }) {
  const { row } = props;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${KIN_LISTS.title}: ${row.name}. ${row.line}`}
        onPress={props.onPress}
        className="min-h-16 flex-row items-center gap-3 px-5 py-3 active:opacity-60"
      >
        <SymbolView
          name="list.bullet"
          size={18}
          tintColorClassName="accent-icon"
          type="monochrome"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" numberOfLines={1} className="text-foreground">
            {row.name}
          </Text>
          <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
            {row.line}
          </Text>
        </View>
      </Pressable>
      <View className="ml-5 h-px bg-border-subtle" />
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
  | { readonly type: "doc"; readonly id: string; readonly row: KinDocRow }
  | { readonly type: "list"; readonly id: string; readonly row: KinListIndexRow };

const DOCS_ONLY = ["docs"] as const;

type Kind = "all" | "docs" | "lists";

/**
 * Every doc under its client, project or keeper, with a search over what they say, and above
 * them the lists people keep that Money doesn't: a list is a doc with columns.
 */
export function KinDocsList(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly directory: KinWorkDirectory;
    readonly stale: boolean;
  },
) {
  const navigation = useNavigation();
  const tab = useKinTab();
  const agent = useKinAskAgent(props, "docs");
  const { environmentId, orgId } = props;
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const { refused, live } = useKinDocsLive(props);
  const { state, list } = useKinDocsList(props, props.stale ? null : (live?.seq ?? null));
  const { state: found, search } = useKinSearch(props, DOCS_ONLY);
  const [by, setBy] = useState<KinDocGrouping>("client");
  const [kind, setKind] = useState<Kind>("all");
  const { filter } = state;
  const lists = useKinLists(props, {
    enabled: true,
    archived: filter.archived,
    seq: props.stale ? null : props.live.seq,
  });
  const refresh = () => {
    refreshKinWorkLive(props);
    list.refresh();
    lists.refresh();
  };
  const searching = found.text.trim() !== "";
  const passages = searching && kind !== "lists" && (found.hits?.length ?? 0) > 0;
  const index = kinListsIndex(
    lists.state._tag === "ready" ? kinPlaceLists(lists.state.value.lists) : [],
  );
  const words = filter.text.trim().toLowerCase();
  const listRows = (filter.archived ? index.archived : index.active).filter(
    (row) => words === "" || row.name.toLowerCase().includes(words),
  );
  const listItems: ReadonlyArray<Item> =
    kind === "docs" || listRows.length === 0
      ? []
      : [
          { type: "group", id: "group:lists", title: `${KIN_LISTS.title} · ${listRows.length}` },
          ...listRows.map((row): Item => ({ type: "list", id: `list:${row.list}`, row })),
        ];
  const docItems: ReadonlyArray<Item> =
    refused || kind === "lists"
      ? []
      : kinDocGroups(state.records, by, names).flatMap((group): ReadonlyArray<Item> => [
          {
            type: "group",
            id: `group:${group.id}`,
            title: `${group.title} · ${group.rows.length}`,
          },
          ...group.rows.map((row): Item => ({ type: "doc", id: row.recordId, row })),
        ]);
  const items = [...listItems, ...docItems];
  // With lists showing, the docs' own loading or failure still needs saying under them.
  const docsPending = listItems.length > 0 && kind !== "lists" && docItems.length === 0;
  const footer =
    kind === "lists" ? null : kinDocsFooter(state.records.length, state.total, state.more);
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
        title={KIN_WORK_HOME.places.docs}
        refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
        {...(agent === null
          ? {}
          : {
              actions: [
                {
                  accessibilityLabel: `Ask ${agent.name}`,
                  icon: "bubble.left",
                  onPress: () => agent.ask(kinWorkAskDraft("docs")),
                },
                {
                  accessibilityLabel: KIN_LISTS.ask,
                  icon: "plus",
                  onPress: () => agent.ask(KIN_LISTS.askMessage),
                },
              ],
            })}
        {...(refused
          ? {}
          : {
              menus: [
                {
                  title: KIN_WORK_HOME.show,
                  icon: "line.3.horizontal.decrease.circle",
                  items: [
                    {
                      id: "kind",
                      title: KIN_WORK_HOME.show,
                      inline: true,
                      items: (
                        [
                          ["all", KIN_DOCS.docsAndLists],
                          ["docs", KIN_DOCS.title],
                          ["lists", KIN_LISTS.title],
                        ] as const
                      ).map(([id, title]) => ({
                        id: `kind:${id}`,
                        title,
                        selected: kind === id,
                        onPress: () => setKind(id),
                      })),
                    },
                    {
                      id: "which",
                      title: KIN_DOCS.which,
                      inline: true,
                      items: [
                        {
                          id: "current",
                          title: KIN_DOCS.current,
                          selected: !filter.archived,
                          onPress: () => {
                            list.setFilter({ ...filter, archived: false });
                            search.setClosed(false);
                          },
                        },
                        {
                          id: "archived",
                          title: KIN_DOCS.archived,
                          selected: filter.archived,
                          onPress: () => {
                            list.setFilter({ ...filter, archived: true });
                            search.setClosed(true);
                          },
                        },
                      ],
                    },
                    {
                      id: "by",
                      title: "Group",
                      inline: true,
                      items: KIN_DOC_GROUPINGS.map((held) => ({
                        id: `by:${held.id}`,
                        title: `By ${held.label.toLowerCase()}`,
                        selected: by === held.id,
                        onPress: () => setBy(held.id),
                      })),
                    },
                  ],
                },
              ],
            })}
        {...kinTabBar(tab, {
          onBack: () => navigation.goBack(),
          search: {
            value: found.text,
            onChangeText: (text) => {
              search.setText(text);
              list.setFilter({ ...filter, text });
            },
            placeholder: KIN_DOCS.searchWithLists,
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
          // The search field, or the dock, floats over the foot of the list.
          contentContainerStyle={{ paddingBottom: tab === null ? 96 : 32 + tab.bottomClearance }}
          data={items}
          keyExtractor={(item) => item.id}
          extraData={[state, by, found, kind, lists.state]}
          estimatedItemSize={72}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            props.stale || state.stale ? (
              <View className="px-4 pt-2">
                <KinWorkStaleNotice environmentId={environmentId} onRetry={refresh} />
              </View>
            ) : filter.archived ? (
              <View className="px-5 pt-2">
                <Text textRole="footnote" className="text-foreground-muted">
                  {KIN_DOCS.archived}
                </Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View className="pt-4">
              {kind === "lists" ? (
                <EmptyState
                  variant="plain"
                  {...(words === "" ? KIN_LISTS.none : KIN_DOCS.noMatch)}
                  {...(agent === null || words !== ""
                    ? {}
                    : {
                        action: (
                          <Button
                            tone="primary"
                            icon="bubble.left"
                            label={KIN_LISTS.ask}
                            onPress={() => agent.ask(KIN_LISTS.askMessage)}
                          />
                        ),
                      })}
                />
              ) : refused ? (
                <EmptyState variant="plain" {...KIN_DOCS.unavailable} />
              ) : state.loading ? (
                <KinWorkLoading label={KIN_DOCS.loading} />
              ) : state.failed !== null ? (
                <EmptyState
                  variant="plain"
                  title={KIN_DOCS.loadFailed}
                  detail="Check your connection to the server and try again."
                  action={<Button tone="secondary" label="Try again" onPress={list.refresh} />}
                />
              ) : passages ? null : searching ? (
                <EmptyState variant="plain" {...KIN_DOCS.noMatch} />
              ) : (
                <EmptyState
                  variant="plain"
                  {...(filter.archived ? KIN_DOCS.emptyArchived : KIN_DOCS.empty)}
                />
              )}
            </View>
          }
          ListFooterComponent={
            <>
              {!docsPending ? null : state.loading ? (
                <KinWorkLoading label={KIN_DOCS.loading} />
              ) : state.failed !== null ? (
                <View className="px-4 pt-4">
                  <Notice
                    tone="danger"
                    message={KIN_DOCS.loadFailed}
                    action={{ label: "Try again", onPress: list.refresh }}
                  />
                </View>
              ) : null}
              {footer === null ? null : (
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
              )}
              {passages ? (
                <View className="pt-4">
                  <View className="px-5 pb-1">
                    <Text
                      textRole="footnote"
                      accessibilityRole="header"
                      className="font-t3-medium text-foreground-muted"
                    >
                      {KIN_DOCS.passages}
                    </Text>
                  </View>
                  <KinSearchHits
                    state={found}
                    docsOnly
                    onRetry={search.retry}
                    onOpen={(hit) => open(hit.key, hit.section?.id)}
                  />
                </View>
              ) : null}
            </>
          }
          renderItem={({ item }) =>
            item.type === "list" ? (
              <KinListRowButton
                row={item.row}
                onPress={() =>
                  navigation.navigate("KinList", { environmentId, orgId, list: item.row.list })
                }
              />
            ) : item.type === "group" ? (
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
  const openRecord = useKinWorkLink();
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
            openRecord("KinDoc", {
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
