import { createFileRoute, redirect } from "@tanstack/react-router";

// Team moved into Settings → Company; its old address lands there.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/team")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/kin/$environmentId/$orgId/settings/$page",
      params: { ...params, page: "team" },
      replace: true,
    });
  },
});
