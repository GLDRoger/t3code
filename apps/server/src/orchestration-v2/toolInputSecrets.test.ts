import { NodeId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { redactToolInputSecrets } from "./toolInputSecrets.ts";

const now = DateTime.makeUnsafe("2026-11-13T00:00:00.000Z");

describe("redactToolInputSecrets", () => {
  it("never stores secret arguments a lead passed to a tool", () => {
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
        apiKey: "example-api-key",
        token: "example-token",
        nested: [
          {
            pdfPassword: "x",
            pin: "1234",
            "http-Authorization": "Bearer example",
            client_secret: "example-secret",
            loginOTP: "123456",
          },
        ],
      },
    } as const;
    expect(redactToolInputSecrets(item)).toMatchObject({
      input: {
        attachment: "statement.pdf",
        password: "[REDACTED]",
        apiKey: "[REDACTED]",
        token: "[REDACTED]",
        nested: [
          {
            pdfPassword: "[REDACTED]",
            pin: "[REDACTED]",
            "http-Authorization": "[REDACTED]",
            client_secret: "[REDACTED]",
            loginOTP: "[REDACTED]",
          },
        ],
      },
    });
    const plain = { ...item, input: { attachment: "statement.pdf" } };
    expect(redactToolInputSecrets(plain)).toBe(plain);
  });

  it("keeps a true/false flag and the tool's answer, which carry no credential", () => {
    const item = {
      id: TurnItemId.make("turn-item:ask"),
      threadId: ThreadId.make("thread:lead"),
      runId: null,
      nodeId: NodeId.make("node:lead"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "dynamic_tool",
      toolName: "mcp__t3__request_secret",
      input: {
        fields: [
          { name: "email", label: "Email", secret: false },
          { name: "password", label: "Password", secret: true },
        ],
        pin: 1234,
        pageToken: "page-1",
      },
      output: { nextPage: "page-2" },
    } as const;
    const redacted = redactToolInputSecrets(item);
    expect(redacted).toMatchObject({
      input: {
        fields: [
          { name: "email", secret: false },
          { name: "password", secret: true },
        ],
        pin: "[REDACTED]",
        pageToken: "[REDACTED]",
      },
    });
    expect(redacted.type === "dynamic_tool" && redacted.output).toBe(item.output);
  });
});
