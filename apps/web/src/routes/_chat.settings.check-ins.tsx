import { createFileRoute } from "@tanstack/react-router";

import { KinSettingsMoved } from "../kin/KinSettingsView";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { KinCheckInsSetting } from "../kin/KinCheckIns";

// Moved into Kin's Settings; this address goes there once Kin's host is known.
function SettingsCheckInsRoute() {
  return (
    <KinSettingsMoved
      page="check-ins"
      fallback={
        <SettingsPageContainer>
          <KinCheckInsSetting inDialog />
        </SettingsPageContainer>
      }
    />
  );
}

export const Route = createFileRoute("/_chat/settings/check-ins")({
  component: SettingsCheckInsRoute,
});
