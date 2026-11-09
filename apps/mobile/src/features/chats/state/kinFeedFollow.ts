/** Whether the chat feed follows its end, and where the "New messages" pill counts from. */
export interface KinFeedFollow {
  readonly atEnd: boolean;
  /** "Load earlier" is prepending a page; the list keeps the reader's place, even at the end. */
  readonly holding: boolean;
  /** The latest seq the reader has had on screen; later messages from others light the pill. */
  readonly seenSeq: number;
}

export type KinFeedFollowEvent =
  | { readonly type: "end-check"; readonly isAtEnd: boolean }
  /** Rows came on screen; `seq` is the latest they show. */
  | { readonly type: "seen"; readonly seq: number }
  | { readonly type: "page-start" }
  /** `added`: the page brought messages, so the reader now sits above them, not at the end. */
  | { readonly type: "page-settled"; readonly added: boolean }
  | { readonly type: "drag-begin" }
  | { readonly type: "jump-to-end" };

/** What the chat held when it opened counts as seen. */
export const initialKinFeedFollow = (latestSeq: number): KinFeedFollow => ({
  atEnd: true,
  holding: false,
  seenSeq: latestSeq,
});

export const kinFollowsEnd = (state: KinFeedFollow) => state.atEnd && !state.holding;

/** Returns `state` itself when nothing changes, so scroll events cost no render. */
export function resolveKinFeedFollow(
  state: KinFeedFollow,
  event: KinFeedFollowEvent,
): KinFeedFollow {
  switch (event.type) {
    case "end-check":
      return event.isAtEnd === state.atEnd ? state : { ...state, atEnd: event.isAtEnd };
    case "seen":
      return event.seq <= state.seenSeq ? state : { ...state, seenSeq: event.seq };
    case "page-start":
      return state.holding ? state : { ...state, holding: true };
    case "page-settled":
      if (!state.holding && !event.added) return state;
      return { ...state, holding: false, atEnd: event.added ? false : state.atEnd };
    case "drag-begin":
      return state.holding ? { ...state, holding: false } : state;
    case "jump-to-end":
      return kinFollowsEnd(state) ? state : { ...state, atEnd: true, holding: false };
  }
}
