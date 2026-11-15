import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, SettingsIcon } from "lucide-react";

import { ApprovalsSettings } from "../components/settings/ApprovalsSettings";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { isElectron } from "../env";
import { isChatOnlySession } from "../environments/primary";
import { KinCompanyProfileSettings } from "./KinCompanyProfile";
import { KinCheckInsSetting } from "./KinCheckIns";
import { KinDailyLimitSetting } from "./KinDailyLimit";
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

/** The company's settings: its details, the daily limit, check-ins, and approvals on this phone. */
export function KinSettingsView() {
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SettingsPageContainer>
          <SettingsSection {...searchableSetting("company-details")} variant="plain">
            <KinCompanyProfileSettings />
          </SettingsSection>
          <KinDailyLimitSetting />
          <KinCheckInsSetting />
        </SettingsPageContainer>
        <ApprovalsSettings />
      </div>
    </>
  );
}
