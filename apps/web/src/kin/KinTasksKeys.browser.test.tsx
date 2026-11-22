import {
  AuthSessionId,
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  type KinTasksKey,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinTasksKeysSection } from "./KinTasksKeys";

const host = vi.hoisted(() => ({ keys: [] as KinTasksKey[], show: () => {} }));

vi.mock("./kinClient", async (importOriginal) => {
  const real = await importOriginal<typeof import("./kinClient")>();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const contracts = await import("@t3tools/contracts");
  const { appAtomRegistry: registry } = await import("../rpc/atomRegistry");
  const keys = A.make(R.success({ keys: host.keys })).pipe(A.keepAlive);
  const allowed = A.make(true);
  const show = () => registry.set(keys, R.success({ keys: [...host.keys] }));
  host.show = show;
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
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

vi.mock("../state/session", async (importOriginal) => {
  const { some } = await import("effect/Option");
  return {
    ...(await importOriginal<typeof import("../state/session")>()),
    usePreparedConnection: () => some({ httpBaseUrl: "https://kin.ambermill.example/" }),
  };
});

function setup(keys: KinTasksKey[] = []) {
  host.keys.length = 0;
  host.keys.push(...keys);
  host.show();
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
    // Folded until asked for: most people never use one.
    await expect.element(page.getByText("No keys yet.")).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Show" }));
    await expect.element(page.getByText("No keys yet.")).toBeVisible();
    await expect.element(page.getByLabelText("Address", { exact: true })).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "How to set it up" }));
    const guide = page.getByRole("dialog");
    await expect
      .element(guide.getByLabelText("Address", { exact: true }))
      .toHaveValue("https://kin.ambermill.example/kin/you/mcp");
    await expect
      .element(guide.getByText("Each line has YOUR_KEY where your key goes.", { exact: false }))
      .toBeVisible();
    for (const agent of ["Claude Code", "Codex", "Cursor", "Another MCP client"]) {
      await expect.element(guide.getByLabelText(agent, { exact: true })).toBeVisible();
    }
    await expect
      .element(guide.getByLabelText("Claude Code", { exact: true }))
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

  it("shows a teammate's keys without an address or setup lines, and nothing when they have none", async () => {
    setup([
      {
        sessionId: AuthSessionId.make("key-dev"),
        personId: KinPersonId.make("dev"),
        label: "Dev's laptop",
        createdAt: "2026-11-15T09:00:00.000Z",
        expiresAt: "2026-12-15T09:00:00.000Z",
        lastUsedAt: null,
      },
    ]);
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
    await expect.element(page.getByText("Dev's laptop")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Remove Dev's laptop" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "How to set it up" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Make a key" })).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Remove Dev's laptop" }));
    await userEvent.click(page.getByRole("button", { name: "Remove key" }));
    await expect.element(page.getByText("Coding agent keys")).not.toBeInTheDocument();
  });
});
