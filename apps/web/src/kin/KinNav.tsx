import { useAtomValue } from "@effect/atom-react";
import { kinAttentionBadge } from "@t3tools/client-runtime/kin/kinAttention";
import {
  KIN_DESTINATION_NAMES,
  type KinDestination,
} from "@t3tools/client-runtime/kin/kinNavigation";
import { Link, useLocation } from "@tanstack/react-router";
import {
  BanknoteIcon,
  BriefcaseBusinessIcon,
  FileTextIcon,
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
import {
  kinDestinationAt,
  kinDestinationLink,
  kinInboxUnreadAtom,
  kinListShownAt,
} from "./kinListSwitch";
import { useKinTasksNeedsYou } from "./useKinAttention";
import { kinHostKeptTarget, useKinHost } from "./useKinHost";
import { useKinDestinations } from "./useKinPlaces";
import type { KinWorkTarget } from "./useKinWork";

const ICON: Record<KinDestination, LucideIcon> = {
  chats: MessagesSquareIcon,
  tasks: ListChecksIcon,
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
  const { destinations } = useKinDestinations(target);
  const unread = useAtomValue(kinInboxUnreadAtom(target.environmentId));
  // The same number as Tasks' Needs you heading, as the phone's dock badge reads it.
  const needsYou = useKinTasksNeedsYou(target);
  return destinations.map((destination) => ({
    destination,
    badge:
      destination === "chats"
        ? kinAttentionBadge(unread)
        : destination === "tasks"
          ? kinAttentionBadge(needsYou ?? 0)
          : null,
  }));
}

const badgeLabel = (destination: KinDestination, badge: string) =>
  destination === "chats" ? `${badge} unread` : `${badge} need you`;

/** Kin's five destinations at the top of the sidebar. T3's coding threads are not offered in Kin. */
export function KinNav() {
  const target = kinHostKeptTarget(useKinHost());
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
