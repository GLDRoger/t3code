import {
  EnvironmentId,
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinDealPage as KinDealPageValue,
  type KinDealRow,
  type KinDealsResult,
  type KinDealStagesResult,
  type KinShell,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  deals: null as unknown,
  page: null as unknown,
  stages: null as unknown,
  move: null as unknown as (...args: Array<unknown>) => unknown,
  update: null as unknown as (...args: Array<unknown>) => unknown,
  setStages: null as unknown as (...args: Array<unknown>) => unknown,
  setQuietDays: null as unknown as (...args: Array<unknown>) => unknown,
}));

vi.mock(import("./useKinDeals"), () => {
  const ready = (value: unknown) => ({
    state: { _tag: "ready", value, stale: false },
    refresh: () => {},
  });
  const done = (deal: unknown) => ({ ok: true, value: { deal } });
  return {
    useKinDeals: (() => ready(state.deals)) as never,
    useKinDealPage: (() => ready(state.page)) as never,
    useKinDealStages: (() => ready(state.stages)) as never,
    useKinDealSend: (() => ({
      move: async (deal: unknown, to: unknown) => {
        state.move(deal, to);
        return done(deal);
      },
      update: async (input: unknown) => {
        state.update(input);
        return done(null);
      },
      create: async () => done(null),
      step: async () => done(null),
    })) as never,
    useKinDealStagesSet: (() => async (input: unknown) => {
      state.setStages(input);
      return { ok: true, value: state.stages };
    }) as never,
    useKinDealQuietDaysSet: (() => async (days: unknown) => {
      state.setQuietDays(days);
      return { ok: true, value: state.stages };
    }) as never,
  };
});

vi.mock(import("./useKinMoney"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinRates: () => null,
  useKinHomeCurrency: () => "EUR",
  useKinAskAgent: () => null,
  useKinLists: (() => ({ state: { _tag: "loading" } })) as never,
}));

// The company's sections as `kin.access.me` has them; the switch's save writes them here.
const shell = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    held: null as unknown,
    canSet: true,
    answer: null as null | ((sent: unknown) => unknown),
    listeners,
    put(next: unknown) {
      this.held = next;
      for (const listener of listeners) listener();
    },
  };
});
vi.mock(import("./useKinShell"), async () => {
  const { useSyncExternalStore } = await import("react");
  const { kinSectionNamed, kinSectionNamedWords, kinSectionOn, kinShellChanged } =
    await import("@t3tools/client-runtime/kin/kinShell");
  const useKinShell = () =>
    useSyncExternalStore(
      (listener) => {
        shell.listeners.add(listener);
        return () => shell.listeners.delete(listener);
      },
      () => shell.held,
    ) as never;
  return {
    useKinShell,
    useKinSectionOn: ((_: unknown, id: "deals") => kinSectionOn(useKinShell(), id)) as never,
    useKinSectionNamed: (() => {
      const held = useKinShell();
      return (text: string) => kinSectionNamed(held, text);
    }) as never,
    useKinSectionWords: ((_: unknown, words: object) =>
      kinSectionNamedWords(useKinShell(), words)) as never,
    useKinSectionCanSet: () => shell.canSet,
    useKinSectionSet: (() => async (held: never, change: never) => {
      const sent = kinShellChanged(held, change);
      const answer = shell.answer?.(sent);
      if (answer !== undefined) return answer;
      const value = { rev: sent.rev + 1, sections: sent.shell.sections };
      shell.put(value);
      return { ok: true, value };
    }) as never,
  };
});
vi.mock(import("./useKinWork"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinWork: (() => ({
    _tag: "ready",
    live: { seq: 1, summary: { parties: {} } },
    stale: false,
  })) as never,
  useKinWorkDirectory: (() => ({
    names: { people: new Map(), agents: new Map(), me: null, zone: null },
  })) as never,
}));
vi.mock(import("./useKinPlaces"), () => ({
  useKinDestinations: (() => ({
    destinations: ["chats", "tasks", "money", "clients", "docs"],
    known: true,
  })) as never,
}));
vi.mock(import("./useKinOwnerLevel"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinOwnerLevel: () => true,
  useKinSeesClients: () => true,
}));
// The Clients tab's own list is its tests'; here it is only where a hidden Deals tab lands.
vi.mock(import("./KinWorkClients"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinWorkClientsList: (() => <p>Every client</p>) as never,
}));

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinDealPage } from "./KinDealPage";
import { KinDealsTab } from "./KinDeals";
import { KinDealStagesSettings } from "./KinDealsSetting";
import { KinPlaceView } from "./KinPlaceView";
import { KinSectionsSettings } from "./settings/KinSectionSwitch";

