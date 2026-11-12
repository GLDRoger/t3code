import { createFileRoute } from "@tanstack/react-router";

import { ApprovalsSettings } from "../components/settings/ApprovalsSettings";

export const Route = createFileRoute("/_chat/settings/approvals")({
  component: ApprovalsSettings,
});
