import { describe, expect, it, vi } from "vite-plus/test";

import { createKinOutboxRetry } from "./kinOutboxRetry";

function setup() {
  vi.useFakeTimers();
  let waiting = true;
  let foreground = true;
  let attempts = 0;
  const retry = createKinOutboxRetry({
    deliver: async () => {
      attempts++;
      return waiting;
    },
    isForeground: () => foreground,
  });
  /** Asserts the next attempt lands exactly `ms` after the last one. */
  const expectNextAfter = async (ms: number) => {
    const before = attempts;
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(attempts).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(before + 1);
  };
  return {
    retry,
    expectNextAfter,
    attempts: () => attempts,
    setWaiting: (value: boolean) => void (waiting = value),
    setForeground: (value: boolean) => void (foreground = value),
    [Symbol.dispose]: () => void vi.useRealTimers(),
  };
}

describe("createKinOutboxRetry", () => {
  it("backs off from 5 s, doubling up to a minute, and starts over on reconnect", async () => {
    using t = setup();
    await t.retry.run();
    for (const ms of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) await t.expectNextAfter(ms);

    await t.retry.reconnected();
    await t.expectNextAfter(5_000);
    await t.expectNextAfter(10_000);
  });

  it("stops once nothing waits, and schedules nothing in the background", async () => {
    using t = setup();
    await t.retry.run();
    t.setWaiting(false);
    await t.expectNextAfter(5_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.attempts()).toBe(2);

    t.setWaiting(true);
    t.setForeground(false);
    await t.retry.run();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.attempts()).toBe(3);

    // Back in the foreground: send at once and resume from 5 s, until the app leaves again.
    t.setForeground(true);
    await t.retry.run();
    expect(t.attempts()).toBe(4);
    t.retry.pause();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.attempts()).toBe(4);
  });
});
