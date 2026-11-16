import { createFileRoute, redirect } from "@tanstack/react-router";

import { kinSettingsHref } from "../kin/kinSettingsAddress";

// Team moved into Settings → Company; its old address opens Settings there.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/team")({
  beforeLoad: () => {
    throw redirect({ href: kinSettingsHref("team"), replace: true });
  },
});
