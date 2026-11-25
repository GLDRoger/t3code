import type { KinOrgState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinStopSetting } from "./KinStopSetting";

const host = vi.hoisted(() => ({
  paused: null as { readonly reason: string | null } | null,
  calls: [] as Array<string>,
  show: () => {},
}));

vi.mock(import("./KinNewLeadButton"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinNewLeadTarget: () => ({ environmentId: "env-1", orgId: "org-1", lead: null }) as never,
}));

vi.mock(import("./useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinHostConnected: () => true,
}));

vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const { appAtomRegistry: registry } = await import("../rpc/atomRegistry");
  const { KinOrgId, KinPersonId } = await import("@t3tools/contracts");
  const DateTime = await import("effect/DateTime");
  const orgId = KinOrgId.make("org-1");
  const state = (): KinOrgState =>
    host.paused === null
      ? { orgId, paused: false, pausedAt: null, pausedBy: null, reason: null }
      : {
          orgId,
          paused: true,
          pausedAt: DateTime.makeUnsafe("2026-11-20T08:30:00.000Z"),
          pausedBy: KinPersonId.make("rhea"),
          reason: host.paused.reason,
        };
  const read = A.make(() => R.success(state())).pipe(A.keepAlive);
  const people = A.make(() =>
    R.success({ profiles: [{ personId: "rhea", displayName: "Rhea" }] }),
  ).pipe(A.keepAlive);
  const allowed = A.make(true);
  host.show = () => registry.refresh(read);
  const command = <C extends object>(
    real: C,
    name: string,
    act: (input: { readonly reason?: string }) => void,
  ) => ({
    ...real,
    permissionAtom: () => allowed,
    run: async (
      _registry: unknown,
      { input }: { readonly input: { readonly reason?: string } },
    ) => {
      host.calls.push(`${name}:${input.reason ?? ""}`);
      act(input);
      return R.success(state());
    },
  });
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      orgState: () => read,
      profiles: () => people as never,
      orgPause: command(real.kinClient.orgPause, "pause", (input) => {
        host.paused = { reason: input.reason ?? null };
      }),
      orgResume: command(real.kinClient.orgResume, "resume", () => {
        host.paused = null;
      }),
    },
  };
});

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (command: { run: (registry: unknown, input: unknown) => Promise<unknown> }) =>
    (input: unknown) =>
      command.run(null, input),
}));

function setup() {
  host.paused = null;
  host.calls.length = 0;
  host.show();
}

describe("Settings → Stop all agents", () => {
  it("asks once before stopping, with an optional reason, and resumes without asking", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinStopSetting />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Agents are working.")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Stop all agents" }));
    const ask = page.getByRole("alertdialog");
    await expect.element(ask.getByText(/^Every agent stops now, for everyone/)).toBeVisible();
    await userEvent.click(ask.getByRole("button", { name: "Cancel" }));
    await expect.element(ask).not.toBeInTheDocument();
    expect(host.calls).toEqual([]);

    await userEvent.click(page.getByRole("button", { name: "Stop all agents" }));
    await userEvent.type(page.getByLabelText("Reason (optional)"), "Checking a wrong invoice");
    await userEvent.click(
      page.getByRole("alertdialog").getByRole("button", { name: "Stop all agents" }),
    );
    expect(host.calls).toEqual(["pause:Checking a wrong invoice"]);
    await expect.element(page.getByText("All agents are stopped.")).toBeVisible();
    await expect.element(page.getByText(/^Stopped by Rhea, /)).toBeVisible();
    await expect.element(page.getByText("Reason: Checking a wrong invoice")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Resume" }));
    await expect.element(page.getByText("Agents are working.")).toBeVisible();
    expect(page.getByRole("alertdialog").elements()).toHaveLength(0);
    expect(host.calls).toEqual(["pause:Checking a wrong invoice", "resume:"]);
  });
});
