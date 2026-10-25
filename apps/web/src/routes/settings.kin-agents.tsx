import { createFileRoute } from "@tanstack/react-router";

import { KinAgentsSettings } from "../components/settings/KinAgentsSettings";

function SettingsKinAgentsRoute() {
  return <KinAgentsSettings />;
}

export const Route = createFileRoute("/settings/kin-agents")({
  component: SettingsKinAgentsRoute,
});
