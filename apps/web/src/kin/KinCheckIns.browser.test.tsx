import { KinAgentId, KinMemoryItemId, type KinCheckIn } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { CheckInSheet } from "./KinCheckIns";

const checkIn = (slug: string, over: Partial<KinCheckIn> = {}): KinCheckIn => ({
  scheduleId: KinMemoryItemId.make(`checkin-${slug}`),
  title: slug === "weekly" ? "Weekly brief" : "Morning check-in",
  what: "Look over the week.",
  agentId: KinAgentId.make("agent-chief"),
  agentName: "Chief of staff",
  at: "09:00",
  days: [1],
  on: true,
  runNowPending: false,
  ...over,
});
const result = {
  zone: "Europe/Oslo",
  checkIns: [],
  agents: [{ agentId: KinAgentId.make("agent-chief"), name: "Chief of staff" }],
};
const sheet = (one: KinCheckIn, onPipeline: (id: string, on: boolean) => Promise<boolean>) => (
  <CheckInSheet
    inDialog
    checkIn={one}
    result={result}
    onSave={async () => true}
    onRemove={async () => true}
    onPipeline={onPipeline}
    onClose={() => {}}
  />
);

describe("the weekly brief's sheet", () => {
  it("has the pipeline switch below Days, off until turned on, and off again", async () => {
    const onPipeline = vi.fn(async () => true);
    // router: false: the sheet is a dialog with no links of its own.
    await using _screen = await render(sheet(checkIn("weekly", { numbers: [] }), onPipeline), {
      router: false,
    });
    const toggle = page.getByRole("switch", { name: "Add the pipeline to Monday's numbers" });
    await expect.element(toggle).not.toBeChecked();
    await expect
      .element(
        page.getByText(
          "Three lines Kin counts: what's open, last week's wins and losses, and late follow-ups.",
        ),
      )
      .toBeVisible();
    await userEvent.click(toggle);
    await expect.element(toggle).toBeChecked();
    expect(onPipeline).toHaveBeenLastCalledWith("checkin-weekly", true);
    await userEvent.click(toggle);
    await expect.element(toggle).not.toBeChecked();
    expect(onPipeline).toHaveBeenLastCalledWith("checkin-weekly", false);
  });

  it("is on no other check-in's sheet", async () => {
    // router: false: the sheet is a dialog with no links of its own.
    await using _screen = await render(
      sheet(checkIn("morning"), async () => true),
      {
        router: false,
      },
    );
    await expect.element(page.getByText("Days")).toBeVisible();
    await expect
      .element(page.getByRole("switch", { name: "Add the pipeline to Monday's numbers" }))
      .not.toBeInTheDocument();
  });
});
