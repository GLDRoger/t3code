import { EnvironmentId, KinPersonId, type KinWidget } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { KinCardGroup } from "./KinCardGroup";

vi.mock(import("../connection/catalog"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: { catalogValueAtom: Atom.make({ isReady: false, entries: new Map() }) },
  } as never;
});
vi.mock(import("../state/server"), async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make([
    { models: [{ slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }] },
  ]);
  const real = await importOriginal();
  return {
    ...real,
    serverEnvironment: { ...real.serverEnvironment, providersValueAtom: () => providers },
  } as never;
});
vi.mock(import("./useKinClock"), () => ({
  useNowMinuteMs: () => Date.parse("2026-11-20T09:10:00.000Z"),
}));

const ENV = EnvironmentId.make("env-1");
const RHEA = KinPersonId.make("rhea");

const card = (widgetId: string, type: string, state: unknown): KinWidget =>
  ({
    orgId: "org-1",
    chatId: "cos-rhea",
    widgetId,
    messageId: `m-${widgetId}`,
    widgetClass: "native",
    type,
    revision: 1,
    state,
    source: null,
    feed: null,
    awaiting: [],
    pinnedAt: null,
    closedAt: null,
    updatedAt: "2026-11-20T09:00:00.000Z",
  }) as unknown as KinWidget;

const QUESTION =
  "Start both invoice drafts for Northwind now (the March one first, then April, each checked against the ledger and sent to Meera for review before anything goes out to the client)?";

const question = card("choice:q1", "choice", {
  question: QUESTION,
  detail: "Meera reviews both before they go.",
  options: [
    { optionId: "both", label: "Start both", kind: "yes" },
    { optionId: "later", label: "Later", kind: "no" },
  ],
  answer: {
    optionId: "both",
    personId: "rhea",
    via: "tap",
    emoji: null,
    answeredAt: "2026-11-20T09:01:00.000Z",
  },
});

const task = (id: string, status: string, model: string | null) =>
  card(`task:${id}`, "task", {
    taskId: id,
    environmentId: "env-1",
    threadId: `thread-${id}`,
    remoteEnvironmentId: null,
    title: `Draft the ${id} invoice`,
    model,
    status,
    pullRequests: [],
    lastError: null,
    updatedAt: "2026-11-20T09:00:00.000Z",
  });

describe("grouped cards", () => {
  it("draws the question, its answer and one row per task that opens that task's thread", async () => {
    await using screen = await render(
      <KinCardGroup
        question={question}
        tasks={[task("march", "working", "claude-sonnet-5-5"), task("april", "done", "gpt-x-raw")]}
        environmentId={ENV}
        viewerPersonId={RHEA}
      />,
    );
    await expect.element(screen.getByText("Starting both.")).toBeVisible();
    const march = screen.getByRole("link", { name: "Draft the march invoice" });
    await expect.element(march).toHaveAttribute("href", "/env-1/thread-march");
    await expect
      .element(screen.getByRole("link", { name: "Draft the april invoice" }))
      .toHaveAttribute("href", "/env-1/thread-april");
    await expect.element(screen.getByText("Working")).toBeVisible();
    await expect.element(screen.getByText("Done")).toBeVisible();
    // Settings' name for a model it lists; nothing at all for one it doesn't.
    await expect.element(screen.getByText("Claude Sonnet 5.5")).toBeVisible();
    await expect.element(screen.getByText("gpt-x-raw")).not.toBeInTheDocument();
  });

  it("clamps the question to three lines and shows all of it, with its detail, on tap", async () => {
    await using _frame = await render(
      <div style={{ width: 320 }}>
        <KinCardGroup
          question={question}
          tasks={[task("march", "working", null)]}
          environmentId={ENV}
          viewerPersonId={RHEA}
        />
      </div>,
    );
    const toggle = page.getByRole("button", { name: QUESTION });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.element(toggle).toHaveClass(/line-clamp-3/);
    await expect
      .element(page.getByText("Meera reviews both before they go."))
      .not.toBeInTheDocument();
    await userEvent.click(toggle);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(toggle).not.toHaveClass(/line-clamp-3/);
    await expect.element(page.getByText("Meera reviews both before they go.")).toBeVisible();
  });

  it("draws tasks alone under one Tasks label, a failed one with what went wrong", async () => {
    const failed = card("task:may", "task", {
      ...(task("may", "failed", null).state as object),
      lastError: "The ledger was locked.",
    });
    await using screen = await render(
      <KinCardGroup
        question={undefined}
        tasks={[task("march", "cancelled", null), failed]}
        environmentId={ENV}
        viewerPersonId={RHEA}
      />,
    );
    await expect.element(screen.getByText("Tasks")).toBeVisible();
    await expect.element(screen.getByText("Cancelled")).toBeVisible();
    await expect.element(screen.getByText("Failed")).toBeVisible();
    await expect.element(screen.getByText("The ledger was locked.")).toBeVisible();
  });
});
