import {
  kinCanvasClampScale,
  kinCanvasPan,
  kinCanvasTween,
  kinCanvasTweenMs,
  kinCanvasZoom,
  type KinCanvasCamera,
} from "@t3tools/client-runtime/kin/kinCanvasCamera";

export type KinCanvasFrameListener = (
  camera: KinCanvasCamera,
  width: number,
  height: number,
) => void;

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * The canvas camera, outside React. Gestures and flights move it; at most once per frame it tells
 * its listeners, which write transforms straight onto the DOM. Nothing renders per frame, and no
 * frame is asked for while it is still.
 */
export class KinCanvasController {
  camera: KinCanvasCamera = { x: 0, y: 0, scale: 1 };
  width = 0;
  height = 0;
  /** False until a person moves it; until then a resize fits everything again. */
  touched = false;
  private flight: {
    from: KinCanvasCamera;
    to: KinCanvasCamera;
    start: number;
    ms: number;
  } | null = null;
  private frame = 0;
  private dirty = true;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<KinCanvasFrameListener>();
  private settleListeners = new Set<(camera: KinCanvasCamera) => void>();

  /** A moment after it stops moving: sharpen the text and rework detail. */
  settled(listener: (camera: KinCanvasCamera) => void) {
    this.settleListeners.add(listener);
    return () => {
      this.settleListeners.delete(listener);
    };
  }

  listen(listener: KinCanvasFrameListener) {
    this.listeners.add(listener);
    this.mark();
    return () => {
      this.listeners.delete(listener);
    };
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.mark();
  }

  set(camera: KinCanvasCamera) {
    this.flight = null;
    this.camera = { ...camera, scale: kinCanvasClampScale(camera.scale, this.width) };
    this.mark();
  }

  panBy(dx: number, dy: number) {
    this.touched = true;
    this.flight = null;
    this.camera = kinCanvasPan(this.camera, dx, dy);
    this.mark();
  }

  zoomAt(factor: number, sx = this.width / 2, sy = this.height / 2) {
    this.touched = true;
    this.flight = null;
    this.camera = kinCanvasZoom(this.camera, factor, sx, sy, this.width, this.height);
    this.mark();
  }

  flyTo(target: KinCanvasCamera) {
    this.touched = true;
    const to = { ...target, scale: kinCanvasClampScale(target.scale, this.width) };
    if (reducedMotion()) return this.set(to);
    this.flight = {
      from: this.camera,
      to,
      start: performance.now(),
      ms: kinCanvasTweenMs(this.camera, to),
    };
    this.mark();
  }

  dispose() {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.flight = null;
    clearTimeout(this.settleTimer);
    this.listeners.clear();
    this.settleListeners.clear();
  }

  /** Tell the listeners again next frame though nothing moved, as when cards are still mounting. */
  redraw() {
    this.mark();
  }

  private mark() {
    this.dirty = true;
    if (this.frame === 0 && typeof requestAnimationFrame !== "undefined")
      this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.frame = 0;
    if (this.flight !== null) {
      const k = Math.min(1, (now - this.flight.start) / this.flight.ms);
      this.camera = kinCanvasTween(this.flight.from, this.flight.to, k);
      if (k >= 1) this.flight = null;
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      for (const listener of this.listeners) listener(this.camera, this.width, this.height);
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        for (const listener of this.settleListeners) listener(this.camera);
      }, 180);
    }
    if (this.flight !== null) this.frame = requestAnimationFrame(this.tick);
  };
}

/**
 * Pan and zoom. Wheel or two-finger scroll pans, pinch or Ctrl/⌘ + wheel zooms toward the pointer,
 * dragging empty canvas pans, two touches pinch. A press becomes a drag only past a few pixels, so
 * cards stay clickable.
 */
export function attachKinCanvasGestures(
  el: HTMLElement,
  camera: KinCanvasController,
  canPan: (target: HTMLElement) => boolean,
) {
  const onWheel = (event: WheelEvent) => {
    if ((event.target as HTMLElement).closest("[data-canvas-control]")) return;
    event.preventDefault();
    const rect = el.getBoundingClientRect();
    const unit = event.deltaMode === 1 ? 16 : 1;
    if (event.ctrlKey || event.metaKey) {
      const d = Math.max(-60, Math.min(60, event.deltaY * unit));
      camera.zoomAt(Math.exp(-d * 0.0075), event.clientX - rect.left, event.clientY - rect.top);
    } else camera.panBy(-event.deltaX * unit, -event.deltaY * unit);
  };
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: number | null = null;
  let origin: { x: number; y: number } | null = null;
  let dragging = false;
  const onDown = (event: PointerEvent) => {
    if (!canPan(event.target as HTMLElement)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    origin = { x: event.clientX, y: event.clientY };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      dragging = true;
    }
  };
  const onMove = (event: PointerEvent) => {
    const prev = pointers.get(event.pointerId);
    if (prev === undefined) return;
    const next = { x: event.clientX, y: event.clientY };
    if (!dragging && origin !== null && Math.hypot(next.x - origin.x, next.y - origin.y) > 4) {
      dragging = true;
      el.setPointerCapture?.(event.pointerId);
      el.dataset.panning = "";
    }
    pointers.set(event.pointerId, next);
    if (!dragging) return;
    if (pointers.size >= 2 && pinch !== null) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const rect = el.getBoundingClientRect();
      camera.zoomAt(d / pinch, (a!.x + b!.x) / 2 - rect.left, (a!.y + b!.y) / 2 - rect.top);
      pinch = d;
    } else camera.panBy(next.x - prev.x, next.y - prev.y);
  };
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  const onUp = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    if (pointers.size > 0) return;
    if (dragging) {
      // The click that ends a pan isn't a click on whatever is under it.
      el.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), 0);
    }
    dragging = false;
    origin = null;
    delete el.dataset.panning;
  };
  // Safari's own pinch would zoom the page; the canvas zooms instead.
  const onGesture = (event: Event) => event.preventDefault();
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("gesturestart", onGesture);
  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("gesturestart", onGesture);
  };
}
