import { KIN_SETTINGS_COPY } from "@t3tools/client-runtime/kin/kinSettingsSpread";
import { ArrowLeftIcon } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "../../components/ui/button";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../../components/WorkspaceBreadcrumb";

/** Where a drill-in page puts its back arrow and its name in the Settings modal's header. */
export interface KinSettingsTrailSlots {
  readonly back: HTMLElement | null;
  readonly trail: HTMLElement | null;
  /** The modal's scroller, so a drill-in page opens at its top. */
  readonly scroller: HTMLElement | null;
}

export const KinSettingsTrail = createContext<KinSettingsTrailSlots | null>(null);

/**
 * One thing's own page inside a Settings page: it replaces the page's whole content, opens at the
 * top, adds its name to the header's trail, and has one way back, the arrow before the trail.
 * Outside the modal (an old settings address) it carries its own back and title.
 * @public An account's page on Connections is its first caller (web-settings-patterns.md).
 */
export function KinSettingsSubpage(props: {
  readonly title: string;
  /** The page it returns to, for the arrow's label: "Connections". */
  readonly backTo: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  const slots = useContext(KinSettingsTrail);
  const back = (
    <Button
      size="icon-sm"
      variant="ghost"
      data-kin-settings-back
      aria-label={`${KIN_SETTINGS_COPY.back} to ${props.backTo}`}
      onClick={props.onBack}
    >
      <ArrowLeftIcon />
    </Button>
  );
  const top = (node: HTMLDivElement | null) => {
    if (node !== null) slots?.scroller?.scrollTo({ top: 0 });
  };
  return (
    <div ref={top} className="contents">
      {slots?.back == null ? null : createPortal(back, slots.back)}
      {slots?.trail == null
        ? null
        : createPortal(
            <>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>
                <span className="truncate">{props.title}</span>
              </WorkspaceBreadcrumbItem>
            </>,
            slots.trail,
          )}
      {slots === null ? (
        <div className="mx-auto flex w-full max-w-2xl items-center gap-2 px-4 pt-6 sm:px-6">
          {back}
          <h2 className="truncate text-base font-semibold text-foreground">{props.title}</h2>
        </div>
      ) : null}
      {props.children}
    </div>
  );
}
