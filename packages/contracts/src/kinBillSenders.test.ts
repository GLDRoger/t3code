import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { KinBillSenderRpcs } from "./kinBillSenders.ts";

const add = KinBillSenderRpcs.find((rpc) => rpc._tag === "kin.billSenders.add")!;
const wire = Schema.encodeUnknownSync(add.successSchema as Schema.Codec<unknown, unknown>);

it("keeps the add sentence on the wire, and an empty answer stays empty", () => {
  const said = { message: "Kin will read held bills from billing@inkspot.example." };
  expect(wire(said)).toEqual(said);
  expect(wire(undefined)).toBeUndefined();
});
