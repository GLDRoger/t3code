import { expect, it, vi } from "vite-plus/test";

import { reloadOnceForChunkLoadError } from "./chunkReloadGuard";

it("reloads once per deployed build, though deploys share the app version", () => {
  const reload = vi.fn();
  const entry = document.createElement("script");
  entry.type = "module";
  entry.src = "/assets/index-0ldBu1ld.js";
  document.head.prepend(entry);
  try {
    window.sessionStorage.clear();
    expect(reloadOnceForChunkLoadError(undefined, reload)).toBe(true);
    expect(reloadOnceForChunkLoadError(undefined, reload)).toBe(false);
    entry.src = "/assets/index-N3wBu1ld.js";
    expect(reloadOnceForChunkLoadError(undefined, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  } finally {
    entry.remove();
    window.sessionStorage.clear();
  }
});
