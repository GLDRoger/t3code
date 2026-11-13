import { NodeId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { redactToolInputSecrets } from "./toolInputSecrets.ts";

const now = DateTime.makeUnsafe("2026-11-13T00:00:00.000Z");

describe("redactToolInputSecrets", () => {
  it("never stores a password argument a lead passed to a tool", () => {
    const item = {
      id: TurnItemId.make("turn-item:statement"),
      threadId: ThreadId.make("thread:lead"),
      runId: null,
      nodeId: NodeId.make("node:lead"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "dynamic_tool",
      toolName: "mcp__kin__statement_read",
      input: {
        attachment: "statement.pdf",
        password: "lakeview2026",
        nested: [{ pdfPassword: "x" }],
      },
    } as const;
    expect(redactToolInputSecrets(item)).toMatchObject({
      input: {
        attachment: "statement.pdf",
        password: "[REDACTED]",
        nested: [{ pdfPassword: "[REDACTED]" }],
      },
    });
    const plain = { ...item, input: { attachment: "statement.pdf" } };
    expect(redactToolInputSecrets(plain)).toBe(plain);
  });
});
