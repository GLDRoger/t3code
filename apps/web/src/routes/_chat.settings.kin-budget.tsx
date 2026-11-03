import { createFileRoute } from "@tanstack/react-router";

import { KinBudgetSettings } from "../components/settings/KinBudgetSettings";

function SettingsKinBudgetRoute() {
  return <KinBudgetSettings />;
}

export const Route = createFileRoute("/_chat/settings/kin-budget")({
  component: SettingsKinBudgetRoute,
});
