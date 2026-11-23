// @effect-diagnostics globalDate:off - Fixtures build times relative to a fixed clock.
import { describe, expect, it } from "vite-plus/test";

import { AuthSessionId, KinPersonId, type KinTasksKey } from "@t3tools/contracts";

import { formatKinTime } from "./kinScreenState.ts";
import {
  KIN_TASKS_KEY_STAND_IN,
  kinTasksKeyGuide,
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

const made = (httpBaseUrl: string, device: "browser" | "phone" = "browser", origin?: string) =>
  kinTasksKeyMade({ key: key(), secret: "sekret-123", origin, httpBaseUrl, device });

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
      { sessionId: held.sessionId, label: "Work laptop", line, canRemove: true },
    ]);
  });

  it("offers Remove unless the host says this reader may not", () => {
    expect(
      kinTasksKeyRows([key({ canRevoke: false }), key({ canRevoke: true }), key()], now).map(
        (row) => row.canRemove,
      ),
    ).toEqual([false, true, true]);
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
  it("puts the key at the address this client reaches its host by, with each setup", () => {
    const panel = made("https://kin.ambermill.example/");
    expect(panel.address).toBe("https://kin.ambermill.example/kin/you/mcp");
    expect(panel.addressNote).toBeNull();
    expect(panel.lines).toEqual([
      "Copy it now. Kin won't show this key again. If you lose it, remove it and make another.",
      "With it, your coding agent can read the tasks you hold, add comments to them, and set them to to-do, in progress or done. It can also read the projects, clients and docs you can see in Kin, money if you have Money, and, for owners and co-owners, team memory.",
      "It can't change anything else, reach anyone else's tasks or your chats, or read anything you can't see yourself. Anything marked private, and everything under a private client or project, stays in Kin.",
      `Expires ${formatKinTime(new Date(key().expiresAt), new Date(key().createdAt))}, in 30 days. Make a new key then to keep going.`,
    ]);
    expect(panel.setups.map((setup) => [setup.agent, setup.text])).toEqual([
      [
        "Claude Code",
        'claude mcp add --transport http --scope user kin https://kin.ambermill.example/kin/you/mcp --header "Authorization: Bearer sekret-123"',
      ],
      [
        "Codex",
        `[mcp_servers.kin]
url = "https://kin.ambermill.example/kin/you/mcp"
http_headers = { "Authorization" = "Bearer sekret-123" }`,
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
    // Codex's key sits in its own config: nothing hangs on a terminal's environment.
    const codex = panel.setups.find((setup) => setup.agent === "Codex")!.text;
    expect(codex).not.toMatch(/export|KIN_TASKS_KEY|env/);
    expect(codex.split("sekret-123").length - 1).toBe(1);
    expect(codex.split("https://kin.ambermill.example/kin/you/mcp").length - 1).toBe(1);
  });

  it("says when the address works only here, or is the phone's own", () => {
    expect(made("http://127.0.0.1:3773").addressNote).toBe(
      "This address only works on this computer. A coding agent anywhere else needs the address your team reaches Kin by.",
    );
    expect(made("https://kin.ambermill.example", "phone").addressNote).toBe(
      "This is the address this phone reaches Kin by. If your coding agent's computer reaches Kin another way, use that address with the same ending.",
    );
  });

  it("uses the host's public address over this client's own, with no note", () => {
    for (const [base, device] of [
      ["http://127.0.0.1:3773", "browser"],
      ["http://192.168.1.20:3773", "phone"],
    ] as const) {
      const panel = made(base, device, "https://ambermill.relay.example");
      expect(panel.address).toBe("https://ambermill.relay.example/kin/you/mcp");
      expect(panel.addressNote).toBeNull();
      expect(panel.setups[0]?.text).toContain(" https://ambermill.relay.example/kin/you/mcp ");
    }
  });
});

describe("kinTasksKeyGuide", () => {
  it("builds the panel's setup lines with one stand-in where the key goes", () => {
    const guide = kinTasksKeyGuide({
      httpBaseUrl: "https://kin.ambermill.example/",
      device: "browser",
    });
    const panel = kinTasksKeyMade({
      key: key(),
      secret: KIN_TASKS_KEY_STAND_IN,
      httpBaseUrl: "https://kin.ambermill.example/",
      device: "browser",
    });
    expect(KIN_TASKS_KEY_STAND_IN).toBe("YOUR_KEY");
    expect(guide).toEqual({
      address: panel.address,
      addressNote: null,
      setups: panel.setups,
    });
    expect(guide?.setups.map((setup) => setup.text.split("YOUR_KEY").length - 1)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(guide?.setups[0]?.text).toBe(
      'claude mcp add --transport http --scope user kin https://kin.ambermill.example/kin/you/mcp --header "Authorization: Bearer YOUR_KEY"',
    );
    expect(guide?.setups[1]?.text).toContain('"Authorization" = "Bearer YOUR_KEY"');
  });

  it("takes the host's address first, keeps the panel's notes, and knows none without one", () => {
    expect(
      kinTasksKeyGuide({
        origin: "https://ambermill.relay.example",
        httpBaseUrl: null,
        device: "phone",
      }),
    ).toMatchObject({ address: "https://ambermill.relay.example/kin/you/mcp", addressNote: null });
    expect(
      kinTasksKeyGuide({ httpBaseUrl: "http://127.0.0.1:3773", device: "browser" })?.addressNote,
    ).toBe(made("http://127.0.0.1:3773").addressNote);
    expect(
      kinTasksKeyGuide({ httpBaseUrl: "https://kin.ambermill.example", device: "phone" })
        ?.addressNote,
    ).toBe(made("https://kin.ambermill.example", "phone").addressNote);
    expect(kinTasksKeyGuide({ httpBaseUrl: null, device: "phone" })).toBeNull();
  });
});
