import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { KinConnectionsSettings } from "../KinConnections";

/** Settings → Connections. Not yet on the shared anatomy (web-settings-patterns.md). */
export function KinConnectionsPage() {
  return (
    <SettingsPageContainer>
      <KinConnectionsSettings />
    </SettingsPageContainer>
  );
}
