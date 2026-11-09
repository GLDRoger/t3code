import { describe, expect, it } from "vite-plus/test";

import {
  initialKinFeedFollow,
  kinFollowsEnd,
  resolveKinFeedFollow,
  type KinFeedFollow,
  type KinFeedFollowEvent,
} from "./kinFeedFollow";

const run = (
  events: ReadonlyArray<KinFeedFollowEvent>,
  from: KinFeedFollow = initialKinFeedFollow(40),
) => events.reduce(resolveKinFeedFollow, from);

describe("resolveKinFeedFollow", () => {
  it("counts from the latest seq the reader had on screen, and follows again at the end", () => {
    const away = run([{ type: "end-check", isAtEnd: false }]);
    expect(away).toEqual({ atEnd: false, holding: false, seenSeq: 40 });
    expect(kinFollowsEnd(away)).toBe(false);
    // Scrolling further away changes nothing.
    expect(run([{ type: "end-check", isAtEnd: false }], away)).toBe(away);
    expect(kinFollowsEnd(run([{ type: "end-check", isAtEnd: true }], away))).toBe(true);
  });

  it("keeps a message unseen until it comes on screen, even one that arrived before the reader left", () => {
    // Seq 41 arrives in a reconnect backlog, below the screen, before the reader scrolls up.
    const away = run([{ type: "end-check", isAtEnd: false }]);
    expect(away.seenSeq).toBe(40);
    const seen = run([{ type: "seen", seq: 41 }], away);
    expect(seen.seenSeq).toBe(41);
    // An older row coming back on screen doesn't move it back.
    expect(run([{ type: "seen", seq: 12 }], seen)).toBe(seen);
  });

  it("holds the place through a page at the end, then lets go whether it loaded or failed", () => {
    const loading = run([{ type: "page-start" }]);
    expect(kinFollowsEnd(loading)).toBe(false);

    const failed = run([{ type: "page-settled", added: false }], loading);
    expect(failed.holding).toBe(false);
    expect(kinFollowsEnd(failed)).toBe(true);

    // A prepended page leaves the reader above the end, so follow stays off without a jump.
    const loaded = run([{ type: "page-settled", added: true }], loading);
    expect(loaded).toEqual({ atEnd: false, holding: false, seenSeq: 40 });
  });

  it("a drag lets go of the hold, and the pill's jump follows the end again", () => {
    const loading = run([{ type: "page-start" }]);
    expect(run([{ type: "drag-begin" }], loading).holding).toBe(false);
    const away = run([{ type: "end-check", isAtEnd: false }], loading);
    expect(kinFollowsEnd(run([{ type: "jump-to-end" }], away))).toBe(true);
  });

  it("returns the same state when nothing changes, so scroll events don't re-render", () => {
    const start = initialKinFeedFollow(9);
    expect(run([{ type: "end-check", isAtEnd: true }], start)).toBe(start);
    expect(run([{ type: "drag-begin" }], start)).toBe(start);
    expect(run([{ type: "jump-to-end" }], start)).toBe(start);
    expect(run([{ type: "seen", seq: 9 }], start)).toBe(start);
  });
});
