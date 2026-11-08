export const KIN_RETRY_BASE_MS = 5_000;
export const KIN_RETRY_MAX_MS = 60_000;

/**
 * Retries sends that failed while the host still reads as connected: 5 s, doubling, capped at a
 * minute. A reconnect starts over at 5 s; nothing is scheduled while the app is in the background.
 */
export function createKinOutboxRetry(options: {
  /** Delivers what's waiting; resolves true while a connected environment still has sends left. */
  readonly deliver: () => Promise<boolean>;
  readonly isForeground: () => boolean;
}) {
  let delay = KIN_RETRY_BASE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const run = async (): Promise<void> => {
    cancel();
    const stillWaiting = await options.deliver();
    if (!stillWaiting) {
      delay = KIN_RETRY_BASE_MS;
      return;
    }
    if (timer !== null || !options.isForeground()) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
    delay = Math.min(delay * 2, KIN_RETRY_MAX_MS);
  };

  return {
    /** Sends now, then backs off if anything is left. */
    run,
    /** An environment came back: start the backoff over. */
    reconnected: () => {
      delay = KIN_RETRY_BASE_MS;
      return run();
    },
    /** The app left the foreground. `run` again when it returns. */
    pause: cancel,
  };
}
