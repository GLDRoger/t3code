import { makeMcpAppHost, McpAppHostRefusal } from "@t3tools/client-runtime/mcp-apps";
import * as Predicate from "effect/Predicate";
import {
  EnvironmentId,
  McpAppCallToolInput,
  McpAppReadResourceInput,
  McpAppToolInfoInput,
  McpAppUpdateModelContextInput,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { McpAppReference } from "@t3tools/shared/mcpApp";
import * as Schema from "effect/Schema";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { outerDocument, ThreadMcpApp } from "../../threads/McpAppWebView";

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

const app = {
  attachmentId: "a",
  server: "kin",
  tool: "widget",
  resourceUri: "ui://kin/widget",
} satisfies McpAppReference;

// Exactly what Kin passes to render a widget inline; typecheck fails when upstream renames a prop.
const kinProps = {
  environmentId: EnvironmentId.make("env-kin"),
  threadId: ThreadId.make("thread-lead"),
  conversationThreadId: ThreadId.make("thread-chat"),
  itemId: TurnItemId.make("item-widget"),
  revision: "r1",
  app,
  width: 320,
} satisfies ComponentProps<typeof ThreadMcpApp>;

const decodeCallTool = Schema.decodeSync(McpAppCallToolInput);
const decodeToolInfo = Schema.decodeSync(McpAppToolInfoInput);
const decodeReadResource = Schema.decodeSync(McpAppReadResourceInput);
const decodeUpdateModelContext = Schema.decodeSync(McpAppUpdateModelContextInput);

interface Envelope {
  readonly secret: string;
  readonly active: boolean;
  readonly message: unknown;
}

/** Runs the outer document's script against a minimal WebView DOM. */
function mountOuterDocument(toReactNative: (data: string) => void = () => {}) {
  const html = outerDocument("https://app.test/widget.html", "", SECRET);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (script === undefined) throw new Error("outer document has no script");

  const toNative: Array<Envelope> = [];
  const toFrame: Array<unknown> = [];
  let awaitingFrame: ((message: unknown) => void) | undefined;
  const contentWindow = {
    postMessage: (message: unknown) => {
      const resolve = awaitingFrame;
      awaitingFrame = undefined;
      if (resolve === undefined) toFrame.push(message);
      else resolve(message);
    },
  };
  const frame = { contentWindow, src: "", addEventListener: () => {} };
  const userActivation = { isActive: false };
  const document = {
    activeElement: null as unknown,
    getElementById: (id: string) => (id === "app" ? frame : null),
  };
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const window: Record<string, unknown> = {
    ReactNativeWebView: {
      postMessage: (data: string) => {
        toNative.push(JSON.parse(data) as Envelope);
        toReactNative(data);
      },
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
    /** Resolves with the next message the host posts into the app frame. */
    nextFrameMessage: () =>
      toFrame.length > 0
        ? Promise.resolve(toFrame.shift())
        : new Promise<unknown>((resolve) => {
            awaitingFrame = resolve;
          }),
  };
}

function mountBridge(
  overrides: Pick<Partial<Parameters<typeof makeMcpAppHost>[0]>, "callTool" | "sendMessage">,
) {
  // Mirrors ThreadMcpApp's onMessage: `active` is set only around the synchronous host.receive.
  const activity = { active: false };
  let host: ReturnType<typeof makeMcpAppHost> | undefined;
  const outer = mountOuterDocument((data) => {
    const envelope: unknown = JSON.parse(data);
    if (!Predicate.isObject(envelope) || envelope.secret !== SECRET) return;
    activity.active = envelope.active === true;
    host?.receive(envelope.message);
    activity.active = false;
  });
  const unused = () => Promise.reject(new Error("unused"));
  host = makeMcpAppHost({
    app,
    hostVersion: "0.0.0",
    post: outer.hostPosts,
    hostContext: () => ({
      theme: "dark",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { width: kinProps.width, maxHeight: 600 },
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
  return {
    ...outer,
    activity,
    request: (message: unknown, options?: Parameters<typeof outer.appPosts>[1]) => {
      const response = outer.nextFrameMessage();
      outer.appPosts(message, options);
      return response;
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

  describe("RPC inputs Kin builds from ThreadMcpApp's target", () => {
    it("decodes with the thread and item Kin passes", () => {
      const target = { threadId: kinProps.threadId, itemId: kinProps.itemId };
      const decoded = [
        decodeCallTool({ ...target, name: "save_note", arguments: { text: "hi" } }),
        decodeToolInfo({ ...target, name: "save_note" }),
        decodeReadResource({ ...target, uri: app.resourceUri }),
        decodeUpdateModelContext({
          ...target,
          conversationThreadId: kinProps.conversationThreadId,
        }),
      ];
      for (const input of decoded) expect(input).toMatchObject(target);
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

      expect(callTool).toHaveBeenCalledWith({ name: "save_note", arguments: { text: "hi" } });
      expect(await pending).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    });

    it("sees a real tap synchronously, before any await", async () => {
      const taps: Array<boolean> = [];
      const bridge = mountBridge({
        callTool: async () => {
          taps.push(bridge.activity.active);
          return { content: [] };
        },
      });
      const call = (id: number) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "save_note", arguments: {} },
      });

      await bridge.request(call(1), { activation: true, focus: "frame" });
      await bridge.request(call(2));

      expect(taps).toEqual([true, false]);
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
