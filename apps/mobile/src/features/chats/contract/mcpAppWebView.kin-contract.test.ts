import { makeMcpAppHost, McpAppHostRefusal } from "@t3tools/client-runtime/mcp-apps";
import { describe, expect, it, vi } from "vite-plus/test";

import { outerDocument } from "../../threads/McpAppWebView";

// Stubs only what keeps McpAppWebView.tsx from loading in Node; a new native import upstream needs one here.
vi.mock("react-native", () => ({}));
vi.mock("react-native-webview", () => ({}));
vi.mock("expo-constants", () => ({}));
vi.mock("@react-navigation/native", () => ({}));
vi.mock("react-native-safe-area-context", () => ({}));
vi.mock("../../../components/ui/Button", () => ({}));
vi.mock("../../../components/ui/AppActivityIndicator", () => ({}));
vi.mock("../../../lib/uuid", () => ({}));
vi.mock("../../../state/assets", () => ({}));
vi.mock("../../../state/entities", () => ({}));
vi.mock("../../../state/mcpApps", () => ({}));
vi.mock("../../../state/orchestration", () => ({}));
vi.mock("../../../state/thread-outbox", () => ({}));
vi.mock("../../settings/appearance/AppearancePreferencesProvider", () => ({}));

const SECRET = "kin-secret";

interface Envelope {
  readonly secret: string;
  readonly active: boolean;
  readonly message: unknown;
}

/** Runs the outer document's script against a minimal WebView DOM. */
function mountOuterDocument() {
  const html = outerDocument("https://app.test/widget.html", "", SECRET);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (script === undefined) throw new Error("outer document has no script");

  const toNative: Array<Envelope> = [];
  const toFrame: Array<unknown> = [];
  const contentWindow = { postMessage: (message: unknown) => toFrame.push(message) };
  const frame = { contentWindow, src: "", addEventListener: () => {} };
  const userActivation = { isActive: false };
  const document = {
    activeElement: null as unknown,
    getElementById: (id: string) => (id === "app" ? frame : null),
  };
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const window: Record<string, unknown> = {
    ReactNativeWebView: {
      postMessage: (data: string) => toNative.push(JSON.parse(data) as Envelope),
    },
    addEventListener: (type: string, listener: (typeof listeners)[number]) => {
      if (type === "message") listeners.push(listener);
    },
  };
  new Function("window", "document", "navigator", script)(window, document, { userActivation });

  return {
    html,
    toNative,
    /** The sandboxed app posts to its parent; activation and focus vary independently. */
    appPosts: (
      data: unknown,
      options: { activation?: boolean; focus?: "frame" | null; source?: unknown } = {},
    ) => {
      userActivation.isActive = options.activation ?? false;
      document.activeElement = options.focus === "frame" ? frame : null;
      for (const listener of listeners) listener({ source: options.source ?? contentWindow, data });
    },
    /** What React Native's `post` injects: `window.__t3McpAppReceive(message)`. */
    hostPosts: (message: unknown) => (window.__t3McpAppReceive as (m: unknown) => void)(message),
    // A host that stops answering fails here with a readable diff, not at the suite timeout.
    nextFrameMessage: async () => {
      await vi.waitFor(() => expect(toFrame).toHaveLength(1));
      return toFrame.shift();
    },
  };
}

const app = { attachmentId: "a", server: "kin", tool: "widget", resourceUri: "ui://kin/widget" };

