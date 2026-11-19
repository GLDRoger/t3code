import { createFileRoute } from "@tanstack/react-router";

import { KinNoChat } from "../kin/KinPage";

export const Route = createFileRoute("/_chat/kin/")({
  // `settings`: the Settings section open over the page, `at`: the setting it opens at (see
  // `kinSettingsAddress`).
  validateSearch: (
    raw: Record<string, unknown>,
  ): { readonly settings?: string; readonly at?: string } => ({
    ...(typeof raw.settings === "string" ? { settings: raw.settings } : {}),
    ...(typeof raw.at === "string" ? { at: raw.at } : {}),
  }),
  component: KinNoChat,
});
