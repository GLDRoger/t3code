import { createFileRoute } from "@tanstack/react-router";

import { KinNoChat } from "../kin/KinPage";

export const Route = createFileRoute("/_chat/kin/")({
  // `settings`: a teammate followed a link into the app's Settings, which their session lacks.
  validateSearch: (raw: Record<string, unknown>): { readonly settings?: string } =>
    typeof raw.settings === "string" ? { settings: raw.settings } : {},
  component: KinNoChat,
});
