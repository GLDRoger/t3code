import { kinTurnReceiptLine } from "@t3tools/client-runtime/kin/kinTurnReceipt";
import { EnvironmentId, KinAgentId, type KinTurnChanges } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinTurnReceipt } from "./KinTurnReceipt";

const mocks = vi.hoisted(() => ({ undo: vi.fn() }));

vi.mock(import("../state/use-atom-command"), () => ({ useAtomCommand: () => mocks.undo }) as never);
vi.mock(import("./kinClient"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return { kinClient: { agentUndoChange: { permissionAtom: () => allowed } } } as never;
});

function setup() {
  mocks.undo.mockReset();
  mocks.undo.mockResolvedValue(AsyncResult.success({}));
}

// Ambermill's Finance agent, invented entries.
const finance = KinAgentId.make("finance");
const receipt = (undone: boolean): KinTurnChanges => ({
  count: 2,
  items: [
    {
      key: "W-25",
      title: "Send the October invoice",
      what: "created",
      change: { agentId: finance, seq: 11 },
      undoable: !undone,
      undone,
    },
    {
      key: "W-26",
      title: "Chase the courier refund",
      what: "given to Meera",
      change: { agentId: finance, seq: 12 },
      undoable: false,
      undone: false,
    },
  ],
  more: 0,
});

const view = (turnChanges: KinTurnChanges) => (
  <AppAtomRegistryProvider>
    <KinTurnReceipt
      line={kinTurnReceiptLine(turnChanges) ?? ""}
      turnChanges={turnChanges}
      links={undefined}
      environmentId={EnvironmentId.make("env-1")}
      orgId="org-1"
      connected
    />
  </AppAtomRegistryProvider>
);

describe("a reply's receipt", () => {
  it("lists the turn's changes, undoes one once, and follows the refreshed reply", async () => {
    setup();
    await using screen = await render(view(receipt(false)));

    await userEvent.click(
      screen.getByRole("button", { name: "Changed W-25 and W-26. Show the changes" }),
    );
    const list = page.getByRole("list", { name: "What this reply changed" });
    await expect.element(list.getByText("Send the October invoice")).toBeVisible();
    await expect.element(list.getByText("given to Meera")).toBeVisible();
    // Only the change Kin can put back offers Undo.
    expect(list.getByRole("button").elements()).toHaveLength(1);

    await userEvent.click(list.getByRole("button", { name: "Undo W-25: created" }));
    expect(mocks.undo).toHaveBeenCalledTimes(1);
    expect(mocks.undo).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { orgId: "org-1", agentId: finance, seq: 11 },
    });

    // The host's refreshed reply arrives on the chat stream; the open list redraws from it.
    await screen.rerender(view(receipt(true)));
    await expect.element(list.getByText("created · Put back.")).toBeVisible();
    expect(list.getByRole("button").elements()).toHaveLength(0);
    expect(mocks.undo).toHaveBeenCalledTimes(1);
  });
});
