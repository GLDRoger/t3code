import { createKinConnectionActions } from "@t3tools/client-runtime/kin/kinConnections";
import {
  type EnvironmentId,
  KIN_SIGN_IN_RETURN_BY_SCHEME,
  type KinConnectionSignInReturn,
  type KinOrgId,
} from "@t3tools/contracts";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";

import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";

const appScheme = () => {
  const value = Constants.expoConfig?.scheme;
  const scheme = Array.isArray(value) ? value[0] : value;
  return scheme !== undefined && Object.hasOwn(KIN_SIGN_IN_RETURN_BY_SCHEME, scheme)
    ? (scheme as keyof typeof KIN_SIGN_IN_RETURN_BY_SCHEME)
    : undefined;
};

/**
 * Which app the return page hands the sign-in back to: this build's own scheme. A scheme the
 * page doesn't know gets the page's copy-and-paste fallback.
 */
export const kinSignInReturn = (): KinConnectionSignInReturn => {
  const scheme = appScheme();
  return scheme === undefined ? "web" : KIN_SIGN_IN_RETURN_BY_SCHEME[scheme];
};

/**
 * Opens the service's sign-in page in the in-app browser and waits for the return page to hand
 * the result back by this app's scheme. `null` when the owner closed it first.
 */
export async function kinSignInInApp(authorizationUrl: string): Promise<string | null> {
  const scheme = appScheme();
  const result = await WebBrowser.openAuthSessionAsync(
    authorizationUrl,
    scheme === undefined ? null : `${scheme}://kin-oauth`,
  );
  return result.type === "success" ? result.url : null;
}

/** The owner's connection changes, wired to this environment's commands. */
export function useKinConnectionActions(
  environmentId: EnvironmentId,
  orgId: KinOrgId,
  refresh: () => void,
) {
  const add = useAtomCommand(kinClient.connectionAdd, { reportFailure: false });
  const remove = useAtomCommand(kinClient.connectionRemove, { reportFailure: false });
  const signInStart = useAtomCommand(kinClient.connectionSignInStart, { reportFailure: false });
  const signInFinish = useAtomCommand(kinClient.connectionSignInFinish, { reportFailure: false });
  const setSignInClient = useAtomCommand(kinClient.connectionSetSignInClient, {
    reportFailure: false,
  });
  return createKinConnectionActions({
    orgId,
    add: (input) => add({ environmentId, input }),
    remove: (input) => remove({ environmentId, input }),
    signInStart: (input) => signInStart({ environmentId, input }),
    signInFinish: (input) => signInFinish({ environmentId, input }),
    setSignInClient: (input) => setSignInClient({ environmentId, input }),
    refresh,
  });
}
