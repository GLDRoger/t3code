import { KinCompanyProfile } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const host = vi.hoisted(() => ({
  saved: [] as Array<unknown>,
  profile: null as KinCompanyProfile | null,
}));

vi.mock(import("./KinNewLeadButton"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinNewLeadTarget: () => ({ environmentId: "env-1", orgId: "org-1", lead: null }) as never,
}));
vi.mock(import("./useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinHost: (() => ({})) as never,
  useKinGate: () => null,
  kinHostConnected: () => true,
}));
vi.mock(import("./useKinMoney"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinCompanyProfile: (() => ({
    state: { _tag: "ready", value: host.profile },
    refresh: () => {},
  })) as never,
  useKinCountryNeeded: () => false,
}));
vi.mock(import("./KinBrand"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinBrandSection: (() => null) as never,
}));
vi.mock(import("./KinTemplates"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinTemplatesSection: (() => null) as never,
}));
vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const allowed = A.make(true);
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      companyProfileSet: {
        ...real.kinClient.companyProfileSet,
        permissionAtom: () => allowed,
        run: async (_registry: unknown, request: { readonly input: unknown }) => {
          host.saved.push(request.input);
          return R.success(host.profile!);
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

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinCompanyProfileSettings } from "./KinCompanyProfile";

// Invented company only.
const ambermill = Schema.decodeSync(KinCompanyProfile)({
  legalName: "Ambermill Studio Private Limited",
  tradeName: "Ambermill",
  address: null,
  gstin: null,
  pan: null,
  placeOfSupply: null,
  sac: null,
  bank: {
    accountName: null,
    accountNumber: null,
    ifsc: null,
    bankName: null,
    branch: null,
    upi: null,
  },
  country: "GB",
  rev: 3,
  updatedAt: null,
});

function setup() {
  host.saved.length = 0;
  host.profile = ambermill;
}

const companyForm = () => page.getByRole("dialog", { name: "Edit company details" });
const ask = () => page.getByRole("alertdialog", { name: "Discard what you typed?" });

describe("Settings → Company details form", () => {
  it("asks before throwing away typing, on Close and on Escape, and closes at once untouched", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinCompanyProfileSettings />
      </AppAtomRegistryProvider>,
    );
    const edit = page.getByRole("button", { name: "Edit", exact: true });

    await userEvent.click(edit);
    await expect.element(companyForm()).toBeVisible();
    await userEvent.click(companyForm().getByRole("button", { name: "Close" }));
    await expect.element(companyForm()).not.toBeInTheDocument();
    expect(ask().elements()).toHaveLength(0);

    await userEvent.click(edit);
    const tradingName = companyForm().getByRole("textbox", { name: "Trading name" });
    await userEvent.fill(tradingName, "Ambermill Works");
    await userEvent.click(companyForm().getByRole("button", { name: "Close" }));
    await userEvent.click(ask().getByRole("button", { name: "Keep editing" }));
    await expect.element(ask()).not.toBeInTheDocument();
    await expect.element(tradingName).toHaveValue("Ambermill Works");

    await userEvent.keyboard("{Escape}");
    await userEvent.click(ask().getByRole("button", { name: "Discard" }));
    await expect.element(companyForm()).not.toBeInTheDocument();
    expect(host.saved).toEqual([]);
  });
});
