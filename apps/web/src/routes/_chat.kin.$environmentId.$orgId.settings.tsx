import { createFileRoute, redirect } from "@tanstack/react-router";

import { kinSettingsHref } from "../kin/kinSettingsAddress";

// Settings is a modal over the page you are on; its old page addresses open it on that section.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/settings")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: kinSettingsHref(location.pathname.split("/")[5] ?? ""), replace: true });
  },
});
