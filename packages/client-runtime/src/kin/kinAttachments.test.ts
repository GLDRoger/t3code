import type { KinAttachment } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { createKinLocalPreviews, kinLocalImageUrls } from "./kinAttachments.ts";

const attachment = (type: "image" | "file", id: string): KinAttachment => ({
  type,
  id,
  name: `${id}.${type === "image" ? "png" : "txt"}`,
  mimeType: type === "image" ? "image/png" : "text/plain",
  sizeBytes: 3,
});

it("pairs a message's images with this device's copies in order, under either id", () => {
  const copies = ["blob:a", "blob:b"];
  const sending = [attachment("image", "pending-1"), attachment("file", "pending-2")];
  const posted = [
    attachment("file", "claimed-2"),
    attachment("image", "claimed-1"),
    attachment("image", "claimed-3"),
  ];
  expect([...kinLocalImageUrls(sending, copies)]).toEqual([["pending-1", "blob:a"]]);
  expect([...kinLocalImageUrls(posted, copies)]).toEqual([
    ["claimed-1", "blob:a"],
    ["claimed-3", "blob:b"],
  ]);
  expect(kinLocalImageUrls(posted, undefined).size).toBe(0);
});

it("frees each copy once, when its message no longer needs it", () => {
  const release = vi.fn<(url: string) => void>();
  const previews = createKinLocalPreviews(release);
  const changed = vi.fn();
  const unsubscribe = previews.subscribe(changed);
  previews.remember("sent", ["blob:a", "blob:b"]);
  expect(previews.get("sent")).toEqual(["blob:a", "blob:b"]);
  previews.remember("sent", ["blob:b"]);
  expect(release.mock.calls).toEqual([["blob:a"]]);
  previews.forget("sent");
  previews.forget("sent");
  expect(release.mock.calls).toEqual([["blob:a"], ["blob:b"]]);
  expect(previews.get("sent")).toBeUndefined();
  expect(changed).toHaveBeenCalledTimes(3);
  unsubscribe();
  previews.remember("other", ["blob:c"]);
  expect(changed).toHaveBeenCalledTimes(3);
});
