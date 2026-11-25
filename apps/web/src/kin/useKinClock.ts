import { minuteTick } from "@t3tools/client-runtime/clock";
import { KIN_PRESENCE_TICK_MS } from "@t3tools/client-runtime/kin/kinLive";
import {
  kinClockOffsetMs,
  kinNowMs,
  setKinDevClockOffset,
} from "@t3tools/client-runtime/kin/kinNow";
import { useEffect, useState, useSyncExternalStore } from "react";

/** `kv clock` keeps its dev server's offset here (whole minutes); a built client never reads it. */
export const KIN_DEV_CLOCK_KEY = "kin-dev-clock-offset";
if (import.meta.env.DEV)
  setKinDevClockOffset(Number(globalThis.localStorage?.getItem(KIN_DEV_CLOCK_KEY) ?? 0));

/** Epoch ms floored to the minute, from the shared minute tick (UTC `YYYY-MM-DDTHH:mm`). */
export function useNowMinuteMs(): number {
  const minute = useSyncExternalStore(
    minuteTick.subscribe,
    minuteTick.getSnapshot,
    minuteTick.getSnapshot,
  );
  return Date.parse(`${minute}:00Z`) + kinClockOffsetMs();
}

/**
 * The presence line's clock: wakes on the 15 s boundary only while `active`, so every reader of
 * one presence changes text on the same tick. Static in between; nothing repaints.
 */
export function useKinPresenceNow(active: boolean): number {
  const [now, setNow] = useState(() => kinNowMs());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer for the presence line's elapsed text
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const wait = KIN_PRESENCE_TICK_MS - (Date.now() % KIN_PRESENCE_TICK_MS);
      timer = setTimeout(() => {
        setNow(kinNowMs());
        schedule();
      }, wait);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [active]);
  return now;
}
