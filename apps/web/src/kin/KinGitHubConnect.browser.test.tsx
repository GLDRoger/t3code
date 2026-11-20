import type { KinGitHubAgents } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { KinGitHubInstantLine } from "./KinGitHubConnect";

const agents: KinGitHubAgents = {
  as: "app",
  appName: "Invented Kin",
  problem: null,
  watched: 4,
  installed: 4,
  without: [],
  ownerUses: [],
};
const settingsUrl = "https://github.com/settings/apps/invented-kin/permissions";

describe("how fast Kin hears from GitHub", () => {
  it("names the events to tick and opens GitHub's page outside Kin", async () => {
    await using _screen = await render(
      <KinGitHubInstantLine
        agents={{
          ...agents,
          instant: { state: "events", missing: ["Pull request"], settingsUrl, last: null },
        }}
        now={0}
      />,
      { router: false }, // The row has no links inside Kin.
    );
    await expect.element(page.getByText("Events to tick")).toBeVisible();
    await expect.element(page.getByText(/tick "Pull request" under Subscribe/)).toBeVisible();
    const link = page.getByRole("link", { name: "Open Permissions & events" });
    await expect.element(link).toHaveAttribute("href", settingsUrl);
    await expect.element(link).toHaveAttribute("target", "_blank");
    await expect.element(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("draws nothing when the status carries no instant, as for a teammate", async () => {
    await using _screen = await render(<KinGitHubInstantLine agents={agents} now={0} />, {
      router: false, // The row has no links inside Kin.
    });
    await expect.element(page.getByText("How fast Kin hears from GitHub")).not.toBeInTheDocument();
  });
});
