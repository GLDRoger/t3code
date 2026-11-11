import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { KinMemoryConfirmSuggestionsInput, KinMemorySetVisibilityInput } from "./kinMemory.ts";

const visibility = Schema.decodeUnknownExit(KinMemorySetVisibilityInput);
const confirm = Schema.decodeUnknownExit(KinMemoryConfirmSuggestionsInput);
const item = { orgId: "org-1", itemId: "item-1" };

// Review of e1460657a0: a yes without the listed version let the team know words never shown.
it("letting the team know needs the version the owner was shown", () => {
  expect(visibility({ ...item, onlyOwner: true })._tag).toBe("Success");
  expect(visibility({ ...item, onlyOwner: false, version: "v1" })._tag).toBe("Success");
  expect(visibility({ ...item, onlyOwner: false })._tag).toBe("Failure");
  expect(confirm({ orgId: "org-1", asOf: 3 })._tag).toBe("Success");
  expect(confirm({ orgId: "org-1", itemIds: ["item-1"], versions: { "item-1": "v1" } })._tag).toBe(
    "Success",
  );
  expect(confirm({ orgId: "org-1", itemIds: ["item-1"] })._tag).toBe("Failure");
});
