import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { KinCheckInsSetting } from "../kin/KinCheckIns";

function SettingsCheckInsRoute() {
  return (
    <SettingsPageContainer>
      <KinCheckInsSetting inDialog />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/check-ins")({
  component: SettingsCheckInsRoute,
});
