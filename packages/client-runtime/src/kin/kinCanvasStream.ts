import type { KinCanvasEvent, KinCanvasInput, KinCanvasRead } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { subscribe } from "../rpc/index.ts";
import { resubscribeWhenKinReturns, retryWhileKinUnavailable } from "./kinStreams.ts";

export const KIN_CANVAS_LIVE_LABEL = "kin:canvas:live";

/** The held canvas after one event from `kin.canvas.subscribe`. */
export function kinCanvasApply(
  held: KinCanvasRead | null,
  event: KinCanvasEvent,
): KinCanvasRead | null {
  if (event._tag === "snapshot") return event.read;
  if (held === null) return null;
  switch (event._tag) {
    case "placed": {
      const moved = new Map(event.places.map((place) => [place.key, place]));
      return {
        ...held,
        places: [...held.places.filter((place) => !moved.has(place.key)), ...event.places],
      };
    }
    case "unplaced": {
      const gone = new Set<string>(event.keys);
      return { ...held, places: held.places.filter((place) => !gone.has(place.key)) };
    }
    case "widget": {
      const at = held.widgets.findIndex((widget) => widget.id === event.widget.id);
      const widgets =
        at < 0
          ? [...held.widgets, event.widget]
          : held.widgets.map((widget, i) => (i === at ? event.widget : widget));
      return { ...held, widgets };
    }
    case "widgetRemoved":
      return {
        ...held,
        widgets: held.widgets.filter((widget) => widget.id !== event.id),
        places: held.places.filter((place) => place.key !== event.id),
      };
    case "activity":
      return { ...held, activity: event.activity };
  }
}

/**
 * The canvas as the host keeps it: the read whole, then each move, widget and agent change. Its
 * cards' entries come from Work's and Docs' own streams.
 */
export function kinCanvasLiveStream(input: KinCanvasInput) {
  return Stream.suspend(() => {
    let held: KinCanvasRead | null = null;
    return resubscribeWhenKinReturns(
      retryWhileKinUnavailable(subscribe("kin.canvas.subscribe", input)),
      Stream.empty,
      Stream.empty,
    ).pipe(
      Stream.map((event) => (held = kinCanvasApply(held, event))),
      Stream.filter((read): read is KinCanvasRead => read !== null),
    );
  });
}
