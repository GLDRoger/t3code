import { createFileRoute } from "@tanstack/react-router";

import { ApprovalsSettings } from "../components/settings/ApprovalsSettings";
import { KinSettingsMoved } from "../kin/KinSettingsView";

// Moved into Kin's Settings; this address goes there once Kin's host is known.
function SettingsApprovalsRoute() {
  return <KinSettingsMoved page="approvals" fallback={<ApprovalsSettings />} />;
}

export const Route = createFileRoute("/_chat/settings/approvals")({
  component: SettingsApprovalsRoute,
});
