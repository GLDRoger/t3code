import { installKinNotifications } from "./notifications/installKinNotifications";
import { startKinOutbox } from "./state/kinOutboxDelivery";

/**
 * Kin's app services. Install before upstream's notification router: Kin reads the cold-start
 * notification response before that router consumes it.
 */
export function installKin(navigate: (href: string) => void): () => void {
  const disposers = [startKinOutbox(), installKinNotifications(navigate)];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
