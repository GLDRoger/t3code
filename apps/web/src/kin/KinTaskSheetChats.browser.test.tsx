import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  type KinRecordDetail,
} from "@t3tools/contracts";
import { useLocation, useRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock(import("./useKinWork"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinWork: (() => ({ _tag: "ready", live: { seq: 1, summary: null }, stale: false })) as never,
  useKinWorkDirectory: (() => ({
    names: {
      people: new Map([["rhea", "Rhea"]]),
      agents: new Map([["chief", "Chief of staff"]]),
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
// The list's own reads are its tests'; here the task is opened by its address.
vi.mock(import("./KinWorkTasks"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinWorkTaskList: (() => <ul />) as never,
}));
// T-29 is Chief of staff's, and its draft mail waits in Rhea's chat with it.
vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  // Imports are not yet bound while a factory runs.
  const { KinAgentId, KinChatId, KinMessageId, KinOrgId, KinPersonId, KinRecordId, KinWidgetId } =
    await import("@t3tools/contracts");
  const chief = KinAgentId.make("chief");
  const item: KinRecordDetail = {
    recordId: KinRecordId.make("rec-29"),
    orgId: KinOrgId.make("ambermill"),
    key: "T-29",
    title: "Rewrite the appointment reminder texts",
    state: "doing",
    waitingOn: null,
    owner: { _tag: "agent", agentId: chief },
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
    notes: "",
    source: { chatId: null, messageId: null },
    assignedBy: { _tag: "person", personId: KinPersonId.make("rhea") },
    assignedAt: "2026-11-09T09:00:00.000Z",
    createdBy: { _tag: "person", personId: KinPersonId.make("rhea") },
    links: [],
    waiting: {
      kind: "send",
      chatId: KinChatId.make("rhea-chief"),
      messageId: KinMessageId.make("message-7"),
      widgetId: KinWidgetId.make("widget-7"),
      preview: "To the clinic: New reminder texts",
      files: [],
      at: "2026-11-15T09:00:00.000Z",
    },
    changes: [],
    seq: 4,
  };
  const workItem = A.make(R.success(item)).pipe(A.keepAlive);
  const leads = A.make(
    R.success({
      leads: [{ agentId: chief, name: "Chief of staff", ownerChatId: "rhea-chief" }],
    }),
  ).pipe(A.keepAlive);
  return {
    ...real,
    kinClient: { ...real.kinClient, workItem: () => workItem, leads: () => leads } as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinPlaceView } from "./KinPlaceView";

const tasksPath = "/kin/env-1/ambermill/tasks";
const taskPath = `${tasksPath}?task=T-29`;

// As the Tasks route does: a task opened from the list is one step on, and closing it is Back.
function Tasks() {
  const router = useRouter();
  const task = (useLocation().search as { readonly task?: string }).task;
  return (
    <KinPlaceView
      environmentId={EnvironmentId.make("env-1")}
      orgId={KinOrgId.make("ambermill")}
      place="tasks"
      tab="clients"
      onTab={() => {}}
      record={null}
      onGo={() => {}}
      openKey={task === undefined ? null : KinRecordKey.make(task)}
      onOpenKey={(key) =>
        key === null ? router.history.go(-1) : router.history.push(`${tasksPath}?task=${key}`)
      }
      dialog={null}
      onDialog={() => {}}
      docLink={() => ""}
    />
  );
}

describe("a way into a chat from a task", () => {
  it.each([
    { link: "Chat with Chief of staff", width: 1440 },
    { link: "Chat with Chief of staff", width: 390 },
    { link: "Open the draft", width: 1440 },
    { link: "Open the draft", width: 390 },
  ])("$link lands in the chat at $width wide, and Back returns to the task", async (row) => {
    await page.viewport(row.width, 900);
    await using screen = await render(
      <AppAtomRegistryProvider>
        <Tasks />
      </AppAtomRegistryProvider>,
      { router: tasksPath },
    );
    const history = screen.router!.history;
    history.push(taskPath);

    await userEvent.click(page.getByRole("link", { name: row.link }));

    await vi.waitFor(() =>
      expect(history.location.pathname).toBe("/kin/env-1/ambermill/rhea-chief"),
    );
    history.back();
    await vi.waitFor(() =>
      expect(`${history.location.pathname}${history.location.search}`).toBe(taskPath),
    );
  });
});
