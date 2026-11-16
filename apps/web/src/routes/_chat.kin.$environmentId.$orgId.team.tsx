import { createFileRoute, redirect } from "@tanstack/react-router";

// Team moved into Settings → Company; its old address opens Settings there.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/team")({
  beforeLoad: () => {
    throw redirect({ to: "/kin", search: { settings: "team" }, replace: true });
  },
});
