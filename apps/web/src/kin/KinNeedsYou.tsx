import {
  KIN_ATTENTION,
  kinAttention,
  kinNeedsYouBeside,
  kinTasksAttention,
  kinTasksBlock,
  type KinAttentionOpen,
  type KinAttentionRow,
} from "@t3tools/client-runtime/kin/kinAttention";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import type { KinListOpen } from "@t3tools/client-runtime/kin/kinMoney";
import { kinOpenNeeds } from "@t3tools/client-runtime/kin/kinOpenView";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import {
  KIN_WORK_HOME,
  kinNeedsPane,
  kinNeedsYou,
  type KinNeedsYouOpen,
  type KinNeedsYouRow,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinRecord, KinRecordKey } from "@t3tools/contracts";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import { useNavigate } from "@tanstack/react-router";
import { BanknoteIcon, CircleAlertIcon, CircleCheckIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { KinAttentionHandled, KinAttentionItem, kinAttentionNames } from "./KinAttention";
import { KinWorkSection } from "./KinWorkParts";
import { useKinAttention, useKinAttentionHandle } from "./useKinAttention";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import { useNowMinuteMs } from "./useKinClock";
import { useKinInbox } from "./useKinHost";
import { useKinOpen } from "./useKinOpen";
import { kinListsOf, useKinLists, useKinMoneySummary } from "./useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const ICON: Record<KinNeedsYouRow["kind"], LucideIcon> = {
  task: CircleCheckIcon,
  money: BanknoteIcon,
  waiting: CircleAlertIcon,
};

/** Where a Needs-you row goes: the task over the list, a list, Money, or a chat. */
export interface KinNeedsYouGo {
  readonly onOpenTask: (key: KinRecordKey) => void;
  readonly onOpenList: (open: KinListOpen) => void;
  readonly onOpenMoney: () => void;
}

/**
 * What needs attention and what needs you, read for one screen: the attention rows, then your
 * late tasks, what clients owe past due, what an agent waits on you for, and your tasks today.
 * Where the host streams the open list they are its rows, and `mine` is only whether to show.
 * Null while `mine` is (still loading, or not asked for: then nothing is read).
 */
