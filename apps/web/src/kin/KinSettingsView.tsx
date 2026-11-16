import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, SettingsIcon } from "lucide-react";

import { ApprovalsSettings } from "../components/settings/ApprovalsSettings";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { isElectron } from "../env";
import { isChatOnlySession } from "../environments/primary";
import { KinCompanyProfileSettings } from "./KinCompanyProfile";
import { KinCheckInsSetting } from "./KinCheckIns";
import { KinCompanyTimeZoneSetting } from "./KinCompanyTimeZone";
import { KinDailyLimitSetting } from "./KinDailyLimit";
import { KinWorkNotice } from "./KinWorkParts";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { useKinHost } from "./useKinHost";
import { useKinOwnerLevel } from "./useKinOwnerLevel";

const KIN_SETTINGS_TITLE = "Settings";

/**
 * The gear beside Chats for a co-owner, whose session has no app Settings: the company's own
 * settings, inside Kin. The owner's session reaches them in the app's Settings.
 */
export function KinSettingsButton() {
  const target = kinNewLeadTarget(useKinHost());
  if (target === null || !isChatOnlySession()) return null;
  return <OwnerLevelSettingsButton environmentId={target.environmentId} orgId={target.orgId} />;
}

function OwnerLevelSettingsButton(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const { environmentId, orgId } = props;
  if (!useKinOwnerLevel(environmentId)) return null;
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={KIN_SETTINGS_TITLE}
      render={<Link to="/kin/$environmentId/$orgId/settings" params={{ environmentId, orgId }} />}
    >
      <SettingsIcon />
    </Button>
  );
}

/**
 * Where a teammate lands after following a link into Settings, which their session has none of:
 * owner-level people get Kin's own settings; members are told plainly whose they are.
 */
export function KinOwnerSettingsNotice() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? (
    <SettingsNotice ownerLevel={false} target={null} />
  ) : (
    <OwnerLevelNotice environmentId={target.environmentId} orgId={target.orgId} />
  );
}

function OwnerLevelNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  return <SettingsNotice ownerLevel={useKinOwnerLevel(props.environmentId)} target={props} />;
}

function SettingsNotice(props: {
  readonly ownerLevel: boolean;
  readonly target: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId } | null;
}) {
  const { target } = props;
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>
          {props.ownerLevel ? "Kin's settings are here" : "These settings are the owner's"}
        </EmptyTitle>
        <EmptyDescription>
          {props.ownerLevel && target !== null ? (
            <Link
              to="/kin/$environmentId/$orgId/settings"
              params={target}
              className="text-foreground underline underline-offset-4"
            >
              Open {KIN_SETTINGS_TITLE}
            </Link>
          ) : (
            "Only the owner and co-owners change them. Ask one of them if something should change."
          )}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** The company's settings: its details, the daily limit, check-ins, and approvals on this phone. */
export function KinSettingsView() {
  const target = kinNewLeadTarget(useKinHost());
  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("company-details")} variant="plain">
          <KinCompanyProfileSettings />
        </SettingsSection>
        <KinCompanyTimeZoneSetting />
        <KinDailyLimitSetting />
        <KinCheckInsSetting />
      </SettingsPageContainer>
      <ApprovalsSettings />
    </div>
  );
  return (
    <>
      <WorkspacePageHeader electron={isElectron}>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back to chats"
          className="md:hidden"
          render={<Link to="/kin" />}
        >
          <ArrowLeftIcon />
        </Button>
        <WorkspaceBreadcrumb ariaLabel={KIN_SETTINGS_TITLE}>
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{KIN_SETTINGS_TITLE}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      {target === null ? (
        body
      ) : (
        <OwnerLevelOnly environmentId={target.environmentId}>{body}</OwnerLevelOnly>
      )}
    </>
  );
}

/** A teammate who follows a link here: these are the owner's; theirs is their profile. */
function OwnerLevelOnly(props: {
  readonly environmentId: EnvironmentId;
  readonly children: React.ReactNode;
}) {
  if (useKinOwnerLevel(props.environmentId)) return props.children;
  return (
    <KinWorkNotice
      title="These settings are the owner's"
      detail="The owner and co-owners keep the company's settings. Yours are under your name in the sidebar."
    />
  );
}
