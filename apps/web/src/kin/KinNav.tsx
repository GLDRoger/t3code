import { useAtomValue } from "@effect/atom-react";
import { kinAttentionBadge, kinAttentionCount } from "@t3tools/client-runtime/kin/kinAttention";
import {
  KIN_DESTINATION_NAMES,
  kinDestinations,
  type KinDestination,
} from "@t3tools/client-runtime/kin/kinNavigation";
import { kinWorkHostClients } from "@t3tools/client-runtime/kin/kinWork";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  BanknoteIcon,
  BriefcaseBusinessIcon,
  CodeXmlIcon,
  FileTextIcon,
  ListChecksIcon,
  type LucideIcon,
  MessagesSquareIcon,
} from "lucide-react";

import { mainAppReturnHref } from "../components/sidebar/mainAppLocation";
import { Badge } from "../components/ui/badge";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { isChatOnlySession } from "../environments/primary";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { cn } from "../lib/utils";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import {
  kinDestinationAt,
  kinDestinationLink,
  kinInboxUnreadAtom,
  kinShownDestinationsAtom,
  kinListShownAt,
  noAttentionAtom,
  threadsAttentionAtom,
} from "./kinListSwitch";
import { useKinAttention } from "./useKinAttention";
import { useKinDocsLive } from "./useKinDocs";
import { useKinHost } from "./useKinHost";
import { useKinMoneySummary } from "./useKinMoney";
import { useKinOwnerLevel, useKinPlaceReach } from "./useKinOwnerLevel";
import { useKinWork, type KinWorkTarget } from "./useKinWork";

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
  const work = useKinWork(target);
  const ready = work._tag === "ready";
  const money = useKinMoneySummary(target, { enabled: ready }).state;
  const docs = useKinDocsLive(target);
  const ownerLevel = useKinOwnerLevel(target.environmentId);
  const reaches = useKinPlaceReach(target.environmentId);
  const unread = useAtomValue(kinInboxUnreadAtom(target.environmentId));
  const attention = useKinAttention(target, work._tag !== "refused", true);
  const destinations = kinDestinations({
    work: work._tag !== "refused",
    ownerLevel,
    refused: {
      money: money._tag === "refused",
      // Only an answer from an older host takes Clients away, never one still on its way.
      clients: ready && !kinWorkHostClients(work.live.summary),
      docs: docs.refused,
    },
    reaches,
  });
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
          ? kinAttentionBadge(kinAttentionCount(attention))
          : null,
  }));
}

const badgeLabel = (destination: KinDestination, badge: string) =>
  destination === "chats" ? `${badge} unread` : `${badge} need you`;

/** Kin's five destinations at the top of the sidebar, and Code for a session that has threads. */
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
  const coding = !isChatOnlySession();
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
        {coding ? (
          <>
            <div role="separator" className="mx-2 border-t border-sidebar-border" />
            <SidebarMenu>
              <KinCodeEntry active={current === null} onOpen={close} />
            </SidebarMenu>
          </>
        ) : null}
      </nav>
    </SidebarGroup>
  );
}

/** T3's coding threads, for the owner's own session: kept apart from the five, as it always was. */
function KinCodeEntry(props: { readonly active: boolean; readonly onOpen: () => void }) {
  const navigate = useNavigate();
  // Threads are read for the dot only while they are the list you are not in.
  const waiting = useAtomValue(props.active ? noAttentionAtom : threadsAttentionAtom).waiting;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={props.active}
        aria-current={props.active ? "page" : undefined}
        onClick={() => {
          props.onOpen();
          if (!props.active) void navigate({ href: mainAppReturnHref() });
        }}
      >
        <CodeXmlIcon />
        <span className="min-w-0 flex-1 truncate">Code</span>
        {waiting ? (
          <Badge size="sm" variant="warning" aria-label="Threads need you">
            !
          </Badge>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
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
