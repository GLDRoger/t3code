export const KIN_RETRY_BASE_MS = 5_000;
export const KIN_RETRY_MAX_MS = 60_000;

/**
 * Retries sends that failed while the host still reads as connected: 5 s, doubling, capped at a
 * minute. Only a failed retry grows the wait, so queuing more sends doesn't. A new connected
 * session sends at once and starts over at 5 s; nothing is scheduled in the background.
 */
export function createKinOutboxRetry(options: {
  /** Delivers what's waiting; resolves true while a connected environment still has sends left. */
  readonly deliver: () => Promise<boolean>;
  readonly isForeground: () => boolean;
}) {
  let delay = KIN_RETRY_BASE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sessions: ReadonlySet<string> = new Set();

  const cancel = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const attempt = async (retrying: boolean): Promise<void> => {
    cancel();
    const stillWaiting = await options.deliver();
    if (!stillWaiting) {
      delay = KIN_RETRY_BASE_MS;
      return;
    }
    if (retrying) delay = Math.min(delay * 2, KIN_RETRY_MAX_MS);
    if (timer !== null || !options.isForeground()) return;
    timer = setTimeout(() => {
      timer = null;
      void attempt(true);
    }, delay);
  };

  const restart = () => {
    delay = KIN_RETRY_BASE_MS;
    return attempt(false);
  };

  return {
    /** Sends now, then retries with the current wait if anything is left. */
    run: () => attempt(false),
    /**
     * The connected sessions, one key per environment and session. A key not seen before is a
     * host that came back, so sends go out at once with the wait reset.
     */
    sessionsChanged: (next: ReadonlySet<string>): Promise<void> => {
      const fresh = [...next].some((key) => !sessions.has(key));
      sessions = next;
      return fresh ? restart() : Promise.resolve();
    },
    /** The app came back to the foreground. */
    resume: restart,
    /** The app left the foreground. `resume` when it returns. */
    pause: cancel,
  };
}
