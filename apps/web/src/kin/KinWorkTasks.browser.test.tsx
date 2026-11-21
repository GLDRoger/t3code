import {
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  KinWidgetId,
  type KinRecord,
  type KinWorkListInput,
  type KinWorkMoveCounts,
  type KinWorkRowMove,
  type KinWorkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The host: what `kin.work.list` answers, and what the act and nudge calls were sent.
const host = vi.hoisted(() => ({
  ownerLevel: true,
  records: [] as Array<unknown>,
  moves: [] as Array<unknown>,
  counts: null as unknown,
  reads: [] as Array<unknown>,
  acts: [] as Array<unknown>,
  nudges: [] as Array<unknown>,
  refuse: null as string | null,
  open: null as unknown,
}));

vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { KinChatError: Refused } = await import("@t3tools/contracts");
  const allowed = Atom.make(true);
  const command = (answer: (input: unknown) => unknown) => ({
    label: "test",
    permissionAtom: () => allowed,
    run: async (_registry: unknown, { input }: { readonly input: unknown }) => answer(input),
  });
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      workUpdate: { ...real.kinClient.workUpdate, permissionAtom: () => allowed },
      workList: command((input) => {
        host.reads.push(input);
        const byMove = (input as KinWorkListInput).byMove === true;
        return AsyncResult.success({
          records: host.records,
          total: host.records.length,
          nextCursor: null,
          seq: 1,
          asOf: "2026-11-18T09:00:00.000Z",
          ...(byMove ? { moves: host.moves, counts: host.counts } : {}),
        });
      }),
      widgetAction: command((input) => {
        host.acts.push(input);
        return host.refuse === null
          ? AsyncResult.success({})
          : AsyncResult.failure(
              Cause.fail(new Refused({ reason: "conflict", message: host.refuse })),
            );
      }),
      workNudge: command((input) => {
        host.nudges.push(input);
        return AsyncResult.success({
          key: (input as { readonly key: string }).key,
          nudgedAt: "2026-11-18T09:00:00.000Z",
          already: false,
        });
      }),
    } as never,
  };
});
vi.mock(import("./useKinOwnerLevel"), async (importOriginal) => {
  const { KIN_SCOPE_ALL } = await import("@t3tools/client-runtime/kin/kinViewerScope");
  return {
    ...(await importOriginal()),
    useKinOwnerLevel: () => host.ownerLevel,
    useKinViewerScope: () => KIN_SCOPE_ALL,
  };
});
// The host's open list; null is an older host's, where Tasks' own read counts Needs you.
vi.mock(import("./useKinOpen"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinOpen: () => host.open as never,
}));
vi.mock(import("./useKinAttention"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinAskAbout: () => () => null,
}));
vi.mock(import("./useKinWork"), async (importOriginal) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const quiet = Atom.make(AsyncResult.initial());
  return { ...(await importOriginal()), kinWorkLiveAtom: (() => quiet) as never };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinWorkTaskList } from "./KinWorkTasks";

// Ambermill, invented: owner Rhea; Meera, Zoya; agents Finance.
const rhea = { _tag: "person", personId: KinPersonId.make("ambermill-rhea") } as const;
const meera = { _tag: "person", personId: KinPersonId.make("ambermill-meera") } as const;
const zoya = { _tag: "person", personId: KinPersonId.make("ambermill-zoya") } as const;
const finance = { _tag: "agent", agentId: KinAgentId.make("ambermill-finance") } as const;
const orbit = {
  recordId: KinRecordId.make("rec-c1"),
  key: KinRecordKey.make("C-1"),
  title: "Orbit Dental",
};
const bakery = {
  recordId: KinRecordId.make("rec-p1"),
  key: KinRecordKey.make("P-1"),
  title: "Northgate Bakery website",
};

const task = (key: string, title: string, patch: Partial<KinRecord> = {}): KinRecord => ({
  recordId: KinRecordId.make(`rec-${key}`),
  orgId: KinOrgId.make("ambermill"),
  key: KinRecordKey.make(key),
  title,
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
  rev: 1,
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
  closedAt: null,
  ...patch,
});

const draft = task("T-1", "Remind Orbit Dental about the October invoice", {
  owner: finance,
  party: orbit,
});
const lateWithMeera = task("T-2", "Rewrite the appointment reminder texts", {
  owner: meera,
  late: true,
  dueAt: "2026-11-15T00:00:00.000Z",
  dueAllDay: true,
});
const bakeryForm = task("T-3", "Fix the order form on the bakery's website", {
  owner: zoya,
  project: bakery,
});

