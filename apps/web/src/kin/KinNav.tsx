import { useAtomValue } from "@effect/atom-react";
import { kinAttentionBadge, kinTasksBadgeCount } from "@t3tools/client-runtime/kin/kinAttention";
import { kinWorkListsMoved } from "@t3tools/client-runtime/kin/kinWorkStream";
import {
  KIN_DESTINATION_NAMES,
  type KinDestination,
} from "@t3tools/client-runtime/kin/kinNavigation";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  BanknoteIcon,
  BriefcaseBusinessIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  type LucideIcon,
  MessagesSquareIcon,
} from "lucide-react";

import { Badge } from "../components/ui/badge";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { cn } from "../lib/utils";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import {
  kinDestinationAt,
  kinDestinationLink,
  kinInboxUnreadAtom,
  kinShownDestinationsAtom,
  kinListShownAt,
} from "./kinListSwitch";
import { useKinAttention } from "./useKinAttention";
import { useKinHost } from "./useKinHost";
import { useKinDestinations, useKinMyDueTasks } from "./useKinPlaces";
import { useKinWorkDirectory, type KinWorkTarget } from "./useKinWork";

const ICON: Record<KinDestination, LucideIcon> = {
  chats: MessagesSquareIcon,
  tasks: ListChecksIcon,
  canvas: LayoutDashboardIcon,
  money: BanknoteIcon,
  clients: BriefcaseBusinessIcon,
  docs: FileTextIcon,
};

interface KinNavEntry {
  readonly destination: KinDestination;
  readonly badge: string | null;
}

/** The destinations this person has, in the phone's order, each with the phone's badge. */
function useKinNavEntries(target: KinWorkTarget): ReadonlyArray<KinNavEntry> {
  const { work, ownerLevel, destinations } = useKinDestinations(target);
  const ready = work._tag === "ready";
  const unread = useAtomValue(kinInboxUnreadAtom(target.environmentId));
  const attention = useKinAttention(target, ownerLevel && work._tag !== "refused", true);
  // Anyone else's badge counts their own late and due-today tasks, the ones "On me" marks.
  const directory = useKinWorkDirectory(target, ready && !ownerLevel);
  const mineDue = useKinMyDueTasks(
    target,
    ready && !ownerLevel ? directory.names.me : null,
    ready && !work.stale ? kinWorkListsMoved(work.live, ["work"]) : null,
  );
  const key = destinations.join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the destinations this person has, so the command palette lists the same ones the nav shows
  useEffect(() => {
    appAtomRegistry.set(kinShownDestinationsAtom, {
      target: { environmentId: target.environmentId, orgId: target.orgId },
      destinations: key.split(",") as ReadonlyArray<KinDestination>,
    });
  }, [key, target.environmentId, target.orgId]);
  return destinations.map((destination) => ({
    destination,
    badge:
      destination === "chats"
        ? kinAttentionBadge(unread)
        : destination === "tasks"
          ? kinAttentionBadge(kinTasksBadgeCount({ ownerLevel, attention, mineDue }))
          : null,
  }));
}

const badgeLabel = (destination: KinDestination, badge: string) =>
  destination === "chats" ? `${badge} unread` : `${badge} need you`;

/** Kin's five destinations at the top of the sidebar. T3's coding threads are not offered in Kin. */
export function KinNav() {
  const target = kinNewLeadTarget(useKinHost());
  if (target === null) return null;
  return <KinNavList environmentId={target.environmentId} orgId={target.orgId} />;
}

function KinNavList(props: KinWorkTarget) {
  const entries = useKinNavEntries(props);
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const current = kinListShownAt(pathname) === "kin" ? kinDestinationAt(pathname) : null;
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <SidebarGroup>
      <nav aria-label="Kin" className="flex flex-col gap-2">
        <SidebarMenu>
          {entries.map(({ destination, badge }) => {
            const Icon = ICON[destination];
            const active = current === destination;
            return (
              <SidebarMenuItem key={destination}>
                <SidebarMenuButton
                  isActive={active}
                  aria-current={active ? "page" : undefined}
                  data-kin-destination={destination}
                  onClick={close}
                  render={<Link {...kinDestinationLink(destination, props, isMobile)} />}
                >
                  <Icon />
                  <span className="min-w-0 flex-1 truncate">
                    {KIN_DESTINATION_NAMES[destination]}
                  </span>
                  {badge === null ? null : (
                    <Badge
                      size="sm"
                      variant={destination === "tasks" ? "error" : "default"}
                      aria-label={badgeLabel(destination, badge)}
                    >
                      {badge}
                    </Badge>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </nav>
    </SidebarGroup>
  );
}

/**
 * The phone's dock, on a narrow window: on the chat list and the places, not inside a chat or
 * Settings, where the phone has none either.
 */
export function KinDock(props: KinWorkTarget) {
  const entries = useKinNavEntries(props);
  const pathname = useLocation({ select: (location) => location.pathname });
  const current = kinDestinationAt(pathname);
  if (entries.length < 2 || current === null) return null;
  if (current === "chats" && pathname !== "/kin") return null;
  return (
    <nav
      aria-label="Kin"
      className="grid shrink-0 auto-cols-fr grid-flow-col border-t bg-background pb-(--workspace-safe-bottom) md:hidden"
    >
      {entries.map(({ destination, badge }) => {
        const Icon = ICON[destination];
        const active = current === destination;
        return (
          <Link
            key={destination}
            {...kinDestinationLink(destination, props, true)}
            aria-current={active ? "page" : undefined}
            data-kin-destination={destination}
            className={cn(
              "relative flex h-14 flex-col items-center justify-center gap-0.5 text-2xs font-medium outline-none ring-ring focus-visible:ring-2 focus-visible:ring-inset",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Icon aria-hidden className="size-5" />
            {KIN_DESTINATION_NAMES[destination]}
            {badge === null ? null : (
              <span className="absolute top-1.5 left-[calc(50%+0.5rem)]">
                <Badge
                  size="sm"
                  variant={destination === "tasks" ? "error" : "default"}
                  aria-label={badgeLabel(destination, badge)}
                >
                  {badge}
                </Badge>
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
