import { EnvironmentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { appAtomRegistry, AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinAskRecord } from "./KinAskRecord";
import { kinDraftAtom, kinDraftKey } from "./kinDraft";

const made = vi.hoisted(() => ({ agents: [] as Array<string> }));

// Arjun may message Chief of staff, whom he has a chat with, and Finance, whom he has never messaged.
vi.mock("./kinClient", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const agent = (agentId: string, name: string) => ({
    orgId: "ambermill",
    agentId,
    name,
    intro: "",
    ownerName: "Rhea",
  });
  const leads = A.make(
    R.success({
      leads: [],
      contacts: [{ ...agent("chief", "Chief of staff"), chatId: "arjun-chief" }],
      messageable: [agent("chief", "Chief of staff"), agent("finance", "Finance")],
    }),
  ).pipe(A.keepAlive);
  return {
    kinClient: {
      leads: () => leads,
      chatWithAgent: {
        run: async (_registry: unknown, { input }: { readonly input: { agentId: string } }) => {
          made.agents.push(input.agentId);
          return R.success({ chatId: `arjun-${input.agentId}` });
        },
      },
    },
  };
});

const environmentId = EnvironmentId.make("env-1");
const orgId = KinOrgId.make("ambermill");
const taskPath = "/kin/env-1/ambermill/tasks?task=W-5";

describe("Ask an agent about a task", () => {
  it("makes the chat with an agent never messaged, lands in it with the draft, and Back returns to the task", async () => {
    made.agents = [];
    await using screen = await render(
      <AppAtomRegistryProvider>
        <KinAskRecord
          environmentId={environmentId}
          orgId={orgId}
          record={{ key: "W-5", title: "SMS reminder integration" }}
        />
      </AppAtomRegistryProvider>,
      { router: "/kin/env-1/ambermill/tasks" },
    );
    const history = screen.router!.history;
    // The task was opened from the list, as Tasks does.
    history.push(taskPath);

    await userEvent.click(page.getByRole("button", { name: "Ask an agent" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Finance" }));

    await vi.waitFor(() =>
      expect(history.location.pathname).toBe("/kin/env-1/ambermill/arjun-finance"),
    );
    expect(made.agents).toEqual(["finance"]);
    expect(
      appAtomRegistry.get(
        kinDraftAtom(kinDraftKey(environmentId, orgId, KinChatId.make("arjun-finance"))),
      ),
    ).toBe("About W-5 (SMS reminder integration): ");

    history.back();
    await vi.waitFor(() =>
      expect(`${history.location.pathname}${history.location.search}`).toBe(taskPath),
    );
  });
});
