import { EnvironmentId, KinLeadProfile, KinPersonId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinLeadAccess } from "./KinLeadAccess";

const host = vi.hoisted(() => ({ revoked: [] as string[] }));

// The access rows load; the company's people list never does.
vi.mock("./kinClient", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const rows = {
    people: [
      {
        personId: "meera",
        displayName: "Meera",
        since: "2026-11-15T09:00:00.000Z",
        ownerLevel: true,
      },
    ],
  };
  const access = A.make(R.success(rows)).pipe(A.keepAlive);
  const pending = A.make(R.initial(true)).pipe(A.keepAlive);
  const allowed = A.make(true);
  return {
    kinClient: {
      leadAccess: () => access,
      people: () => pending,
      leadAllow: { permissionAtom: () => allowed, run: async () => R.success(rows) },
      leadDisallow: {
        permissionAtom: () => allowed,
        run: async ({ input }: { readonly input: { readonly personId: string } }) => {
          host.revoked.push(input.personId);
          return R.success({ people: [] });
        },
      },
    },
  };
});

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { run: (input: unknown) => Promise<unknown> }) => command.run,
}));

const lead = Schema.decodeSync(KinLeadProfile)({
  orgId: "ambermill",
  agentId: "finance",
  name: "Finance",
  domain: "finance",
  charter: "Handles billing questions and invoices.",
  model: "gpt-5.5",
  ownerChatId: "rhea-finance",
  working: false,
  tracking: [],
});

function setup() {
  host.revoked.length = 0;
}

describe("who can message an agent", () => {
  it("says what removing a co-owner does from the row itself, before the people list loads", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinLeadAccess
          lead={lead}
          environmentId={EnvironmentId.make("env-1")}
          personId={KinPersonId.make("rhea")}
        />
      </AppAtomRegistryProvider>,
    );
    await userEvent.click(page.getByRole("button", { name: "Remove Meera" }));
    await expect
      .element(
        page.getByText(
          "Meera is a co-owner, so they can still message Finance. This matters only if they stop being one.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Remove", exact: true }));
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Meera can still message Finance as a co-owner.");
    expect(host.revoked).toEqual(["meera"]);
  });
});
