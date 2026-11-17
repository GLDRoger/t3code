import { useNavigation } from "@react-navigation/native";
import {
  KIN_ATTENTION,
  kinAttention,
  kinNeedsYouBeside,
  kinTasksAttention,
  type KinAttentionOpen,
  type KinAttentionRow,
} from "@t3tools/client-runtime/kin/kinAttention";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_HOME,
  kinNeedsYou,
  type KinNeedsYouRow,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import { useState } from "react";
import { View } from "react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
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

/**
 * What needs attention over Tasks, read for the owner and a co-owner: the attention rows, what
 * clients owe past due and what an agent waits on you for. Your own tasks are under "On me".
 * Null when not asked for (`enabled` false), and then nothing is read.
 */
export function useKinNeedsRows(
  props: KinWorkTarget & { readonly names: KinWorkNames },
  enabled: boolean,
) {
  const { environmentId, orgId, names } = props;
  const target = { environmentId, orgId };
  const now = new Date(useNowMinuteMs());
  const money = useKinMoneySummary(target, { enabled }).state;
  const lists = useKinLists(target, { enabled, archived: true }).state;
  const inbox = useKinInbox();
  const [expanded, setExpanded] = useState(false);
  // The first page until See all; then everything, the page standing in until it arrives.
  const pagedRead = useKinAttention(target, enabled, true);
  const fullRead = useKinAttention(target, enabled && expanded);
  const attentionRead = expanded && fullRead !== null ? fullRead : pagedRead;
  const handler = useKinAttentionHandle(target);
  if (!enabled) return null;
  const attention = kinAttention(attentionRead, {
    scope: { type: "all" },
    names: kinAttentionNames(names),
    now,
  });
  const inboxReady =
    inbox.state._tag === "ready" && inbox.state.environmentId === environmentId
      ? inbox.state
      : null;
  const before = kinNeedsYou({
    mine: [],
    // A viewer the host keeps money from sees nothing owed here.
    money: money._tag === "ready" ? money.value : null,
    lists: lists._tag === "ready" ? lists.value.lists : [],
    waiting:
      inboxReady === null
        ? []
        : selectKinInboxView(inboxReady.inbox.value).waiting.filter((item) => item.orgId === orgId),
    chats: inboxReady?.inbox.value.chats ?? [],
    agentNames: kinDirectory(inbox.host).agentNames,
    names,
    now,
  });
  // Money's own rows live on Money; here they are one row that opens it.
  const split = kinTasksAttention(attention.open, attentionRead);
  const needs: ReadonlyArray<KinNeedsYouRow> = [
    ...(split.moneyRow === null ? [] : [split.moneyRow]),
    ...kinNeedsYouBeside(before, attention, attentionRead),
  ];
  return {
    attention: split.rows,
    needs,
    hidden: split.hidden,
    handled: attention.handled,
    handler,
    expanded,
    setExpanded,
  };
}

/** Over Tasks, the owner's and a co-owner's: what needs attention that "On me" doesn't hold. */
export function KinTasksAttention(
  props: KinWorkTarget &
    NonNullable<ReturnType<typeof useKinNeedsRows>> & {
      readonly total: number;
      readonly more: boolean;
    },
) {
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const openPlace = useKinOpenPlace(props);
  const { environmentId, orgId, handler, expanded, setExpanded, total } = props;
  const target = { environmentId, orgId };
  const needs: ReadonlyArray<KinNeedsYouRow> = props.needs;
  const attentionRows: ReadonlyArray<KinAttentionRow> = props.attention;
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
  // The rows come already cut to what shows (`kinTasksBlock`); the money row leads.
  const lead = needs[0]?.id === "attention:money" ? 1 : 0;
  const shownAttention = attentionRows;
  const shownNeeds = needs.slice(lead);
  const shown = needs.slice(0, lead);
  return (
    <View className="px-4">
      <ListSection title={KIN_ATTENTION.title}>
        {[
          ...shown.map((row) => (
            <ListRow
              key={row.id}
              icon={NEEDS_ICON[row.kind]}
              label={row.title}
              description={row.detail}
              onPress={() => open(row)}
            />
          )),
          ...shownAttention.map((row) => (
            <KinAttentionItem
              key={row.id}
              {...target}
              row={row}
              handler={handler}
              onOpen={openAttention}
            />
          )),
          ...shownNeeds.map((row) => (
            <ListRow
              key={row.id}
              icon={NEEDS_ICON[row.kind]}
              label={row.title}
              description={row.detail}
              onPress={() => open(row)}
            />
          )),
        ]}
        {!props.more ? null : (
          <ListActionRow
            label={expanded ? KIN_WORK_HOME.seeFewer : KIN_WORK_HOME.seeAll(total)}
            onPress={() => setExpanded(!expanded)}
          />
        )}
        <KinAttentionHandled rows={props.handled} handler={handler} />
      </ListSection>
    </View>
  );
}
