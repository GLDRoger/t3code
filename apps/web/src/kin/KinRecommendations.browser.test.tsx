import { EnvironmentId, KinOrgId, type KinRecommendationRow } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinRecommendationsSettings } from "./KinRecommendations";

const host = vi.hoisted(() => ({
  rows: [] as KinRecommendationRow[],
  calls: [] as string[],
}));

vi.mock("./kinClient", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const { appAtomRegistry: registry } = await import("../rpc/atomRegistry");
  const list = A.make(R.success({ rows: host.rows })).pipe(A.keepAlive);
  const allowed = A.make(true);
  const answer = (kind: string, outcome: string) => ({
    permissionAtom: () => allowed,
    run: async ({ input }: { readonly input: { readonly recId: string } }) => {
      host.calls.push(`${kind}:${input.recId}`);
      host.rows = host.rows.map((row) =>
        row.recId === input.recId ? { ...row, outcome, action: null } : row,
      );
      registry.set(list, R.success({ rows: host.rows }));
      return R.success({ rows: host.rows });
    },
  });
  return {
    kinClient: {
      recommendations: () => list,
      recommendationUndo: answer("undo", "Done 12 Nov. Undone since."),
      recommendationAskAgain: answer("ask_again", "Not now on 3 Nov. Kin may suggest it again."),
    },
  };
});

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { run: (input: unknown) => Promise<unknown> }) => command.run,
}));

const row = (recId: string, change: Partial<KinRecommendationRow>): KinRecommendationRow => ({
  recId,
  rule: "route_access",
  noticed: `Meera asked Chief of staff for Tech lead's work 4 times since 22 Oct. (${recId})`,
  outcome: "Waiting in Needs you.",
  postedAt: "2026-11-12T10:00:00.000Z",
  decidedAt: null,
  action: null,
  ...change,
});

function setup(rows: ReadonlyArray<KinRecommendationRow>) {
  host.rows = [...rows];
  host.calls.length = 0;
}

const settingsPage = () => (
  <AppAtomRegistryProvider>
    <KinRecommendationsSettings
      environmentId={EnvironmentId.make("env-1")}
      orgId={KinOrgId.make("org-1")}
    />
  </AppAtomRegistryProvider>
);

describe("Settings → Recommendations", () => {
  it("lists each suggestion with what came of it; Undo and Ask again act on their row", async () => {
    setup([
      row("waiting", {}),
      row("done", {
        outcome: "Done 12 Nov. Meera may message Tech lead.",
        decidedAt: "2026-11-12T10:05:00.000Z",
        action: { kind: "undo", label: "Stop Meera messaging Tech lead" },
      }),
      row("declined", {
        outcome: "Not now on 3 Nov. Kin won't suggest this before 3 Dec.",
        decidedAt: "2026-11-03T10:05:00.000Z",
        action: { kind: "ask_again", label: "Ask again" },
      }),
      row("unanswered", {
        outcome: "Not answered. Kin may suggest it again after 26 Nov.",
        action: { kind: "ask_again", label: "Ask again" },
      }),
    ]);
    await using _screen = await render(settingsPage());
    await expect.element(page.getByText("Waiting in Needs you.")).toBeVisible();
    await expect.element(page.getByText("Done 12 Nov. Meera may message Tech lead.")).toBeVisible();
    await expect.element(page.getByText(/\(waiting\)$/)).toBeVisible();
    // A waiting card is answered in Needs you: its row has no button.
    expect(page.getByRole("button", { name: "Ask again" }).elements()).toHaveLength(2);

    await userEvent.click(page.getByRole("button", { name: "Stop Meera messaging Tech lead" }));
    await expect.element(page.getByText("Done 12 Nov. Undone since.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Stop Meera messaging Tech lead" }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Ask again" }).first());
    await expect
      .element(page.getByText("Not now on 3 Nov. Kin may suggest it again."))
      .toBeVisible();
    expect(host.calls).toEqual(["undo:done", "ask_again:declined"]);
  });

  it("says what the page is for before anything was suggested", async () => {
    setup([]);
    await using _screen = await render(settingsPage());
    await expect.element(page.getByText(/^Nothing suggested yet\./)).toBeVisible();
  });
});
