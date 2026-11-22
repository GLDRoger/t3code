import { KinConnectionId, KinOrgId, type KinConnection } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The host: its connections, what Add was sent, and a refusal it answers with when set.
const host = vi.hoisted(() => ({
  connections: [] as Array<unknown>,
  adds: [] as Array<Record<string, unknown>>,
  refuse: null as string | null,
}));

vi.mock(import("./KinNewLeadButton"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinNewLeadTarget: () => ({ environmentId: "env-1", orgId: "org-1", lead: null }) as never,
}));
// Settings → Connections also holds these; each is its own screen with its own test.
vi.mock(
  import("./KinGitHubConnect"),
  () => ({ KinGitHubConnect: () => null, KinGitHubPage: () => null }) as never,
);
vi.mock(import("./KinSocialConnect"), () => ({ KinSocialConnect: () => null }) as never);
vi.mock(import("./KinVisualHosts"), () => ({ KinVisualHosts: () => null }) as never);
vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { KinChatError: Refused } = await import("@t3tools/contracts");
  const allowed = Atom.make(true);
  const services = [
    {
      service: "sentry",
      label: "Sentry",
      available: true,
      setup: null,
      connect: "key",
      fields: [],
      needsSetup: false,
    },
  ];
  const list = Atom.make(() =>
    AsyncResult.success({
      orgId: "org-1",
      connections: host.connections,
      services,
      signInAddress: "",
    }),
  );
  const quiet = Atom.make(AsyncResult.initial());
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      connections: () => list,
      connection: () => quiet,
      connectionCalls: () => quiet,
      connectionAdd: {
        label: "test:connectionAdd",
        permissionAtom: () => allowed,
        run: async (_registry: unknown, { input }: { readonly input: Record<string, unknown> }) => {
          host.adds.push(input);
          if (host.refuse !== null)
            return AsyncResult.failure(
              Cause.fail(new Refused({ reason: "unavailable", message: host.refuse })),
            );
          const connection = made(String(input.label ?? "Sentry"));
          host.connections = [connection];
          return AsyncResult.success({ connection, tools: [] });
        },
      },
    } as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinConnectionsSettings } from "./KinConnections";

// An invented key: it must reach the host and never the page.
const KEY = "sntr-invented-0d9c2b7e41";

function made(label: string): KinConnection {
  return {
    connectionId: KinConnectionId.make("conn-1"),
    preset: "sentry",
    label,
    kind: "remote",
    url: null,
    urlHost: "sentry.invented",
    auth: "key",
    reach: "owner",
    state: "ready",
    paused: false,
    accountLabel: null,
    protocolVersion: null,
    instructions: null,
    instructionsDigest: null,
    acceptedInstructions: null,
    changedTools: 0,
    readTools: 0,
    createdAt: 0,
    updatedAt: 0,
    listedAt: null,
    lastOkAt: null,
    lastError: null,
  } as unknown as KinConnection;
}

function setup(refuse: string | null) {
  host.connections = [];
  host.adds = [];
  host.refuse = refuse;
}

const screen = () => (
  <AppAtomRegistryProvider>
    <KinConnectionsSettings />
  </AppAtomRegistryProvider>
);

async function addWithKey() {
  await userEvent.click(page.getByRole("button", { name: "Add service" }));
  const dialog = page.getByRole("dialog");
  await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Ambermill errors");
  await userEvent.type(dialog.getByLabelText("Key"), KEY);
  return dialog;
}

describe("adding a connection with a key", () => {
  it("sends the key once to the host, then opens the connection with the key nowhere on the page", async () => {
    setup(null);
    await using _screen = await render(screen());
    const dialog = await addWithKey();

    await userEvent.dblClick(dialog.getByRole("button", { name: "Connect" }));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByText("Ambermill errors").first()).toBeVisible();
    expect(host.adds).toHaveLength(1);
    const { key, ...rest } = host.adds[0]!;
    expect(rest).toEqual({
      orgId: KinOrgId.make("org-1"),
      service: "sentry",
      label: "Ambermill errors",
    });
    expect(Redacted.isRedacted(key)).toBe(true);
    expect(Redacted.value(key as Redacted.Redacted<string>)).toBe(KEY);
    expect(document.body.innerHTML).not.toContain(KEY);
    const values = [...document.querySelectorAll("input, textarea")].map(
      (one) => (one as HTMLInputElement).value,
    );
    expect(values).not.toContain(KEY);
  });

  it("shows the service's refusal and keeps what was typed", async () => {
    setup("Sentry refused the key.");
    await using _screen = await render(screen());
    const dialog = await addWithKey();

    await userEvent.click(dialog.getByRole("button", { name: "Connect" }));
    await expect
      .element(
        dialog.getByText(
          "The service didn't accept the key. Make a new key there and use Replace key.",
        ),
      )
      .toBeVisible();
    await expect
      .element(dialog.getByRole("textbox", { name: "Name" }))
      .toHaveValue("Ambermill errors");
    await expect.element(dialog.getByLabelText("Key")).toHaveValue(KEY);
  });

  it("asks before throwing away what was typed, and closes at once when nothing was", async () => {
    setup(null);
    await using _screen = await render(screen());
    await userEvent.click(page.getByRole("button", { name: "Add service" }));
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    const dialog = await addWithKey();
    await userEvent.keyboard("{Escape}");
    const ask = page.getByRole("alertdialog");
    await expect.element(ask.getByText("Discard what you typed?")).toBeVisible();
    await userEvent.click(ask.getByRole("button", { name: "Keep editing" }));
    await expect.element(dialog.getByLabelText("Key")).toHaveValue(KEY);

    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "Discard" }));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(host.adds).toHaveLength(0);
  });
});
