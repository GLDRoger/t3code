import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import installedPolicy from "../../../ops/kin/host/policy.json" with { type: "json" };
import { KIN_HOST_POLICY } from "./kinHost.ts";
import { ManagedPolicyDocument } from "./managedPolicy.ts";

const decode = Schema.decodeUnknownSync(ManagedPolicyDocument, { onExcessProperty: "error" });

describe("KIN_HOST_POLICY", () => {
  it.each([
    ["the document", KIN_HOST_POLICY],
    ["the file setup.sh installs", installedPolicy],
  ])("%s decodes as T3's policy, unchanged", (_name, document) => {
    expect(decode(document)).toStrictEqual(KIN_HOST_POLICY);
  });
});