const moves: ReadonlyArray<KinWorkRowMove> = [
  {
    key: draft.key,
    group: "needsYou",
    card: {
      kind: "send",
      chatId: KinChatId.make("chat-1"),
      messageId: KinMessageId.make("message-1"),
      widgetId: KinWidgetId.make("card-1"),
      preview: "Email to their accounts team is ready.",
      files: [],
      at: "2026-11-18T08:00:00.000Z",
      revision: 2,
      options: [
        { optionId: "cancel", label: "Cancel", kind: "no" },
        { optionId: "confirm", label: "Confirm", kind: "yes" },
      ],
    },
  },
  { key: lateWithMeera.key, group: "needsYou", said: "Waiting on the clinic." },
  { key: bakeryForm.key, group: "waiting" },
];

const summary = {
  open: 3,
  doing: 0,
  waiting: 0,
  late: 1,
  closed: 4,
  owners: [],
  projects: [{ project: bakery, open: 3, late: 0, health: null }],
  seq: 1,
  asOf: "2026-11-18T09:00:00.000Z",
} as unknown as KinWorkSummary;

const people = new Map([
  [rhea.personId, "Rhea"],
  [meera.personId, "Meera"],
  [zoya.personId, "Zoya"],
]);

function setup(options: {
  readonly ownerLevel: boolean;
  readonly records: ReadonlyArray<KinRecord>;
  readonly moves: ReadonlyArray<KinWorkRowMove>;
  readonly counts: KinWorkMoveCounts;
  readonly refuse?: string;
  readonly open?: unknown;
}) {
  localStorage.clear();
  host.ownerLevel = options.ownerLevel;
  host.records = [...options.records];
  host.moves = [...options.moves];
  host.counts = options.counts;
  host.reads = [];
  host.acts = [];
  host.nudges = [];
  host.refuse = options.refuse ?? null;
  host.open = options.open ?? null;
}

// Each test its own company, so no test resumes the list another one kept.
function Tasks(props: {
  readonly me: KinPersonId;
  readonly org: string;
  readonly onOpen?: (key: KinRecordKey) => void;
}) {
  return (
    <AppAtomRegistryProvider>
      <div className="flex h-[720px] flex-col">
        <KinWorkTaskList
          environmentId={EnvironmentId.make("env-1")}
          orgId={KinOrgId.make(props.org)}
          live={{ seq: 1, summary } as never}
          stale={false}
          directory={
            {
              names: {
                people,
                agents: new Map([[finance.agentId, "Finance"]]),
                me: props.me,
                owner: rhea.personId,
                zone: "UTC",
              },
            } as never
          }
          changes={
            { state: { pending: {}, answers: {}, edit: null, notice: null }, changes: {} } as never
          }
          openKey={null}
          onOpen={props.onOpen ?? (() => {})}
          onAdd={null}
          initial={{ view: "open", owner: null, text: "", party: null, project: null }}
          choices={null}
        />
      </div>
    </AppAtomRegistryProvider>
  );
}

const headings = () =>
  page
    .getByRole("heading", { level: 3 })
    .elements()
    .map((h) => h.textContent);

