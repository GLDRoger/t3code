import { createFileRoute } from "@tanstack/react-router";

import { KinNoChat } from "../kin/KinPage";

export const Route = createFileRoute("/_chat/kin/")({
  // `settings`: the Settings section open over the page (see `kinSettingsAddress`).
  validateSearch: (raw: Record<string, unknown>): { readonly settings?: string } =>
    typeof raw.settings === "string" ? { settings: raw.settings } : {},
  component: KinNoChat,
});
