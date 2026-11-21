import { EnvironmentId, type KinGitHubAgents, KinOrgId } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The host: GitHub's status for the company, what Start was sent, and a refusal when set.
const host = vi.hoisted(() => ({
  signIn: null as { readonly code: string; readonly url: string } | null,
  starts: [] as Array<Record<string, unknown>>,
  refuse: null as string | null,
}));

vi.mock(import("./useKinOwnerLevel"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinOwnerLevel: () => true,
}));
vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { KinChatError: Refused } = await import("@t3tools/contracts");
  const allowed = Atom.make(true);
  const status = () => ({
    orgId: "org-1",
    account: null,
    signIn: host.signIn === null ? null : { ...host.signIn, expiresAt: 0 },
    failed: null,
  });
  const read = Atom.make(() => AsyncResult.success(status()));
  const command = (answer: (input: Record<string, unknown>) => unknown) => ({
    label: "test:github",
    permissionAtom: () => allowed,
    run: async (_registry: unknown, { input }: { readonly input: Record<string, unknown> }) =>
      answer(input),
  });
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      github: () => read,
      githubStart: command((input) => {
        host.starts.push(input);
        if (host.refuse !== null)
          return AsyncResult.failure(
            Cause.fail(new Refused({ reason: "not_allowed", message: host.refuse })),
          );
        host.signIn = { code: "WXYZ-1234", url: "https://github.invented/login/device" };
        return AsyncResult.success(status());
      }),
      githubCancel: command(() => {
        host.signIn = null;
        return AsyncResult.success(status());
      }),
    } as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinGitHubConnect, KinGitHubInstantLine } from "./KinGitHubConnect";

const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("org-1") };

function setup(refuse: string | null) {
  host.signIn = null;
  host.starts = [];
  host.refuse = refuse;
}

const screen = () => (
  <AppAtomRegistryProvider>
    <KinGitHubConnect {...target} />
  </AppAtomRegistryProvider>
);

describe("connecting GitHub", () => {
  it("starts the sign-in once, shows its code, and opens GitHub's page at the host's address", async () => {
    setup(null);
    await using _screen = await render(screen());
    using opened = vi.spyOn(window, "open").mockReturnValue(null);

    await userEvent.click(page.getByRole("button", { name: "Connect" }));
    await userEvent.dblClick(page.getByRole("button", { name: "Get a code" }));
    await expect.element(page.getByLabelText("Code W X Y Z - 1 2 3 4")).toBeVisible();
    expect(host.starts).toEqual([{ orgId: target.orgId }]);

    await userEvent.click(page.getByRole("button", { name: "Open GitHub" }));
    expect(opened).toHaveBeenCalledWith(
      "https://github.invented/login/device",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("shows the host's refusal and keeps the token as pasted", async () => {
    setup("Only the owner can connect GitHub here.");
    await using _screen = await render(screen());

    await userEvent.click(page.getByRole("button", { name: "Connect" }));
    await userEvent.click(page.getByRole("button", { name: "Use a token instead" }));
    const token = page.getByLabelText("Personal access token (classic)");
    await userEvent.type(token, "ghp_invented0000");
    await userEvent.click(page.getByRole("button", { name: "Connect with token" }));

    await expect.element(page.getByText("Only the owner can connect GitHub here.")).toBeVisible();
    await expect.element(token).toHaveValue("ghp_invented0000");
    const sent = host.starts[0]?.token;
    expect(Redacted.isRedacted(sent)).toBe(true);
    expect(Redacted.value(sent as Redacted.Redacted<string>)).toBe("ghp_invented0000");
  });
});

const agents: KinGitHubAgents = {
  as: "app",
  appName: "Invented Kin",
  problem: null,
  watched: 4,
  installed: 4,
  without: [],
  ownerUses: [],
};
const settingsUrl = "https://github.com/settings/apps/invented-kin/permissions";

describe("how fast Kin hears from GitHub", () => {
  it("names the events to tick and opens GitHub's page outside Kin", async () => {
    await using _screen = await render(
      <KinGitHubInstantLine
        agents={{
          ...agents,
          instant: { state: "events", missing: ["Pull request"], settingsUrl, last: null },
        }}
        now={0}
      />,
      { router: false }, // The row has no links inside Kin.
    );
    await expect.element(page.getByText("Events to tick")).toBeVisible();
    await expect.element(page.getByText(/tick "Pull request" under Subscribe/)).toBeVisible();
    const link = page.getByRole("link", { name: "Open Permissions & events" });
    await expect.element(link).toHaveAttribute("href", settingsUrl);
    await expect.element(link).toHaveAttribute("target", "_blank");
    await expect.element(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("draws nothing when the status carries no instant, as for a teammate", async () => {
    await using _screen = await render(<KinGitHubInstantLine agents={agents} now={0} />, {
      router: false, // The row has no links inside Kin.
    });
    await expect.element(page.getByText("How fast Kin hears from GitHub")).not.toBeInTheDocument();
  });
});
