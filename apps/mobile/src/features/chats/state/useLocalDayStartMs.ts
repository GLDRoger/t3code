import { minuteTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

import { minuteTickToEpochMs } from "../../../lib/clock";

const readLocalDayStartMs = () => {
  const now = new Date(minuteTickToEpochMs(minuteTick.getSnapshot()));
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

/** Epoch ms of the local day's start; re-renders only when the day changes. */
export function useLocalDayStartMs(): number {
  return useSyncExternalStore(minuteTick.subscribe, readLocalDayStartMs, readLocalDayStartMs);
}
