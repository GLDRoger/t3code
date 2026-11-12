import { describe, expect, it } from "vite-plus/test";

import { kinAttachmentFailure } from "./kinAttachmentFailure";

describe("kinAttachmentFailure", () => {
  it("says what happened in plain words, never the cause's own text", () => {
    const stalled = new Error("All fibers interrupted without error");
    expect(kinAttachmentFailure(stalled, ["image"])).toEqual({
      title: "Couldn't send the photo",
      message: "Check the connection and try again. It's still in the message box.",
    });
    expect(
      kinAttachmentFailure(new Error("Upload failed for 'a.pdf' (500)."), ["file", "image"]),
    ).toMatchObject({ title: "Couldn't send the files" });
    expect(kinAttachmentFailure("timeout", ["image", "image"]).title).toBe(
      "Couldn't send the photos",
    );
  });

  it("keeps the one cause that asks for something else: attaching a lost file again", () => {
    const lost = new Error("'IMG_1.heic' is no longer available. Attach the image again.");
    expect(kinAttachmentFailure(lost, ["image"]).message).toBe(lost.message);
  });
});
