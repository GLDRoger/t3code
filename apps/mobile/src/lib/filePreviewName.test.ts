import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { filePreviewName } from "./filePreviewGallery";

describe("filePreviewName", () => {
  it("titles an image by its name as stored, dots and all", () => {
    const environmentId = EnvironmentId.make("test");
    const titled = (name: string) =>
      filePreviewName({
        kind: "image",
        name,
        environmentId,
        resource: { _tag: "attachment", attachmentId: "a", fileName: name },
      });
    expect(titled("nine.jpg")).toBe("nine.jpg");
    expect(titled("Harbor Power 11.2026")).toBe("Harbor Power 11.2026");
    expect(titled("Fig. 1")).toBe("Fig. 1");
    // A path separator or control character never reaches the native file name.
    expect(titled("bills/nine.jpg")).toBe("bills_nine.jpg");
  });
});
