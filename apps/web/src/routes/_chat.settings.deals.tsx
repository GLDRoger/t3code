import { createFileRoute } from "@tanstack/react-router";

import { KinSettingsMoved } from "../kin/KinSettingsView";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { KinDealsSetting } from "../kin/KinDealsSetting";

// Kin's Settings holds this page; this address goes there once Kin's host is known.
function SettingsDealsRoute() {
  return (
    <KinSettingsMoved
      page="deals"
      fallback={
        <SettingsPageContainer>
          <KinDealsSetting />
        </SettingsPageContainer>
      }
    />
  );
}

export const Route = createFileRoute("/_chat/settings/deals")({
  component: SettingsDealsRoute,
});
