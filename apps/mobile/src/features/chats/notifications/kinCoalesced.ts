/**
 * `run` once at a time: a call while it runs asks for exactly one more pass after it, however many
 * calls came, so a trigger is never dropped and never piles up.
 */
export function kinCoalesced(run: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const go = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void run().finally(() => {
      running = false;
      if (!again) return;
      again = false;
      go();
    });
  };
  return go;
}
