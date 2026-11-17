import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { closeKinSettings, openKinSettingsInstead } from "./kinSettingsAddress";

describe("openKinSettingsInstead", () => {
  it("opens Kin's Settings on a section in place of the agent page, and Back brings the page back", () => {
    const history = createMemoryHistory({
      initialEntries: ["/kin/env/org/chat-1?agent=finance&tab=x"],
    });
    openKinSettingsInstead(history, "check-ins", "agent");
    expect(`${history.location.pathname}${history.location.search}`).toBe(
      "/kin/env/org/chat-1?tab=x&settings=check-ins",
    );
    closeKinSettings(history);
    expect(history.location.search).toBe("?agent=finance&tab=x");
  });
});
