import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  type KinPeopleProfilesResult,
  type KinPersonProfile,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { act, render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinProfileSheetHost, openKinProfile } from "./KinProfileSheet";

const state = vi.hoisted(() => ({
  /** What the host sends for each person's GitHub username; absent, the reader may not change it. */
  logins: {} as Record<string, string | null | undefined>,
  saved: [] as Array<{ readonly personId: string; readonly githubLogin: string | null }>,
  /** How the next save is answered. */
  answer: "saved" as "saved" | "taken",
}));

function setup(logins: Record<string, string | null | undefined>, answer: "saved" | "taken") {
  state.logins = logins;
  state.saved = [];
  state.answer = answer;
}

const environmentId = EnvironmentId.make("env-1");
const orgId = KinOrgId.make("org-1");
const rhea = KinPersonId.make("rhea");
const zoya = KinPersonId.make("zoya");

vi.mock("./useKinHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useKinHost")>()),
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
  const profile = (personId: string, displayName: string): KinPersonProfile => {
    const githubLogin = state.logins[personId];
    return {
      personId: contracts.KinPersonId.make(personId),
      displayName,
      handle: personId,
      pictureId: null,
      roleTags: [],
      skills: "",
      timeZone: null,
      workHours: null,
      ...(githubLogin === undefined ? {} : { githubLogin }),
    };
  };
  const profiles = (): KinPeopleProfilesResult => ({
    profiles: [profile("rhea", "Rhea"), profile("zoya", "Zoya")],
    ownerPersonId: contracts.KinPersonId.make("rhea"),
  });
  return { useKinProfiles: () => R.success(profiles()) };
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
vi.mock("../state/use-atom-command", async () => {
  const { Cause } = await import("effect");
  const { AsyncResult } = await import("effect/reactivity");
  const { KinChatError } = await import("@t3tools/contracts");
  return {
    useAtomCommand:
      (command: { readonly label: string }) =>
      async (value: {
        readonly input: { readonly personId: string; readonly githubLogin: string | null };
      }) => {
        if (command.label !== "kin:person:set-github-login")
          return AsyncResult.failure(Cause.fail("unused"));
        if (state.answer === "taken")
          return AsyncResult.failure(
            Cause.fail(
              new KinChatError({
                reason: "not_allowed",
                message: "That GitHub login is already linked to someone.",
              }),
            ),
          );
        state.saved.push({
          personId: value.input.personId,
          githubLogin: value.input.githubLogin,
        });
        return AsyncResult.success({});
      },
  };
});

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

describe("a GitHub username on a profile", () => {
  const field = () => page.getByRole("textbox", { name: "GitHub username" });
  const save = () => page.getByRole("button", { name: "Save" });

  it("is added on your own profile and refused plainly when it isn't one", async () => {
    setup({ rhea: null }, "saved");
    await using _mine = await opened("/kin", rhea);
    await expect.element(page.getByRole("heading", { name: "GitHub username" })).toBeVisible();
    expect(document.getElementById("kin-github-username")?.textContent).toContain("Not set");
    await expect
      .element(
        page.getByText(
          "Kin uses it to find your pull requests when you ask an agent to review them.",
        ),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Add GitHub username…" }).click();
    await userEvent.type(field(), "-rhea");
    await save().click();
    await expect.element(page.getByText(/That isn't a GitHub username/)).toBeVisible();
    expect(state.saved).toEqual([]);
    await userEvent.clear(field());
    await userEvent.type(field(), "@rhea-ambermill");
    await save().click();
    await expect.element(field()).not.toBeInTheDocument();
    expect(state.saved).toEqual([{ personId: rhea, githubLogin: "rhea-ambermill" }]);
  });

  it("is cleared with Remove", async () => {
    setup({ rhea: "rhea-ambermill" }, "saved");
    await using _mine = await opened("/kin", rhea);
    await expect.element(page.getByText("rhea-ambermill")).toBeVisible();
    await page.getByRole("button", { name: "Remove" }).click();
    await vi.waitFor(() => expect(state.saved).toEqual([{ personId: rhea, githubLogin: null }]));
  });

  it("says when someone else already has it, without saying who", async () => {
    setup({ rhea: null }, "taken");
    await using _mine = await opened("/kin", rhea);
    await page.getByRole("button", { name: "Add GitHub username…" }).click();
    await userEvent.type(field(), "zoya-ambermill");
    await save().click();
    await expect
      .element(page.getByText("That GitHub username is already on file for someone else."))
      .toBeVisible();
    await expect.element(field()).toBeVisible();
  });

  it("is set on a teammate's page by the owner", async () => {
    setup({ rhea: null, zoya: null }, "saved");
    await using _theirs = await opened("/kin", zoya);
    await expect
      .element(
        page.getByText(
          "Kin uses it to find their pull requests when they ask an agent to review them.",
        ),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Add GitHub username…" }).click();
    await userEvent.type(field(), "zoya-ambermill");
    await save().click();
    await expect.element(field()).not.toBeInTheDocument();
    expect(state.saved).toEqual([{ personId: zoya, githubLogin: "zoya-ambermill" }]);
  });

  it("isn't on someone else's page when the host doesn't let the reader change it", async () => {
    setup({ rhea: null }, "saved");
    await using _theirs = await opened("/kin", zoya);
    await expect.element(page.getByRole("heading", { name: "Zoya" })).toBeVisible();
    await expect.element(page.getByText("GitHub username")).not.toBeInTheDocument();
  });
});
