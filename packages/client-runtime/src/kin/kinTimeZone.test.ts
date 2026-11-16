import { describe, expect, it } from "vite-plus/test";

import { kinSameTimeZone } from "./kinTimeZone.ts";

describe("kinSameTimeZone", () => {
  it("treats a zone's old and new names as one zone", () => {
    expect(kinSameTimeZone("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
    expect(kinSameTimeZone("Europe/Kyiv", "Europe/Kiev")).toBe(true);
    expect(kinSameTimeZone("Asia/Kolkata", "Asia/Dubai")).toBe(false);
  });
});
