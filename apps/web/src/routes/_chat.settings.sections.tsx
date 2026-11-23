import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { KinSettingsMoved } from "../kin/KinSettingsView";
import { KinSectionsPage } from "../kin/settings/KinSectionsPage";

// Kin's Settings holds this page; this address goes there once Kin's host is known.
function SettingsSectionsRoute() {
  return (
    <KinSettingsMoved
      page="sections"
      fallback={
        <SettingsPageContainer>
          <KinSectionsPage />
        </SettingsPageContainer>
      }
    />
  );
}

export const Route = createFileRoute("/_chat/settings/sections")({
  component: SettingsSectionsRoute,
});
