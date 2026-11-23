import type { EnvironmentId, KinBrief, KinBriefSaveInput, KinOrgId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinBriefsSetting } from "./KinBriefs";

const host = vi.hoisted(() => ({
  briefs: [] as KinBrief[],
  saves: [] as Omit<KinBriefSaveInput, "orgId">[],
  show: () => {},
}));

vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const { appAtomRegistry: registry } = await import("../rpc/atomRegistry");
  const read = A.make(() => R.success({ zone: "Pacific/Auckland", briefs: host.briefs })).pipe(
    A.keepAlive,
  );
  host.show = () => registry.refresh(read);
  return {
    ...real,
    refreshKinBriefs: () => host.show(),
    kinClient: {
      ...real.kinClient,
      briefs: () => read,
      briefSave: {
        ...real.kinClient.briefSave,
        run: async (_registry: unknown, { input }: { readonly input: KinBriefSaveInput }) => {
          const { orgId: _orgId, ...change } = input;
          host.saves.push(change);
          host.briefs = host.briefs.map((brief) =>
            brief.kind === input.kind
              ? { ...brief, at: input.at, days: input.days, on: input.on }
              : brief,
          );
          return R.success({ zone: "Pacific/Auckland", briefs: host.briefs });
        },
      },
    },
  };
});

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (command: { run: (registry: unknown, input: unknown) => Promise<unknown> }) =>
    (input: unknown) =>
      command.run(null, input),
}));

const weekdays = [1, 2, 3, 4, 5];

function setup(briefs: KinBrief[]) {
  host.briefs = briefs;
  host.saves.length = 0;
  host.show();
}

const setting = () => (
  <AppAtomRegistryProvider>
    <KinBriefsSetting environmentId={"env-1" as EnvironmentId} orgId={"org-1" as KinOrgId} />
  </AppAtomRegistryProvider>
);

describe("Settings → Briefs", () => {
  it("a teammate's morning page: off and on again, and its own time and days", async () => {
    setup([{ kind: "morning", at: "08:00", days: weekdays, around: false, on: true, page: true }]);
    await using _screen = await render(setting());
    await expect.element(page.getByText("Morning page")).toBeVisible();
    await expect.element(page.getByText("08:00 · Weekdays")).toBeVisible();
    await expect.element(page.getByText(/Times are in/)).toBeVisible();

    // The switch says on or off; the line keeps saying when.
    await userEvent.click(page.getByRole("switch", { name: "Morning page: On" }));
    await expect.element(page.getByRole("switch", { name: "Morning page: Off" })).not.toBeChecked();
    await expect.element(page.getByText("08:00 · Weekdays", { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("switch", { name: "Morning page: Off" }));
    await expect.element(page.getByRole("switch", { name: "Morning page: On" })).toBeChecked();
    expect(host.saves.map((save) => [save.on, save.changed])).toEqual([
      [false, ["on"]],
      [true, ["on"]],
    ]);

    await userEvent.click(page.getByRole("button", { name: "Edit brief: Morning page" }));
    const sheet = page.getByRole("dialog");
    await expect.element(sheet.getByText("Morning page")).toBeVisible();
    await userEvent.fill(sheet.getByLabelText("Time"), "07:15");
    await userEvent.click(sheet.getByRole("button", { name: "Fri" }));
    await userEvent.click(sheet.getByRole("button", { name: "Save brief" }));
    await expect.element(sheet).not.toBeInTheDocument();
    await expect.element(page.getByText("07:15 · Mon, Tue, Wed, Thu")).toBeVisible();
    expect(host.saves.at(-1)).toEqual({
      kind: "morning",
      at: "07:15",
      days: [1, 2, 3, 4],
      on: true,
      changed: ["at", "days"],
    });
  });

  it("the owner's morning brief keeps coming: it has no switch", async () => {
    setup([{ kind: "morning", at: "09:30", days: [0, 1, 2, 3, 4, 5, 6], around: true, on: true }]);
    await using _screen = await render(setting());
    await expect.element(page.getByText("Morning brief")).toBeVisible();
    await expect.element(page.getByText("Around 09:30 · Every day")).toBeVisible();
    expect(page.getByRole("switch").elements()).toHaveLength(0);
  });
});
