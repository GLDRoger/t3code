import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import {
  EnvironmentId,
  KinOrgId,
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { registerCommands } from "../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../state/server";
import { kinDestinationLink, registerKinListCommands, startKinListTracking } from "./kinListSwitch";
import { kinHostAtom } from "./useKinHost";

const KIN_HOST: KinHost = {
  _tag: "host",
  environmentId: EnvironmentId.make("kin-host"),
  connected: true,
  probe: { _tag: "error", message: "offline for a moment", transient: true },
};

const keybindings: ResolvedKeybindingsConfig = (
  [
    ["k", "chat.new"],
    ["6", "thread.jump.6"],
    ["]", "thread.next"],
    ["p", "filePicker.toggle"],
    ["f", "projectSearch.toggle"],
    ["s", "kin.switchList"],
  ] as const satisfies ReadonlyArray<readonly [string, KeybindingCommand]>
).map(([key, command]) => ({
  command,
  shortcut: { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: false },
}));

function fakeRouter(pathname: string) {
  const location = { pathname, href: pathname, state: {} };
  const navigate = vi.fn(async (to: { readonly to?: string; readonly href?: string }) => {
    location.pathname = to.to ?? to.href ?? location.pathname;
    location.href = location.pathname;
  });
  const router = { state: { location }, navigate, subscribe: () => () => {} };
  return { router: router as unknown as AnyRouter, navigate, location };
}

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

describe("registerKinListCommands", () => {
  it.each([
    // Kin offers no coding threads: over Kin, T3's ways into them do nothing.
    { at: "/kin/kin-host/org/chat", host: KIN_HOST, key: "k", reaches: false },
    { at: "/kin/kin-host/org/tasks", host: KIN_HOST, key: "6", reaches: false },
    { at: "/kin", host: KIN_HOST, key: "]", reaches: false },
    { at: "/kin/kin-host/org/docs", host: KIN_HOST, key: "p", reaches: false },
    { at: "/kin/kin-host/org/docs", host: KIN_HOST, key: "f", reaches: false },
    // Over a thread opened from a task, and without Kin at all, they are T3's as before.
    { at: "/kin-host/thread-1", host: KIN_HOST, key: "k", reaches: true },
    { at: "/kin-host/thread-1", host: KIN_HOST, key: "6", reaches: true },
    { at: "/kin-host/thread-1", host: KIN_HOST, key: "p", reaches: true },
    { at: "/", host: { _tag: "none" } as const, key: "f", reaches: true },
    { at: "/", host: { _tag: "none" } as const, key: "k", reaches: true },
    { at: "/kin", host: { _tag: "none" } as const, key: "]", reaches: true },
  ])("$key at $at with host $host._tag reaches T3: $reaches", (row) => {
    using stack = new DisposableStack();
    const registry = stack.adopt(
      AtomRegistry.make({
        initialValues: [
          [kinHostAtom, row.host],
          [primaryServerKeybindingsAtom, keybindings],
        ],
      }),
      (made) => made.dispose(),
    );
    const t3 = vi.fn();
    const { router } = fakeRouter(row.at);
    stack.defer(
      registerCommands(
        {
          "chat.new": t3,
          "thread.jump.6": t3,
          "thread.next": t3,
          "filePicker.toggle": t3,
          "projectSearch.toggle": t3,
        },
        { keybindings: () => keybindings },
      ),
    );
    stack.defer(registerKinListCommands(router, registry));

    press(row.key);

    expect(t3).toHaveBeenCalledTimes(row.reaches ? 1 : 0);
  });

  it("leads from a coding thread back into Kin, and is no way out of Kin", () => {
    using stack = new DisposableStack();
    const registry = stack.adopt(
      AtomRegistry.make({
        initialValues: [
          [kinHostAtom, KIN_HOST],
          [primaryServerKeybindingsAtom, keybindings],
        ],
      }),
      (made) => made.dispose(),
    );
    const { router, navigate, location } = fakeRouter("/kin-host/thread-1");
    stack.defer(registerKinListCommands(router, registry));

    press("s");
    expect(navigate).toHaveBeenCalledWith({ href: "/kin" });

    navigate.mockClear();
    expect(location.pathname).toBe("/kin");
    press("s");
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("startKinListTracking", () => {
  it.each([
    { host: KIN_HOST, opens: "/kin" },
    { host: { _tag: "none" } as const, opens: "/" },
  ])("a launch at / with host $host._tag and none saved opens $opens", (row) => {
    using stack = new DisposableStack();
    const registry = stack.adopt(
      AtomRegistry.make({ initialValues: [[kinHostAtom, row.host]] }),
      (made) => made.dispose(),
    );
    const { router, location } = fakeRouter("/");
    stack.defer(startKinListTracking(router, registry));

    expect(location.pathname).toBe(row.opens);
  });

  it("returns Chats to the chat you left only on the host it is on", () => {
    using stack = new DisposableStack();
    const registry = stack.adopt(
      AtomRegistry.make({ initialValues: [[kinHostAtom, KIN_HOST]] }),
      (made) => made.dispose(),
    );
    const { router } = fakeRouter("/kin/kin-host/org-ambermill/chat-rhea");
    stack.defer(startKinListTracking(router, registry));
    const on = (host: string) =>
      kinDestinationLink("chats", {
        environmentId: EnvironmentId.make(host),
        orgId: KinOrgId.make("org-ambermill"),
      });

    expect(on("kin-host")).toMatchObject({ params: { chatId: "chat-rhea" } });
    expect(on("other-host")).toEqual({ to: "/kin" });
  });
});
