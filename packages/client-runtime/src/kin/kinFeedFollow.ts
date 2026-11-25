/**
 * Whether the chat feed follows its end, and where the "New messages" pill counts from. As in the
 * coding thread's timeline follow, only the person's own scroll lets go; the list's position
 * reports only bring following back once the person has left the end and returned.
 */
export interface KinFeedFollow {
  readonly following: boolean;
  /** Let go, and the list has since reported leaving the end; reaching it again follows. */
  readonly away: boolean;
  /** "Load earlier" is prepending a page; the list keeps the reader's place, even at the end. */
  readonly holding: boolean;
  /** The latest seq the reader has had on screen; later messages from others light the pill. */
  readonly seenSeq: number;
}

export type KinFeedFollowEvent =
  /** The list's own position report: after a layout, a late measure, a re-pin or a scroll. */
  | { readonly type: "end-check"; readonly isAtEnd: boolean }
  /** The person scrolled away from the end (wheel, touch, key, scrollbar). `seq`: the latest shown. */
  | { readonly type: "navigated"; readonly seq: number }
  /** Rows came on screen; `seq` is the latest they show. */
  | { readonly type: "seen"; readonly seq: number }
  | { readonly type: "page-start" }
  /** `added`: the page brought messages, so the reader now sits above them, not at the end. */
  | { readonly type: "page-settled"; readonly added: boolean }
  /** A touch began; it ends a page's hold without letting go of the end. */
  | { readonly type: "drag-begin" }
  | { readonly type: "jump-to-end" }
  /** The chat brings a message it was opened on into view; like a scroll, it lets go of the end. */
  | { readonly type: "land"; readonly seq?: number };

/** What the chat held when it opened counts as seen. */
export const initialKinFeedFollow = (latestSeq: number): KinFeedFollow => ({
  following: true,
  away: false,
  holding: false,
  seenSeq: latestSeq,
});

export const kinFollowsEnd = (state: KinFeedFollow) => state.following && !state.holding;

/** Following, and the list reads off its end: re-pin, since the list skips it during its opening scroll. */
export const kinRepinsEnd = (state: KinFeedFollow, isAtEnd: boolean) =>
  !isAtEnd && kinFollowsEnd(state);

/** Returns `state` itself when nothing changes, so scroll events cost no render. */
export function resolveKinFeedFollow(
  state: KinFeedFollow,
  event: KinFeedFollowEvent,
): KinFeedFollow {
  switch (event.type) {
    case "end-check":
      if (state.following) return state;
      if (event.isAtEnd) return state.away ? { ...state, following: true, away: false } : state;
      return state.away ? state : { ...state, away: true };
    case "navigated":
      if (!state.following && !state.holding) return state;
      return {
        ...state,
        following: false,
        away: state.following ? false : state.away,
        holding: false,
        seenSeq: state.following ? Math.max(state.seenSeq, event.seq) : state.seenSeq,
      };
    case "seen":
      return event.seq <= state.seenSeq ? state : { ...state, seenSeq: event.seq };
    case "page-start":
      return state.holding ? state : { ...state, holding: true };
    case "page-settled":
      if (!state.holding) return state;
      return event.added
        ? { ...state, holding: false, following: false, away: true }
        : { ...state, holding: false };
    case "drag-begin":
      return state.holding ? { ...state, holding: false } : state;
    case "land": {
      const seenSeq = event.seq === undefined ? state.seenSeq : Math.max(state.seenSeq, event.seq);
      return state.following || state.holding || seenSeq !== state.seenSeq
        ? { ...state, following: false, away: false, holding: false, seenSeq }
        : state;
    }
    case "jump-to-end":
      return kinFollowsEnd(state) && !state.away
        ? state
        : { ...state, following: true, away: false, holding: false };
  }
}
