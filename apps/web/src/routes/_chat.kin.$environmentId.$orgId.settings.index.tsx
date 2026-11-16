import { createFileRoute } from "@tanstack/react-router";

import { KinSettingsIndex } from "../kin/KinSettingsView";

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/settings/")({
  component: KinSettingsIndex,
});
