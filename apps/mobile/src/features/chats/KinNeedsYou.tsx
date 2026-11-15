import { useNavigation } from "@react-navigation/native";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_NEEDS_YOU_SHOWN,
  KIN_WORK_HOME,
  kinNeedsYou,
  type KinNeedsYouRow,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import { useState } from "react";
import { View } from "react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useNowMinuteMs } from "../../lib/clock";
import { useKinOpenPlace } from "./state/kinHomeTab";
import { useKinWorkLink } from "./state/kinWorkLink";
import { useKinInbox } from "./state/useKinInbox";
import { useKinLists, useKinMoneySummary } from "./state/useKinMoney";
import type { KinWorkTarget } from "./state/useKinWork";
import { useKinMyDueTasks } from "./state/useKinWorkHome";

const NEEDS_ICON: Record<KinNeedsYouRow["kind"], AppSymbolName> = {
  task: "checkmark.circle",
  money: "banknote",
  waiting: "exclamationmark.circle",
};

/** The top of Tasks: your late and due-today tasks, overdue invoices, and what agents ask you. */
export function KinNeedsYou(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly names: KinWorkNames;
    /** An empty company has nothing to say here, and Tasks' own empty state says it. */
    readonly hideWhenNone: boolean;
  },
) {
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const openPlace = useKinOpenPlace(props);
  const { environmentId, orgId, names } = props;
  const target = { environmentId, orgId };
  const now = new Date(useNowMinuteMs());
  const seq = props.stale ? null : props.live.seq;
  const money = useKinMoneySummary(target, { enabled: true, seq }).state;
  const lists = useKinLists(target, { enabled: true, archived: true, seq }).state;
  const mine = useKinMyDueTasks(target, names.me, seq);
  const inbox = useKinInbox();
  const [expanded, setExpanded] = useState(false);

  const inboxReady =
    inbox.state._tag === "ready" && inbox.state.environmentId === environmentId
      ? inbox.state
      : null;
  const needs =
    mine === null
      ? null
      : kinNeedsYou({
          mine,
          // A viewer the host keeps money from sees nothing owed here.
          money: money._tag === "ready" ? money.value : null,
          lists: lists._tag === "ready" ? lists.value.lists : [],
          waiting:
            inboxReady === null
              ? []
              : selectKinInboxView(inboxReady.inbox.value).waiting.filter(
                  (item) => item.orgId === orgId,
                ),
          chats: inboxReady?.inbox.value.chats ?? [],
          agentNames: kinDirectory(inbox.host).agentNames,
          names,
          now,
        });
  if (props.hideWhenNone && needs !== null && needs.length === 0) return null;

  const base = { environmentId: String(environmentId), orgId: String(orgId) };
  const open = (row: KinNeedsYouRow) => {
    const { open: to } = row;
    if (to.type === "task") openRecord("KinWorkItem", { ...base, task: to.key });
    else if (to.type === "chat") navigation.navigate("KinChat", { ...base, chatId: to.chatId });
    // Overdue invoices jump to Money, which splits them by client.
    else openPlace("money");
  };
  const shown = needs === null ? [] : expanded ? needs : needs.slice(0, KIN_NEEDS_YOU_SHOWN);
  return (
    <View className="px-4">
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
              onPress={() => open(row)}
            />
          ))
        )}
        {needs === null || needs.length <= KIN_NEEDS_YOU_SHOWN ? null : (
          <ListActionRow
            label={expanded ? KIN_WORK_HOME.seeFewer : KIN_WORK_HOME.seeAll(needs.length)}
            onPress={() => setExpanded((held) => !held)}
          />
        )}
      </ListSection>
    </View>
  );
}
