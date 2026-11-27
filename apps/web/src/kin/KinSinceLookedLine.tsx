import type { KinSinceLookedView } from "@t3tools/client-runtime/kin/kinSinceLooked";
import { HistoryIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { cn } from "../lib/utils";

const subscribeVisibility = (onChange: () => void) => {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};

const readVisibility = () =>
  typeof document === "undefined" ? true : document.visibilityState === "visible";

/** True while this tab is visible to the person, never during a hidden background refresh. */
export function useKinPageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, readVisibility, () => true);
}

/**
 * Scrolls an element's own scroller to it, turning smooth scrolling off when reduced motion is asked
 * for. Only that scroller moves: `scrollIntoView` also shifts the clipped app frame around it.
 */
export function scrollIntoViewRespectingMotion(node: HTMLElement | null) {
  if (node === null) return;
  let scroller = node.parentElement;
  while (
    scroller !== null &&
    (scroller.scrollHeight <= scroller.clientHeight ||
      !/auto|scroll/.test(getComputedStyle(scroller).overflowY))
  )
    scroller = scroller.parentElement;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const behavior = reduced ? "auto" : "smooth";
  const top = node.getBoundingClientRect().top;
  if (scroller === null) window.scrollBy({ top, behavior });
  else scroller.scrollBy({ top: top - scroller.getBoundingClientRect().top, behavior });
}

/**
 * One quiet secondary-text button at the top of a task, list entry, doc or project saying what
 * changed since the person last looked. Absent when nothing qualifies.
 */
export function KinSinceLookedLine(props: {
  readonly view: KinSinceLookedView | null;
  readonly onOpen: () => void;
  readonly className?: string;
}) {
  const { view } = props;
  if (view === null) return null;
  return (
    <button
      type="button"
      data-slot="kin-since-looked"
      aria-label={view.accessibilityLabel}
      onClick={props.onOpen}
      className={cn(
        "flex w-full items-start gap-1.5 rounded-sm py-0.5 text-start text-xs text-muted-foreground outline-none ring-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset",
        props.className,
      )}
    >
      <HistoryIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="line-clamp-2 min-w-0 flex-1 text-pretty wrap-break-word">{view.text}</span>
    </button>
  );
}
