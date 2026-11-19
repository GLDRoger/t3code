import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("./KinNewLeadButton"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinNewLeadTarget: () => ({ environmentId: "env-1", orgId: "org-1", lead: null }) as never,
}));

import { render } from "../../test/render";
import { KinSettingsMoved } from "./KinSettingsView";

describe("an app settings address that moved into Kin's Settings", () => {
  it("opens Kin's Settings on its page at the setting a search found", async () => {
    await using screen = await render(<KinSettingsMoved page="profile" fallback={null} />, {
      router: "/settings/kin-profile#kin-quiet-hours",
    });
    await vi.waitFor(() =>
      expect(screen.router!.state.location.href).toBe("/kin?settings=profile#kin-quiet-hours"),
    );
  });
});
