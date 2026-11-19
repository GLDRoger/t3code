import {
  EnvironmentId,
  KinAgentId,
  KinConnectionId,
  KinOrgId,
  type KinRecommendationRow,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinRecommendationsSettings } from "./KinRecommendations";

const host = vi.hoisted(() => ({
  rows: [] as KinRecommendationRow[],
  calls: [] as string[],
  show: () => {},
}));

vi.mock("./kinClient", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const { appAtomRegistry: registry } = await import("../rpc/atomRegistry");
  // Read from the host on every refresh, as the page's own refresh after Ask again does.
  const list = A.make(() => R.success({ rows: host.rows })).pipe(A.keepAlive);
  const allowed = A.make(true);
  host.show = () => registry.refresh(list);
  return {
    kinClient: {
      recommendations: () => list,
      recommendationAskAgain: {
        permissionAtom: () => allowed,
        run: async ({ input }: { readonly input: { readonly recId: string } }) => {
          host.calls.push(`ask_again:${input.recId}`);
          host.rows = host.rows.map((row) =>
            row.recId === input.recId
              ? { ...row, outcome: "Not now on 3 Nov. Kin may suggest it again.", action: null }
              : row,
          );
          return R.success({ rows: host.rows });
        },
      },
    },
  };
});

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { run: (input: unknown) => Promise<unknown> }) => command.run,
}));

const row = (recId: string, change: Partial<KinRecommendationRow>): KinRecommendationRow => ({
  recId,
  rule: "route_access",
  noticed: `Noticed 12 Nov: Since 22 Oct, 4 of Meera's requests for Tech lead had to wait for your yes, and 2 ran out or waited behind another. (${recId})`,
  outcome: "Waiting in Needs you.",
  postedAt: "2026-11-12T10:00:00.000Z",
  decidedAt: null,
  action: null,
  ...change,
});

function setup(rows: ReadonlyArray<KinRecommendationRow>) {
  host.rows = [...rows];
  host.calls.length = 0;
  host.show();
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
  it("lists each suggestion with what came of it; a done one opens its agent's page, Ask again acts on its row", async () => {
    setup([
      row("waiting", {}),
      row("done", {
        outcome: "Done 12 Nov: Meera can message Tech lead.",
        decidedAt: "2026-11-12T10:05:00.000Z",
        action: {
          kind: "open_agent",
          label: "Open Tech lead's page",
          agentId: KinAgentId.make("tech"),
        },
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
    await expect.element(page.getByText("Done 12 Nov: Meera can message Tech lead.")).toBeVisible();
    await expect.element(page.getByText(/\(waiting\)$/)).toBeVisible();
    // A waiting card is answered in Needs you: its row has no button.
    expect(page.getByRole("button", { name: "Ask again" }).elements()).toHaveLength(2);

    // Who can message an agent is changed on its page: the done row only goes there.
    await expect
      .element(page.getByRole("link", { name: "Open Tech lead's page" }))
      .toHaveAttribute("href", expect.stringContaining("agent=tech"));
    await userEvent.click(page.getByRole("button", { name: "Ask again" }).first());
    await expect
      .element(page.getByText("Not now on 3 Nov. Kin may suggest it again."))
      .toBeVisible();
    expect(host.calls).toEqual(["ask_again:declined"]);
  });

  it("says what the page is for before anything was suggested", async () => {
    setup([]);
    await using _screen = await render(settingsPage());
    await expect.element(page.getByText(/^Nothing suggested yet\./)).toBeVisible();
  });

  it("a done limit or connection opens Settings where it is changed, a connection at itself", async () => {
    setup([
      row("limit", {
        rule: "daily_limit",
        outcome: "Done 12 Nov: the daily limit is Twice the usual.",
        action: { kind: "open_daily_limit", label: "Open Daily limit" },
      }),
      row("zoho", {
        rule: "connection_paused",
        outcome: "Done 12 Nov: Zoho Books is running.",
        action: {
          kind: "open_connection",
          label: "Open Zoho Books",
          connectionId: KinConnectionId.make("conn-zoho"),
        },
      }),
    ]);
    await using screen = await render(settingsPage());
    const search = () => new URLSearchParams(screen.router!.history.location.search);
    await userEvent.click(page.getByRole("button", { name: "Open Daily limit" }));
    expect(search().get("settings")).toBe("company");
    await userEvent.click(page.getByRole("button", { name: "Open Zoho Books" }));
    expect([search().get("settings"), search().get("find")]).toEqual(["connections", "conn-zoho"]);
  });
});
