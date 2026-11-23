import { useAtomValue } from "@effect/atom-react";
import { kinAttentionBadge } from "@t3tools/client-runtime/kin/kinAttention";
import { kinDestinationName, type KinDestination } from "@t3tools/client-runtime/kin/kinNavigation";
import { kinListSections } from "@t3tools/client-runtime/kin/kinShell";
import { Link, useLocation } from "@tanstack/react-router";
import {
  BanknoteIcon,
  BriefcaseBusinessIcon,
  ChartLineIcon,
  FileTextIcon,
  ListChecksIcon,
  ListIcon,
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
  kinNumbersLink,
} from "./kinListSwitch";
import { KIN_NUMBERS } from "@t3tools/client-runtime/kin/kinNumbers";
import { useKinNumbersShown } from "./useKinNumbers";
import { useKinTasksNeedsYou } from "./useKinAttention";
import { kinHostKeptTarget, useKinHost } from "./useKinHost";
import { useKinDestinations } from "./useKinPlaces";
import { kinListsOf, useKinLists } from "./useKinMoney";
import { useKinShell } from "./useKinShell";
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
  const shell = useKinShell(props.environmentId);
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const current = kinListShownAt(pathname) === "kin" ? kinDestinationAt(pathname) : null;

  const close = () => {
    if (isMobile) setOpenMobile(false);
  };
  const numbersShown = useKinNumbersShown(props) === true;
  const inNumbers = kinListShownAt(pathname) === "kin" && pathname.split("/")[4] === "numbers";
  // Numbers sits after the company's work places, before Docs; it has no place in the dock.
  const numbersAt = entries.some((entry) => entry.destination === "docs")
    ? entries.length - 1
    : entries.length;
  const numbers = !numbersShown ? null : (
    <SidebarMenuItem key="numbers">
      <SidebarMenuButton
        isActive={inNumbers}
        aria-current={inNumbers ? "page" : undefined}
        data-kin-numbers=""
        onClick={close}
        render={<Link {...kinNumbersLink(props)} />}
      >
        <ChartLineIcon />
        <span className="min-w-0 flex-1 truncate">{KIN_NUMBERS.title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
  return (
    <SidebarGroup>
      <nav aria-label="Kin" className="flex flex-col gap-2">
        <SidebarMenu>
          {entries.map(({ destination, badge }, index) => {
            const Icon = ICON[destination];
            const active = current === destination;
            return [
              index === numbersAt ? numbers : null,
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
                    {kinDestinationName(destination, shell)}
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
              </SidebarMenuItem>,
            ];
          })}
          {numbersAt === entries.length ? numbers : null}
          <KinNavListSections {...props} pathname={pathname} onOpen={close} />
        </SidebarMenu>
      </nav>
    </SidebarGroup>
  );
}

/**
 * The company's own lists shown as sections, after Kin's, in the shell's order: those that are on
 * and that the host says this person reaches, each under the list's own name once it is read.
 */
function KinNavListSections(
  props: KinWorkTarget & { readonly pathname: string; readonly onOpen: () => void },
) {
  const shell = useKinShell(props.environmentId);
  const sections = kinListSections(shell).filter((section) => section.on);
  const lists = useKinLists(props, { enabled: sections.length > 0 });
  const names = new Map(kinListsOf(lists).map((def) => [def.list, def.name]));
  const open = /^\/kin\/[^/]+\/[^/]+\/list\/([^/?#]+)/.exec(props.pathname)?.[1] ?? null;
  return sections.map((section) => {
    const name = names.get(section.list);
    if (name === undefined) return null;
    const active = open === section.list;
    return (
      <SidebarMenuItem key={section.id}>
        <SidebarMenuButton
          isActive={active}
          aria-current={active ? "page" : undefined}
          data-kin-list-section={section.list}
          onClick={props.onOpen}
          render={
            <Link
              to="/kin/$environmentId/$orgId/list/$list"
              params={{
                environmentId: props.environmentId,
                orgId: props.orgId,
                list: section.list,
              }}
            />
          }
        >
          <ListIcon />
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  });
}
