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
  from: KinFeedFollow = initialKinFeedFollow,
) => events.reduce(resolveKinFeedFollow, from);

describe("resolveKinFeedFollow", () => {
  it("remembers the latest seq when the reader leaves the end, and follows again at the end", () => {
    const away = run([{ type: "end-check", isAtEnd: false, latestSeq: 40 }]);
    expect(away).toEqual({ atEnd: false, holding: false, seenSeq: 40 });
    expect(kinFollowsEnd(away)).toBe(false);
    // Scrolling further away keeps the seq it left at.
    expect(run([{ type: "end-check", isAtEnd: false, latestSeq: 45 }], away)).toBe(away);
    expect(kinFollowsEnd(run([{ type: "end-check", isAtEnd: true, latestSeq: 45 }], away))).toBe(
      true,
    );
  });

  it("holds the place through a page at the end, then lets go whether it loaded or failed", () => {
    const loading = run([{ type: "page-start", latestSeq: 50 }]);
    expect(kinFollowsEnd(loading)).toBe(false);
    // New messages during the load count from where follow stopped.
    expect(loading.seenSeq).toBe(50);

    const failed = run([{ type: "page-settled", added: false }], loading);
    expect(failed.holding).toBe(false);
    expect(kinFollowsEnd(failed)).toBe(true);

    // A prepended page leaves the reader above the end, so follow stays off without a jump.
    const loaded = run([{ type: "page-settled", added: true }], loading);
    expect(loaded).toEqual({ atEnd: false, holding: false, seenSeq: 50 });
  });

  it("a drag lets go of the hold, and the pill's jump follows the end again", () => {
    const loading = run([{ type: "page-start", latestSeq: 50 }]);
    expect(run([{ type: "drag-begin" }], loading).holding).toBe(false);
    const away = run([{ type: "end-check", isAtEnd: false, latestSeq: 50 }], loading);
    expect(kinFollowsEnd(run([{ type: "jump-to-end" }], away))).toBe(true);
  });

  it("returns the same state when nothing changes, so scroll events don't re-render", () => {
    expect(run([{ type: "end-check", isAtEnd: true, latestSeq: 9 }])).toBe(initialKinFeedFollow);
    expect(run([{ type: "drag-begin" }])).toBe(initialKinFeedFollow);
    expect(run([{ type: "jump-to-end" }])).toBe(initialKinFeedFollow);
  });
});
