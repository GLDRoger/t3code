import type { KinViewerScope } from "@t3tools/client-runtime/kin/kinViewerScope";
import { kinNothingShown } from "@t3tools/client-runtime/kin/kinViewerScope";
import { useKinViewerScope } from "./state/kinChatOnly";
import { KIN_MORE_FAILED, KIN_RETRY, kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
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
  kinDocsMine,
  kinDocsMineHeld,
  kinDocsOnPhone,
  kinDocsPinned,
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
import {
  KIN_WORK_HOME,
  kinPlaceLists,
  kinWorkAskDraft,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import { kinHostLink } from "@t3tools/client-runtime/kin/kinHost";
import { kinWorkOffline } from "@t3tools/client-runtime/kin/kinWork";
import { kinListShown } from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import {
  kinClientsChosenKey,
  kinIsMine,
  kinMineChosenAtom,
  kinMineOpens,
  type KinMineHeld,
  type KinMineSide,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import type { KinDocListRow, KinPersonId, KinRecordKey } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
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
import { appAtomRegistry } from "../../state/atom-registry";
import { kinTabBar, useKinTab, kinTabFoot } from "./components/KinTab";
import { KinWorkLoading, KinWorkPrivateMark, KinWorkStaleNotice } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import { useKinDocDelete } from "./state/useKinDocDelete";
import {
  useKinDocsList,
  useKinDocsLive,
  useKinDocsUnder,
  useKinSearch,
  useKinWhatWeSell,
  useKinWhatWeSellStart,
} from "./state/useKinDocs";
import { useKinAskAgent, useKinLists } from "./state/useKinMoney";
import {
  kinWorkChoicesAtom,
  refreshKinWorkLive,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";
import { KinListPinned, KinMineSwitch } from "./KinDealsList";
import { useKinWorkLink } from "./state/kinWorkLink";
import { useKinHostAt } from "./state/useKinHost";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { kinLines, useKinTextGrows } from "./components/kinTextGrows";

/** A doc as a row that opens it: its name, its kind and last change, and where it is filed. */
function KinDocRowButton(props: {
  readonly row: KinDocRowView;
  /** Under its own home the row needn't name it again. */
  readonly bare?: boolean;
  /** Inside a rounded section the divider keeps to the section's edges. */
  readonly inset?: boolean;
  readonly onPress: () => void;
  /** An unfiled doc's one-tap way to file it. */
  readonly onFile?: () => void;
  /** A deleted doc's way back, for whoever may. */
  readonly onRestore?: () => void;
  readonly restoring?: boolean;
}) {
  const { row, onFile, onRestore } = props;
  const grows = useKinTextGrows();
  return (
    <>
      <View className={cn("min-h-16 flex-row items-center gap-3", props.inset ? "px-4" : "px-5")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={row.accessibilityLabel}
          onPress={props.onPress}
          className="min-w-0 flex-1 gap-0.5 py-3 active:opacity-60"
        >
          <View className="flex-row items-center gap-2">
            <Text
              textRole="body"
              numberOfLines={kinLines(1, grows)}
              className="min-w-0 shrink text-foreground"
            >
              {row.title}
            </Text>
            {row.pinned ? (
              <Text textRole="footnote" className="font-t3-medium text-accent-foreground">
                {KIN_WHAT_WE_SELL.pinned}
              </Text>
            ) : null}
            {row.private ? <KinWorkPrivateMark label="" /> : null}
          </View>
          <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
            {row.line}
          </Text>
          {props.bare || row.under === null ? null : (
            <Text
              textRole="footnote"
              numberOfLines={kinLines(1, grows)}
              className="text-foreground-muted"
            >
              {row.under}
            </Text>
          )}
          {row.deletedLine === null ? null : (
            <Text
              textRole="footnote"
              numberOfLines={kinLines(1, grows)}
              className="text-foreground-muted"
            >
              {row.deletedLine}
            </Text>
          )}
        </Pressable>
        {row.archived && row.deletedLine === null ? (
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            {KIN_DOCS.archived}
          </Text>
        ) : null}
        {onFile === undefined ? null : (
          <Button
            tone="secondary"
            size="compact"
            label={KIN_DOC_HOMES.file}
            accessibilityLabel={`${KIN_DOC_HOMES.file} ${row.title}`}
            onPress={onFile}
          />
        )}
        {onRestore === undefined ? null : (
          <Button
            tone="secondary"
            size="compact"
            label={props.restoring === true ? KIN_DOCS.restoringDoc : KIN_DOCS.restoreDoc}
            accessibilityLabel={`${KIN_DOCS.restoreDoc} ${row.title}`}
            loading={props.restoring === true}
            disabled={props.restoring === true}
            onPress={onRestore}
          />
        )}
      </View>
      <View className={cn("h-px bg-border-subtle", props.inset ? "ml-4" : "ml-5")} />
    </>
  );
}

const WAY_ICON: Record<KinWhatWeSellWay, "arrow.right" | "doc.text" | "bubble.left"> = {
  website: "arrow.right",
  brochure: "doc.text",
  talk: "bubble.left",
};

/** No What we sell yet: three ways in, each starting it and opening the sales agent's chat. */
function KinWhatWeSellEmpty(props: {
  readonly agent: string;
  readonly start: (draft: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <View className="mx-4 mt-2 gap-2 rounded-2xl bg-grouped-card px-4 py-3.5">
      <Text textRole="body" accessibilityRole="header" className="font-t3-medium text-foreground">
        {KIN_WHAT_WE_SELL.empty.title}
      </Text>
      <Text textRole="footnote" className="text-foreground-muted">
        {KIN_WHAT_WE_SELL.empty.detail}
      </Text>
      {kinWhatWeSellWays(props.agent).map((way) => (
        <Pressable
          key={way.way}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            setFailed(false);
            const started = await props.start(way.draft);
            setBusy(false);
            setFailed(!started);
          }}
          className="min-h-11 flex-row items-center gap-3 active:opacity-60"
        >
          <SymbolView
            name={WAY_ICON[way.way]}
            size={16}
            tintColorClassName="text-foreground-muted"
            type="monochrome"
          />
          <Text textRole="body" className="text-foreground">
            {way.label}
          </Text>
        </Pressable>
      ))}
      {failed ? <Notice tone="danger" message={KIN_WHAT_WE_SELL.startFailed} /> : null}
    </View>
  );
}

/** A list kept beside the docs, as a row that opens it. */
/** The company's playbooks as one row until it is opened, so the docs people write lead. */
function KinPlaybooksRow(props: {
  readonly count: number;
  readonly open: boolean;
  readonly onPress: () => void;
}) {
  const line = KIN_DOC_HOMES.playbooksLine(props.count);
  const grows = useKinTextGrows();
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${KIN_DOC_HOMES.playbooks}. ${line}`}
        accessibilityState={{ expanded: props.open }}
        onPress={props.onPress}
        className="min-h-16 flex-row items-center gap-3 px-5 py-3 active:opacity-60"
      >
        <SymbolView
          name="list.number"
          size={18}
          tintColorClassName="accent-icon"
          type="monochrome"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" numberOfLines={kinLines(1, grows)} className="text-foreground">
            {KIN_DOC_HOMES.playbooks}
          </Text>
          <Text
            textRole="footnote"
            numberOfLines={kinLines(1, grows)}
            className="text-foreground-muted"
          >
            {line}
          </Text>
        </View>
        <SymbolView
          name={props.open ? "chevron.up" : "chevron.down"}
          size={13}
          tintColorClassName="text-foreground-muted"
          type="monochrome"
        />
      </Pressable>
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}

function KinListRowButton(props: { readonly row: KinListIndexRow; readonly onPress: () => void }) {
  const { row } = props;
  const grows = useKinTextGrows();
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
          <Text textRole="body" numberOfLines={kinLines(1, grows)} className="text-foreground">
            {row.name}
          </Text>
          <Text
            textRole="footnote"
            numberOfLines={kinLines(1, grows)}
            className="text-foreground-muted"
          >
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
  readonly scope?: KinViewerScope;
  /** Finding nothing says nothing: the list above already answers for the search. */
  readonly quietWhenNone?: boolean;
}) {
  const { state } = props;
  const grows = useKinTextGrows();
  if (state.hits === null) {
    return state.failed ? (
      <KinLoadFailed title={KIN_SEARCH.failed} cause={state.failed.cause} onRetry={props.onRetry} />
    ) : (
      <KinWorkLoading label="Searching" />
    );
  }
  if (state.hits.length === 0)
    return props.quietWhenNone ? null : (
      <EmptyState variant="plain" {...kinSearchNothing(state.answered, props.scope)} />
    );
  return (
    <View className={cn(state.loading && "opacity-60")}>
      {state.failed ? (
        <View className="px-4 pb-2">
          <Notice
            tone="danger"
            message={kinFailureText(state.failed.cause, `${KIN_SEARCH.failed}.`)}
          />
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
                <Text
                  textRole="body"
                  numberOfLines={kinLines(1, grows)}
                  className="min-w-0 shrink text-foreground"
                >
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
  | { readonly type: "group"; readonly id: string; readonly title: string; readonly unfiled?: true }
  | { readonly type: "recent"; readonly id: string; readonly rows: ReadonlyArray<KinDocListRow> }
  | { readonly type: "whatWeSell"; readonly id: string }
  | {
      readonly type: "doc";
      readonly id: string;
      readonly row: KinDocListRow;
      readonly bare: boolean;
    }
  | { readonly type: "list"; readonly id: string; readonly row: KinListIndexRow }
  | { readonly type: "moreLists"; readonly id: string; readonly label: string }
  | { readonly type: "playbooks"; readonly id: string; readonly count: number };

const DOCS_ONLY = ["docs"] as const;
const LISTS_FOLDED = 3;

/** The last few docs changed, as two rows of cards; nothing scrolls sideways. */
function KinRecentStrip(props: {
  readonly rows: ReadonlyArray<KinDocListRow>;
  readonly names: KinWorkDirectory["names"];
  readonly now: Date;
  readonly onOpen: (key: KinRecordKey) => void;
}) {
  const grows = useKinTextGrows();
  return (
    <View className="gap-1 pt-2">
      <View className="px-5 pb-1">
        <Text
          textRole="footnote"
          accessibilityRole="header"
          className="font-t3-medium text-foreground-muted"
        >
          {KIN_DOC_HOMES.recent}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-3 px-4">
        {props.rows.map((doc) => {
          const row = kinDocRow(doc, props.names, props.now);
          return (
            <Pressable
              key={doc.recordId}
              accessibilityRole="button"
              accessibilityLabel={row.accessibilityLabel}
              onPress={() => props.onOpen(doc.key)}
              className={cn(
                "min-w-0 grow gap-1 rounded-2xl bg-grouped-card px-3.5 py-3 active:opacity-60",
                grows ? "basis-full" : "basis-[45%]",
              )}
            >
              <Text
                textRole="body"
                numberOfLines={kinLines(2, grows)}
                className="font-t3-medium text-foreground"
              >
                {row.title}
              </Text>
              <Text
                textRole="footnote"
                numberOfLines={kinLines(1, grows)}
                className="text-foreground-muted"
              >
                {row.under ?? KIN_DOC_HOMES.unfiled}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const noHeld = Atom.make(AsyncResult.initial<never, never>());

/**
 * The clients the viewer looks after and the projects they lead or are on, for Docs' Mine; null
 * until both are read. A read the host refuses counts as none.
 */
function useKinDocsMineHeld(target: KinWorkTarget, me: KinPersonId | null): KinMineHeld | null {
  const { environmentId, orgId } = target;
  const choices = useAtomValue(me === null ? noHeld : kinWorkChoicesAtom(target));
  const projects = useAtomValue(
    me === null
      ? noHeld
      : kinClient.teammateProjects({ environmentId, input: { orgId, person: me } }),
  );
  if (me === null) return kinDocsMineHeld(null, [], []);
  if (AsyncResult.isInitial(choices) || AsyncResult.isInitial(projects)) return null;
  return kinDocsMineHeld(
    me,
    Option.getOrNull(AsyncResult.value(choices))?.clients ?? [],
    Option.getOrNull(AsyncResult.value(projects))?.theirs ?? [],
  );
}

/**
 * Docs as a library: the last few changed on top, the lists people keep, then every doc under
 * its home (each client with its projects, then the company's own, then the unfiled). One
 * filter picks a kind or a shelf; Company is a tap away above the list, the playbooks fold below.
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
  const [allLists, setAllLists] = useState(false);
  const [playbooksOpen, setPlaybooksOpen] = useState(false);
  const canFile = useAtomValue(kinClient.docFile.permissionAtom(environmentId));
  const deleting = useKinDocDelete(props);
  const scope = useKinViewerScope(environmentId);
  const { filter } = state;
  const shown = kinListShown(state, kinHostLink(useKinHostAt(environmentId)));
  const lists = useKinLists(props, {
    enabled: true,
    archived: filter.archived,
  });
  const refresh = () => {
    refreshKinWorkLive(props);
    list.refresh();
    lists.refresh();
  };
  const searching = found.text.trim() !== "";
  const passages = searching && (found.hits?.length ?? 0) > 0;
  const everything = filter.show._tag === "all";
  const chip = kinDocsChip(filter);
  const index = kinListsIndex(
    lists.state._tag === "ready" ? kinPlaceLists(lists.state.value.lists) : [],
  );
  const words = filter.text.trim().toLowerCase();
  const listRows = (filter.archived ? index.archived : index.active).filter(
    (row) => words === "" || row.name.toLowerCase().includes(words),
  );
  // What we sell is read on its own: pinned whatever page holds it, or its empty state's ways in.
  const pinShown = kinWhatWeSellShown(filter);
  const pinned = useKinWhatWeSell(props, pinShown);
  const starter = useKinWhatWeSellStart(props);
  const held = useKinDocsMineHeld(props, names.me);
  const all = kinDocsOnPhone(state.records);
  const mine = held === null || shown !== "rows" ? null : kinDocsMine(all, held, !state.more);
  const remembered = kinMineChosenAtom(kinClientsChosenKey(environmentId, names.me));
  const [asked, setAsked] = useState<KinMineSide | null>(null);
  const side =
    asked ?? kinMineOpens(appAtomRegistry.get(remembered).docs ?? null, mine?.counts.mine ?? null);
  const choose = (next: KinMineSide) => {
    appAtomRegistry.set(remembered, { ...appAtomRegistry.get(remembered), docs: next });
    setAsked(next);
  };
  const onMine = side !== "everyone";
  const records = !onMine ? all : (mine?.mine ?? []);
  const pinnedRow = pinShown ? (pinned ?? null) : null;
  const pin =
    pinnedRow === null || !onMine || (held !== null && kinIsMine(pinnedRow, held))
      ? pinnedRow
      : null;
  const library = kinDocLibrary(records, pin);
  const whatWeSell: ReadonlyArray<Item> =
    !refused && !onMine && shown === "rows" && pinShown && pinned === null && starter !== null
      ? [{ type: "whatWeSell", id: "what-we-sell" }]
      : [];
  const shownLists = allLists ? listRows : listRows.slice(0, LISTS_FOLDED);
  // The lists people keep are the company's, so they show under Everyone.
  const listItems: ReadonlyArray<Item> =
    !everything || onMine || listRows.length === 0
      ? []
      : [
          { type: "group", id: "group:lists", title: `${KIN_LISTS.title} · ${listRows.length}` },
          ...shownLists.map((row): Item => ({ type: "list", id: `list:${row.list}`, row })),
          ...(listRows.length > LISTS_FOLDED
            ? [
                {
                  type: "moreLists" as const,
                  id: "more-lists",
                  label: allLists ? KIN_DOC_HOMES.fewerLists : KIN_DOC_HOMES.seeAllLists,
                },
              ]
            : []),
        ];
  // A shelf or a kind is one flat list; everything is filed under its home.
  const docItems: ReadonlyArray<Item> = refused
    ? []
    : !everything || searching
      ? kinDocsPinned(records, searching ? null : pin).map((row): Item => ({
          type: "doc",
          id: row.recordId,
          row,
          bare: false,
        }))
      : library.homes.flatMap((home): ReadonlyArray<Item> => [
          {
            type: "group",
            id: `group:${home.id}`,
            title: `${home.title} · ${home.rows.length}`,
            ...(home.kind === "unfiled" ? { unfiled: true as const } : {}),
          },
          ...home.rows.map((row): Item => ({
            type: "doc",
            id: row.recordId,
            row,
            bare: home.kind !== "client",
          })),
        ]);
  const playbookItems: ReadonlyArray<Item> =
    refused || !everything || searching || library.playbooks.length === 0
      ? []
      : [
          { type: "playbooks", id: "playbooks", count: library.playbooks.length },
          ...(playbooksOpen
            ? library.playbooks.map((row): Item => ({
                type: "doc",
                id: row.recordId,
                row,
                bare: true,
              }))
            : []),
        ];
  const recent: ReadonlyArray<Item> =
    everything && !searching && !filter.archived && library.recent.length > 0
      ? [{ type: "recent", id: "recent", rows: library.recent }]
      : [];
  const items = [...whatWeSell, ...recent, ...listItems, ...docItems, ...playbookItems];
  // With lists showing, the docs' own loading or failure still needs saying under them.
  const docsPending = listItems.length > 0 && docItems.length === 0;
  const footer = kinDocsFooter(state.records.length, state.total, state.more);
  const open = (doc: KinRecordKey, section?: string) =>
    navigation.navigate("KinDoc", {
      environmentId,
      orgId,
      doc,
      ...(section === undefined ? {} : { section }),
    });
  const fileDoc = (doc: KinRecordKey) =>
    navigation.navigate("KinDocFile", { environmentId, orgId, doc });
  const show = (next: KinDocsShow) => list.setFilter({ ...filter, show: next });
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
                  title: "Filter",
                  icon: "line.3.horizontal.decrease.circle",
                  items: [
                    {
                      id: "show",
                      title: KIN_WORK_HOME.show,
                      inline: true,
                      items: KIN_DOCS_SHOWS.slice(0, 3).map((one) => ({
                        id: `show:${one.label}`,
                        title: one.label,
                        selected: kinDocsSameShow(filter.show, one.show),
                        onPress: () => show(one.show),
                      })),
                    },
                    {
                      id: "kind",
                      title: KIN_DOC_HOMES.kind,
                      items: KIN_DOCS_SHOWS.slice(3, -1).map((one) => ({
                        id: `show:${one.label}`,
                        title: one.label,
                        selected: kinDocsSameShow(filter.show, one.show),
                        onPress: () => show(one.show),
                      })),
                    },
                    {
                      id: "which",
                      title: KIN_DOCS.which,
                      inline: true,
                      items: [
                        ...KIN_DOCS_SHOWS.slice(-1).map((one) => ({
                          id: "show:files",
                          title: one.label,
                          selected: kinDocsSameShow(filter.show, one.show),
                          onPress: () => show(one.show),
                        })),
                        {
                          id: "archived",
                          title: KIN_DOCS.archived,
                          selected: filter.archived,
                          onPress: () => {
                            list.setFilter({ ...filter, archived: !filter.archived });
                            search.setClosed(!filter.archived);
                          },
                        },
                      ],
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
        {refused || side === null ? null : (
          <KinListPinned>
            <KinMineSwitch
              side={side}
              counts={{ mine: mine?.counts.mine ?? null, everyone: mine?.counts.everyone ?? null }}
              onSelect={choose}
            />
          </KinListPinned>
        )}
        <LegendList<Item>
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
          extraData={[
            state,
            found,
            lists.state,
            allLists,
            playbooksOpen,
            canFile,
            deleting.busy,
            deleting.problem,
            starter?.agent,
            pinned,
          ]}
          estimatedItemSize={72}
          recycleItems
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            refused ? null : (
              <View className="gap-2 pt-2">
                {shown === "rows" && (props.stale || state.stale) ? (
                  <View className="px-4">
                    <KinWorkStaleNotice
                      environmentId={environmentId}
                      onRetry={refresh}
                      readAt={state.readAt}
                    />
                  </View>
                ) : null}
                {deleting.problem === null ? null : (
                  <View className="px-4">
                    <Notice tone="danger" message={deleting.problem} onDismiss={deleting.dismiss} />
                  </View>
                )}
                <View className="flex-row flex-wrap gap-2 px-4">
                  {chip === null ? (
                    KIN_DOC_SHELVES.map((shelf) => (
                      <Chip
                        key={shelf.label}
                        label={shelf.label}
                        icon="folder.fill"
                        accessibilityLabel={`Show ${shelf.label}`}
                        onPress={() => show(shelf.show)}
                      />
                    ))
                  ) : (
                    <Chip
                      label={chip}
                      selected
                      trailingIcon="xmark"
                      accessibilityLabel={`Showing ${chip}. ${KIN_WORK_HOME.clearFilter}`}
                      onPress={() => {
                        list.setFilter({ ...filter, archived: false, show: KIN_DOCS_ALL });
                        search.setClosed(false);
                      }}
                    />
                  )}
                </View>
                {filter.show._tag === "files" ? (
                  <Text textRole="footnote" className="px-5 text-foreground-muted">
                    {KIN_DOC_HOMES.filesDetail}
                  </Text>
                ) : null}
              </View>
            )
          }
          ListEmptyComponent={
            <View className="pt-4">
              {refused ? (
                <EmptyState variant="plain" {...KIN_DOCS.unavailable} />
              ) : shown === "offline" ? (
                <EmptyState variant="plain" {...kinWorkOffline("docs")} />
              ) : shown === "loading" || (shown === "rows" && side === null) ? (
                <KinWorkLoading label={KIN_DOCS.loading} />
              ) : shown === "failed" ? (
                <KinLoadFailed
                  title={KIN_DOCS.loadFailed}
                  cause={state.failed}
                  onRetry={list.refresh}
                />
              ) : passages ? null : searching || !everything ? (
                <EmptyState variant="plain" {...KIN_DOCS.noMatch} />
              ) : onMine && !filter.archived && all.length > 0 ? (
                <EmptyState variant="plain" {...KIN_DOCS.noneMine} />
              ) : (
                <EmptyState
                  variant="plain"
                  {...(filter.archived
                    ? KIN_DOCS.emptyArchived
                    : (kinNothingShown("docs", scope) ?? KIN_DOCS.empty))}
                />
              )}
            </View>
          }
          ListFooterComponent={
            <>
              {!docsPending ? null : shown === "offline" ? (
                <View className="px-4 pt-4">
                  <EmptyState variant="plain" {...kinWorkOffline("docs")} />
                </View>
              ) : shown === "loading" ? (
                <KinWorkLoading label={KIN_DOCS.loading} />
              ) : shown === "failed" ? (
                <View className="px-4 pt-4">
                  <Notice
                    tone="danger"
                    message={KIN_DOCS.loadFailed}
                    action={{ label: KIN_RETRY, onPress: list.refresh }}
                  />
                </View>
              ) : null}
              {footer === null ? null : (
                <View className="items-start gap-2 px-5 py-4">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {state.moreFailed ? KIN_MORE_FAILED : footer}
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
            item.type === "whatWeSell" ? (
              starter === null ? null : (
                <KinWhatWeSellEmpty agent={starter.agent} start={starter.start} />
              )
            ) : item.type === "recent" ? (
              <KinRecentStrip rows={item.rows} names={names} now={now} onOpen={open} />
            ) : item.type === "list" ? (
              <KinListRowButton
                row={item.row}
                onPress={() =>
                  navigation.navigate("KinList", { environmentId, orgId, list: item.row.list })
                }
              />
            ) : item.type === "playbooks" ? (
              <KinPlaybooksRow
                count={item.count}
                open={playbooksOpen}
                onPress={() => setPlaybooksOpen(!playbooksOpen)}
              />
            ) : item.type === "moreLists" ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setAllLists(!allLists)}
                className="min-h-11 justify-center px-5 active:opacity-60"
              >
                <Text textRole="body" className="text-accent-foreground">
                  {item.label}
                </Text>
              </Pressable>
            ) : item.type === "group" ? (
              <View className="flex-row items-end gap-3 px-5 pb-1 pt-5">
                <Text
                  textRole="footnote"
                  accessibilityRole="header"
                  className="min-w-0 flex-1 font-t3-medium text-foreground-muted"
                >
                  {item.title}
                </Text>
                {item.unfiled === true && agent !== null ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${KIN_DOC_HOMES.fileAll}, ${agent.name}`}
                    onPress={() => agent.ask(KIN_DOC_HOMES.fileAllMessage)}
                    className="min-h-8 justify-center active:opacity-60"
                  >
                    <Text textRole="footnote" className="font-t3-medium text-accent-foreground">
                      {KIN_DOC_HOMES.fileAll}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <KinDocRowButton
                row={kinDocRow(item.row, names, now)}
                bare={item.bare}
                onPress={() => open(item.row.key)}
                {...(canFile && kinDocUnfiled(item.row) && filter.show._tag !== "files"
                  ? { onFile: () => fileDoc(item.row.key) }
                  : {})}
                {...(deleting.allowed && item.row.archived && item.row.deletable === true
                  ? {
                      onRestore: () =>
                        void deleting
                          .restore(item.row.key)
                          .then((why) => why === null && list.refresh()),
                      restoring: deleting.busy === item.row.key,
                    }
                  : {})}
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
