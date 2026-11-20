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
}));

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinDealPage } from "./KinDealPage";
import { KinDealsTab } from "./KinDeals";
import { KinDealStagesSettings } from "./KinDealsSetting";

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

  it("offers no hand-over to whoever may not give the deal away", async () => {
    setup({
      page: dealPage(
        deal(7, "Clinic scheduling pilot", {
          can: { edit: false, move: false, give: false, mark: false },
        }),
      ),
    });
    await using _screen = await renderPage(company);
    await expect.element(page.getByText("Zoya")).toBeVisible();
    expect(page.getByRole("button", { name: "Change who looks after it" }).elements()).toHaveLength(
      0,
    );
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

  it("lets the owner rename, add and remove a stage, moving its open deals first", async () => {
    const { setStages } = setup({ stages: held(true) });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinDealStagesSettings {...target} />
      </AppAtomRegistryProvider>,
    );
    const second = page.getByRole("textbox", { name: "Stage name 2" });
    await userEvent.clear(second);
    await userEvent.type(second, "Talking");
    await userEvent.click(page.getByRole("button", { name: "Add a stage" }));
    await userEvent.type(page.getByRole("textbox", { name: "Stage name 5" }), "Signed off");
    await userEvent.click(page.getByRole("button", { name: "Remove…" }).nth(3));
    const ask = page.getByRole("dialog");
    await userEvent.click(ask.getByRole("button", { name: "Move 2 and remove" }));
    await userEvent.click(page.getByRole("button", { name: "Save stages" }));
    expect(setStages).toHaveBeenCalledWith({
      rev: 5,
      stages: [
        { id: "new", name: "New" },
        { id: "in-talks", name: "Talking" },
        { id: "proposal", name: "Proposal" },
        { name: "Signed off" },
      ],
      moveTo: { deciding: "new" },
    });
  });

  it("lets the owner set when a deal goes quiet, on its own Save", async () => {
    const { setQuietDays, setStages } = setup({ stages: held(true) });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinDealStagesSettings {...target} />
      </AppAtomRegistryProvider>,
    );
    const days = page.getByRole("spinbutton", { name: "Days before a deal is quiet" });
    await expect.element(days).toHaveValue(14);
    const save = page.getByRole("region", { name: "A deal goes quiet after" }).getByRole("button", {
      name: "Save",
    });
    await expect.element(save).toBeDisabled();
    await userEvent.clear(days);
    await userEvent.type(days, "0");
    await expect.element(page.getByText("Say a whole number of days, 1 to 365.")).toBeVisible();
    await userEvent.clear(days);
    await userEvent.type(days, "21");
    await userEvent.click(save);
    expect(setQuietDays).toHaveBeenCalledWith(21);
    expect(setStages).not.toHaveBeenCalled();
  });

  it("shows a teammate the stages to read, not change", async () => {
    setup({ stages: held(false) });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinDealStagesSettings {...target} />
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(page.getByText("The owner and co-owners set the stages. Ask them to change one."))
      .toBeVisible();
    expect(page.getByRole("textbox").elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Save stages" }).elements()).toHaveLength(0);
    await expect.element(page.getByText("14 days")).toBeVisible();
    expect(page.getByRole("spinbutton").elements()).toHaveLength(0);
  });
});
