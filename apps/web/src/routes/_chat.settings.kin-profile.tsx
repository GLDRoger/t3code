import { createFileRoute } from "@tanstack/react-router";

import { KinSettingsMoved } from "../kin/KinSettingsView";

// Only Kin's Settings has a Profile; this address, from settings search, opens it there.
function SettingsKinProfileRoute() {
  return <KinSettingsMoved page="profile" fallback={null} />;
}

export const Route = createFileRoute("/_chat/settings/kin-profile")({
  component: SettingsKinProfileRoute,
});
