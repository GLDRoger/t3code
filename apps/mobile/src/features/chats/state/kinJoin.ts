import { connectionRoutes } from "@t3tools/client-runtime/connection";
import {
  kinJoinFailureMessage,
  kinJoinStanding,
  type KinJoinStanding,
  type KinJoinTarget,
} from "@t3tools/client-runtime/kin/kinJoin";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../../../connection/catalog";
import { connectPairingUrl } from "../../../connection/onboarding";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentPresentations } from "../../../state/presentation";
import { readEnvironmentChatOnly, whenEnvironmentSessionKnown } from "./kinChatOnly";

// A join that connected but whose session never answered still lands; the app corrects itself.
const SESSION_WAIT_MS = 8_000;

/** Where this phone already stands with the Kin a link points at; read before the link is spent. */
export function readKinJoinStanding(target: KinJoinTarget): KinJoinStanding {
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  const { entries } = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  return kinJoinStanding(
    target,
    [...entries].map(([environmentId, entry]) => ({
      environmentId,
      httpBaseUrls: connectionRoutes(entry).flatMap((route) => {
        const profile = Option.getOrNull(route.profile);
        return profile !== null && "httpBaseUrl" in profile ? [profile.httpBaseUrl] : [];
      }),
      chatOnly: readEnvironmentChatOnly(environmentId),
      connected: presentations.get(environmentId)?.connection.phase === "connected",
    })),
  );
}

/** Spends the link for a teammate's session and waits until the app knows what that session is. */
export async function joinKin(
  target: KinJoinTarget,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly problem: string }> {
  const result = await runAtomCommand(
    appAtomRegistry,
    connectPairingUrl,
    { pairingUrl: target.link },
    { reportFailure: false },
  );
  if (!AsyncResult.isSuccess(result)) {
    return { ok: false, problem: kinJoinFailureMessage(Cause.squash(result.cause)) };
  }
  await Promise.race([
    whenEnvironmentSessionKnown(result.value),
    new Promise((resolve) => setTimeout(resolve, SESSION_WAIT_MS)),
  ]);
  return { ok: true };
}
