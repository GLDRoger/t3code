import { createFileRoute, redirect } from "@tanstack/react-router";

// Memory moved into Settings → Company; its old address lands there.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/memory")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/kin/$environmentId/$orgId/settings/$page",
      params: { ...params, page: "memory" },
      replace: true,
    });
  },
});
