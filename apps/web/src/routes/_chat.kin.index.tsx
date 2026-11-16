import { createFileRoute } from "@tanstack/react-router";

import { KinNoChat } from "../kin/KinPage";

export const Route = createFileRoute("/_chat/kin/")({
  // `settings: "owner"`: a teammate followed a link into Settings, which their session lacks.
  validateSearch: (raw: Record<string, unknown>): { readonly settings?: "owner" } =>
    raw.settings === "owner" ? { settings: "owner" } : {},
  component: KinNoChat,
});
