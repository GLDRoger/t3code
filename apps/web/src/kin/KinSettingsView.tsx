import { useAtomValue } from "@effect/atom-react";
import { kinAgentGroups } from "@t3tools/client-runtime/kin/kinAgentRetire";
import { kinDomainLabel } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import {
  KIN_SETTINGS_MOVED,
  KIN_SETTINGS_PAGE_TITLES,
  kinSettingsGroups,
  kinSettingsPageOf,
  type KinSettingsGroup,
  type KinSettingsPage,
} from "@t3tools/client-runtime/kin/kinNavigation";
import { KinOrgId, type EnvironmentId } from "@t3tools/contracts";
import { Link, Navigate, Outlet, useLocation, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowLeftIcon,
  Building2Icon,
  CalendarCheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleUserIcon,
  FingerprintIcon,
  PaletteIcon,
  PlugIcon,
  BrainIcon,
  SettingsIcon,
  SparklesIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { ApprovalsSettings } from "../components/settings/ApprovalsSettings";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { isElectron } from "../env";
import { isChatOnlySession } from "../environments/primary";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import type { ThemePreferenceMode } from "../themePalette";
import { KinCheckInsSetting } from "./KinCheckIns";
import { kinClient } from "./kinClient";
import { KinCompanyProfileSettings } from "./KinCompanyProfile";
import { KinCompanyTimeZoneSetting } from "./KinCompanyTimeZone";
import { KinConnectionsSettings } from "./KinConnections";
import { KinDailyLimitSetting } from "./KinDailyLimit";
import { KinMemoryView } from "./KinMemoryView";
import { kinNewLeadTarget, openKinLeadForm } from "./KinNewLeadButton";
import { KinProfileBody, useKinMe } from "./KinProfileSheet";
import { KinTeamView } from "./KinTeamView";
import { useKinHost } from "./useKinHost";
import { useKinOwnerLevel, useKinPlaceReach } from "./useKinOwnerLevel";

const KIN_SETTINGS_TITLE = "Settings";

const PAGE_ICON: Record<KinSettingsPage, LucideIcon> = {
  profile: CircleUserIcon,
  notifications: SettingsIcon,
  appearance: PaletteIcon,
  team: UsersIcon,
  agents: SparklesIcon,
  "check-ins": CalendarCheckIcon,
  connections: PlugIcon,
  memory: BrainIcon,
  company: Building2Icon,
  approvals: FingerprintIcon,
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
  { to: "/settings/general", label: "All app settings" },
] as const;

interface KinSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

function useKinSettingsTarget(): KinSettingsTarget {
  const params = useParams({ from: "/_chat/kin/$environmentId/$orgId/settings" });
  return {
    environmentId: params.environmentId as EnvironmentId,
    orgId: KinOrgId.make(params.orgId),
  };
}

function useKinSettingsGroups(environmentId: EnvironmentId): ReadonlyArray<KinSettingsGroup> {
  const ownerLevel = useKinOwnerLevel(environmentId);
  // Web has no Kin notifications of its own yet: the phone's are push.
  return kinSettingsGroups({ ownerLevel, computer: !isChatOnlySession(), notifications: false });
}

/** The gear on Chats: everyone's way into Settings. */
export function KinSettingsButton() {
  const target = kinNewLeadTarget(useKinHost());
  if (target === null) return null;
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={KIN_SETTINGS_TITLE}
      render={
        <Link
          to="/kin/$environmentId/$orgId/settings"
          params={{ environmentId: target.environmentId, orgId: target.orgId }}
        />
      }
    >
      <SettingsIcon />
    </Button>
  );
}

/**
 * An old address of a page that moved into Kin's Settings (the app's Company details, Check-ins,
 * Connections and Approvals, Kin's Team and Memory): goes there once Kin's host is known.
 */
export function KinSettingsMoved(props: {
  readonly page: KinSettingsPage | null;
  readonly fallback?: React.ReactNode;
}) {
  const target = kinNewLeadTarget(useKinHost());
  if (target === null) return props.fallback ?? null;
  const params = { environmentId: target.environmentId, orgId: target.orgId };
  return props.page === null ? (
    <Navigate to="/kin/$environmentId/$orgId/settings" params={params} replace />
  ) : (
    <Navigate
      to="/kin/$environmentId/$orgId/settings/$page"
      params={{ ...params, page: props.page }}
      replace
    />
  );
}

/** The app's Settings address a teammate followed, which their session lacks: Kin's own page. */
export function KinSettingsFromApp(props: { readonly slug: string }) {
  return (
    <KinSettingsMoved
      page={KIN_SETTINGS_MOVED[props.slug] ?? null}
      fallback={
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>Opening Settings…</EmptyTitle>
          </EmptyHeader>
        </Empty>
      }
    />
  );
}

/**
 * Settings: You for everyone, Company for the owner and co-owners, This computer where the session
 * has the app's own settings. Wide, the groups sit beside the open page; narrow, the groups are
 * the page and each one opens over them, as on the phone.
 */
