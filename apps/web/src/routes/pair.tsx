import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";
import { Button } from "../components/ui/button";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";
import { peekPairingTokenFromUrl } from "../environments/primary";
import { kinAccessEnded, wasKinTeammate } from "../kin/kinTeammateMark";

export const Route = createFileRoute("/pair")({
  beforeLoad: async ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }

    if (
      authGateState.status === "authenticated" ||
      authGateState.status === "hosted-static" ||
      authGateState.status === "guest"
    ) {
      throw redirect({ to: "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const { authGateState } = Route.useRouteContext();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  return (
    <KinAccessEndedGate>
      <PairingForm />
    </KinAccessEndedGate>
  );
}

/** A Kin teammate whose session ended hears that, and whom to ask, before any pairing form. */
function KinAccessEndedGate(props: { readonly children: React.ReactNode }) {
  const [ended] = useState(() => wasKinTeammate() && peekPairingTokenFromUrl() === null);
  const [copy] = useState(kinAccessEnded);
  const [pairAnyway, setPairAnyway] = useState(false);
  if (!ended || pairAnyway) return props.children;
  return (
    <StandalonePage>
      <StandalonePageHeader context="Kin" title={copy.title} description={copy.detail} />
      <Button variant="ghost" size="sm" className="mt-6" onClick={() => setPairAnyway(true)}>
        {/* oxlint-disable-next-line t3code/no-untranslated-copy -- Kin's copy stays English until Kin is translated */}
        {"Pair with a token instead"}
      </Button>
    </StandalonePage>
  );
}

function PairingForm() {
  const router = useRouter();
  const { authGateState } = Route.useRouteContext();
  if (authGateState?.status !== "requires-auth") return null;
  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        // Recreate the connection so WebSocket and cached scopes use the new pairing cookie.
        router.history.replace("/");
        router.history.flush();
        window.location.reload();
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
