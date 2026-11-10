import { installKinNotifications } from "./notifications/installKinNotifications";
import { installKinStartList } from "./state/kinLastList";
import { startKinOutbox } from "./state/kinOutboxDelivery";

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
    installKinStartList(
      () => navigate("/kin"),
      () => !navigated,
    ),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
