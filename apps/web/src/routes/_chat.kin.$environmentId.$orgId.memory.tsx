import { createFileRoute, redirect } from "@tanstack/react-router";

// Memory moved into Settings → Company; its old address opens Settings there.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/memory")({
  beforeLoad: () => {
    throw redirect({ to: "/kin", search: { settings: "memory" }, replace: true });
  },
});
