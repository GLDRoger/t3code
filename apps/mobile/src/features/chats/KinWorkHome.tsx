import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { KIN_SEARCH, type KinSearchHitView } from "@t3tools/client-runtime/kin/kinDocs";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import { kinMoneyView } from "@t3tools/client-runtime/kin/kinMoney";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import { KIN_WORK_TITLE, kinWorkHostClients } from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_NEEDS_YOU_SHOWN,
  KIN_WORK_HOME,
  kinClientsLine,
  kinDocsLine,
  kinListsLine,
  kinMoneyLine,
  kinNeedsYou,
  kinTasksLine,
  kinWorkEmpty,
  type KinNeedsYouRow,
  type KinWorkPlace,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import { useState } from "react";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { KinSearchHits } from "./KinDocsList";
import { kinTabBar, useKinTab } from "./components/KinTab";
import { KinWorkStaleNotice } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import { useKinSearch } from "./state/useKinDocs";
import { useKinInbox } from "./state/useKinInbox";
import { useKinAskAgent, useKinLists, useKinMoneySummary } from "./state/useKinMoney";
import { refreshKinWorkLive, type KinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";
import { useKinClientCounts, useKinDocsRecent, useKinMyDueTasks } from "./state/useKinWorkHome";

const NEEDS_ICON: Record<KinNeedsYouRow["kind"], AppSymbolName> = {
  task: "checkmark.circle",
  money: "chart.bar.xaxis",
  waiting: "exclamationmark.circle",
};

/** Work's one page: search over everything, what needs you, then every place with its summary. */
export function KinWorkHome(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
  },
) {
  const navigation = useNavigation();
  const tab = useKinTab();
  const { environmentId, orgId, live } = props;
  const target = { environmentId, orgId };
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const seq = props.stale ? null : live.seq;
  const summary = live.summary;
  const hostClients = kinWorkHostClients(summary);

  const money = useKinMoneySummary(target, { enabled: true, seq });
  const lists = useKinLists(target, { enabled: true, archived: true, seq });
  const docs = useKinDocsRecent(target);
  const counts = useKinClientCounts(target, hostClients, seq);
  const mine = useKinMyDueTasks(target, names.me, seq);
  const inbox = useKinInbox();
  const { state: found, search } = useKinSearch(target, null);
  const [expanded, setExpanded] = useState(false);
  const chief = useKinAskAgent(target, null);
  const bookkeeper = useKinAskAgent(target, "money");
  const canAddTask = useAtomValue(kinClient.workCreate.permissionAtom(environmentId));
  const canAddClient = useAtomValue(kinClient.workClientCreate.permissionAtom(environmentId));
  const canReceipt = useAtomValue(kinClient.makeReceipt.permissionAtom(environmentId));

  const moneyState = money.state;
  const listsState = lists.state;
  const listDefs = listsState._tag === "ready" ? listsState.value.lists : [];
  // A viewer the host keeps money from never sees it: no row, nothing owed in "Needs you".
  const moneyShown = moneyState._tag !== "refused" && moneyState._tag !== "failed";
  const moneyValue = moneyState._tag === "ready" ? moneyState.value : null;
  const inboxReady =
    inbox.state._tag === "ready" && inbox.state.environmentId === environmentId
      ? inbox.state
      : null;
  const waiting =
    inboxReady === null
      ? []
      : selectKinInboxView(inboxReady.inbox.value).waiting.filter((item) => item.orgId === orgId);
  const needs =
    mine === null
      ? null
      : kinNeedsYou({
          mine,
          money: moneyValue,
          lists: listDefs,
          waiting,
          chats: inboxReady?.inbox.value.chats ?? [],
          agentNames: kinDirectory(inbox.host).agentNames,
          names,
          now,
        });
  const listsLine = listsState._tag === "ready" ? kinListsLine(listDefs) : null;
  const moneyEmpty =
    moneyValue === null
      ? moneyShown
        ? undefined
        : null
      : kinMoneyView(moneyValue, listDefs).empty;
  const empty =
    summary !== null &&
    needs !== null &&
    kinWorkEmpty({
      summary,
      clients: !hostClients ? null : counts === null ? undefined : counts.clients + counts.projects,
      docs: docs.refused ? null : docs.docs === null ? undefined : docs.docs.total,
      moneyEmpty,
      lists:
        listsState._tag === "ready"
          ? listsLine === null
            ? 0
            : 1
          : listsState._tag === "loading"
            ? undefined
            : null,
      needsYou: needs.length,
    });

  const base = { environmentId: String(environmentId), orgId: String(orgId) };
  const openPlace = (place: KinWorkPlace) =>
    navigation.dispatch(StackActions.push("KinWork", { ...base, show: place }));
  const openNeed = (row: KinNeedsYouRow) => {
    const { open } = row;
    if (open.type === "task") navigation.navigate("KinWorkItem", { ...base, task: open.key });
    else if (open.type === "chat") navigation.navigate("KinChat", { ...base, chatId: open.chatId });
    else if (open.type === "money") openPlace("money");
    else
      navigation.navigate("KinList", {
        ...base,
        list: open.open.list,
        filter: JSON.stringify(open.open.filter),
      });
  };
  const openHit = (hit: KinSearchHitView) => {
    if (hit.kind === "docs")
      navigation.navigate("KinDoc", {
        ...base,
        doc: hit.key,
        ...(hit.section === null ? {} : { section: hit.section.id }),
      });
    else if (hit.kind === "clients") navigation.navigate("KinClient", { ...base, party: hit.key });
    else if (hit.kind === "projects")
      navigation.navigate("KinProject", { ...base, project: hit.key });
    else navigation.navigate("KinWorkItem", { ...base, task: hit.key });
  };
  const newTask = canAddTask ? () => navigation.navigate("KinWorkNew", base) : null;
  const askChief = chief === null ? null : () => chief.ask("");
  const refresh = () => {
    refreshKinWorkLive(target);
    money.refresh();
    lists.refresh();
  };

  const addItems: ReadonlyArray<AppBarMenuItem> = [
    ...(newTask === null
      ? []
      : [{ id: "task", title: KIN_WORK_HOME.addTask, icon: "checkmark.circle", onPress: newTask }]),
    ...(canAddClient && hostClients
      ? [
          {
            id: "client",
            title: KIN_WORK_HOME.addClient,
            icon: "person.2",
            onPress: () => navigation.navigate("KinClientForm", base),
          },
        ]
      : []),
    ...(bookkeeper === null || !moneyShown
      ? []
      : [
          {
            id: "expense",
            title: KIN_WORK_HOME.addExpense,
            subtitle: `${bookkeeper.name} logs it`,
            icon: "tag",
            onPress: () => bookkeeper.ask("Log an expense: "),
          },
        ]),
    ...(canReceipt && moneyShown
      ? [
          {
            id: "receipt",
            title: KIN_WORK_HOME.addReceipt,
            icon: "doc.text",
            onPress: () => navigation.navigate("KinReceiptNew", base),
          },
        ]
      : []),
    ...(chief === null
      ? []
      : [
          {
            id: "ask",
            title: KIN_WORK_HOME.askAgent,
            subtitle: chief.name,
            icon: "bubble.left",
            onPress: () => chief.ask(""),
          },
        ]),
  ];

  const searching = found.text.trim() !== "";
  const shown = needs === null ? [] : expanded ? needs : needs.slice(0, KIN_NEEDS_YOU_SHOWN);

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={KIN_WORK_TITLE}
        refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
        {...(addItems.length === 0
          ? {}
          : { menus: [{ title: KIN_WORK_HOME.add, icon: "plus", items: addItems }] })}
        {...kinTabBar(tab, {
          onBack: () => navigation.goBack(),
          search: {
            value: found.text,
            onChangeText: search.setText,
            placeholder: KIN_WORK_HOME.search,
            closeAccessibilityLabel: "Close search",
            clearAccessibilityLabel: "Clear search",
          },
        })}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingTop: 8,
            paddingBottom: 32 + (tab?.bottomClearance ?? 64),
            gap: 20,
          }}
        >
          {props.stale ? (
            <View className="px-4">
              <KinWorkStaleNotice environmentId={environmentId} onRetry={refresh} />
            </View>
          ) : null}
          {searching ? (
            <>
              <View className="px-4">
                <ListSection>
                  <ListToggleRow
                    label={KIN_SEARCH.includeClosed}
                    value={found.closed}
                    onValueChange={search.setClosed}
                  />
                </ListSection>
              </View>
              <KinSearchHits state={found} onRetry={search.retry} onOpen={openHit} />
            </>
          ) : empty ? (
            <View className="px-4 pt-8">
              <EmptyState
                variant="plain"
                {...KIN_WORK_HOME.empty}
                action={
                  <View className="gap-3">
                    {newTask === null ? null : (
                      <View className="flex-row justify-center">
                        <Button tone="primary" icon="plus" label="New task" onPress={newTask} />
                      </View>
                    )}
                    {askChief === null ? null : (
                      <View className="flex-row justify-center">
                        <Button
                          tone={newTask === null ? "primary" : "secondary"}
                          icon="bubble.left"
                          label={`Ask ${chief?.name ?? "an agent"}`}
                          onPress={askChief}
                        />
                      </View>
                    )}
                  </View>
                }
              />
            </View>
          ) : (
            <View className="gap-6 px-4">
              <ListSection title={KIN_WORK_HOME.needsYou}>
                {needs === null ? (
                  <ListRowLayout label="Checking what needs you" disabled />
                ) : needs.length === 0 ? (
                  <ListRowLayout label={KIN_WORK_HOME.nothingNeedsYou} disabled />
                ) : (
                  shown.map((row) => (
                    <ListRow
                      key={row.id}
                      icon={NEEDS_ICON[row.kind]}
                      label={row.title}
                      description={row.detail}
                      onPress={() => openNeed(row)}
                    />
                  ))
                )}
                {needs === null || needs.length <= KIN_NEEDS_YOU_SHOWN ? null : (
                  <ListActionRow
                    label={expanded ? KIN_WORK_HOME.seeFewer : KIN_WORK_HOME.seeAll(needs.length)}
                    onPress={() => setExpanded((open) => !open)}
                  />
                )}
              </ListSection>
              <ListSection>
                <ListRow
                  icon="checkmark.circle"
                  label={KIN_WORK_HOME.places.tasks}
                  {...(summary === null ? {} : { description: kinTasksLine(summary) })}
                  onPress={() => openPlace("tasks")}
                />
                {!moneyShown ? null : (
                  <ListRow
                    icon="chart.bar.xaxis"
                    label={KIN_WORK_HOME.places.money}
                    {...(moneyValue === null ? {} : { description: kinMoneyLine(moneyValue) })}
                    onPress={() => openPlace("money")}
                  />
                )}
                {!hostClients ? null : (
                  <ListRow
                    icon="person.2"
                    label={KIN_WORK_HOME.places.clients}
                    {...(counts === null
                      ? {}
                      : { description: kinClientsLine(counts.clients, counts.projects) })}
                    onPress={() => openPlace("clients")}
                  />
                )}
                {docs.refused ? null : (
                  <ListRow
                    icon="doc.text"
                    label={KIN_WORK_HOME.places.docs}
                    {...(docs.docs === null
                      ? {}
                      : { description: kinDocsLine(docs.docs.total, docs.docs.docs, now) })}
                    onPress={() => openPlace("docs")}
                  />
                )}
                {listsLine === null ? null : (
                  <ListRow
                    icon="line.3.horizontal"
                    label={KIN_WORK_HOME.places.lists}
                    description={listsLine}
                    onPress={() => openPlace("lists")}
                  />
                )}
              </ListSection>
            </View>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
