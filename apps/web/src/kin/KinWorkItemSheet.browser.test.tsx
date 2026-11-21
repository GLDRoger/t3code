import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinRecordDetail,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The host: the task as read, what each update was sent, and a refusal it answers with when set.
const host = vi.hoisted(() => ({
  item: null as unknown,
  updates: [] as Array<Record<string, unknown>>,
  refuse: null as string | null,
}));

vi.mock(import("./useKinWork"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinWork: (() => ({ _tag: "ready", live: { seq: 1, summary: null }, stale: false })) as never,
  useKinWorkDirectory: (() => ({
    names: {
      people: new Map([["rhea", "Rhea"]]),
      agents: new Map(),
      me: KinPersonId.make("rhea"),
      zone: null,
    },
  })) as never,
  useKinWorkItemWatch: () => {},
}));
vi.mock(import("./useKinPlaces"), () => ({
  useKinDestinations: (() => ({
    destinations: ["chats", "tasks", "money", "clients", "docs"],
    known: true,
  })) as never,
}));
vi.mock(import("./useKinMoney"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinAskAgent: () => null,
  useKinLists: (() => ({ state: { _tag: "loading" } })) as never,
}));
vi.mock(import("./useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinHostConnected: () => true,
}));
// The list's own reads are its tests'; here the task is opened by its address.
vi.mock(import("./KinWorkTasks"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinWorkTaskList: (() => <ul />) as never,
}));
vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { KinChatError: Refused } = await import("@t3tools/contracts");
  const allowed = Atom.make(true);
  const workItem = Atom.make(() => AsyncResult.success(host.item));
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      workItem: () => workItem,
      workUpdate: {
        label: "test:workUpdate",
        permissionAtom: () => allowed,
        run: async (_registry: unknown, { input }: { readonly input: Record<string, unknown> }) => {
          host.updates.push(input);
          if (host.refuse !== null)
            return AsyncResult.failure(
              Cause.fail(new Refused({ reason: "not_allowed", message: host.refuse })),
            );
          const { orgId: _org, key: _key, rev, ...changed } = input;
          return AsyncResult.success({
            ...(host.item as KinRecordDetail),
            ...changed,
            rev: Number(rev) + 1,
          });
        },
      },
    } as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinPlaceView } from "./KinPlaceView";

const orgId = KinOrgId.make("ambermill");
const rhea = { _tag: "person", personId: KinPersonId.make("rhea") } as const;

// Each test opens its own task: answers the host gave are shared by every screen on the page.
function setup(key: string, refuse: string | null) {
  const item: KinRecordDetail = {
    recordId: KinRecordId.make(`rec-${key}`),
    orgId,
    key: KinRecordKey.make(key),
    title: "Book the Ambermill van",
    state: "open",
    waitingOn: null,
    owner: rhea,
    category: null,
    side: "ours",
    dueAt: null,
    dueAllDay: false,
    late: false,
    confirmed: true,
    sensitive: false,
    working: false,
    pullRequest: null,
    rev: 4,
    createdAt: "2026-11-09T09:00:00.000Z",
    updatedAt: "2026-11-15T09:00:00.000Z",
    closedAt: null,
    notes: "For the Saturday fair.",
    source: { chatId: null, messageId: null },
    assignedBy: rhea,
    assignedAt: "2026-11-09T09:00:00.000Z",
    createdBy: rhea,
    links: [],
    changes: [],
    seq: 4,
  } as unknown as KinRecordDetail;
  host.item = item;
  host.updates = [];
  host.refuse = refuse;
  return item;
}

const screen = (key: string) =>
  render(
    <AppAtomRegistryProvider>
      <KinPlaceView
        environmentId={EnvironmentId.make("env-1")}
        orgId={orgId}
        place="tasks"
        tab="clients"
        onTab={() => {}}
        record={null}
        onGo={() => {}}
        openKey={KinRecordKey.make(key)}
        onOpenKey={() => {}}
        dialog={null}
        onDialog={() => {}}
        docLink={() => ""}
        onLeave={() => {}}
      />
    </AppAtomRegistryProvider>,
    { router: "/kin/env-1/ambermill/tasks" },
  );

async function retitle(title: string) {
  await userEvent.click(page.getByRole("button", { name: "Edit the brief" }));
  const box = page.getByRole("textbox", { name: "Title" });
  await userEvent.clear(box);
  await userEvent.type(box, title);
  return box;
}

describe("changing a task from its sheet", () => {
  it("saves the edited title at the revision it was read at, then a double click marks it done once", async () => {
    await page.viewport(1440, 900);
    setup("T-41", null);
    await using _screen = await screen("T-41");

    await retitle("Book the Ambermill van and driver");
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await expect.element(page.getByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
    expect(host.updates).toEqual([
      { orgId, key: "T-41", rev: 4, title: "Book the Ambermill van and driver" },
    ]);

    await userEvent.dblClick(page.getByRole("button", { name: "Mark done" }).first());
    await expect.element(page.getByRole("button", { name: "Reopen" }).first()).toBeVisible();
    expect(host.updates.slice(1)).toEqual([{ orgId, key: "T-41", rev: 5, state: "done" }]);
  });

  it("shows the host's refusal and keeps the title as typed", async () => {
    await page.viewport(1440, 900);
    setup("T-42", "Only Rhea can change this task.");
    await using _screen = await screen("T-42");

    const box = await retitle("Book the Ambermill van and driver");
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await expect.element(page.getByText("Only Rhea can change this task.")).toBeVisible();
    await expect.element(box).toHaveValue("Book the Ambermill van and driver");
  });
});
