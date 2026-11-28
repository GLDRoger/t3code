import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { KinBillSenderRpcs } from "./kinBillSenders.ts";

const add = KinBillSenderRpcs.find((rpc) => rpc._tag === "kin.billSenders.add")!;
const encodeAdded = Schema.encodeSync(add.successSchema);
const decodeAdded = Schema.decodeSync(add.successSchema);

describe("kin.billSenders.add", () => {
  it("carries the host's sentence over the wire, and still answers nothing", () => {
    const said = { message: "Kin will read held bills from billing@inkspot.example." };
    expect(decodeAdded(encodeAdded(said))).toEqual(said);
    expect(decodeAdded(undefined)).toBeUndefined();
  });
});