const zoya = KinPersonId.make("person-zoya");
const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("org-1") };
const directory = {
  names: { people: new Map([[zoya, "Zoya"]]), agents: new Map(), me: zoya, zone: null },
} as never;
const stages = [
  { id: "new", name: "New" },
  { id: "in-talks", name: "In talks" },
  { id: "proposal", name: "Proposal" },
];
const deal = (n: number, title: string, over: Partial<KinDealRow> = {}): KinDealRow => ({
  recordId: KinRecordId.make(`rec-${n}`),
  key: KinRecordKey.make(`DL-${n}`),
  title,
  state: "open",
  stage: "new",
  expectedAt: null,
  expectedAllDay: false,
  party: {
    recordId: KinRecordId.make("rec-c1"),
    key: KinRecordKey.make("C-1"),
    title: "Brightwater Clinics",
  },
  owner: { _tag: "person", personId: zoya },
  sensitive: false,
  next: null,
  can: { edit: true, move: true, give: true, mark: false },
  rev: 3,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  closedAt: null,
  ...over,
});
const dealsOn: KinShell = {
  rev: 0,
  sections: ["clients", "deals", "money", "invoices", "docs"].map((id) => ({ id, on: true })),
};
const step = (title: string, late: boolean) => ({
  key: KinRecordKey.make(`T-${title.length}`),
  title,
  dueAt: null,
  dueAllDay: false,
  late,
});

function setup(input: {
  readonly deals?: ReadonlyArray<KinDealRow>;
  readonly page?: KinDealPageValue;
  readonly stages?: KinDealStagesResult;
  /** The company's sections; Deals on unless given. */
  readonly shell?: KinShell | undefined;
  readonly canSet?: boolean;
}) {
  state.deals = {
    stages,
    deals: input.deals ?? [],
    more: 0,
    open: { count: input.deals?.length ?? 0, values: [{ minor: 2_100_000, currency: "EUR" }] },
    canCreate: true,
    seq: 1,
    asOf: "2026-11-20T00:00:00.000Z",
  } satisfies KinDealsResult;
  state.page = input.page ?? null;
  state.stages = input.stages ?? null;
  state.move = vi.fn();
  state.update = vi.fn();
  state.setStages = vi.fn();
  state.setQuietDays = vi.fn();
  shell.put(input.shell === undefined ? dealsOn : input.shell);
  shell.canSet = input.canSet ?? true;
  shell.answer = null;
  return {
    move: state.move,
    update: state.update,
    setStages: state.setStages,
    setQuietDays: state.setQuietDays,
  };
}

const board = () => (
  <AppAtomRegistryProvider>
    <KinDealsTab
      {...target}
      directory={directory}
      selected={null}
      onOpen={() => {}}
      onNew={() => {}}
    />
  </AppAtomRegistryProvider>
);

