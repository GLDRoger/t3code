import { useAtomValue } from "@effect/atom-react";
import { KIN_COMPANY_SETTINGS } from "@t3tools/client-runtime/kin/kinCompanyProfile";

import { KinCompanyExportSection, KinCompanyProfileSettings } from "../KinCompanyProfile";
import { KinCompanyTimeZoneSetting, useKinCanSetTimeZone } from "../KinCompanyTimeZone";
import { KinDailyLimitSetting } from "../KinDailyLimit";
import { kinNewLeadTarget } from "../KinNewLeadButton";
import { KinStopSetting } from "../KinStopSetting";
import { kinClient } from "../kinClient";
import { useKinHost } from "../useKinHost";
import type { KinWorkTarget } from "../useKinWork";
import { KinSettingsPage, KinSettingsSection } from "./KinSettingsLayout";

/** Settings → Company details: the company on paper, how the agents' day runs, your data, Stop last. */
export function KinCompanyPage() {
  const target = kinNewLeadTarget(useKinHost());
  return (
    <KinSettingsPage purpose={KIN_COMPANY_SETTINGS.purpose}>
      <KinCompanyProfileSettings />
      {target === null ? null : <TimeAndLimits {...target} />}
      {target === null ? null : <KinCompanyExportSection {...target} />}
      <KinStopSetting />
    </KinSettingsPage>
  );
}

function TimeAndLimits(props: KinWorkTarget) {
  const zone = useKinCanSetTimeZone(props.environmentId);
  const limit = useAtomValue(kinClient.budgetSet.permissionAtom(props.environmentId));
  if (!zone && !limit) return null;
  return (
    <KinSettingsSection title={KIN_COMPANY_SETTINGS.timeAndLimits}>
      <KinCompanyTimeZoneSetting />
      <KinDailyLimitSetting />
    </KinSettingsSection>
  );
}
