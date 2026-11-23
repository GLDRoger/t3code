import { expect, it } from "vite-plus/test";

import { AuthEnvironmentScope, AuthStandardClientScopes, sessionIsChatOnly } from "./auth.ts";

it("calls a session chat-only when it reaches Kin chats and none of the coding app", () => {
  const granted = (permissions: ReadonlyArray<AuthEnvironmentScope>) => ({
    authenticated: true,
    permissions,
    auth: { serverUpdateScope: "environment:maintain" },
  });
  expect(sessionIsChatOnly(granted(["kin:chat"]))).toBe(true);
  expect(sessionIsChatOnly(granted(["kin:chat", "orchestration:read"]))).toBe(false);
  // An owner's standard session reaches chat through its other grants, never as chat-only.
  expect(sessionIsChatOnly(granted([...AuthStandardClientScopes]))).toBe(false);
  expect(sessionIsChatOnly(granted([]))).toBe(false);
  expect(sessionIsChatOnly({ ...granted(["kin:chat"]), authenticated: false })).toBe(false);
});
