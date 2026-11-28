import { describe, expect, it } from "vite-plus/test";

import { KinCanvasController } from "./kinCanvasController";

const leave = (key: string, move: (camera: KinCanvasController) => void) => {
  const camera = new KinCanvasController(key);
  camera.resize(1200, 800);
  move(camera);
  camera.dispose();
  return camera.camera;
};

describe("KinCanvasController", () => {
  it("comes back where the map was left, as Back from an opened page does", () => {
    const left = leave("studio:acme", (camera) => {
      camera.zoomAt(2.4, 900, 200);
      camera.panBy(120, -40);
    });
    const back = new KinCanvasController("studio:acme");
    expect(back.camera).toEqual(left);
    // Held, so the first sizing doesn't fit the overview over it.
    expect(back.touched).toBe(true);
  });

  it("keeps where a flight was headed when the map leaves mid-flight", () => {
    leave("studio:flight", (camera) => camera.flyTo({ x: 400, y: 300, scale: 1.5 }));
    expect(new KinCanvasController("studio:flight").camera).toEqual({ x: 400, y: 300, scale: 1.5 });
  });

  it("starts fresh for another company, or when nobody moved it", () => {
    leave("studio:acme", (camera) => camera.zoomAt(2));
    leave("studio:untouched", (camera) => camera.set({ x: 50, y: 50, scale: 0.4 }));
    for (const key of ["studio:other", "studio:untouched"]) {
      const camera = new KinCanvasController(key);
      expect(camera.touched, key).toBe(false);
      expect(camera.camera, key).toEqual({ x: 0, y: 0, scale: 1 });
    }
  });
});
