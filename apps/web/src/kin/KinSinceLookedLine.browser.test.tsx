import { describe, expect, it, vi } from "vite-plus/test";

import { scrollIntoViewRespectingMotion } from "./KinSinceLookedLine";

const box = (tag: string, css: string) => {
  const element = document.createElement(tag);
  element.style.cssText = css;
  return element;
};

const mounted = (element: HTMLElement) => {
  document.body.append(element);
  return { [Symbol.dispose]: () => element.remove() };
};

describe("scrollIntoViewRespectingMotion", () => {
  it("moves only the section's own scroller, never the clipped page around it", () => {
    using _reduced = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue({ matches: true } as MediaQueryList);
    // The app shell: a clipped frame whose content runs past it, holding the sheet's scroller.
    const frame = box("main", "height: 300px; overflow: hidden");
    const scroller = box("div", "height: 300px; overflow-y: auto");
    // The section sits near the scroller's end, so the scroller alone can't bring it to the top.
    const section = box("section", "height: 100px");
    scroller.append(box("div", "height: 500px"), section);
    frame.append(scroller, box("div", "height: 200px"));
    using _frame = mounted(frame);

    scrollIntoViewRespectingMotion(section);

    expect(scroller.scrollTop).toBe(300);
    expect(frame.scrollTop).toBe(0);
  });
});
