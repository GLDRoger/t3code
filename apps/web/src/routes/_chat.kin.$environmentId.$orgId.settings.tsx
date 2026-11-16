import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings is a modal now; its old page addresses open it on that section over the chats.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/settings")({
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/kin",
      search: { settings: location.pathname.split("/")[5] ?? "" },
      replace: true,
    });
  },
});
