import { describe, expect, it } from "vite-plus/test";

import { kinDocBlockIndex, kinDocBlocks, kinDocParts } from "./kinDocBlocks.ts";

describe("kinDocBlocks", () => {
  it.each([
    [
      "a chart and a titled visual",
      "```kin_chart\n{}\n```\n\n~~~~kin_visual Funnel  \n<p>```</p>\n~~~~",
      [
        { kind: "chart", info: "", content: "{}" },
        { kind: "visual", info: "Funnel", content: "<p>```</p>" },
      ],
    ],
    ["inside another fence it is code", "````md\n```kin_chart\n{}\n```\n````", []],
    [
      "a longer closing fence closes; one with words does not",
      "```kin_chart\n{}\n``` no\n`````",
      [{ kind: "chart", info: "", content: "{}\n``` no" }],
    ],
    ["indented four spaces is not a fence", "    ```kin_chart\n{}\n```", []],
    ["an unclosed block draws nothing", "```kin_visual T\n<p>", []],
    [
      "CRLF line endings",
      "```kin_chart\r\n{}\r\n```",
      [{ kind: "chart", info: "", content: "{}" }],
    ],
  ] as const)("%s", (_name, body, expected) => {
    expect(kinDocBlocks(body)).toEqual(expected);
  });

  it("cuts the body around its blocks, keeping other fences and the text between", () => {
    const chart = { kind: "chart", info: "", content: "{}" } as const;
    expect(
      kinDocParts("Intro\n\n```kin_chart\n{}\n```\n\n```kin_chart\n{}\n```\n```ts\nx\n```\nEnd"),
    ).toEqual([
      { type: "text", text: "Intro\n" },
      { type: "block", block: chart },
      { type: "block", block: chart },
      { type: "text", text: "```ts\nx\n```\nEnd" },
    ]);
    expect(kinDocParts("```kin_visual T\n<p>")).toEqual([
      { type: "text", text: "```kin_visual T\n<p>" },
    ]);
  });

  it("finds a reader's block by kind and text, its trailing newline or not", () => {
    const blocks = kinDocBlocks('```kin_chart\n{"a":1}\n```\n```kin_visual X\n{"a":1}\n```');
    expect(kinDocBlockIndex(blocks, "visual", '{"a":1}\n')).toBe(1);
    expect(kinDocBlockIndex(blocks, "chart", '{"a":1}')).toBe(0);
    expect(kinDocBlockIndex(blocks, "chart", "{}")).toBe(-1);
  });
});
