import { createFileRoute } from "@tanstack/react-router";

import { KinSettingsLayout } from "../kin/KinSettingsView";

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/settings")({
  component: KinSettingsLayout,
});
