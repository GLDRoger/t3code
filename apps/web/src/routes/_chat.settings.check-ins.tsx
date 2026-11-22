import { createFileRoute } from "@tanstack/react-router";

import { KinSettingsMoved } from "../kin/KinSettingsView";

// Moved into Kin's Settings; this address goes there once Kin's host is known (before that,
// Check-ins has nothing to show).
function SettingsCheckInsRoute() {
  return <KinSettingsMoved page="check-ins" fallback={null} />;
}

export const Route = createFileRoute("/_chat/settings/check-ins")({
  component: SettingsCheckInsRoute,
});
