import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { useAtomValue } from "@effect/atom-react";
import { kinAgentGroups } from "@t3tools/client-runtime/kin/kinAgentRetire";
import { kinDomainLabel, KIN_AGENTS_COPY } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import {
  KIN_SETTINGS_MOVED,
  KIN_SETTINGS_PAGE_TITLES,
  kinSettingsGroups,
  kinSettingsPageOf,
  type KinSettingsGroup,
  type KinSettingsPage,
} from "@t3tools/client-runtime/kin/kinNavigation";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { Link, Navigate, useLocation, useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowLeftIcon,
  BellIcon,
  Building2Icon,
  CalendarCheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleUserIcon,
  FingerprintIcon,
  SlidersHorizontalIcon,
  PaletteIcon,
  PlugIcon,
  BrainIcon,
  SettingsIcon,
  BotIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { AppRouteModal, AppRouteModalClose } from "../components/AppRouteModal";
import { ApprovalsSettings } from "../components/settings/ApprovalsSettings";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../components/ui/sidebar";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { isChatOnlySession, signOutThisBrowser } from "../environments/primary";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import type { ThemePreferenceMode } from "../themePalette";
import { KinAgentDefaultsSetting } from "./KinAgentsSetting";
import { KinAvatar } from "./KinAvatar";
import { withKinAgentPage } from "./kinPlaces";
import { KinCheckInsSetting } from "./KinCheckIns";
import { kinClient } from "./kinClient";
import { KinCompanyProfileSettings } from "./KinCompanyProfile";
import { KinCompanyTimeZoneSetting } from "./KinCompanyTimeZone";
import { KinConnectionsSettings } from "./KinConnections";
import { KinDailyLimitSetting } from "./KinDailyLimit";
import { KinMemoryView } from "./KinMemoryView";
import { KinSettingsNotifications } from "./KinNotifications";
import { kinNewLeadTarget, openKinLeadForm } from "./KinNewLeadButton";
import { KinProfileBody, useKinMe } from "./KinProfileSheet";
import { KinRecommendationsSettings } from "./KinRecommendations";
import {
  closeKinSettings,
  kinSettingsFindIn,
  kinSettingsSectionIn,
  openKinSettings,
} from "./kinSettingsAddress";
import { rememberKinTeammate } from "./kinTeammateMark";
import { KinTeamView } from "./KinTeamView";
import { useKinHost, useKinWorkingAgents } from "./useKinHost";
import { useKinOwnerLevel, useKinPlaceReach } from "./useKinOwnerLevel";

const KIN_SETTINGS_TITLE = "Settings";

const PAGE_ICON: Record<KinSettingsPage, LucideIcon> = {
  profile: CircleUserIcon,
  notifications: BellIcon,
  appearance: PaletteIcon,
  team: UsersIcon,
  agents: BotIcon,
  "check-ins": CalendarCheckIcon,
  connections: PlugIcon,
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

interface KinSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

function useKinSettingsGroups(environmentId: EnvironmentId): ReadonlyArray<KinSettingsGroup> {
  const ownerLevel = useKinOwnerLevel(environmentId);
  // The owner alone, as the host gates `kin.recommendations.*`: a co-owner sees none of it.
  const recommendations = useAtomValue(
    kinClient.recommendationAskAgain.permissionAtom(environmentId),
  );
  return kinSettingsGroups({
    ownerLevel,
    computer: !isChatOnlySession(),
    notifications: true,
    recommendations,
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
  if (target === null) return props.fallback;
  return <Navigate to="/kin" search={{ settings: props.page }} replace />;
}

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
          <header className="flex h-12 shrink-0 items-center gap-2 border-b ps-2 pe-2 md:ps-5">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Back to Settings"
              className="md:hidden"
              onClick={() => show("")}
            >
              <ArrowLeftIcon />
            </Button>
            <WorkspaceBreadcrumb ariaLabel={KIN_SETTINGS_TITLE}>
              <WorkspaceBreadcrumbItem>
                <span className="truncate">{KIN_SETTINGS_TITLE}</span>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>
                <h2 className="truncate">{KIN_SETTINGS_PAGE_TITLES[page]}</h2>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="ms-auto flex shrink-0 items-center">
              <AppRouteModalClose />
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {waiting ? null : <KinSettingsPageBody page={page} target={target} />}
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
                ? THIS_COMPUTER.map((item) => (
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
  switch (props.page) {
    case "profile":
      return <KinSettingsProfile {...target} />;
    case "notifications":
      return <KinSettingsNotifications />;
    case "appearance":
      return <KinSettingsAppearance />;
    case "team":
      return <KinTeamView key={target.orgId} {...target} />;
    case "agents":
      return <KinSettingsAgents {...target} />;
    case "check-ins":
      return (
        <SettingsPageContainer>
          <KinCheckInsSetting inDialog />
        </SettingsPageContainer>
      );
    case "connections":
      return (
        <SettingsPageContainer>
          <KinConnectionsSettings />
        </SettingsPageContainer>
      );
    case "memory":
      return <KinSettingsMemory {...target} />;
    case "company":
      return (
        <SettingsPageContainer>
          <SettingsSection {...searchableSetting("company-details")} variant="plain">
            <KinCompanyProfileSettings />
          </SettingsSection>
          <KinCompanyTimeZoneSetting />
          <KinDailyLimitSetting />
        </SettingsPageContainer>
      );
    case "approvals":
      return <ApprovalsSettings />;
    case "recommendations":
      return <KinRecommendationsSettings key={target.orgId} {...target} />;
  }
}

function KinSettingsProfile(props: KinSettingsTarget) {
  const me = useKinMe(props.environmentId, props.orgId);
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-4 sm:p-6">
      {me === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <KinProfileBody {...props} personId={me} />
      )}
      {/* A teammate's browser is a chat-only session; the owner's never is. */}
      {isChatOnlySession() ? <KinLeaveTeam /> : null}
    </div>
  );
}

/**
 * The phone's Leave this team: this browser forgets the team. On the web that ends its own
 * session on the host, so a shared computer is left signed out, and shows the access-ended page.
 */
function KinLeaveTeam() {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leave = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await signOutThisBrowser();
    } catch {
      setBusy(false);
      setFailed(true);
      return;
    }
    rememberKinTeammate("left");
    window.location.assign("/pair");
  };
  return (
    <section className="flex flex-col items-start gap-2 border-t pt-6">
      <Button size="sm" variant="destructive-outline" onClick={() => setAsking(true)}>
        {KIN_LEAVE_TEAM.button}
      </Button>
      {failed ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {KIN_LEAVE_TEAM.failed}
        </p>
      ) : null}
      <AlertDialog open={asking} onOpenChange={(open) => !busy && setAsking(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{KIN_LEAVE_TEAM.title}</AlertDialogTitle>
            <AlertDialogDescription>{KIN_LEAVE_TEAM.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={busy}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              aria-busy={busy}
              onClick={() => {
                setAsking(false);
                void leave();
              }}
            >
              {KIN_LEAVE_TEAM.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

const KIN_LEAVE_TEAM = {
  button: "Leave this team",
  title: "Leave this team?",
  detail: KIN_DEVICE_COPY.leave("browser"),
  confirm: "Leave",
  failed: "Couldn't sign this browser out. Nothing changed.",
} as const;

const APPEARANCE_LABELS: Record<ThemePreferenceMode, string> = {
  system: "Match this device",
  light: "Light",
  dark: "Dark",
};

/** Light, dark or the device's own, for this browser; the app's theme library is under This computer. */
function KinSettingsAppearance() {
  const { appearanceMode, setAppearanceMode } = useTheme();
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-2 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-foreground">Theme</h2>
          <p className="text-xs text-muted-foreground">On this browser.</p>
        </div>
        <Select
          value={appearanceMode}
          onValueChange={(value) => {
            if (value === "system" || value === "light" || value === "dark")
              setAppearanceMode(value);
          }}
        >
          <SelectTrigger size="sm" className="w-48" aria-label="Theme">
            <SelectValue>{APPEARANCE_LABELS[appearanceMode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(["system", "light", "dark"] as const).map((mode) => (
              <SelectItem key={mode} hideIndicator value={mode}>
                {APPEARANCE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}

/** The agents, each opening its chat (where its sheet is), and a way to add another. */
function KinSettingsAgents(props: KinSettingsTarget) {
  const { environmentId, orgId } = props;
  const result = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const working = useKinWorkingAgents(environmentId);
  const canAdd = useAtomValue(kinClient.leadCreate.permissionAtom(environmentId));
  const all = Option.getOrNull(AsyncResult.value(result))?.leads ?? null;
  const agents = all === null ? null : kinAgentGroups(all).active;
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-4 sm:p-6">
      {canAdd ? (
        <Button
          size="sm"
          className="self-end"
          onClick={() => openKinLeadForm({ ...props, lead: null })}
        >
          New agent
        </Button>
      ) : null}
      {agents === null ? (
        <p className="text-sm text-muted-foreground">
          {AsyncResult.isFailure(result) ? KIN_AGENTS_COPY.loadFailed : "Loading…"}
        </p>
      ) : agents.length === 0 ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>No agents yet</EmptyTitle>
            <EmptyDescription>{KIN_AGENTS_COPY.explain}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {agents.map((agent) => (
            <li key={agent.agentId}>
              <Link
                // Over the Kin page under Settings, which closes as the agent's page opens.
                to="."
                search={(prev) => withKinAgentPage(prev, agent.agentId)}
                className="flex items-center gap-3 px-3 py-2.5 outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
              >
                <KinAvatar avatar={kinAgentAvatar(agent.agentId)} size="xs" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {kinDomainLabel(agent.domain)}
                  </span>
                </span>
                {working.has(agent.agentId) ? (
                  <span className="text-xs text-muted-foreground">Working</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Open an agent to see its page.</p>
      <KinAgentDefaultsSetting {...props} />
    </div>
  );
}

/** Memory, filtered to what a search result named. */
function KinSettingsMemory(props: KinSettingsTarget) {
  const find = useLocation({ select: (location) => kinSettingsFindIn(location.searchStr) });
  return <KinMemoryView key={`${props.orgId}\u0000${find}`} {...props} find={find} />;
}
