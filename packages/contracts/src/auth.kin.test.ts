import { expect, it } from "vite-plus/test";

import {
  AuthEnvironmentScope,
  AuthKinChatScope,
  AuthStandardClientScopes,
  sessionIsChatOnly,
} from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { KinBankSenderRpcs } from "./kinBankSenders.ts";
import { kinRpcAccess } from "./kinRpcs.ts";

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

it.each(KinBankSenderRpcs)(
  "guards $._tag for owners and co-owners with the Kin chat grant",
  ({ _tag }) => {
    expect(clientRpcRequiredScopes(_tag, undefined)).toEqual([AuthKinChatScope]);
    expect(kinRpcAccess(_tag)).toBe("owner_level");
  },
);

const billSenderRpcs = ["list", "approve", "decline", "remove", "add"] as const;
it.each(billSenderRpcs)("guards billing sender %s for owners and co-owners", (method) => {
  const tag = `kin.billSenders.${method}`;
  expect(clientRpcRequiredScopes(tag, undefined)).toEqual([AuthKinChatScope]);
  expect(kinRpcAccess(tag as Parameters<typeof kinRpcAccess>[0])).toBe("owner_level");
});
