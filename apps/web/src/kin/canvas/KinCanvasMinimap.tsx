import { kinCanvasVisible } from "@t3tools/client-runtime/kin/kinCanvasCamera";
import type { KinCanvasLayout } from "@t3tools/client-runtime/kin/kinCanvasLayout";
import { KIN_CANVAS } from "@t3tools/client-runtime/kin/kinCanvasView";
import { useEffect, useRef } from "react";

import type { KinCanvasController } from "./kinCanvasController";

const W = 168;
const H = 112;
const PAD = 120;

/** The whole canvas small, with the part on screen outlined; a click goes there. */
export function KinCanvasMinimap(props: {
  readonly controller: KinCanvasController;
  readonly layout: KinCanvasLayout;
}) {
  const { controller, layout } = props;
  const frame = useRef<SVGRectElement | null>(null);
  const b = layout.bounds;
  const box = { x: b.x - PAD, y: b.y - PAD, w: b.w + PAD * 2, h: b.h + PAD * 2 };
  const scale = Math.min(W / box.w, H / box.h);
  const ox = (W - box.w * scale) / 2;
  const oy = (H - box.h * scale) / 2;
  const sx = (x: number) => ox + (x - box.x) * scale;
  const sy = (y: number) => oy + (y - box.y) * scale;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the outline of what is on screen with the camera, which lives outside React
  useEffect(
    () =>
      controller.listen((camera, width, height) => {
        const rect = frame.current;
        if (rect === null) return;
        const seen = kinCanvasVisible(camera, width, height);
        rect.setAttribute("x", String(ox + (seen.x - box.x) * scale));
        rect.setAttribute("y", String(oy + (seen.y - box.y) * scale));
        rect.setAttribute("width", String(Math.max(4, seen.w * scale)));
        rect.setAttribute("height", String(Math.max(4, seen.h * scale)));
      }),
    [controller, ox, oy, scale, box.x, box.y],
  );

  return (
    <svg
      data-canvas-control=""
      role="button"
      tabIndex={-1}
      aria-label={KIN_CANVAS.minimap}
      width={W}
      height={H}
      className="absolute right-3 bottom-3 cursor-pointer rounded-lg border bg-popover shadow-sm"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        controller.flyTo({
          x: box.x + (event.clientX - rect.left - ox) / scale,
          y: box.y + (event.clientY - rect.top - oy) / scale,
          scale: controller.camera.scale,
        });
      }}
    >
      {layout.groups.map((group) => (
        <rect
          key={group.key ?? "none"}
          x={sx(group.x)}
          y={sy(group.y)}
          width={group.w * scale}
          height={group.h * scale}
          rx={2}
          className="fill-muted stroke-border"
          strokeWidth={0.5}
        />
      ))}
      <rect ref={frame} rx={2} className="fill-primary/10 stroke-primary" strokeWidth={1.25} />
    </svg>
  );
}
