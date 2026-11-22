import { useAtomValue } from "@effect/atom-react";
import {
  KIN_SETTINGS_MOVED,
  KIN_SETTINGS_PAGE_TITLES,
  kinSettingsGroups,
  kinSettingsPageOf,
  type KinSettingsGroup,
  type KinSettingsPage,
} from "@t3tools/client-runtime/kin/kinNavigation";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, Navigate, useLocation, useRouter } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BellIcon,
  Building2Icon,
  CalendarCheckIcon,
  EyeIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleUserIcon,
  FingerprintIcon,
  SlidersHorizontalIcon,
  PaletteIcon,
  PlugIcon,
  TrendingUpIcon,
  BrainIcon,
  SettingsIcon,
  BotIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { AppRouteModal, AppRouteModalClose } from "../components/AppRouteModal";
import { ApprovalsSettings } from "../components/settings/ApprovalsSettings";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { Button } from "../components/ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../components/ui/sidebar";
import { isChatOnlySession } from "../environments/primary";
import { cn } from "../lib/utils";
import { KinCheckInsPage } from "./KinCheckIns";
import { kinClient } from "./kinClient";
import { KinSettingsNotifications } from "./KinNotifications";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { kinSettingsShown } from "./kinNoCode";
import { KinRecommendationsSettings } from "./KinRecommendations";
import {
  closeKinSettings,
  kinSettingsSectionIn,
  openKinSettings,
  useKinSettingLanding,
} from "./kinSettingsAddress";
import { kinSettingsPageHolding } from "./kinSettingsSearch";
import { KinTeamView } from "./KinTeamView";
import { useKinHost } from "./useKinHost";
import { useKinOwnerLevel, useKinPlaceReach, useKinSeesClients } from "./useKinOwnerLevel";
import { KinAgentsPage } from "./settings/KinAgentsPage";
import { KinAppearancePage } from "./settings/KinAppearancePage";
import { KinCompanyPage } from "./settings/KinCompanyPage";
import { KinConnectionsPage } from "./settings/KinConnectionsPage";
import { KinDealsPage } from "./settings/KinDealsPage";
import { KinMemoryPage } from "./settings/KinMemoryPage";
import { KinProfilePage } from "./settings/KinProfilePage";
import { KinWatchLogPage } from "./settings/KinWatchLogPage";
import { KinSettingsTrail } from "./settings/KinSettingsSubpage";
import type { KinSettingsTarget } from "./settings/kinSettingsTarget";

const KIN_SETTINGS_TITLE = "Settings";

const PAGE_ICON: Record<KinSettingsPage, LucideIcon> = {
  profile: CircleUserIcon,
  notifications: BellIcon,
  appearance: PaletteIcon,
  team: UsersIcon,
  agents: BotIcon,
  "check-ins": CalendarCheckIcon,
  watches: EyeIcon,
  connections: PlugIcon,
  deals: TrendingUpIcon,
  memory: BrainIcon,
  company: Building2Icon,
  approvals: FingerprintIcon,
  recommendations: SlidersHorizontalIcon,
};

/**
 * The app's own settings that still matter to whoever runs the server. The rest of T3 Code's
 * settings are about coding threads; they stay a click away under All app settings.
 */
const THIS_COMPUTER = [
  { to: "/settings/providers", label: "Providers and models" },
  { to: "/settings/keybindings", label: "Keybindings" },
  { to: "/settings/access", label: "Sharing & access" },
  { to: "/settings/connections", label: "Environments" },
  { to: "/settings/devices", label: "Devices" },
  { to: "/settings/maintenance", label: "Maintenance" },
  { to: "/settings/about", label: "About" },
  { to: "/usage", label: "Usage" },
  { to: "/settings/general", label: "All app settings" },
] as const;

function useKinSettingsGroups(environmentId: EnvironmentId): ReadonlyArray<KinSettingsGroup> {
  const ownerLevel = useKinOwnerLevel(environmentId);
  const deals = useKinSeesClients(environmentId);
  // The owner alone, as the host gates `kin.recommendations.*`: a co-owner sees none of it.
  const recommendations = useAtomValue(
    kinClient.recommendationAskAgain.permissionAtom(environmentId),
  );
  return kinSettingsGroups({
    ownerLevel,
    computer: !isChatOnlySession(),
    notifications: true,
    recommendations,
    deals,
  });
}

