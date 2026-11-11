import { kinJoinOffersApp } from "@t3tools/client-runtime/kin/kinJoin";
import {
  KIN_INVITE_APP_ROUTE,
  KIN_INVITE_BROWSER_ACCEPT_ROUTE,
  KinInviteAppResult,
} from "@t3tools/contracts";
import { buildKinJoinAppLink } from "@t3tools/shared/remote";
import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

const decodeAppResult = Schema.decodeUnknownOption(KinInviteAppResult);

/** The scheme of the app this host's teammates install, or null when the host doesn't say. */
async function hostAppScheme(): Promise<string | null> {
  try {
    const response = await fetch(KIN_INVITE_APP_ROUTE, { credentials: "same-origin" });
    if (!response.ok) return null;
    return Option.getOrNull(decodeAppResult(await response.json()))?.appScheme ?? null;
  } catch {
    return null;
  }
}

type InviteStep = "choose" | "accepted" | "spent";

export const Route = createFileRoute("/kin/invite")({
  beforeLoad: async (): Promise<{
    readonly step: InviteStep;
    readonly appScheme: string | null;
  }> => {
    const secret = window.location.hash.slice(1);
    if (!secret) return { step: "spent", appScheme: null };
    // The phone app may be installed, and opening the link here would spend it before it got there.
    if (kinJoinOffersApp(navigator.userAgent)) {
      return { step: "choose", appScheme: await hostAppScheme() };
    }
    return { step: (await joinHere(secret)) ? "accepted" : "spent", appScheme: null };
  },
  component: KinInviteView,
});

function KinInviteView() {
  const context = Route.useRouteContext();
  const [step, setStep] = useState(context.step);
  const [joining, setJoining] = useState(false);
  const [triedApp, setTriedApp] = useState(false);
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
            description={
              context.appScheme === null
                ? "This link works once."
                : "This link works once. Open it in the app if it's on this phone, or carry on here in the browser."
            }
          />
          <div className="mt-6 flex flex-wrap gap-2">
            {context.appScheme === null ? null : (
              <Button
                render={
                  <a
                    href={buildKinJoinAppLink(context.appScheme, window.location.href)}
                    onClick={() => setTriedApp(true)}
                  />
                }
              >
                Open in the app
              </Button>
            )}
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
          {triedApp ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Don't have the app? Ask whoever invited you for it, or continue in the browser. This
              link still works.
            </p>
          ) : null}
        </>
      )}
    </StandalonePage>
  );
}
