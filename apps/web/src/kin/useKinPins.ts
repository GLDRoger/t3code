import { makeKinPinsHooks } from "@t3tools/client-runtime/kin/react/kinPinsHooks";

import { kinHookApp } from "./kinHookApp";

export const { useKinPinZones, useKinPins, useKinPinActions } = makeKinPinsHooks(kinHookApp);

/** Recomputes day counts when this browser tab becomes visible or focused again. */
export function subscribeKinPinsForeground(update: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") update();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  };
}
