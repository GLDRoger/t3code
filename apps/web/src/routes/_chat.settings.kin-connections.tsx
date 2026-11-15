import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { KinConnectionsSettings } from "../kin/KinConnections";

function SettingsKinConnectionsRoute() {
  return (
    <SettingsPageContainer>
      <KinConnectionsSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/kin-connections")({
  component: SettingsKinConnectionsRoute,
});
