import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  type KinPeopleProfilesResult,
  type KinPersonProfile,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { act, render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinProfileSheetHost, openKinProfile } from "./KinProfileSheet";

const environmentId = EnvironmentId.make("env-1");
const orgId = KinOrgId.make("org-1");
const rhea = KinPersonId.make("rhea");
const zoya = KinPersonId.make("zoya");

vi.mock("./useKinHost", () => ({
  useKinHostAt: () => ({
    _tag: "host",
    probe: {
      _tag: "ready",
      orgs: {
        orgs: [{ orgId: "org-1", agents: [] }],
        me: [{ orgId: "org-1", personId: "rhea", displayName: "Rhea" }],
      },
    },
  }),
}));

vi.mock("./kinPictures", async () => {
  const { AsyncResult: R } = await import("effect/reactivity");
  const contracts = await import("@t3tools/contracts");
  const profile = (personId: string, displayName: string): KinPersonProfile => ({
    personId: contracts.KinPersonId.make(personId),
    displayName,
    handle: personId,
    pictureId: null,
    roleTags: [],
    skills: "",
    timeZone: null,
    workHours: null,
  });
  const profiles: KinPeopleProfilesResult = {
    profiles: [profile("rhea", "Rhea"), profile("zoya", "Zoya")],
    ownerPersonId: contracts.KinPersonId.make("rhea"),
  };
  return { useKinProfiles: () => R.success(profiles) };
});

vi.mock("./KinPersonTasks", () => ({
  KinPersonTasks: (props: { readonly personId: string }) => (
    <p>{`Tasks ${props.personId} holds`}</p>
  ),
}));
vi.mock("./KinAvatar", () => ({ KinAvatar: () => null }));
vi.mock("./KinAway", () => ({ KinAwayField: () => null }));
vi.mock("./KinTasksKeys", () => ({ KinTasksKeysSection: () => null }));
vi.mock("./KinDevices", () => ({ KinMyDevices: () => null }));
vi.mock("./useKinOwnerLevel", () => ({ useKinOwnerLevelKnown: () => true }));
vi.mock("./KinPeopleChat", () => ({ useOpenKinPeopleChat: () => async () => null }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

const opened = async (path: string, personId: KinPersonId) => {
  const screen = await render(
    <AppAtomRegistryProvider>
      <KinProfileSheetHost />
    </AppAtomRegistryProvider>,
    { router: path },
  );
  await act(() => openKinProfile({ environmentId, orgId, personId }));
  return screen;
};

describe("a person's profile over a Kin page", () => {
  it("lists what someone else holds, as their Team page does", async () => {
    await using _screen = await opened("/kin", zoya);
    await expect.element(page.getByRole("heading", { name: "Zoya" })).toBeVisible();
    await expect.element(page.getByText("Tasks zoya holds")).toBeVisible();
  });

  it("lists none on your own profile", async () => {
    await using _mine = await opened("/kin", rhea);
    await expect.element(page.getByRole("heading", { name: "Your profile" })).toBeVisible();
    await expect.element(page.getByText("Tasks rhea holds")).not.toBeInTheDocument();
  });

  it("lists none over Settings, where the Team page behind it already does", async () => {
    await using _settings = await opened("/kin?settings=team", zoya);
    await expect.element(page.getByRole("heading", { name: "Zoya" })).toBeVisible();
    await expect.element(page.getByText("Tasks zoya holds")).not.toBeInTheDocument();
  });
});
