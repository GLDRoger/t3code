/** Whether the chat feed follows its end, and where the "New messages" pill counts from. */
export interface KinFeedFollow {
  readonly atEnd: boolean;
  /** "Load earlier" is prepending a page; the list keeps the reader's place, even at the end. */
  readonly holding: boolean;
  /** The latest seq when follow stopped; later messages from others light the pill. */
  readonly seenSeq: number;
}

export type KinFeedFollowEvent =
  | { readonly type: "end-check"; readonly isAtEnd: boolean; readonly latestSeq: number }
  | { readonly type: "page-start"; readonly latestSeq: number }
  /** `added`: the page brought messages, so the reader now sits above them, not at the end. */
  | { readonly type: "page-settled"; readonly added: boolean }
  | { readonly type: "drag-begin" }
  | { readonly type: "jump-to-end" };

export const initialKinFeedFollow: KinFeedFollow = { atEnd: true, holding: false, seenSeq: 0 };

export const kinFollowsEnd = (state: KinFeedFollow) => state.atEnd && !state.holding;

/** Returns `state` itself when nothing changes, so scroll events cost no render. */
export function resolveKinFeedFollow(
  state: KinFeedFollow,
  event: KinFeedFollowEvent,
): KinFeedFollow {
  switch (event.type) {
    case "end-check":
      if (event.isAtEnd === state.atEnd) return state;
      return {
        ...state,
        atEnd: event.isAtEnd,
        seenSeq: kinFollowsEnd(state) ? event.latestSeq : state.seenSeq,
      };
    case "page-start":
      return {
        ...state,
        holding: true,
        seenSeq: kinFollowsEnd(state) ? event.latestSeq : state.seenSeq,
      };
    case "page-settled":
      if (!state.holding && !event.added) return state;
      return { ...state, holding: false, atEnd: event.added ? false : state.atEnd };
    case "drag-begin":
      return state.holding ? { ...state, holding: false } : state;
    case "jump-to-end":
      return kinFollowsEnd(state) ? state : { ...state, atEnd: true, holding: false };
  }
}
