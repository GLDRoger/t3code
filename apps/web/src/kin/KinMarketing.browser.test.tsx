import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";

import "~/index.css";
import { render } from "../../test/render";
import { KinCampaignResultsSection, KinTagEditor } from "./KinMarketing";

function Tags(props: { readonly start: ReadonlyArray<string> }) {
  const [tags, setTags] = useState(props.start);
  return (
    <KinTagEditor
      id="tags"
      tags={tags}
      company={["Harbour", "clinics", "newsletter"]}
      onChange={setTags}
    />
  );
}

describe("a contact's tags", () => {
  it("adds a typed tag on Enter once in any case, picks one the company uses, and takes one off", async () => {
    await using _screen = await render(<Tags start={["Harbour"]} />, { router: false });
    const field = page.getByPlaceholder("Add a tag");
    await userEvent.type(field, "harbour{Enter}");
    await expect.element(field).toHaveValue("");
    const list = page.getByRole("list", { name: "Tags" });
    expect(list.getByRole("listitem").elements()).toHaveLength(1);
    await userEvent.click(page.getByRole("button", { name: "clinics" }));
    await expect.element(list.getByText("clinics")).toBeVisible();
    expect(page.getByRole("button", { name: "clinics" }).elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Remove tag Harbour" }));
    await expect.element(page.getByRole("button", { name: "Harbour" })).toBeVisible();
    expect(list.getByRole("listitem").elements()).toHaveLength(1);
  });
});

describe("a campaign's results", () => {
  it("shows the host's counts, each currency on its own, and opens the list each one counts", async () => {
    const onOpen = vi.fn();
    await using _screen = await render(
      <KinCampaignResultsSection
        deals
        results={{
          prospects: 14,
          clients: 2,
          open: {
            count: 5,
            values: [
              { minor: 6_100_000, currency: "EUR" as never },
              { minor: 500_000, currency: "USD" as never },
            ],
          },
          won: { count: 1, values: [{ minor: 900_000, currency: "EUR" as never }] },
          audience: 212,
        }}
        audience="harbour"
        onOpen={onOpen}
      />,
      { router: false },
    );
    // Folded like the page's other blocks, its counts on the line.
    const fold = page.getByRole("button", {
      name: /Results so far\s*14 prospects · 2 clients · 5 deals · 1 won · 212 contacts/,
    });
    await expect.element(fold).toHaveAttribute("aria-expanded", "false");
    expect(page.getByRole("button", { name: /Prospects from it/ }).elements()).toHaveLength(0);
    await userEvent.click(fold);
    await expect
      .element(page.getByRole("button", { name: /Prospects from it\s*14/ }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /Deals from them\s*5 · €61,000.* · \$5,000/ }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: /People on its list\s*212 contacts/ }));
    expect(onOpen).toHaveBeenCalledWith("audience");
    await userEvent.click(page.getByRole("button", { name: /^Won/ }));
    expect(onOpen).toHaveBeenLastCalledWith("won");
  });
});
