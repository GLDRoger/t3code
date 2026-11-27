import type { KinSinceLookedView } from "@t3tools/client-runtime/kin/kinSinceLooked";
import { HistoryIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { observeResize } from "../lib/observeResize";
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
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [fit, setFit] = useState<{ readonly forText: string; readonly index: number }>({
    forText: "",
    index: 0,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures rendered variants against two lines so narrow widths drop trailing fragments instead of clamping mid-word
  useLayoutEffect(() => {
    const node = textRef.current;
    if (view === null || node === null || view.variants.length <= 1) return;
    const measure = () => {
      if (node.clientWidth === 0) return;
      const style = getComputedStyle(node);
      const parsed = Number.parseFloat(style.lineHeight);
      const lineHeight = Number.isFinite(parsed)
        ? parsed
        : (Number.parseFloat(style.fontSize) || 12) * 1.4;
      const maxHeight = lineHeight * 2 + 1;
      const current = node.textContent ?? "";
      let chosen = view.variants.length - 1;
      for (let i = 0; i < view.variants.length; i += 1) {
        const candidate = view.variants[i]!;
        if (node.textContent !== candidate) node.textContent = candidate;
        if (node.getBoundingClientRect().height <= maxHeight) {
          chosen = i;
          break;
        }
      }
      if (node.textContent !== current) node.textContent = current;
      setFit((prev) =>
        prev.forText === view.text && prev.index === chosen
          ? prev
          : { forText: view.text, index: chosen },
      );
    };
    measure();
    return observeResize(node, measure);
  }, [view]);

  if (view === null) return null;
  const shown = fit.forText === view.text ? (view.variants[fit.index] ?? view.text) : view.text;
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
      <span ref={textRef} className="min-w-0 flex-1 text-pretty wrap-break-word">
        {shown}
      </span>
    </button>
  );
}
