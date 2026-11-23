import { installKinNotifications } from "./notifications/installKinNotifications";
import { installKinNotificationSync } from "./notifications/kinNotificationSync";
import { CommonActions } from "@react-navigation/native";

import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { installKinAccessEnded, installKinChatOnlyMemory } from "./state/kinChatOnly";
import { installKinShellReset, readKinIsHome } from "./state/kinHome";
import { startKinOutbox } from "./state/kinOutboxDelivery";

const resetToHome = () =>
  whenRootNavigationReady(() =>
    rootNavigationRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: "Home" }] })),
  );

/**
 * Kin's app services. Install before upstream's notification router: Kin reads the cold-start
 * notification response before that router consumes it.
 */
export function installKin(navigate: (href: string) => void): () => void {
  const disposers = [
    startKinOutbox(),
    installKinNotifications(navigate),
    installKinNotificationSync(),
    installKinChatOnlyMemory(),
    installKinShellReset(resetToHome),
    installKinAccessEnded(() => {
      // Where Kin is home, Home may be showing the team that ended.
      if (readKinIsHome()) resetToHome();
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