export function useKinNeedsRows(
  props: KinWorkTarget & { readonly names: KinWorkNames },
  mine: ReadonlyArray<KinRecord> | null,
) {
  const { environmentId, orgId, names } = props;
  const asked = mine !== null;
  const open = useKinOpen(props);
  const enabled = asked && open === null;
  const now = new Date(useNowMinuteMs());
  const money = useKinMoneySummary(props, { enabled });
  const lists = useKinLists(props, { enabled });
  const inbox = useKinInbox();
  const [expanded, setExpanded] = useState(false);
  // The first page until See all; then everything, the page standing in until it arrives. The
  // open list has no answered facts, so their Undo still comes from the page.
  const pagedRead = useKinAttention(props, asked, true);
  const fullRead = useKinAttention(props, enabled && expanded);
  const attentionRead = expanded && fullRead !== null ? fullRead : pagedRead;
  const handler = useKinAttentionHandle(props);
  if (mine === null || open === undefined) return null;
  const attention = kinAttention(attentionRead, {
    scope: { type: "all" },
    names: kinAttentionNames(names),
    now,
  });
  const ready =
    inbox.state._tag === "ready" && inbox.state.environmentId === environmentId
      ? inbox.state
      : null;
  if (open !== null)
    return {
      ...kinOpenNeeds(open, {
        names,
        chats: ready?.inbox.value.chats ?? [],
        agentNames: kinDirectory(inbox.host).agentNames,
        now,
      }),
      handled: attention.handled,
      handler,
      expanded,
      setExpanded,
      openList: true,
    };
  const before = kinNeedsYou({
    mine,
    // Where the host keeps money from this viewer, nothing owed shows here either.
    money: money.state._tag === "ready" ? money.state.value : null,
    lists: kinListsOf(lists),
    waiting:
      ready === null
        ? []
        : selectKinInboxView(ready.inbox.value).waiting.filter((item) => item.orgId === orgId),
    chats: ready?.inbox.value.chats ?? [],
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
    openList: false,
  };
}

/**
 * The wide window's top with no chat open: what needs you today, your own tasks included. For a
 * teammate that is what is on them.
 */
export function KinNeedsYou(
  props: KinWorkTarget &
    KinNeedsYouGo & {
      readonly directory: KinWorkDirectory;
      /** Your open tasks due by the end of today; null until read. */
      readonly mine: ReadonlyArray<KinRecord> | null;
    },
) {
  const read = useKinNeedsRows({ ...props, names: props.directory.names }, props.mine);
  const pane = kinNeedsPane(useKinOwnerLevel(props.environmentId));
  if (read === null) return null;
  const cut = kinTasksBlock({
    ownerLevel: true,
    onMe: new Set(),
    attention: read.attention,
    needs: read.needs,
    hidden: read.hidden,
    handled: read.handled.length,
    expanded: read.expanded,
  });
  return (
    <KinNeedsBlock
      {...props}
      {...read}
      attention={cut?.attention ?? []}
      needs={cut?.needs ?? []}
      title={pane.title}
      total={cut?.total ?? 0}
      more={cut?.more ?? false}
      empty={pane.empty}
    />
  );
}

/** Over Tasks, the owner's and a co-owner's: what needs attention that "On me" doesn't hold. */
export function KinTasksAttention(
  props: KinWorkTarget &
    KinNeedsYouGo &
    NonNullable<ReturnType<typeof useKinNeedsRows>> & {
      readonly total: number;
      readonly onMe: number;
      readonly more: boolean;
    },
) {
  return (
    <KinNeedsBlock
      {...props}
      title={KIN_ATTENTION.title}
      empty={null}
      below={props.openList ? props.onMe : 0}
    />
  );
}

function KinNeedsBlock(
  props: KinWorkTarget &
    KinNeedsYouGo &
    NonNullable<ReturnType<typeof useKinNeedsRows>> & {
      readonly title: string;
      readonly total: number;
      readonly more: boolean;
      /** What an empty block says; null where it never shows empty. */
      readonly empty: string | null;
      /** Of `total`, the things the list below draws under "On me". */
      readonly below?: number;
    },
) {
  const { environmentId, orgId, handler, expanded, setExpanded, total, below = 0 } = props;
  const navigate = useNavigate();
  const rows: ReadonlyArray<KinNeedsYouRow> = props.needs;
  const attentionRows: ReadonlyArray<KinAttentionRow> = props.attention;
  const openAttention = (to: KinAttentionOpen) => {
    if (to.type === "record") props.onOpenTask(to.key);
    else if (to.type === "money") props.onOpenMoney();
  };
  const open = (to: KinNeedsYouOpen) => {
    if (to.type === "task") props.onOpenTask(to.key);
    else if (to.type === "list") props.onOpenList(to.open);
    else if (to.type === "money") props.onOpenMoney();
    else
      void navigate({
        to: "/kin/$environmentId/$orgId/$chatId",
        params: { environmentId, orgId, chatId: to.chatId },
      });
  };
  // The rows come already cut to what shows (`kinTasksBlock`); the money row leads.
  const lead = rows[0]?.id === "attention:money" ? 1 : 0;
  const shownAttention = attentionRows;
  const shown = rows;
  const needRow = (row: (typeof rows)[number]) => {
    const Icon = ICON[row.kind];
    return (
      <li key={row.id}>
        <button
          type="button"
          onClick={() => open(row.open)}
          className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
        >
          <Icon
            aria-hidden
            className={cn(
              "mt-0.5 size-4 shrink-0",
              row.late ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm text-foreground">{row.title}</span>
            <span
              className={cn(
                "truncate text-xs",
                row.late ? "text-destructive-foreground" : "text-muted-foreground",
              )}
            >
              {row.detail}
            </span>
          </span>
        </button>
      </li>
    );
  };
  const seeAll = !props.more ? undefined : (
    <Button size="xs" variant="ghost" onClick={() => setExpanded(!expanded)}>
      {expanded ? KIN_WORK_HOME.seeFewer : KIN_WORK_HOME.seeAll(total)}
    </Button>
  );
  return (
    <KinWorkSection
      title={props.title}
      action={
        below === 0 ? (
          seeAll
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            {seeAll}
            <span className="truncate text-xs text-muted-foreground">
              {props.more ? "· " : null}
              {KIN_WORK_HOME.onMeBelow(below)}
            </span>
          </span>
        )
      }
    >
      {total === 0 ? (
        props.empty === null ? null : (
          <p className="px-2 text-sm text-muted-foreground">{props.empty}</p>
        )
      ) : (
        <ul className="flex flex-col">
          {shown.slice(0, lead).map(needRow)}
          {shownAttention.map((row) => (
            <KinAttentionItem
              key={row.id}
              environmentId={environmentId}
              orgId={orgId}
              row={row}
              handler={handler}
              onOpen={openAttention}
            />
          ))}
          {shown.slice(lead).map(needRow)}
        </ul>
      )}
      <KinAttentionHandled rows={props.handled} handler={handler} />
      {handler.problem === null ? null : (
        <p role="alert" className="px-2 text-xs text-destructive-foreground">
          {handler.problem}
        </p>
      )}
    </KinWorkSection>
  );
}
