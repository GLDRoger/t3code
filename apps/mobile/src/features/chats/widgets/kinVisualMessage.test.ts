import { describe, expect, it } from "vite-plus/test";

import { fromVisualPage } from "./kinVisualMessage";

const page = "https://kin.example.test/api/assets/visual/v1.html?t=1#theme=dark";

describe("fromVisualPage", () => {
  it("reads iOS messages from the outer page only, and Android's by their shape alone", () => {
    expect(
      [
        ["ios", "https://kin.example.test/api/assets/visual/v1.html?t=1"],
        ["ios", "https://kin.example.test/api/assets/visual/v1.html?t=1#theme=light"],
        ["ios", "about:srcdoc"],
        ["ios", "https://kin.example.test/api/assets/visual/v2.html?t=1"],
        ["android", "null"],
        ["android", "https://kin.example.test"],
      ].map(([platform, url]) => fromVisualPage(platform!, url!, page)),
    ).toEqual([true, true, false, false, true, true]);
  });
});
