import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { KinAvatar } from "./KinAvatar";

describe("KinAvatar", () => {
  it("marks an agent and a person apart, each named only by the row", async () => {
    await using screen = await render(
      <ul>
        <li aria-label="Finance">
          <KinAvatar avatar={kinAgentAvatar("finance")} size="sm" />
        </li>
        <li aria-label="Meera">
          <KinAvatar avatar={{ kind: "person", seed: "person:meera" }} size="sm" />
        </li>
      </ul>,
    );
    const agent = screen.getByRole("listitem", { name: "Finance" });
    const person = screen.getByRole("listitem", { name: "Meera" });
    await expect.element(agent).toBeVisible();
    expect(
      agent.element().querySelector("[data-kin-avatar]")?.getAttribute("data-kin-avatar"),
    ).toBe("agent");
    expect(
      person.element().querySelector("[data-kin-avatar]")?.getAttribute("data-kin-avatar"),
    ).toBe("person");
    expect(screen.getByRole("img").elements()).toHaveLength(0);
  });
});