describe("Tasks on the web, by whose move", () => {
  it("opens on Needs you with the host's counts, and a draft's Approve and send acts once", async () => {
    setup({
      ownerLevel: true,
      records: [draft, lateWithMeera, bakeryForm],
      moves,
      counts: { needsYou: 5, waiting: 4, rest: 0, doneRecently: 7 },
    });
    await using _screen = await render(<Tasks me={rhea.personId} org="ambermill-1" />);
    await expect.element(page.getByText("Done in the last 14 days")).toBeVisible();
    expect(headings()).toEqual(["Needs you", "Waiting on others"]);
    await expect.element(page.getByText("5", { exact: true })).toBeVisible();
    await expect.element(page.getByText("4", { exact: true })).toBeVisible();
    expect(host.reads).toContainEqual(expect.objectContaining({ byMove: true }));
    // Late is a red word on the row, not a badge.
    await expect.element(page.getByText(/^(Late|\d+ days? late)$/)).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: `Approve and send: ${draft.title}` }));
    await expect.element(page.getByText("Sent to Orbit Dental")).toBeVisible();
    expect(host.acts).toEqual([
      expect.objectContaining({ widgetId: "card-1", revision: 2, value: "confirm" }),
    ]);
  });

  it("shows the host's reason on the row when it refuses the draft", async () => {
    setup({
      ownerLevel: true,
      records: [draft],
      moves,
      counts: { needsYou: 1, waiting: 0, rest: 0, doneRecently: 0 },
      refuse: "The accounts address bounced last week.",
    });
    await using _screen = await render(<Tasks me={rhea.personId} org="ambermill-2" />);
    await userEvent.click(page.getByRole("button", { name: `Approve and send: ${draft.title}` }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The accounts address bounced last week.");
    expect(page.getByText("Sent to Orbit Dental").elements()).toHaveLength(0);
  });

  it("nudges a late holder once, then says Nudged today", async () => {
    setup({
      ownerLevel: true,
      records: [lateWithMeera],
      moves,
      counts: { needsYou: 1, waiting: 0, rest: 0, doneRecently: 0 },
    });
    await using _screen = await render(<Tasks me={rhea.personId} org="ambermill-3" />);
    await expect.element(page.getByText("Meera: “Waiting on the clinic.”")).toBeVisible();
    await userEvent.click(
      page.getByRole("button", { name: `Nudge Meera: ${lateWithMeera.title}` }),
    );
    const nudged = page.getByRole("button", { name: `Nudged today: ${lateWithMeera.title}` });
    await expect.element(nudged).toBeDisabled();
    await userEvent.click(nudged, { force: true });
    expect(host.nudges).toEqual([expect.objectContaining({ key: "T-2" })]);
  });

  it("gives a teammate their own groups and no step on a task they did not ask for", async () => {
    setup({
      ownerLevel: false,
      records: [draft, bakeryForm],
      moves: [
        { key: bakeryForm.key, group: "needsYou" },
        { key: draft.key, group: "rest" },
      ],
      counts: { needsYou: 1, waiting: 0, rest: 1, doneRecently: 0 },
    });
    await using _screen = await render(<Tasks me={zoya.personId} org="ambermill-4" />);
    await expect
      .element(
        page.getByText("You see tasks you hold, tasks you asked for, and tasks on your projects."),
      )
      .toBeVisible();
    expect(headings()).toEqual(["Needs you", "Your projects"]);
    expect(page.getByRole("button", { name: /^Approve and send/ }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: /^Nudge/ }).elements()).toHaveLength(0);
  });

  it("lists a teammate's deal with no next step under Needs you, with What's next?", async () => {
    const fact = (key: string, actor: unknown, title: string) => ({
      id: `fact:deal_no_next_step:${key}`,
      late: false,
      item: {
        _tag: "fact",
        fact: {
          sense: "deal_no_next_step",
          family: "work",
          key: `deal_no_next_step:${key}`,
          subject: { kind: "record", key, title },
          scope: { clientKey: "C-1", clientTitle: "Corran Tiles" },
          since: DateTime.makeUnsafe(Date.UTC(2026, 10, 16)),
          consequence: `${title} for Corran Tiles has no next step.`,
          actor,
          sensitive: false,
          wake: "sweep",
          handled: null,
        },
      },
    });
    setup({
      ownerLevel: false,
      records: [bakeryForm],
      moves: [{ key: bakeryForm.key, group: "needsYou" }],
      counts: { needsYou: 1, waiting: 0, rest: 0, doneRecently: 0 },
      open: {
        asOf: DateTime.makeUnsafe(Date.UTC(2026, 10, 18, 9)),
        counts: { needsYou: 3, waiting: 0 },
        rows: [
          fact("DL-1", zoya, "Corran rollout"),
          // Rhea's own deal: not Zoya's to answer.
          fact("DL-3", rhea, "Harbourline pilot"),
        ],
      },
    });
    const onOpen = vi.fn();
    await using _screen = await render(
      <Tasks me={zoya.personId} org="ambermill-6" onOpen={onOpen} />,
    );
    await expect.element(page.getByText("Corran rollout", { exact: true })).toBeVisible();
    await expect.element(page.getByText(bakeryForm.title)).toBeVisible();
    expect(page.getByText("Harbourline pilot", { exact: true }).elements()).toHaveLength(0);
    expect(page.getByText("Nothing needs you right now").elements()).toHaveLength(0);
    await expect.element(page.getByRole("button", { name: "Not now" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "What's next?" }));
    expect(onOpen).toHaveBeenCalledWith("DL-1");
  });

  it("groups by project from the filter, and the chip puts Me first back", async () => {
    setup({
      ownerLevel: true,
      records: [draft, lateWithMeera, bakeryForm],
      moves,
      counts: { needsYou: 2, waiting: 1, rest: 0, doneRecently: 0 },
    });
    await using _screen = await render(<Tasks me={rhea.personId} org="ambermill-5" />);
    await expect.element(page.getByRole("heading", { name: "Needs you" })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Filter" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "Project" }));
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("heading", { name: "Not in a project" })).toBeVisible();
    expect(headings()).toEqual([bakery.title, "Not in a project"]);
    expect(localStorage.getItem("kin:tasks:groupBy")).toContain("project");

    await userEvent.click(page.getByRole("button", { name: "Grouped by project. Clear grouping" }));
    await expect.element(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
    expect(page.getByRole("button", { name: /Clear grouping/ }).elements()).toHaveLength(0);
  });
});
