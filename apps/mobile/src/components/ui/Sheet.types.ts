import type { ReactNode } from "react";

export interface SheetProps {
  /** The header's title; a `plain` sheet has no header and VoiceOver reads this as its name. */
  readonly title: string;
  /**
   * `titled` (default): a header with the title and a close button, half to full height.
   * `plain`: a grab handle only, sized to its content, for short action sheets.
   */
  readonly variant?: "titled" | "plain";
  readonly children: ReactNode;
  readonly onClose: () => void;
  /** Blocks the close button and the swipe, such as while a submit is in flight. */
  readonly dismissDisabled?: boolean;
}
