import { kinNotNowUntil, type KinAttentionRow } from "@t3tools/client-runtime/kin/kinAttention";
import { EnvironmentId, KinOrgId, KinRecordKey } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const NOW = Date.UTC(2026, 10, 20, 9);

vi.mock(import("./useKinClock"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNowMinuteMs: () => NOW,
}));
vi.mock(import("./useKinAttention"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinAskAbout: () => () => null,
}));

import "~/index.css";
import { render } from "../../test/render";
import { KinAttentionItem } from "./KinAttention";

const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("org-1") };
const deal = KinRecordKey.make("DL-4");
const row = (whatsNext: KinRecordKey | null): KinAttentionRow => ({
  id: "deal_no_next_step:DL-4:1",
  factKey: "deal_no_next_step:DL-4:1",
  title: "Stock and orders system",
  detail: "Stock and orders system for Corran Tiles has no next step.",
  about: "DL-4 · Corran Tiles",
  urgent: false,
  open: { type: "record", key: deal },
  agentId: null,
  askDraft: "",
  handled: null,
  money: false,
  record: deal,
  whatsNext,
});
const handler = () => ({
  busy: null,
  problem: null,
  aside: vi.fn(async () => true),
  send: vi.fn(async () => true),
});

describe("a deal with no next step in Needs you", () => {
  it("offers What's next?, which opens the deal, and Not now, its own hold for two weeks", async () => {
    const onOpen = vi.fn();
    const answers = handler();
    await using _screen = await render(
      <ul>
        <KinAttentionItem {...target} row={row(deal)} handler={answers as never} onOpen={onOpen} />
      </ul>,
    );
    expect(page.getByRole("button", { name: "I've got it" }).elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "What's next?" }));
    expect(onOpen).toHaveBeenCalledWith({ type: "record", key: deal });
    await userEvent.click(page.getByRole("button", { name: "Not now" }));
    expect(answers.aside).toHaveBeenCalledWith(
      deal,
      "set",
      kinNotNowUntil(new Date(NOW)),
      "deal_no_next_step:DL-4:1",
    );
  });

  it("keeps I've got it on every other row", async () => {
    await using _screen = await render(
      <ul>
        <KinAttentionItem
          {...target}
          row={row(null)}
          handler={handler() as never}
          onOpen={vi.fn()}
        />
      </ul>,
    );
    await expect.element(page.getByRole("button", { name: "I've got it" })).toBeVisible();
    expect(page.getByRole("button", { name: "What's next?" }).elements()).toHaveLength(0);
  });

  it("offers Later and Not needed in the menu, mapping record rows to set-aside and non-record rows to got_it", async () => {
    const answers = handler();
    await using screen = await render(
      <ul>
        <KinAttentionItem {...target} row={row(null)} handler={answers as never} onOpen={vi.fn()} />
      </ul>,
    );
    const trigger = page.getByRole("button", {
      name: "Later or not needed for Stock and orders system",
    });
    await userEvent.click(trigger);
    await expect.element(page.getByRole("menuitem", { name: "Later" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Not needed" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Snooze until tomorrow" }).elements()).toHaveLength(
      0,
    );
    expect(page.getByRole("menuitem", { name: "Not a problem" }).elements()).toHaveLength(0);

    // Keyboard reach into Later -> Tomorrow uses the set-aside store for a row with a record.
    await userEvent.keyboard("{ArrowDown}{ArrowRight}");
    await expect.element(page.getByRole("menuitem", { name: "Tomorrow" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Monday" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "A week" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Pick a day" })).toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: "Tomorrow" }));
    expect(answers.aside).toHaveBeenCalledWith(
      deal,
      "set",
      "2026-11-21",
      "deal_no_next_step:DL-4:1",
    );

    // Pick a day on a record row opens the set-aside dialog with "Until I lift it".
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("menuitem", { name: "Later" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Pick a day" }));
    await expect.element(page.getByRole("button", { name: "Until I lift it" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Set aside" }));
    expect(answers.aside).toHaveBeenCalledWith(
      deal,
      "set",
      "2026-12-20",
      "deal_no_next_step:DL-4:1",
    );

    // Not needed maps to not_a_problem.
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("menuitem", { name: "Not needed" }));
    expect(answers.send).toHaveBeenCalledWith(
      "deal_no_next_step:DL-4:1",
      "not_a_problem",
      undefined,
    );

    // Non-record row: Later -> Tomorrow uses got_it with that day, and Pick a day has no "Until I lift it".
    const plainAnswers = handler();
    const plainRow: KinAttentionRow = {
      ...row(null),
      id: "budget_over:BUD-1",
      factKey: "budget_over:BUD-1",
      title: "Cloud spend",
      record: null,
      open: { type: "money" },
    };
    await screen.rerender(
      <ul>
        <KinAttentionItem
          {...target}
          row={plainRow}
          handler={plainAnswers as never}
          onOpen={vi.fn()}
        />
      </ul>,
    );
    const plainTrigger = page.getByRole("button", {
      name: "Later or not needed for Cloud spend",
    });
    await userEvent.click(plainTrigger);
    await userEvent.click(page.getByRole("menuitem", { name: "Later" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Tomorrow" }));
    expect(plainAnswers.send).toHaveBeenCalledWith("budget_over:BUD-1", "got_it", "2026-11-21");

    await userEvent.click(plainTrigger);
    await userEvent.click(page.getByRole("menuitem", { name: "Later" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Pick a day" }));
    expect(page.getByRole("button", { name: "Until I lift it" }).elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Later" }));
    expect(plainAnswers.send).toHaveBeenCalledWith("budget_over:BUD-1", "got_it", "2026-12-20");
  });
});