/** The gear on Chats on a narrow window, where there is no sidebar corner for it. */
export function KinSettingsButton() {
  const router = useRouter();
  const target = kinNewLeadTarget(useKinHost());
  if (target === null) return null;
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={KIN_SETTINGS_TITLE}
      onClick={() => openKinSettings(router.history)}
    >
      <SettingsIcon />
    </Button>
  );
}

/**
 * An old address of a page that moved into Kin's Settings (the app's Company details, Check-ins,
 * Connections and Approvals): opens Settings on it once Kin's host is known.
 */
export function KinSettingsMoved(props: {
  readonly page: KinSettingsPage;
  readonly fallback: React.ReactNode;
}) {
  const target = kinNewLeadTarget(useKinHost());
  const hash = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  // As the address named it on arrival; the redirect itself takes the hash away.
  const [found] = useState(hash);
  if (target === null) return props.fallback;
  // The hash is the setting a settings search found, so Settings opens at it.
  const settings = kinSettingsPageHolding(props.page, found);
  return (
    <Navigate to="/kin" search={found === "" ? { settings } : { settings, at: found }} replace />
  );
}

// A still ring, not the focus outline, so a click marks the row as Enter does; no motion.
const KIN_FOUND_MARK =
  "[&_[data-kin-setting-found]]:rounded-xl [&_[data-kin-setting-found]]:outline-none [&_[data-kin-setting-found]]:ring-2 [&_[data-kin-setting-found]]:ring-primary/60 [&_[data-kin-setting-found]]:ring-offset-4 [&_[data-kin-setting-found]]:ring-offset-background";

/** Settings, open over the Kin page on screen while the address names a section. */
export function KinSettingsModalHost() {
  const section = useLocation({ select: (location) => kinSettingsSectionIn(location.searchStr) });
  const target = kinNewLeadTarget(useKinHost());
  if (section === null || target === null) return null;
  return <KinSettingsModal target={target} section={section} />;
}

/**
 * You for everyone, Company for the owner and co-owners, This computer where the session has the
 * app's own settings. Wide, the groups sit beside the open section; narrow, the groups are the
 * first screen and each section opens over them, as on the phone.
 */
function KinSettingsModal(props: { readonly target: KinSettingsTarget; readonly section: string }) {
  const { target } = props;
  const router = useRouter();
  const groups = useKinSettingsGroups(target.environmentId);
  // A teammate's session learns from the host whether they run the company; until it has said,
  // a Company section waits rather than showing a co-owner their profile.
  const reach = useKinPlaceReach(target.environmentId);
  const known = !isChatOnlySession() || reach !== null;
  const wanted = KIN_SETTINGS_MOVED[props.section] ?? props.section;
  const atIndex = wanted === "";
  // A section this person can't open shows their own profile, not a refusal.
  const page = kinSettingsPageOf(wanted, groups);
  const waiting = !atIndex && page !== wanted && !known;
  const show = (section: KinSettingsPage | "") => openKinSettings(router.history, section);
  const landing = useKinSettingLanding();
  const [backSlot, setBackSlot] = useState<HTMLElement | null>(null);
  const [trailSlot, setTrailSlot] = useState<HTMLElement | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  return (
    <AppRouteModal label={KIN_SETTINGS_TITLE} onClose={() => closeKinSettings(router.history)}>
      <div className="relative flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className={cn(
            "flex w-60 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground max-md:w-full max-md:border-e-0",
            atIndex ? null : "max-md:hidden",
          )}
        >
          <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2 md:hidden">
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{KIN_SETTINGS_TITLE}</h1>
            <AppRouteModalClose />
          </header>
          <SidebarContent className="overflow-x-hidden">
            <SidebarGroup>
              <KinSettingsMenu groups={groups} active={page} onOpen={(section) => show(section)} />
            </SidebarGroup>
          </SidebarContent>
        </nav>
        <div
          className={cn("flex min-h-0 min-w-0 flex-1 flex-col", atIndex ? "max-md:hidden" : null)}
        >
          <header className="group/kin-settings-header flex h-12 shrink-0 items-center gap-2 border-b ps-2 pe-2 md:has-[[data-kin-settings-back]]:ps-2 md:ps-5">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Back to Settings"
              className="md:hidden group-has-[[data-kin-settings-back]]/kin-settings-header:hidden"
              onClick={() => show("")}
            >
              <ArrowLeftIcon />
            </Button>
            <span ref={setBackSlot} className="contents" />
            <WorkspaceBreadcrumb ariaLabel={KIN_SETTINGS_TITLE}>
              <WorkspaceBreadcrumbItem>
                <span className="truncate">{KIN_SETTINGS_TITLE}</span>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>
                <h2 className="truncate">{KIN_SETTINGS_PAGE_TITLES[page]}</h2>
              </WorkspaceBreadcrumbItem>
              <span ref={setTrailSlot} className="contents" />
            </WorkspaceBreadcrumb>
            <div className="ms-auto flex shrink-0 items-center">
              <AppRouteModalClose />
            </div>
          </header>
          <div
            ref={(node) => {
              landing(node);
              setScroller(node);
            }}
            className={cn(
              // A stable gutter, so a page tall enough to scroll keeps its column where the rest have it.
              "flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]",
              KIN_FOUND_MARK,
            )}
          >
            <KinSettingsTrail value={{ back: backSlot, trail: trailSlot, scroller }}>
              {/* Keyed by page, so a drill-in left open on one page never shows on the next. */}
              {waiting ? null : <KinSettingsPageBody key={page} page={page} target={target} />}
            </KinSettingsTrail>
          </div>
        </div>
      </div>
    </AppRouteModal>
  );
}

