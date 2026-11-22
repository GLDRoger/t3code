import { describe, expect, it } from "vite-plus/test";

import { kinCodingLanding } from "./kinNoCode";

const HELPER = "thread:delegated-task:command%3Amcp%3Aa1%3Adelegate-task%3Ab2";

describe("kinCodingLanding", () => {
  it.each([
    ["/kin", null],
    ["/kin/env-1/kin-default/chat-1", null],
    ["/settings/providers", null],
    ["/usage", null],
    ["/pair", null],
    ["/kin/invite", null],
    ["/", { stray: null }],
    ["/new", { stray: null }],
    ["/draft/draft-1", { stray: null }],
    ["/projects/env-1%2Fproject-1", { stray: null }],
    ["/pull-requests", { stray: null }],
    ["/issues", { stray: null }],
    [
      `/env-1/${encodeURIComponent(HELPER)}`,
      { stray: { environmentId: "env-1", threadId: HELPER } },
    ],
    ["/threads/env-1/kin%3A01ABC", { stray: { environmentId: "env-1", threadId: "kin:01ABC" } }],
  ] as const)("%s", (pathname, landing) => {
    expect(kinCodingLanding(pathname)).toEqual(landing);
  });
});
