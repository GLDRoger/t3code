import { useNavigation } from "@react-navigation/native";
import {
  kinAttention,
  kinNeedsYouBeside,
  type KinAttentionOpen,
} from "@t3tools/client-runtime/kin/kinAttention";
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
import type { KinRecord } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useNowMinuteMs } from "../../lib/clock";
import { KinAttentionHandled, KinAttentionItem, kinAttentionNames } from "./KinAttention";
import { useKinOpenPlace } from "./state/kinHomeTab";
import { useKinAttention, useKinAttentionHandle } from "./state/useKinAttention";
import { useKinWorkLink } from "./state/kinWorkLink";
import { useKinInbox } from "./state/useKinInbox";
import { useKinLists, useKinMoneySummary } from "./state/useKinMoney";
import type { KinWorkTarget } from "./state/useKinWork";

const NEEDS_ICON: Record<KinNeedsYouRow["kind"], AppSymbolName> = {
  task: "checkmark.circle",
  money: "banknote",
  waiting: "exclamationmark.circle",
};

/** The top of Tasks: what needs attention, your late and due-today tasks, and what agents ask. */
export function KinNeedsYou(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly names: KinWorkNames;
    /** Your open tasks due by the end of today; null until read. Tasks leaves them out below. */
    readonly mine: ReadonlyArray<KinRecord> | null;
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
  const { mine } = props;
  const inbox = useKinInbox();
  const [expanded, setExpanded] = useState(false);
  const attentionRead = useKinAttention(target);
  const handler = useKinAttentionHandle(target);
  const attention = kinAttention(attentionRead, {
    scope: { type: "all" },
    names: kinAttentionNames(names),
    now,
  });

  const inboxReady =
    inbox.state._tag === "ready" && inbox.state.environmentId === environmentId
      ? inbox.state
      : null;
  const before =
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
  const needs = before === null ? null : kinNeedsYouBeside(before, attention.open);
  const total = needs === null ? 0 : needs.length + attention.open.length;
  if (props.hideWhenNone && needs !== null && total === 0 && attention.handled.length === 0)
    return null;

  const base = { environmentId: String(environmentId), orgId: String(orgId) };
  const open = (row: KinNeedsYouRow) => {
    const { open: to } = row;
    if (to.type === "task") openRecord("KinWorkItem", { ...base, task: to.key });
    else if (to.type === "chat") navigation.navigate("KinChat", { ...base, chatId: to.chatId });
    // Overdue invoices jump to Money, which splits them by client.
    else openPlace("money");
  };
  const openAttention = (to: KinAttentionOpen) => {
    if (to.type === "record") openRecord("KinWorkItem", { ...base, task: to.key });
    else if (to.type === "money") openPlace("money");
  };
  const limit = expanded ? total : KIN_NEEDS_YOU_SHOWN;
  const shownAttention = needs === null ? [] : attention.open.slice(0, limit);
  const shown = needs === null ? [] : needs.slice(0, Math.max(0, limit - shownAttention.length));
  return (
    <View className="px-4">
      <ListSection title={KIN_WORK_HOME.needsYou}>
        {needs === null ? (
          <ListRowLayout label="Checking what needs you" disabled />
        ) : total === 0 ? (
          <ListRowLayout label={KIN_WORK_HOME.nothingNeedsYou} disabled />
        ) : (
          [
            ...shownAttention.map((row) => (
              <KinAttentionItem
                key={row.id}
                {...target}
                row={row}
                handler={handler}
                onOpen={openAttention}
              />
            )),
            ...shown.map((row) => (
              <ListRow
                key={row.id}
                icon={NEEDS_ICON[row.kind]}
                label={row.title}
                description={row.detail}
                onPress={() => open(row)}
              />
            )),
          ]
        )}
        {needs === null || total <= KIN_NEEDS_YOU_SHOWN ? null : (
          <ListActionRow
            label={expanded ? KIN_WORK_HOME.seeFewer : KIN_WORK_HOME.seeAll(total)}
            onPress={() => setExpanded((held) => !held)}
          />
        )}
        <KinAttentionHandled rows={attention.handled} handler={handler} />
      </ListSection>
    </View>
  );
}
