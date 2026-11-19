import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChartNoAxesColumnIcon,
  CodeIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { T, useGT } from "gt-react";
import { memo } from "react";
import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";

import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  navigateHistory,
  useCanNavigateHistory,
  type HistoryDirection,
} from "../../navigationHistory";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { cn } from "../../lib/utils";
import { useIssuesSupported, usePullRequestsSupported } from "../../state/environments";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { KIN_CODING_ENTRY, kinCodingEntryShown } from "@t3tools/client-runtime/kin/kinListSwitch";
import { kinListAt, kinListShownAt, kinListSwitchHref } from "../../kin/kinListSwitch";
import { openKinSettings } from "../../kin/kinSettingsAddress";
import { isChatOnlySession } from "../../environments/primary";
import { useKinListSwitch } from "../../kin/useKinListSwitch";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { IssueGlyph } from "../issue/issuePresentation";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const gt = useGT();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode,
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto translate-y-0"
          aria-label={gt("Toggle main sidebar")}
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <div className="flex shrink-0 items-center gap-1">
          <SidebarBrand onBackdrop={backdropVariant !== null} />
          {isElectron ? (
            <div className="hidden items-center md:flex">
              <HistoryNavigationButton direction="back" onBackdrop={backdropVariant !== null} />
              <HistoryNavigationButton direction="forward" onBackdrop={backdropVariant !== null} />
            </div>
          ) : null}
        </div>
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function SidebarBrandWidthProbe({
  isElectron,
  onWidthChange,
}: {
  isElectron: boolean;
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex gap-1">
        <SidebarBrandMark onBackdrop={false} />
        {isElectron ? <div className="w-[calc(2*var(--workspace-titlebar-control-size))]" /> : null}
      </div>
    </div>
  );
}

function HistoryNavigationButton({
  direction,
  onBackdrop,
}: {
  direction: HistoryDirection;
  onBackdrop: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const enabled = useCanNavigateHistory(direction);
  const gt = useGT();
  const label = direction === "back" ? gt("Go back") : gt("Go forward");
  const shortcutLabel = shortcutLabelForCommand(
    keybindings,
    direction === "back" ? "navigation.back" : "navigation.forward",
  );
  const Icon = direction === "back" ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={cn(
              "[-webkit-app-region:no-drag]",
              onBackdrop && "relative top-auto translate-y-0",
            )}
            disabled={!enabled}
            onClick={() => navigateHistory(direction)}
            size="icon-sm"
            variant={onBackdrop ? "media-navigation" : "ghost"}
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  const gt = useGT();
  const kinSwitch = useKinListSwitch();
  const className = cn(
    "relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
    onBackdrop ? "text-white" : "text-foreground",
  );
  // A teammate's session has no coding threads to switch to or go home to.
  if (isChatOnlySession()) {
    return (
      <span className={cn(className, "flex")}>
        <SidebarBrandMark onBackdrop={onBackdrop} product="Kin" />
      </span>
    );
  }
  // With Kin on, the mark names the area you're in; the destinations above the list move between them.
  if (kinSwitch !== null) {
    return (
      <span className={cn(className, "flex")}>
        <SidebarBrandMark
          onBackdrop={onBackdrop}
          product={kinSwitch.current === "kin" ? "Kin" : "Code"}
        />
      </span>
    );
  }
  return (
    <Link aria-label={gt("T3 Code home")} className={cn(className, "hidden md:flex")} to="/">
      <SidebarBrandMark onBackdrop={onBackdrop} />
    </Link>
  );
}

function SidebarBrandMark({
  onBackdrop,
  product = "Code",
}: {
  onBackdrop: boolean;
  product?: string;
}) {
  // Kin is its own name: no T3 mark before it, and it takes the brand's own colour.
  const ownName = product === "Kin";
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
      {ownName ? null : <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />}
      <span
        className={cn(
          "truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1",
          ownName ? undefined : onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        {product}
      </span>
    </span>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const gt = useGT();
  const { isMobile, setOpenMobile } = useSidebar();
  const router = useRouter();
  // Kin is a list of its own, not a utility page, so it keeps the everyday footer.
  const isOnUtilityPage = useLocation({
    select: (location) =>
      isSidebarUtilityPage(location.pathname) && kinListAt(location.pathname) !== "kin",
  });
  // Over Kin (and the app's settings opened from it) the corner holds only Kin's Settings.
  const overKin = useLocation({
    select: (location) => kinListShownAt(location.pathname) === "kin",
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const coding = kinCodingEntryShown({
    current: overKin ? "kin" : "threads",
    chatOnly: isChatOnlySession(),
  });
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleIssuesClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/issues", search: readIssueListPreferences() });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    if (overKin) openKinSettings(router.history);
    else void navigate({ to: "/settings" });
  };

  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };

  const handleCodingClick = () => {
    closeMobileSidebar();
    void navigate({ href: kinListSwitchHref("kin") });
  };

  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>
              <T>Back</T>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label={gt("Settings")}
            onClick={handleSettingsClick}
          />
          {coding ? (
            <SidebarUtilityItem
              icon={<CodeIcon />}
              label={KIN_CODING_ENTRY}
              onClick={handleCodingClick}
            />
          ) : null}
          {/* Pull requests, issues and usage are about coding threads, which Kin doesn't offer. */}
          {pullRequestsSupported && !overKin ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label={gt("Pull requests")}
              onClick={handlePullRequestsClick}
            />
          ) : null}
          {issuesSupported && !overKin ? (
            <SidebarUtilityItem
              icon={<IssueGlyph.issue />}
              label={gt("Issues", { $context: "sidebar link to the list of issues" })}
              onClick={handleIssuesClick}
            />
          ) : null}
          {overKin ? null : (
            <SidebarUtilityItem
              icon={<ChartNoAxesColumnIcon />}
              label={gt("Usage")}
              onClick={handleUsageClick}
            />
          )}
        </>
      )}
      <SidebarThreadUndoNotice />
      {/* Provider updates are for coding threads; over Kin they stay under This computer. */}
      <SidebarUpdatePill appOnly={overKin} />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  // A teammate's session runs no providers and doesn't update the server.
  const chatOnly = isChatOnlySession();
  const overKin = useLocation({
    select: (location) => kinListShownAt(location.pathname) === "kin",
  });
  return (
    <SidebarFooter>
      {chatOnly || overKin ? null : <SidebarProviderUpdatePill />}
      {chatOnly ? null : <SidebarUpdateArchitectureWarning />}
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
