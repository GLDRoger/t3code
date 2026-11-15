import { kinAttentionBadge, kinAttentionCount } from "@t3tools/client-runtime/kin/kinAttention";
import { kinWorkHostClients } from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_HOME,
  kinClientsLine,
  kinDocsLine,
  kinMoneyLine,
  kinTasksLine,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  BanknoteIcon,
  BriefcaseBusinessIcon,
  FileTextIcon,
  ListChecksIcon,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "../components/ui/badge";
import { KIN_PLACE_PATH, type KinPlace } from "./kinPlaces";
import { useKinAttention } from "./useKinAttention";
import { useNowMinuteMs } from "./useKinClock";
import { useKinMoneySummary } from "./useKinMoney";
import { useKinClientCounts, useKinDocsRecent } from "./useKinPlaces";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import { useKinWork, type KinWorkTarget } from "./useKinWork";

const ICON: Record<KinPlace, LucideIcon> = {
  tasks: ListChecksIcon,
  money: BanknoteIcon,
  clients: BriefcaseBusinessIcon,
  docs: FileTextIcon,
};

function PlaceEntry(
  props: KinWorkTarget & {
    readonly place: KinPlace;
    readonly line: string | null;
    /** What needs attention, on Tasks; null shows none. */
    readonly badge?: string | null;
    readonly onOpen: () => void;
  },
) {
  const { environmentId, orgId, place } = props;
  const active = useMatchRoute()({ to: KIN_PLACE_PATH[place] });
  const Icon = ICON[place];
  return (
    <Link
      to={KIN_PLACE_PATH[place]}
      params={{ environmentId, orgId }}
      aria-current={active === false ? undefined : "page"}
      data-active={active !== false}
      onClick={props.onOpen}
      className="flex items-center gap-2.5 rounded-md px-2 py-2 outline-none ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[active=true]:bg-sidebar-row-selected"
    >
      <span className="flex size-10 shrink-0 items-center justify-center text-sidebar-muted-foreground">
        <Icon aria-hidden className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-sidebar-foreground">
          {KIN_WORK_HOME.places[place]}
        </span>
        {props.line === null ? null : (
          <span className="truncate text-xs text-sidebar-muted-foreground tabular-nums">
            {props.line}
          </span>
        )}
      </span>
      {props.badge == null ? null : (
        <Badge size="sm" variant="error" aria-label={`${props.badge} need attention`}>
          {props.badge}
        </Badge>
      )}
    </Link>
  );
}

/** Tasks, Money, Clients and Docs straight from the chat list, each with its live figure. */
export function KinPlaceEntries(props: KinWorkTarget & { readonly onOpen: () => void }) {
  const state = useKinWork(props);
  const ownerLevel = useKinOwnerLevel(props.environmentId);
  // A teammate, or a host that couldn't be read: no ways in rather than dead ones.
  if (state._tag === "refused" || state._tag === "failed") return null;
  const summary = state._tag === "ready" ? state.live.summary : null;
  const seq = state._tag === "ready" && !state.stale ? state.live.seq : null;
  const tasks = <TasksEntry {...props} line={summary === null ? null : kinTasksLine(summary)} />;
  // Money, Clients and Docs are the owner's and co-owners'; a member has Tasks.
  if (!ownerLevel) return tasks;
  return (
    <>
      {tasks}
      <MoneyEntry {...props} seq={seq} enabled={state._tag === "ready"} />
      {summary !== null && !kinWorkHostClients(summary) ? null : (
        <ClientsEntry {...props} seq={seq} enabled={state._tag === "ready"} />
      )}
      <DocsEntry {...props} />
    </>
  );
}

function TasksEntry(
  props: KinWorkTarget & { readonly line: string | null; readonly onOpen: () => void },
) {
  const attention = useKinAttention(props);
  return (
    <PlaceEntry {...props} place="tasks" badge={kinAttentionBadge(kinAttentionCount(attention))} />
  );
}

function MoneyEntry(
  props: KinWorkTarget & {
    readonly seq: number | null;
    readonly enabled: boolean;
    readonly onOpen: () => void;
  },
) {
  const { state } = useKinMoneySummary(props, { enabled: props.enabled, seq: props.seq });
  // Whoever the host keeps money from doesn't get a way in to it.
  if (state._tag === "refused") return null;
  return (
    <PlaceEntry
      {...props}
      place="money"
      line={state._tag === "ready" ? kinMoneyLine(state.value) : null}
    />
  );
}

function ClientsEntry(
  props: KinWorkTarget & {
    readonly seq: number | null;
    readonly enabled: boolean;
    readonly onOpen: () => void;
  },
) {
  const counts = useKinClientCounts(props, props.enabled, props.seq);
  if (counts === "refused") return null;
  return (
    <PlaceEntry
      {...props}
      place="clients"
      line={counts === null ? null : kinClientsLine(counts.clients, counts.projects)}
    />
  );
}

function DocsEntry(props: KinWorkTarget & { readonly onOpen: () => void }) {
  const now = new Date(useNowMinuteMs());
  const { refused, docs } = useKinDocsRecent(props);
  if (refused) return null;
  return (
    <PlaceEntry
      {...props}
      place="docs"
      line={docs === null ? null : kinDocsLine(docs.total, docs.docs, now)}
    />
  );
}