function mountBridge(
  overrides: Pick<Partial<Parameters<typeof makeMcpAppHost>[0]>, "callTool" | "sendMessage">,
) {
  const outer = mountOuterDocument();
  const unused = () => Promise.reject(new Error("unused"));
  const host = makeMcpAppHost({
    app,
    hostVersion: "0.0.0",
    post: outer.hostPosts,
    hostContext: () => ({
      theme: "dark",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { width: 320, maxHeight: 600 },
      platform: "mobile",
    }),
    callTool: unused,
    readResource: unused,
    openLink: unused,
    sendMessage: unused,
    updateModelContext: unused,
    requestDisplayMode: unused,
    downloadFile: unused,
    onRequestTeardown: () => {},
    onSizeChanged: () => {},
    ...overrides,
  });
  // React Native's onMessage: only envelopes carrying the secret reach the host.
  const relay = () => {
    for (const envelope of outer.toNative.splice(0)) {
      if (envelope.secret === SECRET) host.receive(envelope.message);
    }
  };
  return {
    ...outer,
    request: (message: unknown) => {
      outer.appPosts(message);
      relay();
      return outer.nextFrameMessage();
    },
  };
}

describe("McpAppWebView bridge (Kin contract)", () => {
  describe("real-tap check in the outer document", () => {
    it("attests active only while a real tap has focus on the app frame", () => {
      const outer = mountOuterDocument();
      const message = { jsonrpc: "2.0", id: 1, method: "ui/request-display-mode" };

      outer.appPosts(message, { activation: true, focus: "frame" });
      outer.appPosts(message, { activation: true, focus: null });
      // The frame keeps focus after a tap; a later post with no activation must not count.
      outer.appPosts(message, { activation: false, focus: "frame" });
      outer.appPosts(message);

      expect(outer.toNative).toEqual([
        { secret: SECRET, active: true, message },
        { secret: SECRET, active: false, message },
        { secret: SECRET, active: false, message },
        { secret: SECRET, active: false, message },
      ]);
    });

    it("drops messages that do not come from the app frame", () => {
      const outer = mountOuterDocument();
      outer.appPosts(
        { jsonrpc: "2.0", method: "x" },
        { activation: true, focus: "frame", source: {} },
      );
      expect(outer.toNative).toEqual([]);
    });

    it("keeps the app sandboxed away from the outer document's origin", () => {
      const { html } = mountOuterDocument();
      const sandbox = html.match(/<iframe[^>]*\ssandbox="([^"]*)"/)?.[1];
      expect(sandbox?.split(" ")).toContain("allow-scripts");
      expect(sandbox?.split(" ")).not.toContain("allow-same-origin");
    });
  });

  describe("tools/call reaches callTool", () => {
    it("answers with the tool result", async () => {
      const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
      const bridge = mountBridge({ callTool });

      const pending = bridge.request({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "save_note", arguments: { text: "hi" } },
      });

      // Dispatch is synchronous, so a gate can read `active` before any await.
      expect(callTool).toHaveBeenCalledWith({ name: "save_note", arguments: { text: "hi" } });
      expect(await pending).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    });

    it("answers a refusal with its message", async () => {
      const bridge = mountBridge({
        callTool: () => Promise.reject(new McpAppHostRefusal({ message: "Declined by the user." })),
      });

      const response = await bridge.request({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "save_note", arguments: {} },
      });

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: 8,
        error: { code: -32000, message: "Declined by the user." },
      });
    });
  });

  describe("ui/message reaches sendMessage", () => {
    it("passes the user's text through", async () => {
      const sendMessage = vi.fn(async () => {});
      const bridge = mountBridge({ sendMessage });

      const pending = bridge.request({
        jsonrpc: "2.0",
        id: 9,
        method: "ui/message",
        params: { role: "user", content: [{ type: "text", text: "Remind me at 5" }] },
      });

      expect(sendMessage).toHaveBeenCalledWith("Remind me at 5");
      expect(await pending).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
    });

    it("answers a refusal with its message", async () => {
      const bridge = mountBridge({
        sendMessage: () =>
          Promise.reject(new McpAppHostRefusal({ message: "Declined by the user." })),
      });

      const response = await bridge.request({
        jsonrpc: "2.0",
        id: 10,
        method: "ui/message",
        params: { role: "user", content: [{ type: "text", text: "hi" }] },
      });

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: 10,
        error: { code: -32000, message: "Declined by the user." },
      });
    });
  });
});
