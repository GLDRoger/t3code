import { createFileRoute, redirect } from "@tanstack/react-router";

import { kinSettingsHref } from "../kin/kinSettingsAddress";

// Memory moved into Settings → Company; its old address opens Settings there.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/memory")({
  beforeLoad: () => {
    throw redirect({ href: kinSettingsHref("memory"), replace: true });
  },
});
