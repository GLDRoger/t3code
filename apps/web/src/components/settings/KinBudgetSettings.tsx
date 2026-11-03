import { KIN_MAIN_THREAD_CHILD_CAP, KIN_PLAN_CAPS } from "@t3tools/contracts";

import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function KinBudgetSettings() {
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("kin-budget")} title="Routing & Budget">
        <SettingsRow
          title="Main thread"
          description="Active children one main thread may run at once. Finished children do not count."
          control={
            <span className="text-sm text-muted-foreground">{KIN_MAIN_THREAD_CHILD_CAP}</span>
          }
        />
        {KIN_PLAN_CAPS.map((cap) => (
          <SettingsRow
            key={cap.driver}
            title={cap.plan}
            description={`Stop new children at ${cap.maxUsedPercent}% of this plan.`}
            control={
              <span className="text-sm text-muted-foreground">{cap.maxChildren} children</span>
            }
          />
        ))}
        <SettingsRow
          title="Chaos canary and weekly"
          description="Live provider chaos stays off unless KIN_CHAOS=1 and KIN_CHAOS_LIVE=1, and never in production."
          control={<span className="text-sm text-muted-foreground">Off</span>}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
