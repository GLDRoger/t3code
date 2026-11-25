import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinPeoplePickerHost, openKinPeoplePicker } from "./KinPeopleChat";

// Arjun, a teammate with no chat yet: the host lists the agents he may message, and makes the
// chat when he picks one.
const host = vi.hoisted(() => ({ opened: [] as Array<string> }));

vi.mock("./kinClient", async () => {
  const { commandRun } = await import("../../test/commandRun");
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const leads = A.make(
    R.success({
      leads: [],
      contacts: [],
      messageable: [
        {
          orgId: "ambermill",
          agentId: "chief",
          name: "Chief of staff",
          intro: "Keeps track of who has what.",
          ownerName: "Rhea Kapoor",
        },
        {
          orgId: "ambermill",
          agentId: "finance",
          name: "Finance",
          intro: "",
          ownerName: "Rhea Kapoor",
        },
      ],
    }),
  ).pipe(A.keepAlive);
  return {
    kinClient: {
      leads: () => leads,
      chatWithAgent: {
        run: commandRun(
          async (_registry: unknown, { input }: { readonly input: { agentId: string } }) => {
            host.opened.push(input.agentId);
            return R.success({ chatId: `arjun-${input.agentId}` });
          },
        ),
      },
      chatWithPerson: { run: commandRun(async () => R.success({ chatId: "arjun-zoya" })) },
    },
  };
});
vi.mock("./kinPictures", async () => {
  const { AsyncResult: R } = await import("effect/reactivity");
  const profiles = R.success({
    profiles: [
      { personId: "arjun", displayName: "Arjun Rao" },
      { personId: "zoya", displayName: "Zoya Sheikh" },
    ],
  });
  return { useKinProfiles: () => profiles };
});
vi.mock("./KinProfileSheet", () => ({ useKinMe: () => "arjun" }));
vi.mock("./KinAvatar", () => ({ KinAvatar: () => null }));

const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("ambermill") };

function setup() {
  host.opened.length = 0;
}

describe("Message someone", () => {
  it("lists people, then the agents a teammate may message, and opens an agent's chat in one tap", async () => {
    setup();
    await using screen = await render(
      <AppAtomRegistryProvider>
        <KinPeoplePickerHost />
      </AppAtomRegistryProvider>,
      { router: "/kin/env-1/ambermill" },
    );
    openKinPeoplePicker(target);

    const dialog = page.getByRole("dialog", { name: "Message someone" });
    await expect.element(dialog).toBeVisible();
    const people = dialog.getByRole("region", { name: "People" });
    const agents = dialog.getByRole("region", { name: "Agents" });
    await expect.element(people.getByRole("button", { name: "Message Zoya Sheikh" })).toBeVisible();
    await expect
      .element(agents.getByRole("button", { name: "Message Chief of staff" }))
      .toHaveTextContent("Chief of staffKeeps track of who has what.");
    await expect.element(agents.getByRole("button", { name: "Message Finance" })).toBeVisible();
    await expect
      .element(dialog.getByText("Rhea Kapoor runs this workspace and can see chats with agents."))
      .toBeVisible();

    await userEvent.click(agents.getByRole("button", { name: "Message Finance" }));
    await expect.element(dialog).not.toBeInTheDocument();
    expect(host.opened).toEqual(["finance"]);
    expect(screen.router?.state.location.pathname).toBe("/kin/env-1/ambermill/arjun-finance");
  });
});
