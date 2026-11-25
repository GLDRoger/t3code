import { kinNumberDecimal, KIN_NUMBER_LOCALE_PLAIN } from "@t3tools/client-runtime/kin/kinNumbers";
import type { KinListOutcome } from "@t3tools/client-runtime/kin/kinLists";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { KinNumberTypeField } from "./KinNumberTypeField";

const REFUSED = "A teammate may only type a number shared with them.";

/** A row as the list draws it: the field until a value for today is saved, then the value. */
function Row(props: { readonly host: (value: string) => Promise<KinListOutcome<unknown>> }) {
  const [shown, setShown] = useState<string | null>(null);
  return shown !== null ? (
    <p>Today: {shown}</p>
  ) : (
    <KinNumberTypeField
      name="Daily users"
      onSave={async (typed) => {
        const read = kinNumberDecimal(typed, "users", KIN_NUMBER_LOCALE_PLAIN);
        if (!read.ok) return { ok: false, problem: read.problem, changed: false };
        const outcome = await props.host(read.value);
        if (outcome.ok) setShown(read.value);
        return outcome;
      }}
    />
  );
}

describe("KinNumberTypeField", () => {
  it("saves today's value on Enter and the row shows it", async () => {
    const host = vi.fn(async (_value: string) => ({ ok: true as const, value: { recorded: 1 } }));
    // A field and its row alone: nothing here reads a route.
    await using screen = await render(<Row host={host} />, { router: false });
    await userEvent.type(
      screen.getByRole("textbox", { name: "Today's value: Daily users" }),
      "4,210{Enter}",
    );
    await expect.element(screen.getByText("Today: 4210")).toBeVisible();
    expect(host).toHaveBeenCalledWith("4210");
  });

  it("keeps what was typed and says why when the host refuses, or it isn't a number", async () => {
    const host = vi.fn(async (_value: string) => ({
      ok: false as const,
      problem: REFUSED,
      changed: false,
    }));
    // A field and its row alone: nothing here reads a route.
    await using screen = await render(<Row host={host} />, { router: false });
    const field = screen.getByRole("textbox", { name: "Today's value: Daily users" });
    await userEvent.type(field, "12a{Enter}");
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Type a number, like 1,234.5.");
    expect(host).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, "37{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent(REFUSED);
    await expect.element(field).toHaveValue("37");
    await expect.element(field).toHaveAttribute("aria-invalid", "true");
  });
});
