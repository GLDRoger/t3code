// @effect-diagnostics globalDate:off - Fixtures build times relative to a fixed clock.
import { describe, expect, it } from "vite-plus/test";

import { AuthSessionId, KinPersonId, type KinTasksKey } from "@t3tools/contracts";

import { formatKinTime } from "./kinScreenState.ts";
import {
  kinTasksKeyLabelCheck,
  kinTasksKeyMade,
  kinTasksKeyMakeBlocked,
  kinTasksKeyRemoveCopy,
  kinTasksKeyRows,
} from "./kinTasksKeys.ts";

const now = new Date("2026-11-15T10:00:00.000Z");
const at = (iso: string) => formatKinTime(new Date(iso), now);
const key = (over: Partial<KinTasksKey> = {}): KinTasksKey => ({
  sessionId: AuthSessionId.make("s-1"),
  personId: KinPersonId.make("meera"),
  label: "Work laptop",
  createdAt: "2026-11-15T09:00:00.000Z",
  expiresAt: "2026-12-15T09:00:00.000Z",
  lastUsedAt: null,
  ...over,
});

describe("kinTasksKeyRows", () => {
  it.each([
    [
      key(),
      `Made ${at("2026-11-15T09:00:00.000Z")} · Expires ${at("2026-12-15T09:00:00.000Z")}, in 30 days · Never used`,
    ],
    [
      key({
        createdAt: "2026-10-20T09:00:00.000Z",
        expiresAt: "2026-11-16T09:00:00.000Z",
        lastUsedAt: "2026-11-15T08:00:00.000Z",
      }),
      `Made ${at("2026-10-20T09:00:00.000Z")} · Expires ${at("2026-11-16T09:00:00.000Z")}, in 1 day · Last used ${at("2026-11-15T08:00:00.000Z")}`,
    ],
    [
      key({ expiresAt: "2026-11-15T10:30:00.000Z", lastUsedAt: "2026-11-02T08:00:00.000Z" }),
      `Made ${at("2026-11-15T09:00:00.000Z")} · Expires today at ${at("2026-11-15T10:30:00.000Z")} · Last used ${at("2026-11-02T08:00:00.000Z")}`,
    ],
  ] as const)("%# reads its line", (held, line) => {
    expect(kinTasksKeyRows([held], now)).toEqual([
      { sessionId: held.sessionId, label: "Work laptop", line },
    ]);
  });
});

describe("kinTasksKeyMakeBlocked", () => {
  it("turns Make a key off at three, with the reason", () => {
    expect(kinTasksKeyMakeBlocked(2)).toBeNull();
    expect(kinTasksKeyMakeBlocked(3)).toBe(
      "You have 3 keys, the most one person can hold. Remove one to make another.",
    );
  });
});

describe("kinTasksKeyLabelCheck", () => {
  it("takes a short trimmed name and refuses an empty or long one", () => {
    expect(kinTasksKeyLabelCheck("  Work laptop ")).toEqual({ ok: true, label: "Work laptop" });
    expect(kinTasksKeyLabelCheck("   ")).toEqual({
      ok: false,
      problem: "Give the key a short name.",
    });
    expect(kinTasksKeyLabelCheck("x".repeat(61)).ok).toBe(false);
  });
});

describe("kinTasksKeyRemoveCopy", () => {
  it("says what stops working, for your key and a teammate's", () => {
    expect(kinTasksKeyRemoveCopy("Work laptop", null).detail).toBe(
      "The coding agent using this key stops reaching your tasks on its next call. A removed key can't be brought back; make a new one to connect again.",
    );
    expect(kinTasksKeyRemoveCopy("Work laptop", "Dev").detail).toBe(
      "The coding agent using this key stops reaching Dev's tasks on its next call. A removed key can't be brought back; Dev can make a new one to connect again.",
    );
  });
});

describe("kinTasksKeyMade", () => {
  const made = (httpBaseUrl: string, device: "browser" | "phone" = "browser") =>
    kinTasksKeyMade({ key: key(), secret: "sekret-123", httpBaseUrl, device });

  it("puts the key at the address this client reaches its host by, with each setup", () => {
    const panel = made("https://kin.ambermill.example/");
    expect(panel.address).toBe("https://kin.ambermill.example/kin/you/mcp");
    expect(panel.addressNote).toBeNull();
    expect(panel.lines).toEqual([
      "Copy it now. Kin won't show this key again. If you lose it, remove it and make another.",
      "With it, your coding agent can read the tasks you hold, add notes to them, and set them to to-do, in progress or done.",
      "It can't reach anyone else's tasks, or any chats, money or files.",
      `Expires ${formatKinTime(new Date(key().expiresAt), new Date(key().createdAt))}, in 30 days. Make a new key then to keep going.`,
    ]);
    expect(panel.setups.map((setup) => [setup.agent, setup.text])).toEqual([
      [
        "Claude Code",
        'claude mcp add --transport http --scope user kin https://kin.ambermill.example/kin/you/mcp --header "Authorization: Bearer sekret-123"',
      ],
      [
        "Codex",
        'export KIN_TASKS_KEY="sekret-123"\ncodex mcp add kin --url https://kin.ambermill.example/kin/you/mcp --bearer-token-env-var KIN_TASKS_KEY',
      ],
      [
        "Cursor",
        `{
  "mcpServers": {
    "kin": {
      "url": "https://kin.ambermill.example/kin/you/mcp",
      "headers": {
        "Authorization": "Bearer sekret-123"
      }
    }
  }
}`,
      ],
      ["Another MCP client", "Authorization: Bearer sekret-123"],
    ]);
  });

  it("says when the address works only here, or is the phone's own", () => {
    expect(made("http://127.0.0.1:3773").addressNote).toBe(
      "This address only works on this computer. A coding agent anywhere else needs the address your team reaches Kin by.",
    );
    expect(made("https://kin.ambermill.example", "phone").addressNote).toBe(
      "This is the address this phone reaches Kin by. If your coding agent's computer reaches Kin another way, use that address with the same ending.",
    );
  });
});
