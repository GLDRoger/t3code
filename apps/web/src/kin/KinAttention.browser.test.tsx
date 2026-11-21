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
});
