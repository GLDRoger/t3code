import { kinJoinOffersApp } from "@t3tools/client-runtime/kin/kinJoin";
import { KIN_INVITE_BROWSER_ACCEPT_ROUTE } from "@t3tools/contracts";
import { buildKinJoinAppLink } from "@t3tools/shared/remote";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../components/ui/button";
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

async function joinHere(secret: string): Promise<boolean> {
  if (!(await acceptInvite(secret))) return false;
  // A full load, so the connection starts with the new session and the link leaves history.
  window.location.replace("/kin");
  return true;
}

type InviteStep = "choose" | "accepted" | "spent";

export const Route = createFileRoute("/kin/invite")({
  beforeLoad: async (): Promise<{ readonly step: InviteStep }> => {
    const secret = window.location.hash.slice(1);
    if (!secret) return { step: "spent" };
    // The phone app may be installed, and opening the link here would spend it before it got there.
    if (kinJoinOffersApp(navigator.userAgent)) return { step: "choose" };
    return { step: (await joinHere(secret)) ? "accepted" : "spent" };
  },
  component: KinInviteView,
});

function KinInviteView() {
  const [step, setStep] = useState(Route.useRouteContext().step);
  const [joining, setJoining] = useState(false);
  return (
    <StandalonePage>
      {step === "accepted" ? (
        <StandalonePageHeader title="Opening your chats" description="One moment." />
      ) : step === "spent" ? (
        <StandalonePageHeader
          title="This invite link no longer works"
          description="Invite links open once and stop working after a while. Ask the person who sent it for a new one."
        />
      ) : (
        <>
          <StandalonePageHeader
            title="Join your team"
            description="This link works once. Open it in the app if it's on this phone, or carry on here in the browser."
          />
          <div className="mt-6 flex flex-wrap gap-2">
            <Button render={<a href={buildKinJoinAppLink(window.location.href)} />}>
              Open in the app
            </Button>
            <Button
              variant="outline"
              disabled={joining}
              onClick={async () => {
                setJoining(true);
                setStep((await joinHere(window.location.hash.slice(1))) ? "accepted" : "spent");
              }}
            >
              Continue in the browser
            </Button>
          </div>
        </>
      )}
    </StandalonePage>
  );
}
