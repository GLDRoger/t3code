import { describe, expect, it } from "vite-plus/test";

import {
  initialKinFeedFollow,
  kinFollowsEnd,
  kinRepinsEnd,
  resolveKinFeedFollow,
  type KinFeedFollow,
  type KinFeedFollowEvent,
} from "./kinFeedFollow.ts";

const run = (
  events: ReadonlyArray<KinFeedFollowEvent>,
  from: KinFeedFollow = initialKinFeedFollow(40),
) => events.reduce(resolveKinFeedFollow, from);

const left = { type: "end-check", isAtEnd: false } as const;
const reached = { type: "end-check", isAtEnd: true } as const;
const landed = { type: "land" } as const;
const scrolled = (seq = 40) => ({ type: "navigated", seq }) as const;

describe("resolveKinFeedFollow", () => {
  it.each<{ name: string; events: ReadonlyArray<KinFeedFollowEvent>; follows: boolean }>([
    // A chat opened fresh follows until the person scrolls; the list's own reports can't let go.
    { name: "opened", events: [], follows: true },
    { name: "a layout or late measure reads off the end", events: [left], follows: true },
    { name: "off the end, then re-pinned", events: [left, reached, left], follows: true },
    {
      name: "a page added nothing",
      events: [{ type: "page-start" }, left, { type: "page-settled", added: false }],
      follows: true,
    },
    { name: "the person scrolled", events: [scrolled()], follows: false },
    { name: "the person scrolled and left the end", events: [scrolled(), left], follows: false },
    {
      name: "the person scrolled back to the end",
      events: [scrolled(), left, reached],
      follows: true,
    },
    // The scroll's own frame can still read the end before the list moves.
    {
      name: "the person scrolled; the list still reads the end",
      events: [scrolled(), reached],
      follows: false,
    },
    { name: "the pill's jump", events: [scrolled(), left, { type: "jump-to-end" }], follows: true },
    {
      name: "a prepended page leaves the reader above",
      events: [{ type: "page-start" }, { type: "page-settled", added: true }],
      follows: false,
    },
    {
      name: "above a prepended page, back at the end",
      events: [{ type: "page-start" }, { type: "page-settled", added: true }, reached],
      follows: true,
    },
    // Opened on a card above the end: the end's re-pin must not take the reader back down.
    { name: "opened on a card", events: [landed], follows: false },
    { name: "opened on a card; the list still reads the end", events: [landed, reached], follows: false },
    { name: "opened on a card, then back at the end", events: [landed, left, reached], follows: true },
  ])("$name → follows $follows", ({ events, follows }) => {
    expect(kinFollowsEnd(run(events))).toBe(follows);
  });

  it("re-pins a following list that reads off its end, never one the person scrolled away", () => {
    expect(kinRepinsEnd(run([left]), false)).toBe(true);
    expect(kinRepinsEnd(run([left]), true)).toBe(false);
    expect(kinRepinsEnd(run([scrolled()]), false)).toBe(false);
    expect(kinRepinsEnd(run([{ type: "page-start" }]), false)).toBe(false);
    expect(kinRepinsEnd(run([left, landed]), false)).toBe(false);
  });

  it("counts only messages that arrive after the person scrolled away", () => {
    // Opened on seq 40; 41-49 arrive while it follows, then the person scrolls up.
    const away = run([left, scrolled(49), left]);
    expect(away.seenSeq).toBe(49);
    expect(run([{ type: "seen", seq: 12 }], away)).toBe(away);
    expect(run([{ type: "seen", seq: 52 }], away).seenSeq).toBe(52);
  });

  it("holds the place through a page at the end, and a drag lets go of the hold", () => {
    const loading = run([{ type: "page-start" }]);
    expect(kinFollowsEnd(loading)).toBe(false);
    expect(kinFollowsEnd(run([{ type: "drag-begin" }], loading))).toBe(true);
    expect(kinFollowsEnd(run([scrolled()], loading))).toBe(false);
  });

  it("returns the same state when nothing changes, so scroll events don't re-render", () => {
    const start = initialKinFeedFollow(9);
    expect(run([reached], start)).toBe(start);
    expect(run([left], start)).toBe(start);
    expect(run([{ type: "drag-begin" }], start)).toBe(start);
    expect(run([{ type: "jump-to-end" }], start)).toBe(start);
    expect(run([{ type: "seen", seq: 9 }], start)).toBe(start);
    const away = run([scrolled(9), left], start);
    expect(run([left], away)).toBe(away);
    expect(run([scrolled(9)], away)).toBe(away);
  });
});
