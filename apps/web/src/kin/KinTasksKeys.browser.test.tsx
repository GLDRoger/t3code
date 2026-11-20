import { EnvironmentId, KinOrgId, KinPersonId, type KinTasksKey } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinTasksKeysSection } from "./KinTasksKeys";

const host = vi.hoisted(() => ({ keys: [] as KinTasksKey[] }));

vi.mock("./kinClient", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const contracts = await import("@t3tools/contracts");
  const { appAtomRegistry: registry } = await import("../rpc/atomRegistry");
  const keys = A.make(R.success({ keys: host.keys })).pipe(A.keepAlive);
  const allowed = A.make(true);
  const show = () => registry.set(keys, R.success({ keys: [...host.keys] }));
  return {
    kinClient: {
      tasksKeys: () => keys,
      tasksKeyIssue: {
        permissionAtom: () => allowed,
        run: async ({ input }: { readonly input: { readonly label: string } }) => {
          const key: KinTasksKey = {
            sessionId: contracts.AuthSessionId.make("key-1"),
            personId: contracts.KinPersonId.make("meera"),
            label: input.label,
            createdAt: "2026-11-15T09:00:00.000Z",
            expiresAt: "2026-12-15T09:00:00.000Z",
            lastUsedAt: null,
          };
          host.keys.push(key);
          show();
          return R.success({ key, secret: "sekret-123", path: contracts.KIN_TASKS_KEY_PATH });
        },
      },
      tasksKeyRevoke: {
        permissionAtom: () => allowed,
        run: async ({ input }: { readonly input: { readonly sessionId: string } }) => {
          host.keys.splice(
            host.keys.findIndex((key) => key.sessionId === input.sessionId),
            1,
          );
          show();
          return R.success({ revoked: true });
        },
      },
    },
  };
});

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { run: (input: unknown) => Promise<unknown> }) => command.run,
}));

vi.mock("../state/session", async () => {
  const { some } = await import("effect/Option");
  return { usePreparedConnection: () => some({ httpBaseUrl: "https://kin.ambermill.example/" }) };
});

function setup() {
  host.keys.length = 0;
}

describe("coding agent keys on your own profile", () => {
  it("makes a key, shows it once with the address, then lists and removes it", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinTasksKeysSection
          environmentId={EnvironmentId.make("env-1")}
          orgId={KinOrgId.make("org-1")}
          personId={KinPersonId.make("meera")}
          holder={null}
        />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("No keys yet.")).toBeVisible();
    await expect
      .element(page.getByLabelText("Address", { exact: true }))
      .toHaveValue("https://kin.ambermill.example/kin/you/mcp");
    await expect
      .element(page.getByLabelText("Claude Code", { exact: true }))
      .not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "How to set it up" }));
    await expect
      .element(page.getByText("Each line has YOUR_KEY where your key goes.", { exact: false }))
      .toBeVisible();
    for (const agent of ["Claude Code", "Codex", "Cursor", "Another MCP client"]) {
      await expect.element(page.getByLabelText(agent, { exact: true })).toBeVisible();
    }
    await expect
      .element(page.getByLabelText("Claude Code", { exact: true }))
      .toHaveValue(
        'claude mcp add --transport http --scope user kin https://kin.ambermill.example/kin/you/mcp --header "Authorization: Bearer YOUR_KEY"',
      );

    await userEvent.click(page.getByRole("button", { name: "Make a coding agent key" }));
    await userEvent.type(page.getByLabelText("What is it for?"), "Work laptop");
    await userEvent.click(page.getByRole("button", { name: "Make key" }));

    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Key made: Work laptop")).toBeVisible();
    await expect.element(dialog.getByLabelText("Key", { exact: true })).toHaveValue("sekret-123");
    await expect
      .element(dialog.getByLabelText("Address", { exact: true }))
      .toHaveValue("https://kin.ambermill.example/kin/you/mcp");
    await expect
      .element(dialog.getByLabelText("Claude Code", { exact: true }))
      .toHaveValue(
        'claude mcp add --transport http --scope user kin https://kin.ambermill.example/kin/you/mcp --header "Authorization: Bearer sekret-123"',
      );

    await userEvent.click(dialog.getByRole("button", { name: "Done" }));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByText("sekret-123")).not.toBeInTheDocument();
    await expect.element(page.getByText("Work laptop")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Remove Work laptop" }));
    await expect.element(page.getByText('Remove "Work laptop"?')).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Remove key" }));
    await expect.element(page.getByText("No keys yet.")).toBeVisible();
    expect(host.keys).toEqual([]);
  });

  it("shows a teammate's keys without an address or setup lines", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinTasksKeysSection
          environmentId={EnvironmentId.make("env-1")}
          orgId={KinOrgId.make("org-1")}
          personId={KinPersonId.make("dev")}
          holder="Dev"
        />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Dev has no coding agent keys.")).toBeVisible();
    await expect.element(page.getByLabelText("Address", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "How to set it up" }))
      .not.toBeInTheDocument();
  });
});
