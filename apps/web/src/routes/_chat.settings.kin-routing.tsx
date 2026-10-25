import { createFileRoute } from "@tanstack/react-router";

import { KinRoutingSettings } from "../components/settings/KinRoutingSettings";

function SettingsKinRoutingRoute() {
  return <KinRoutingSettings />;
}

export const Route = createFileRoute("/_chat/settings/kin-routing")({
  component: SettingsKinRoutingRoute,
});
