import { createKinConnectionActions } from "@t3tools/client-runtime/kin/kinConnections";
import type { EnvironmentId, KinConnectionSignInReturn, KinOrgId } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";

import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";

const scheme = () => {
  const value = Constants.expoConfig?.scheme;
  return (Array.isArray(value) ? value[0] : value) ?? "t3code";
};

/** Which app the return page hands the sign-in back to: this build's own scheme. */
export const kinSignInReturn = (): KinConnectionSignInReturn =>
  scheme() === "t3code-dev" ? "app-dev" : scheme() === "t3code-preview" ? "app-preview" : "app";

/**
 * Opens the service's sign-in page in the in-app browser and waits for the return page to hand
 * the result back by this app's scheme. `null` when the owner closed it first.
 */
export async function kinSignInInApp(authorizationUrl: string): Promise<string | null> {
  const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, `${scheme()}://kin-oauth`);
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
