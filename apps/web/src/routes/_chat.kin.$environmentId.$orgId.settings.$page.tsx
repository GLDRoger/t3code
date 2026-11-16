import { createFileRoute } from "@tanstack/react-router";

import { KinSettingsPageRoute } from "../kin/KinSettingsView";

// Each page of Settings has its own address, so a link from a chat ("Open Connections") lands on it.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/settings/$page")({
  component: KinSettingsPageRoute,
});
