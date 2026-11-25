import { assert, describe, it } from "@effect/vitest";

import { readCallArguments } from "./callArguments.ts";

const line = 'He wrote "go ahead" {and} C:\\pilot\\eastgate, "reason": not this one.\n';
const body = `Hi Kabir,\n${line.repeat(Math.ceil(3_600 / line.length))}`.slice(0, 3_595) + "\nZoya";
const mail = {
  to: ["kabir@tidewater.example"],
  subject: "Your single-site start at Eastgate",
  body,
};
const told = "Send Zoya's approved pilot mail to Kabir";
/** The arguments as the model sends them long: JSON text that swallowed the sibling reason. */
const swallowed = (reason: string) => `${JSON.stringify(mail)},"reason":${JSON.stringify(reason)}}`;

describe("readCallArguments", () => {
  it("reads the arguments as the object the model meant, or nothing", () => {
    assert.strictEqual(body.length, 3_600);
    const long = "x".repeat(600);
    for (const [name, given, reason, expected] of [
      ["an object", mail, told, { arguments: mail, reason: told }],
      ["no arguments", undefined, told, { reason: told }],
      ["no arguments or reason", undefined, undefined, {}],
      ["null", null, told, { reason: told }],
      ["valid JSON text", `  ${JSON.stringify(mail)}\n`, told, { arguments: mail, reason: told }],
      ["the swallowed reason", swallowed(told), undefined, { arguments: mail, reason: told }],
      ["a reason also given", swallowed(told), "Own", { arguments: mail, reason: "Own" }],
      [
        "the swallowed reason with its last brace dropped",
        swallowed(told).slice(0, -1),
        undefined,
        { arguments: mail, reason: told },
      ],
      [
        "a long swallowed reason",
        swallowed(long),
        undefined,
        { arguments: mail, reason: long.slice(0, 500) },
      ],
      ["text of an array", "[1,2]", told, undefined],
      ["text of a number", "42", told, undefined],
      ["garbage text", '{"to": oops},"reason":"x"}', told, undefined],
      ["an array", [mail], told, undefined],
      ["a number", 42, told, undefined],
    ] as const)
      assert.deepStrictEqual(readCallArguments(given, reason), expected, name);
  });
});
