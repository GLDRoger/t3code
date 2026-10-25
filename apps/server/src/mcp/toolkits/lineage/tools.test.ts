import * as Tool from "effect/ai/Tool";
import { describe, expect, it } from "vite-plus/test";

import { LineageToolkit } from "./tools.ts";

describe("LineageToolkit", () => {
  it("gives every tool an object input schema, which McpServer requires to register it", () => {
    for (const tool of Object.values(LineageToolkit.tools)) {
      expect(Tool.getJsonSchema(tool), tool.name).toMatchObject({ type: "object" });
    }
  });
});
