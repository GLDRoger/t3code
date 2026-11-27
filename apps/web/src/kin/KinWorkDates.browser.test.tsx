import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The host: Work's dated rows, and calendar reads that fail until asked again.
const host = vi.hoisted(() => ({
  calendarAsked: [] as Array<Record<string, unknown>>,
  calendarFails: true,
}));

vi.mock(import("./kinClient"), async (importOriginal) => {
  const { commandRun } = await import("../../test/commandRun");
  const real = await importOriginal();
  const Cause = await import("effect/Cause");
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = (label: string, run: (input: Record<string, unknown>) => unknown) => ({
    label,
    permissionAtom: () => allowed,
    run: commandRun(
      async (_registry: never, { input }: { readonly input: Record<string, unknown> }) =>
        run(input),
    ),
  });
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      workDates: command("test:dates", () =>
        AsyncResult.success({
          rows: [
            {
              record: {
                recordId: "rec-1",
                orgId: "org-tidewater",
                key: "W-1",
                title: "Book the Tidewater Freight trucks",
                state: "open",
                waitingOn: null,
                owner: { _tag: "person", personId: "person-rhea" },
                category: null,
                side: "ours",
                dueAt: "2026-11-27T00:00:00.000Z",
                dueAllDay: true,
                late: false,
                confirmed: true,
                sensitive: false,
                working: false,
                pullRequest: null,
                rev: 1,
                createdAt: "2026-11-10T08:00:00.000Z",
                updatedAt: "2026-11-10T08:00:00.000Z",
                closedAt: null,
              },
              listName: "Work",
              stateLabel: "Not started",
              kind: "due",
              label: "Due",
              at: "2026-11-27T00:00:00.000Z",
              allDay: true,
            },
          ],
          nextCursor: null,
        }),
      ),
      myCalendar: command("test:calendar", (input) => {
        host.calendarAsked.push(input);
        return host.calendarFails
          ? AsyncResult.failure(Cause.die(new Error("socket closed")))
          : AsyncResult.success({
              sources: [
                {
                  connectionId: "conn-google-rhea",
                  service: "google",
                  account: "rhea@tidewater.example",
                  company: false,
                  status: "ok",
                },
              ],
              events: [
                {
                  connectionId: "conn-google-rhea",
                  id: "evt-1",
                  title: "Tidewater Freight review",
                  start: "2026-11-27",
                  end: "2026-11-28",
                  allDay: true,
                  zone: null,
                  link: "https://calendar.google.com/calendar/event?eid=abc123",
                  repeats: false,
                },
              ],
              more: false,
            });
      }),
    } as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinWorkDates } from "./KinWorkDates";

function setup() {
  host.calendarAsked = [];
  host.calendarFails = true;
}

const names = {
  people: new Map(),
  agents: new Map(),
  me: "person-rhea",
  zone: "UTC",
};

describe("Dates beside the calendar", () => {
  it("keeps Work dates when the calendar can't be read, says so once, and Try again recovers", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinWorkDates
          environmentId={"env-1" as never}
          orgId={"org-tidewater" as never}
          live={{ seq: 1 } as never}
          stale={false}
          directory={{ names } as never}
          onOpenKey={() => {}}
        />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Book the Tidewater Freight trucks")).toBeVisible();
    await expect
      .element(page.getByText("Couldn't load your calendar. Your Work dates are all here."))
      .toBeVisible();
    host.calendarFails = false;
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    await expect
      .element(page.getByRole("link", { name: /^Tidewater Freight review\./ }))
      .toHaveAttribute("href", "https://calendar.google.com/calendar/event?eid=abc123");
    await expect.element(page.getByText("Book the Tidewater Freight trucks")).toBeVisible();
    await expect
      .element(page.getByText("Couldn't load your calendar. Your Work dates are all here."))
      .not.toBeInTheDocument();
    // Try again skips the host's short-lived copy.
    expect(host.calendarAsked.map((input) => input.fresh)).toEqual([undefined, true]);
  });
});