function KinSettingsMenu(props: {
  readonly groups: ReadonlyArray<KinSettingsGroup>;
  readonly active: KinSettingsPage | null;
  readonly onOpen: (page: KinSettingsPage) => void;
}) {
  const [computerOpen, setComputerOpen] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {props.groups.map((group) =>
        group.id === "computer" ? (
          <section key={group.id} aria-label={group.title} className="flex flex-col gap-1">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  aria-expanded={computerOpen}
                  onClick={() => setComputerOpen(!computerOpen)}
                >
                  {computerOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  <span className="truncate">{group.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {computerOpen
                ? kinSettingsShown(THIS_COMPUTER).map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton render={<Link to={item.to} />}>
                        <span className="truncate">{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))
                : null}
            </SidebarMenu>
          </section>
        ) : (
          <section key={group.id} aria-label={group.title} className="flex flex-col gap-1">
            <h3 className="px-2 text-xs font-medium text-sidebar-muted-foreground/80">
              {group.title}
            </h3>
            <SidebarMenu>
              {group.pages.map((page) => {
                const Icon = PAGE_ICON[page];
                const active = props.active === page;
                return (
                  <SidebarMenuItem key={page}>
                    <SidebarMenuButton
                      isActive={active}
                      aria-current={active ? "page" : undefined}
                      data-kin-settings-section={page}
                      onClick={() => props.onOpen(page)}
                    >
                      <Icon />
                      <span className="truncate">{KIN_SETTINGS_PAGE_TITLES[page]}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </section>
        ),
      )}
    </div>
  );
}

function KinSettingsPageBody(props: {
  readonly page: KinSettingsPage;
  readonly target: KinSettingsTarget;
}) {
  const { target } = props;
  // Each page is one component in its own file, so pages change without touching this one.
  switch (props.page) {
    case "profile":
      return <KinProfilePage {...target} />;
    case "notifications":
      return <KinSettingsNotifications />;
    case "appearance":
      return <KinAppearancePage />;
    case "team":
      return <KinTeamView key={target.orgId} {...target} />;
    case "agents":
      return <KinAgentsPage {...target} />;
    case "check-ins":
      return <KinCheckInsPage />;
    case "watches":
      return <KinWatchLogPage key={target.orgId} {...target} />;
    case "connections":
      return <KinConnectionsPage />;
    case "deals":
      return <KinDealsPage />;
    case "memory":
      return <KinMemoryPage {...target} />;
    case "company":
      return <KinCompanyPage />;
    case "approvals":
      return <ApprovalsSettings />;
    case "recommendations":
      return <KinRecommendationsSettings key={target.orgId} {...target} />;
  }
}
