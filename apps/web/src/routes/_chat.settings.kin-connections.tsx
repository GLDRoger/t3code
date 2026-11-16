import { createFileRoute } from "@tanstack/react-router";

import { KinSettingsMoved } from "../kin/KinSettingsView";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { KinConnectionsSettings } from "../kin/KinConnections";

// Moved into Kin's Settings; this address goes there once Kin's host is known.
function SettingsKinConnectionsRoute() {
  return (
    <KinSettingsMoved
      page="connections"
      fallback={
        <SettingsPageContainer>
          <KinConnectionsSettings />
        </SettingsPageContainer>
      }
    />
  );
}

export const Route = createFileRoute("/_chat/settings/kin-connections")({
  component: SettingsKinConnectionsRoute,
});