describe("the deals board", () => {
  it("shows the company's stages as columns, and each card's next step, none, or lateness", async () => {
    await page.viewport(1440, 900);
    setup({
      deals: [
        deal(1, "Shop fit-out"),
        deal(2, "Clinic scheduling pilot", {
          stage: "in-talks",
          next: step("Call Ingrid", false),
          value: { minor: 1_800_000, currency: "EUR" },
        }),
        deal(3, "Warehouse picking robots", {
          stage: "proposal",
          next: step("Send the revised proposal", true),
        }),
      ],
    });
    await using _screen = await render(board());
    await expect.element(page.getByRole("listitem", { name: "New, 1" })).toBeVisible();
    await expect.element(page.getByRole("listitem", { name: "In talks, 1" })).toBeVisible();
    await expect.element(page.getByRole("listitem", { name: "Proposal, 1" })).toBeVisible();
    await expect.element(page.getByText("No next step")).toHaveAttribute("data-tone", "missing");
    await expect.element(page.getByText("Next: Call Ingrid")).toHaveAttribute("data-tone", "plain");
    await expect
      .element(page.getByText("Late: Send the revised proposal"))
      .toHaveAttribute("data-tone", "late");
  });

  it("moves a card by its menu, asks why before Lost, and by Shift+Arrow from the keyboard", async () => {
    await page.viewport(1440, 900);
    const shop = deal(1, "Shop fit-out");
    const { move } = setup({ deals: [shop] });
    await using _screen = await render(board());

    await userEvent.click(page.getByRole("button", { name: "Move to… Shop fit-out" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Proposal" }));
    expect(move).toHaveBeenLastCalledWith(shop, { _tag: "stage", stage: "proposal" });

    await userEvent.click(page.getByRole("button", { name: "Move to… Shop fit-out" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Lost…" }));
    const why = page.getByRole("dialog");
    await expect.element(why.getByRole("button", { name: "Mark lost" })).toBeDisabled();
    await userEvent.type(why.getByRole("textbox"), "Went with someone cheaper");
    await userEvent.click(why.getByRole("button", { name: "Mark lost" }));
    expect(move).toHaveBeenLastCalledWith(shop, {
      _tag: "lost",
      reason: "Went with someone cheaper",
    });

    const card = page.getByRole("button", { name: /^Shop fit-out\./ });
    (card.element() as HTMLElement).focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(move).toHaveBeenLastCalledWith(shop, { _tag: "stage", stage: "in-talks" });
  });

  it("is the list by stage at phone width", async () => {
    await page.viewport(390, 844);
    setup({ deals: [deal(1, "Shop fit-out")] });
    await using _screen = await render(board());
    await expect.element(page.getByRole("region", { name: "New" })).toBeVisible();
    expect(page.getByRole("listitem", { name: "New, 1" }).elements()).toHaveLength(0);
  });
});

const dealPage = (row: KinDealRow): KinDealPageValue => ({
  deal: row,
  stages,
  notes: "",
  changes: [],
  steps: [],
  seq: 1,
});

const rhea = KinPersonId.make("person-rhea");
const chief = KinAgentId.make("agent-chief");
const quote = (n: number, title: string, accepted = false) => ({
  recordId: KinRecordId.make(`rec-q${n}`),
  key: KinRecordKey.make(`QT-${n}`),
  title,
  accepted,
});
/** Rhea, the owner, looking at Ambermill with Zoya and the Chief of staff. */
const company = {
  orgs: {
    orgs: [
      {
        orgId: target.orgId,
        agents: [{ agentId: chief, displayName: "Chief of staff", retired: false }],
      },
    ],
    me: [{ orgId: target.orgId, personId: rhea }],
  },
  people: [
    { personId: rhea, orgId: target.orgId, displayName: "Rhea" },
    { personId: zoya, orgId: target.orgId, displayName: "Zoya" },
  ],
  joined: null,
  invited: null,
  names: {
    people: new Map([
      [rhea, "Rhea"],
      [zoya, "Zoya"],
    ]),
    agents: new Map([[chief, "Chief of staff"]]),
    me: rhea,
    zone: null,
  },
} as never;

describe("one deal's page", () => {
  const pageElement = (held: typeof directory = directory) => (
    <AppAtomRegistryProvider>
      <KinDealPage
        {...target}
        dealKey={KinRecordKey.make("DL-7")}
        frame="page"
        directory={held}
        onOpenTask={() => {}}
        onOpenClient={() => {}}
        onStartProject={null}
        onClose={() => {}}
      />
    </AppAtomRegistryProvider>
  );
  const renderPage = (held: typeof directory = directory) => render(pageElement(held));

  it("lists its promises, ours then theirs, each with where it was made, and Add opens the form for this deal", async () => {
    const pilot = deal(7, "Clinic scheduling pilot");
    const promise = (key: string, title: string, side: "ours" | "theirs", from: object) =>
      ({
        recordId: KinRecordId.make(`rec-${key}`),
        orgId: target.orgId,
        key: KinRecordKey.make(key),
        title,
        state: "open",
        waitingOn: null,
        owner: { _tag: "person", personId: zoya },
        category: "obligation",
        side,
        dueAt: null,
        dueAllDay: false,
        late: false,
        confirmed: true,
        sensitive: false,
        working: false,
        pullRequest: null,
        rev: 1,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        closedAt: null,
        from,
      }) as never;
    setup({
      page: {
        ...dealPage(pilot),
        promises: [
          promise("W-1", "Send the revised quote", "ours", {
            kind: "note",
            note: "At the site visit",
          }),
          promise("W-2", "Signed order form", "theirs", { kind: "meeting" }),
        ],
      },
    });
    const onAddTask = vi.fn();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinDealPage
          {...target}
          dealKey={KinRecordKey.make("DL-7")}
          frame="page"
          directory={directory}
          onOpenTask={() => {}}
          onOpenClient={() => {}}
          onStartProject={null}
          onAddTask={onAddTask}
          onClose={() => {}}
        />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "Promises" })).toBeVisible();
    const rows = page.getByRole("button", { name: /Send the revised quote|Signed order form/ });
    expect(rows.elements().map((one) => one.textContent?.includes("Send"))).toEqual([true, false]);
    await expect.element(page.getByText("We promised")).toBeVisible();
    await expect.element(page.getByText("They owe")).toBeVisible();
    await expect.element(page.getByText("At the site visit")).toBeVisible();
    await expect.element(page.getByText("From a meeting")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Add" }));
    await userEvent.click(page.getByRole("menuitem", { name: "They promise" }));
    expect(onAddTask).toHaveBeenCalledWith(
      expect.objectContaining({
        party: { key: "C-1", title: "Brightwater Clinics" },
        side: "theirs",
        deal: { key: "DL-7", title: "Clinic scheduling pilot" },
      }),
    );
  });

  it("moves to the next stage, wins, and loses with a reason", async () => {
    const pilot = deal(7, "Clinic scheduling pilot", { stage: "in-talks" });
    const { move } = setup({ page: dealPage(pilot) });
    await using _screen = await renderPage();
    await userEvent.click(page.getByRole("button", { name: "Move to Proposal" }));
    expect(move).toHaveBeenLastCalledWith(pilot, { _tag: "stage", stage: "proposal" });
    await userEvent.click(page.getByRole("button", { name: "Won", exact: true }));
    expect(move).toHaveBeenLastCalledWith(pilot, { _tag: "won" });
    await userEvent.click(page.getByRole("button", { name: "Lost", exact: true }));
    await userEvent.type(page.getByRole("dialog").getByRole("textbox"), "No budget this year");
    await userEvent.click(page.getByRole("button", { name: "Mark lost" }));
    expect(move).toHaveBeenLastCalledWith(pilot, { _tag: "lost", reason: "No budget this year" });
  });

  it("keeps a lost deal's reason and offers Reopen alone", async () => {
    const lost = deal(2, "Winter campaign", {
      state: "lost",
      stage: "proposal",
      lostReason: "went with someone cheaper",
      closedAt: "2026-11-17T09:00:00.000Z",
    });
    const { move } = setup({ page: dealPage(lost) });
    await using _screen = await renderPage();
    await expect.element(page.getByText("Why: went with someone cheaper")).toBeVisible();
    expect(page.getByRole("button", { name: "Won", exact: true }).elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Reopen" }));
    expect(move).toHaveBeenLastCalledWith(lost, { _tag: "reopen" });
  });

  it("hands the deal to someone else from Looked after by, and back", async () => {
    const pilot = deal(7, "Clinic scheduling pilot");
    const { update } = setup({ page: dealPage(pilot) });
    await using _screen = await renderPage(company);
    await userEvent.click(page.getByRole("button", { name: "Change who looks after it" }));
    await expect
      .element(page.getByRole("menuitem", { name: /Zoya/ }))
      .toHaveAttribute("aria-disabled", "true");
    await expect.element(page.getByRole("menuitem", { name: "Chief of staff" })).toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: "You" }));
    expect(update).toHaveBeenLastCalledWith({
      key: pilot.key,
      rev: pilot.rev,
      owner: { _tag: "person", personId: rhea },
    });
  });

  it("offers no hand-over, and no way to take a concern off, to whoever may not edit the deal", async () => {
    setup({
      page: dealPage(
        deal(7, "Clinic scheduling pilot", {
          can: { edit: false, move: false, give: false, mark: false },
          concerns: [{ label: "Staff confidence" }],
        }),
      ),
    });
    await using _screen = await renderPage(company);
    await expect.element(page.getByText("Zoya")).toBeVisible();
    await expect.element(page.getByText("Staff confidence")).toBeVisible();
    expect(page.getByRole("button", { name: "Change who looks after it" }).elements()).toHaveLength(
      0,
    );
    expect(page.getByRole("button", { name: /^Remove / }).elements()).toHaveLength(0);
  });

  it("takes one concern off through the deal's own edit, keeping the rest", async () => {
    const pilot = deal(7, "Clinic scheduling pilot", {
      concerns: [
        { label: "Past system failed", heard: "The last one never worked for us" },
        { label: "Staff confidence" },
      ],
    });
    const { update } = setup({ page: dealPage(pilot) });
    await using _screen = await renderPage();
    await expect.element(page.getByText("“The last one never worked for us”")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Remove Past system failed" }));
    expect(update).toHaveBeenLastCalledWith({
      key: pilot.key,
      rev: pilot.rev,
      concerns: [{ label: "Staff confidence" }],
    });
  });

  it("links one of the client's quotes from Details, and None unlinks it", async () => {
    const quotes = [quote(3, "Phase two quote"), quote(17, "Pilot quote", true)];
    const open = deal(7, "Clinic scheduling pilot");
    const { update } = setup({ page: { ...dealPage(open), quotes } });
    await using screen = await renderPage();
    await userEvent.click(page.getByRole("button", { name: "Change quote" }));
    await expect.element(page.getByRole("menuitemradio", { name: "None" })).toBeChecked();
    await userEvent.click(page.getByRole("menuitemradio", { name: "Pilot quote · accepted" }));
    expect(update).toHaveBeenLastCalledWith({ key: open.key, rev: open.rev, quote: "QT-17" });
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

    const linked = deal(7, "Clinic scheduling pilot", { quote: quotes[1], rev: 4 });
    state.page = { ...dealPage(linked), quotes };
    await screen.rerender(pageElement());
    await expect.element(page.getByRole("button", { name: "Mark won" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Change quote" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "None" }));
    expect(update).toHaveBeenLastCalledWith({ key: linked.key, rev: 4, quote: null });
  });

  it("says when the client has no quotes, with nothing to type, and Edit sends what changed", async () => {
    const open = deal(7, "Clinic scheduling pilot");
    const { update } = setup({ page: { ...dealPage(open), quotes: [] } });
    await using _screen = await renderPage();
    await expect
      .element(page.getByText("No quotes for Brightwater Clinics to link."))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Change quote" }).elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Edit", exact: true }));
    const form = page.getByRole("dialog");
    const what = form.getByRole("textbox", { name: "What" });
    await userEvent.clear(what);
    await userEvent.type(what, "Clinic scheduling, phase one");
    expect(form.getByRole("combobox", { name: "Quote" }).elements()).toHaveLength(0);
    await userEvent.click(form.getByRole("button", { name: "Save" }));
    expect(update).toHaveBeenLastCalledWith({
      key: open.key,
      rev: open.rev,
      title: "Clinic scheduling, phase one",
    });
  });

  it("offers Mark won once its quote is accepted", async () => {
    const quoted = deal(4, "Warehouse app", {
      quote: {
        recordId: KinRecordId.make("rec-q"),
        key: KinRecordKey.make("QT-17"),
        title: "QT-17",
        accepted: true,
      },
    });
    const { move } = setup({ page: dealPage(quoted) });
    await using _screen = await renderPage();
    await userEvent.click(page.getByRole("button", { name: "Mark won" }));
    expect(move).toHaveBeenLastCalledWith(quoted, { _tag: "won" });
  });
});

describe("Settings → Deals", () => {
  const held = (can: boolean): KinDealStagesResult => ({
    stages: [...stages, { id: "deciding", name: "Deciding" }],
    rev: 5,
    can,
    open: can ? { new: 3, "in-talks": 4, proposal: 2, deciding: 2 } : {},
    quietDays: 14,
  });

  const renderSettings = () =>
    render(
      <AppAtomRegistryProvider>
        <KinDealStagesSettings {...target} />
      </AppAtomRegistryProvider>,
    );

  it("lets the owner rename and move a stage in its own dialog", async () => {
    const { setStages } = setup({ stages: held(true) });
    await using _screen = await renderSettings();
    await userEvent.click(page.getByRole("button", { name: "Edit stage: In talks" }));
    const form = page.getByRole("dialog");
    const name = form.getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Talking");
    await userEvent.click(form.getByRole("button", { name: "Move up" }));
    await expect.element(form.getByText("1 of 4")).toBeVisible();
    await userEvent.click(form.getByRole("button", { name: "Save stage" }));
    expect(setStages).toHaveBeenCalledWith({
      rev: 5,
      stages: [
        { id: "in-talks", name: "Talking" },
        { id: "new", name: "New" },
        { id: "proposal", name: "Proposal" },
        { id: "deciding", name: "Deciding" },
      ],
    });
  });

  it("adds a stage at the end, and waits for a name that isn't there already", async () => {
    const { setStages } = setup({ stages: held(true) });
    await using _screen = await renderSettings();
    await userEvent.click(page.getByRole("button", { name: "Add stage" }));
    const form = page.getByRole("dialog");
    const add = form.getByRole("button", { name: "Add stage" });
    await expect.element(add).toBeDisabled();
    await userEvent.type(form.getByRole("textbox", { name: "Name" }), "proposal");
    await expect.element(form.getByText("“proposal” is there twice.")).toBeVisible();
    await userEvent.clear(form.getByRole("textbox", { name: "Name" }));
    await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Signed off");
    await userEvent.click(add);
    expect(setStages).toHaveBeenCalledWith({
      rev: 5,
      stages: [...held(true).stages, { name: "Signed off" }],
    });
  });

  it("asks where a removed stage's open deals go before removing it", async () => {
    const { setStages } = setup({ stages: held(true) });
    await using _screen = await renderSettings();
    await userEvent.click(page.getByRole("button", { name: "Edit stage: Deciding" }));
    await userEvent.click(page.getByRole("button", { name: "Remove stage" }));
    const ask = page.getByRole("alertdialog");
    await expect.element(ask.getByText("2 open deals are in it. They move to:")).toBeVisible();
    expect(setStages).not.toHaveBeenCalled();
    await userEvent.click(ask.getByRole("button", { name: "Move 2 and remove" }));
    expect(setStages).toHaveBeenCalledWith({
      rev: 5,
      stages: [
        { id: "new", name: "New" },
        { id: "in-talks", name: "In talks" },
        { id: "proposal", name: "Proposal" },
      ],
      moveTo: { deciding: "new" },
    });
  });

  it("lets the owner pick when a deal goes quiet, saved as it is picked", async () => {
    const { setQuietDays, setStages } = setup({ stages: held(true) });
    await using _screen = await renderSettings();
    const days = page.getByRole("combobox", { name: "Days before a deal is quiet" });
    await expect.element(days).toHaveTextContent("14 days");
    await userEvent.click(days);
    await userEvent.click(page.getByRole("option", { name: "21 days" }));
    expect(setQuietDays).toHaveBeenCalledWith(21);
    expect(setStages).not.toHaveBeenCalled();
  });

  it("shows a teammate the stages to read, not change", async () => {
    setup({ stages: held(false) });
    await using _screen = await renderSettings();
    await expect
      .element(
        page.getByText("How every deal in the company moves. The owner and co-owners set it."),
      )
      .toBeVisible();
    await expect.element(page.getByText("Deciding")).toBeVisible();
    expect(page.getByRole("button", { name: /Edit stage/ }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Add stage" }).elements()).toHaveLength(0);
    await expect.element(page.getByText("14 days")).toBeVisible();
    expect(page.getByRole("combobox").elements()).toHaveLength(0);
  });
});

describe("the deals figures", () => {
  const rhea = KinPersonId.make("person-rhea");
  const eur = (count: number, minor: number) => ({
    count,
    values: [{ minor, currency: "EUR" }],
  });
  const numbers = (owner: boolean): NonNullable<KinDealsResult["numbers"]> => ({
    month: "2026-11",
    lastMonth: "2026-10",
    weekStart: "2026-11-16",
    open: eur(2, 2_100_000),
    stages: [],
    wonThisMonth: eur(1, 1_900_000),
    week: {
      won: [
        {
          key: KinRecordKey.make("DL-9"),
          title: "warehouse app",
          party: "Kestrel Freight",
          owner: { _tag: "person", personId: zoya },
          value: { minor: 1_900_000, currency: "EUR" },
        },
      ],
      lost: [],
      new: [],
      moved: [],
      counts: { won: 1, lost: 0, new: 3, moved: 0 },
    },
    people: [
      {
        owner: { _tag: "person", personId: zoya },
        open: eur(1, 1_800_000),
        wonThisMonth: eur(1, 1_900_000),
        late: 1,
      },
      ...(owner
        ? [
            {
              owner: { _tag: "person" as const, personId: rhea },
              open: eur(1, 300_000),
              wonThisMonth: eur(0, 0),
              late: 0,
            },
          ]
        : []),
    ],
    ...(owner
      ? {
          wonLastMonth: eur(0, 0),
          lostThisMonth: eur(1, 650_000),
          lostLastMonth: eur(0, 0),
          winRate: { won: 2, decided: 3 },
          sources: [{ source: "Harbour trade fair", count: 2 }],
          late: 1,
        }
      : {}),
  });
  const withNumbers = (owner: boolean) => {
    setup({ deals: [deal(1, "Shop fit-out")] });
    state.deals = { ...(state.deals as KinDealsResult), numbers: numbers(owner) };
  };

  it("shows the owner won this month and the week, everyone's row folded, and a person's open deals", async () => {
    await page.viewport(1440, 900);
    withNumbers(true);
    await using _screen = await render(board());
    await expect.element(page.getByLabelText("Won in November: 1 deal")).toBeVisible();
    await expect.element(page.getByLabelText("This week: +3 new · 1 won · 0 lost")).toBeVisible();
    // Folded until opened, as the page's other sections.
    await expect.element(page.getByText("Kestrel Freight: warehouse app")).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: /This week in deals/ }));
    await expect.element(page.getByText("Kestrel Freight: warehouse app")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "By person" }));
    await expect.element(page.getByRole("cell", { name: "You" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "This month and last" }));
    await expect.element(page.getByText("2 won of 3")).toBeVisible();
    await expect.element(page.getByText("Harbour trade fair")).toBeVisible();
    // A person's open value opens their open deals through the list's own filter.
    await expect.element(page.getByRole("button", { name: "Whose deals: Everyone" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Open deals looked after by You" }));
    await expect.element(page.getByRole("button", { name: "Whose deals: Me" })).toBeVisible();
  });

  it("shows a sales person their own row and the team's totals, and nobody else's", async () => {
    await page.viewport(1440, 900);
    withNumbers(false);
    await using _screen = await render(board());
    await expect.element(page.getByLabelText("Won in November: 1 deal")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Yours" }));
    await expect.element(page.getByRole("cell", { name: "You" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "By person" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "This month and last" }))
      .not.toBeInTheDocument();
  });

  it("shows no figures at all for a company with no deals", async () => {
    await page.viewport(1440, 900);
    setup({});
    await using _screen = await render(board());
    await expect.element(page.getByText("No deals yet")).toBeVisible();
    await expect.element(page.getByText(/^Won in/)).not.toBeInTheDocument();
    await expect.element(page.getByText("This week in deals")).not.toBeInTheDocument();
  });
});

describe("We run deals", () => {
  const held: KinDealStagesResult = { stages, rev: 5, can: true, open: {}, quietDays: 14 };
  const off: KinShell = {
    rev: 1,
    sections: dealsOn.sections.map((one) => (one.id === "deals" ? { ...one, on: false } : one)),
  };
  const place = () => (
    <KinPlaceView
      {...target}
      place="clients"
      tab="deals"
      onTab={() => {}}
      record={null}
      onGo={() => {}}
      openKey={null}
      onOpenKey={() => {}}
      dialog={null}
      onDialog={() => {}}
      docLink={() => ""}
      onLeave={() => {}}
    />
  );

  it("hides the Deals tab under Clients once switched off, and brings it back on", async () => {
    setup({ stages: held, deals: [deal(1, "Clinic rollout")] });
    await page.viewport(1440, 900);
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinDealStagesSettings {...target} />
        {place()}
      </AppAtomRegistryProvider>,
      { router: "/kin/env-1/org-1/clients" },
    );
    const tab = page.getByRole("button", { name: "Deals", exact: true });
    await expect.element(tab).toBeVisible();
    await expect.element(page.getByText("Clinic rollout").first()).toBeVisible();
    const toggle = page.getByRole("switch", { name: "We run deals" });
    await expect.element(toggle).toBeChecked();

    await userEvent.click(toggle);
    await expect.element(toggle).not.toBeChecked();
    await expect.element(tab).not.toBeInTheDocument();
    await expect.element(page.getByText("Every client")).toBeVisible();
    await expect
      .element(
        page.getByText("Deals is off, so these settings aren't used until you turn it back on."),
      )
      .toBeVisible();
    // The stages stay there to change while off.
    await expect.element(page.getByRole("button", { name: "Edit stage: New" })).toBeVisible();

    await userEvent.click(toggle);
    await expect.element(toggle).toBeChecked();
    await expect.element(tab).toBeVisible();
  });

  it("says what turning it off does, that nothing is deleted, and that older phone apps keep Deals", async () => {
    setup({ stages: held });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinDealStagesSettings {...target} />
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(
        page.getByText(
          "Turning this off hides Deals for everyone in the company: the Deals tab, deals on client and project pages, deals in search, and Kin's deal nudges. Nothing is deleted, and you can turn it back on at any time.",
        ),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "Teammates on an older version of the phone app keep seeing Deals until they update.",
        ),
      )
      .toBeVisible();
  });

  it("shows a teammate no switch, and an older host none either", async () => {
    setup({ stages: { ...held, can: false }, canSet: false });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinDealStagesSettings {...target} />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Deciding").or(page.getByText("Proposal"))).toBeVisible();
    expect(page.getByRole("switch").elements()).toHaveLength(0);
    shell.canSet = true;
    shell.put(undefined);
    expect(page.getByRole("switch").elements()).toHaveLength(0);
  });

  it("keeps the switch where it was when someone changed it since, and says so", async () => {
    setup({ stages: held, shell: dealsOn });
    shell.answer = () => {
      shell.put(off);
      return {
        ok: false,
        changed: true,
        problem:
          "This changed while you were looking at it. Here is the latest, so check it and try again.",
      };
    };
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinDealStagesSettings {...target} />
      </AppAtomRegistryProvider>,
    );
    const toggle = page.getByRole("switch", { name: "We run deals" });
    await userEvent.click(toggle);
    await expect
      .element(page.getByText("This changed while you were looking at it.", { exact: false }))
      .toBeVisible();
    await expect.element(toggle).not.toBeChecked();
  });
});

describe("Settings › Sections", () => {
  const sections = () => (
    <AppAtomRegistryProvider>
      <KinSectionsSettings {...target} />
    </AppAtomRegistryProvider>
  );

  it("switches Money off and on, and says Invoices and quotes is off because of it", async () => {
    setup({});
    await using _screen = await render(sections());
    const money = page.getByRole("switch", { name: "Money", exact: true });
    const invoices = page.getByRole("switch", { name: "Invoices and quotes" });
    await expect.element(money).toBeChecked();
    await userEvent.click(money);
    await expect.element(money).not.toBeChecked();
    // Held off by Money: it explains rather than offering a switch that would be refused.
    await expect.element(invoices).not.toBeChecked();
    await expect.element(invoices).toBeDisabled();
    await expect.element(page.getByText("Off because Money is off.")).toBeVisible();
    await userEvent.click(money);
    await expect.element(money).toBeChecked();
    await expect.element(invoices).toBeChecked();
    await expect.element(invoices).toBeEnabled();
  });

  it("shows the host's refusal in place and keeps the switch as saved", async () => {
    setup({});
    shell.answer = () => ({
      ok: false,
      changed: false,
      problem: "Turn off Invoices and quotes first: invoices need Clients.",
    });
    await using _screen = await render(sections());
    const clients = page.getByRole("switch", { name: "Clients", exact: true });
    await userEvent.click(clients);
    await expect
      .element(page.getByText("Turn off Invoices and quotes first: invoices need Clients."))
      .toBeVisible();
    await expect.element(clients).toBeChecked();
  });

  it("says the host's words when someone changed it since, and shows what they saved", async () => {
    setup({});
    const moneyOff: KinShell = {
      rev: 4,
      sections: dealsOn.sections.map((one) => (one.id === "money" ? { ...one, on: false } : one)),
    };
    shell.answer = () => {
      shell.put(moneyOff);
      return {
        ok: false,
        changed: true,
        problem: "Someone changed this since you opened it. Nothing was saved; open it again.",
      };
    };
    await using _screen = await render(sections());
    await userEvent.click(page.getByRole("switch", { name: "Deals", exact: true }));
    await expect
      .element(page.getByText("Someone changed this since you opened it.", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Deals", exact: true })).toBeChecked();
    await expect
      .element(page.getByRole("switch", { name: "Money", exact: true }))
      .not.toBeChecked();
  });

  it("calls Clients by the company's name, and goes back to Kin's", async () => {
    setup({});
    await using _screen = await render(sections());
    await userEvent.click(page.getByRole("button", { name: "Rename" }));
    await userEvent.fill(page.getByLabelText("Name"), "Patients");
    await userEvent.fill(page.getByLabelText("One of them"), "patient");
    await userEvent.click(page.getByRole("button", { name: "Save name" }));
    await expect.element(page.getByRole("switch", { name: "Patients" })).toBeVisible();
    await expect.element(page.getByText("Patients, one patient")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Use Kin's name" }));
    await expect.element(page.getByRole("switch", { name: "Clients", exact: true })).toBeVisible();
  });

  it("offers a teammate nothing to switch", async () => {
    setup({ canSet: false });
    await using _screen = await render(sections());
    expect(page.getByRole("switch").elements()).toHaveLength(0);
  });
});
