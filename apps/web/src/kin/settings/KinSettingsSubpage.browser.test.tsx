import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { KinSettingsSubpage, KinSettingsTrail } from "./KinSettingsSubpage";

// Settings' header slots, as the modal gives them, and a mailbox page that opens one of its rules.
function MailboxThenRule() {
  const [back, setBack] = useState<HTMLElement | null>(null);
  const [trail, setTrail] = useState<HTMLElement | null>(null);
  const [rule, setRule] = useState(false);
  return (
    <>
      <div ref={setBack} />
      <ol ref={setTrail} />
      <KinSettingsTrail value={{ back, trail, scroller: null }}>
        {rule ? (
          <KinSettingsSubpage
            title="Mail rule"
            backTo="accounts@ambermill.example"
            onBack={() => setRule(false)}
          >
            <button type="button">Run now</button>
          </KinSettingsSubpage>
        ) : (
          <KinSettingsSubpage
            title="accounts@ambermill.example"
            backTo="Connections"
            onBack={() => {}}
          >
            <ul>
              <li>
                <button type="button" onClick={() => setRule(true)}>
                  Open rule: From junipercold.example
                </button>
              </li>
            </ul>
          </KinSettingsSubpage>
        )}
      </KinSettingsTrail>
    </>
  );
}

describe("KinSettingsSubpage: where focus goes on a drill-in", () => {
  it("puts focus on the rule page's name when a rule opens from its mailbox, not on the body", async () => {
    await using _screen = await render(<MailboxThenRule />);
    await userEvent.click(
      page.getByRole("button", { name: "Open rule: From junipercold.example" }),
    );
    await expect.element(page.getByText("Mail rule", { exact: true })).toHaveFocus();
    await userEvent.click(page.getByRole("button", { name: "Back to accounts@ambermill.example" }));
    await expect
      .element(page.getByText("accounts@ambermill.example", { exact: true }))
      .toHaveFocus();
  });
});
