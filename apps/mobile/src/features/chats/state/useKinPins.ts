import { makeKinPinsHooks } from "@t3tools/client-runtime/kin/react/kinPinsHooks";
import { AppState } from "react-native";

import { kinHookApp } from "./kinHookApp";

export const { useKinPinZones, useKinPins, useKinPinActions } = makeKinPinsHooks(kinHookApp);

/** Recomputes day counts when the app returns to the foreground. */
export function subscribeKinPinsForeground(update: () => void): () => void {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") update();
  });
  return () => subscription.remove();
}
