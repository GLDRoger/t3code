import type { EnvironmentId } from "@t3tools/contracts";

import { formatWorkingTimerNow } from "../components/chat/TimelineWorkGroupRows.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { tickTextContent } from "../lib/tickTextContent";

/** The round red stop control the composer draws, for stopping a lead from its presence line. */
export function KinStopButton(props: {
  readonly disabled: boolean;
  readonly label: string;
  readonly tooltip: string;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none sm:size-7 [&_svg]:pointer-events-none"
            disabled={props.disabled}
            onClick={props.onClick}
            aria-label={props.label}
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** Elapsed time since `createdAt` on the host's clock, ticking without re-rendering. */
export function KinWorkingTimer(props: {
  readonly createdAt: string;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <span
      ref={tickTextContent(() => formatWorkingTimerNow(props.createdAt, props.environmentId), true)}
      className="tabular-nums"
    />
  );
}
