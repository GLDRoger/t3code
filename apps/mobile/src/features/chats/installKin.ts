import { installKinNotifications } from "./notifications/installKinNotifications";
import { CommonActions } from "@react-navigation/native";

import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import {
  installKinAccessEnded,
  installKinChatOnlyMemory,
  installKinShellReset,
} from "./state/kinChatOnly";
import { readKinIsHome } from "./state/kinHome";
import { installKinStartList } from "./state/kinLastList";
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
  // A notification that opened a chat owns the screen; the start list then stays out of the way.
  let navigated = false;
  const disposers = [
    startKinOutbox(),
    installKinNotifications((href) => {
      navigated = true;
      navigate(href);
    }),
    installKinChatOnlyMemory(),
    installKinShellReset(resetToHome),
    installKinAccessEnded(() => {
      // Only a teammate's phone: with coding environments too, Home is not about this team.
      if (readKinIsHome()) resetToHome();
    }),
    installKinStartList(
      () => navigate("/kin"),
      // Where Kin is home, Home is already the Kin list.
      () => !navigated && !readKinIsHome(),
    ),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
