import {
  kinCanvasClampScale,
  kinCanvasTweenMs,
  kinCanvasZoom,
  type KinCanvasCamera,
} from "@t3tools/client-runtime/kin/kinCanvasCamera";
import { useState } from "react";
import {
  cancelAnimation,
  Easing,
  ReduceMotion,
  runOnJS,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

/** Where each person left each company's canvas this session, for Back from a card they opened. */
const heldCameras = new Map<string, KinCanvasCamera>();

const EASE = Easing.inOut(Easing.cubic);

/**
 * The camera as shared values the UI thread moves: the canvas point at the middle of the
 * viewport, and points per canvas unit. JS reads it only when a gesture or flight settles.
 */
export function useCanvasCamera(
  key: string,
  reduceMotion: boolean,
  onSettle: (camera: KinCanvasCamera) => void,
) {
  const [held] = useState(() => heldCameras.get(key) ?? null);
  const x = useSharedValue(held?.x ?? 0);
  const y = useSharedValue(held?.y ?? 0);
  const scale = useSharedValue(held?.scale ?? 1);
  const width = useSharedValue(0);
  const height = useSharedValue(0);

  const get = (): KinCanvasCamera => ({ x: x.get(), y: y.get(), scale: scale.get() });
  const keep = () => heldCameras.set(key, get());
  const settled = () => {
    keep();
    onSettle(get());
  };
  const stop = () => {
    cancelAnimation(x);
    cancelAnimation(y);
    cancelAnimation(scale);
  };
  const set = (camera: KinCanvasCamera) => {
    stop();
    x.set(camera.x);
    y.set(camera.y);
    scale.set(kinCanvasClampScale(camera.scale));
    settled();
  };
  const flyTo = (target: KinCanvasCamera) => {
    const to = { ...target, scale: kinCanvasClampScale(target.scale) };
    if (reduceMotion) return set(to);
    stop();
    const timing = {
      duration: kinCanvasTweenMs(get(), to),
      easing: EASE,
      reduceMotion: ReduceMotion.System,
    };
    x.set(withTiming(to.x, timing));
    y.set(withTiming(to.y, timing));
    scale.set(
      withTiming(to.scale, timing, (finished) => {
        if (finished) runOnJS(settled)();
      }),
    );
  };
  const zoomBy = (factor: number) =>
    flyTo(
      kinCanvasZoom(get(), factor, width.get() / 2, height.get() / 2, width.get(), height.get()),
    );

  return { x, y, scale, width, height, held: held !== null, get, set, flyTo, zoomBy, settled };
}

export type CanvasCamera = ReturnType<typeof useCanvasCamera>;