export function KinSettingsLayout() {
  const target = useKinSettingsTarget();
  const groups = useKinSettingsGroups(target.environmentId);
  const pathname = useLocation({ select: (location) => location.pathname });
  const raw = pathname.split("/")[5];
  const atIndex = raw === undefined || raw === "";
  const page = kinSettingsPageOf(raw, groups);
  return (
    <>
      <WorkspacePageHeader electron={isElectron}>
        {atIndex ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Back to chats"
            className="md:hidden"
            render={<Link to="/kin" />}
          >
            <ArrowLeftIcon />
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Back to Settings"
            className="md:hidden"
            render={<Link to="/kin/$environmentId/$orgId/settings" params={target} />}
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <WorkspaceBreadcrumb ariaLabel={KIN_SETTINGS_TITLE}>
          <WorkspaceBreadcrumbItem current={atIndex}>
            <h1 className="truncate">{KIN_SETTINGS_TITLE}</h1>
          </WorkspaceBreadcrumbItem>
          {atIndex ? null : <WorkspaceBreadcrumbSeparator />}
          {atIndex ? null : (
            <WorkspaceBreadcrumbItem current>
              <span className="truncate">{KIN_SETTINGS_PAGE_TITLES[page]}</span>
            </WorkspaceBreadcrumbItem>
          )}
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className={cn(
            "min-h-0 w-full shrink-0 overflow-y-auto p-2 md:block md:w-60 md:border-e",
            atIndex ? "block" : "hidden",
          )}
        >
          <KinSettingsMenu groups={groups} active={atIndex ? null : page} target={target} />
        </nav>
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-y-auto md:flex",
            atIndex ? "hidden" : "flex",
          )}
        >
          <Outlet />
        </div>
      </div>
    </>
  );
}

function KinSettingsMenu(props: {
  readonly groups: ReadonlyArray<KinSettingsGroup>;
  readonly active: KinSettingsPage | null;
  readonly target: KinSettingsTarget;
}) {
  const [computerOpen, setComputerOpen] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {props.groups.map((group) =>
        group.id === "computer" ? (
          <section key={group.id} aria-label={group.title} className="flex flex-col gap-0.5">
            <button
              type="button"
              aria-expanded={computerOpen}
              onClick={() => setComputerOpen(!computerOpen)}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none ring-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset"
            >
              {computerOpen ? (
                <ChevronDownIcon aria-hidden className="size-3.5" />
              ) : (
                <ChevronRightIcon aria-hidden className="size-3.5" />
              )}
              {group.title}
            </button>
            {computerOpen
              ? THIS_COMPUTER.map((item) => (
                  <Link key={item.to} to={item.to} className={MENU_ROW}>
                    <span className="truncate">{item.label}</span>
                  </Link>
                ))
              : null}
          </section>
        ) : (
          <section key={group.id} aria-label={group.title} className="flex flex-col gap-0.5">
            <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.title}</h2>
            {group.pages.map((page) => {
              const Icon = PAGE_ICON[page];
              const active = props.active === page;
              return (
                <Link
                  key={page}
                  to="/kin/$environmentId/$orgId/settings/$page"
                  params={{ ...props.target, page }}
                  aria-current={active ? "page" : undefined}
                  data-active={active}
                  className={MENU_ROW}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{KIN_SETTINGS_PAGE_TITLES[page]}</span>
                </Link>
              );
            })}
          </section>
        ),
      )}
    </div>
  );
}

const MENU_ROW =
  "flex h-9 items-center gap-2.5 rounded-md px-2 text-sm text-foreground outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset data-[active=true]:bg-accent data-[active=true]:font-medium md:h-8";

/** Settings with no page chosen: wide, your profile beside the groups; narrow, just the groups. */
export function KinSettingsIndex() {
  return <KinSettingsPageBody page="profile" />;
}

export function KinSettingsPageRoute() {
  const target = useKinSettingsTarget();
  const groups = useKinSettingsGroups(target.environmentId);
  const { page: raw } = useParams({ from: "/_chat/kin/$environmentId/$orgId/settings/$page" });
  const page = kinSettingsPageOf(raw, groups);
  // A teammate's session learns from the host whether they run the company; until it has said,
  // a Company address waits rather than sending a co-owner to their profile.
  const reach = useKinPlaceReach(target.environmentId);
  const known = !isChatOnlySession() || reach !== null;
  if (page !== raw && !known) return null;
  // An address this person can't open lands on their own profile, not on a refusal.
  if (page !== raw)
    return <Navigate to="/kin/$environmentId/$orgId/settings" params={target} replace />;
  return <KinSettingsPageBody page={page} />;
}

function KinSettingsPageBody(props: { readonly page: KinSettingsPage }) {
  const target = useKinSettingsTarget();
  switch (props.page) {
    case "profile":
      return <KinSettingsProfile {...target} />;
    case "notifications":
      // The phone's push notifications; web has none of Kin's own to set.
      return null;
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
      return <KinMemoryView key={target.orgId} {...target} />;
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
    </div>
  );
}

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
          {AsyncResult.isFailure(result) ? "Couldn't load your agents." : "Loading…"}
        </p>
      ) : agents.length === 0 ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>No agents yet</EmptyTitle>
            <EmptyDescription>
              An agent looks after one part of the company, such as engineering or finance, and you
              talk to it in a chat.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {agents.map((agent) => (
            <li key={agent.agentId}>
              <Link
                to="/kin/$environmentId/$orgId/$chatId"
                params={{ environmentId, orgId, chatId: agent.ownerChatId }}
                className="flex items-center gap-3 px-3 py-2.5 outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
              >
                <SparklesIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {kinDomainLabel(agent.domain)}
                  </span>
                </span>
                {agent.working ? (
                  <span className="text-xs text-muted-foreground">Working</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Open an agent to talk to it; its chat shows what it&apos;s for and who can message it.
      </p>
    </div>
  );
}
