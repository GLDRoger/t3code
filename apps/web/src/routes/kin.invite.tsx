import { KIN_INVITE_BROWSER_ACCEPT_ROUTE } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";

/** The link is single use, so a reload or a second load must not spend it again. */
let accepting: Promise<boolean> | null = null;

function acceptInvite(secret: string) {
  accepting ??= fetch(KIN_INVITE_BROWSER_ACCEPT_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ secret, label: "Browser" }),
  }).then(
    (response) => response.ok,
    () => false,
  );
  return accepting;
}

export const Route = createFileRoute("/kin/invite")({
  beforeLoad: async () => {
    const secret = window.location.hash.slice(1);
    if (secret && (await acceptInvite(secret))) {
      // A full load, so the connection starts with the new session and the link leaves history.
      window.location.replace("/kin");
      return { accepted: true };
    }
    return { accepted: false };
  },
  component: KinInviteView,
});

function KinInviteView() {
  const { accepted } = Route.useRouteContext();
  return (
    <StandalonePage>
      {accepted ? (
        <StandalonePageHeader title="Opening your chats" description="One moment." />
      ) : (
        <StandalonePageHeader
          title="This invite link no longer works"
          description="Invite links open once and stop working after a while. Ask the person who sent it for a new one."
        />
      )}
    </StandalonePage>
  );
}
