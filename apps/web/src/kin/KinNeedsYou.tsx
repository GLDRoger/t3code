import {
  kinAttention,
  kinNeedsYouBeside,
  kinTasksAttention,
  type KinAttentionOpen,
} from "@t3tools/client-runtime/kin/kinAttention";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import type { KinListOpen } from "@t3tools/client-runtime/kin/kinMoney";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import {
  KIN_NEEDS_YOU_SHOWN,
  KIN_WORK_HOME,
  kinNeedsYou,
  type KinNeedsYouOpen,
  type KinNeedsYouRow,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinRecord, KinRecordKey } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BanknoteIcon, CircleAlertIcon, CircleCheckIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { KinAttentionHandled, KinAttentionItem, kinAttentionNames } from "./KinAttention";
import { KinWorkSection } from "./KinWorkParts";
import { useKinAttention, useKinAttentionHandle } from "./useKinAttention";
import { useNowMinuteMs } from "./useKinClock";
import { useKinInbox } from "./useKinHost";
import { kinListsOf, useKinLists, useKinMoneySummary } from "./useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const ICON: Record<KinNeedsYouRow["kind"], LucideIcon> = {
  task: CircleCheckIcon,
  money: BanknoteIcon,
  waiting: CircleAlertIcon,
};

/**
 * The top of Tasks: what needs attention, then your late tasks, what clients owe past due, what an
 * agent waits on you for, and what is yours today. Each row opens the thing itself.
 */
export function KinNeedsYou(
  props: KinWorkTarget & {
    readonly directory: KinWorkDirectory;
    /** The host's latest change number; null while what is held may be behind. */
    readonly seq: number | null;
    /** Your open tasks due by the end of today; null until read. Tasks leaves them out below. */
    readonly mine: ReadonlyArray<KinRecord> | null;
    readonly onOpenTask: (key: KinRecordKey) => void;
    readonly onOpenList: (open: KinListOpen) => void;
    readonly onOpenMoney: () => void;
  },
) {
  const { environmentId, orgId, seq, mine } = props;
  const { names } = props.directory;
  const navigate = useNavigate();
  const now = new Date(useNowMinuteMs());
  const money = useKinMoneySummary(props, { enabled: true, seq });
  const lists = useKinLists(props, { enabled: true, seq });
  const inbox = useKinInbox();
  const attentionRead = useKinAttention(props);
  const handler = useKinAttentionHandle(props);
  const [expanded, setExpanded] = useState(false);
  if (mine === null) return null;
  const attention = kinAttention(attentionRead, {
    scope: { type: "all" },
    names: kinAttentionNames(names),
    now,
  });
  const ready =
    inbox.state._tag === "ready" && inbox.state.environmentId === environmentId
      ? inbox.state
      : null;
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
  const split = kinTasksAttention(attention.open);
  const rows = [
    ...(split.moneyRow === null ? [] : [split.moneyRow]),
    ...kinNeedsYouBeside(before, attention),
  ];
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
  const total = split.rows.length + rows.length;
  const limit = expanded ? total : KIN_NEEDS_YOU_SHOWN;
  const shownAttention = split.rows.slice(0, limit);
  const shown = rows.slice(0, Math.max(0, limit - shownAttention.length));
  return (
    <KinWorkSection
      title={KIN_WORK_HOME.needsYou}
      action={
        total <= KIN_NEEDS_YOU_SHOWN ? undefined : (
          <Button size="xs" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? KIN_WORK_HOME.seeFewer : KIN_WORK_HOME.seeAll(total)}
          </Button>
        )
      }
    >
      {total === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">{KIN_WORK_HOME.nothingNeedsYou}</p>
      ) : (
        <ul className="flex flex-col">
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
          {shown.map((row) => {
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
          })}
        </ul>
      )}
      <KinAttentionHandled rows={attention.handled} handler={handler} />
      {handler.problem === null ? null : (
        <p role="alert" className="px-2 text-xs text-destructive-foreground">
          {handler.problem}
        </p>
      )}
    </KinWorkSection>
  );
}
