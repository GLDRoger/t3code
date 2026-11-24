import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The host: this person's own mailbox, and what they asked of it.
const host = vi.hoisted(() => ({
  mailbox: null as null | { account: string; state: string },
  started: [] as Array<Record<string, unknown>>,
  finished: [] as Array<Record<string, unknown>>,
  removed: 0,
}));

vi.mock(import("./kinClient"), async (importOriginal) => {
  const { commandRun } = await import("../../test/commandRun");
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  let asks = 0;
  const view = Atom.make(0).pipe(Atom.keepAlive);
  const mine = Atom.make((get) => {
    get(view);
    return AsyncResult.success({
      orgId: "org-1",
      mailbox:
        host.mailbox === null
          ? null
          : { connectionId: "conn-mine", preset: "google", ...host.mailbox },
      services: [
        { service: "google", label: "Google", ready: true },
        { service: "microsoft", label: "Microsoft", ready: false },
      ],
      signInAddress: "https://kin.invented/oauth/return",
    });
  });
  const bump = (registry: { readonly set: (atom: unknown, value: unknown) => void }) =>
    registry.set(view, ++asks);
  const command = <I,>(label: string, run: (input: I) => unknown) => ({
    label,
    permissionAtom: () => allowed,
    run: commandRun(async (registry: never, { input }: { readonly input: I }) => {
      const value = run(input);
      bump(registry);
      return AsyncResult.success(value);
    }),
  });
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      myMailbox: () => mine,
      myMailboxSignInStart: command("test:start", (input: Record<string, unknown>) => {
        host.started.push(input);
        return {
          signInId: "s",
          authorizationUrl: "https://accounts.invented/sign-in",
          host: "accounts.invented",
          expiresAt: 0,
        };
      }),
      myMailboxSignInFinish: command("test:finish", (input: Record<string, unknown>) => {
        host.finished.push(input);
        host.mailbox = { account: "meera@ambermill.example", state: "active" };
        return null;
      }),
      myMailboxRemove: command("test:remove", () => {
        host.removed++;
        host.mailbox = null;
        return null;
      }),
    } as never,
  };
});
vi.mock(import("./KinConnectionSignIn"), async (importOriginal) => ({
  ...(await importOriginal()),
  openSignInWindow: () => null,
}));

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinMyMailbox } from "./KinMyMailbox";

function setup(mailbox: (typeof host)["mailbox"]) {
  host.mailbox = mailbox;
  host.started = [];
  host.finished = [];
  host.removed = 0;
}

const screen = () => (
  <AppAtomRegistryProvider>
    <KinMyMailbox environmentId={"env-1" as never} orgId={"org-1" as never} />
  </AppAtomRegistryProvider>
);

describe("Your mailbox", () => {
  it("connects your own Google mail, shows its address, and disconnects it", async () => {
    setup(null);
    await using _screen = await render(screen());
    // Microsoft isn't set up for the company: said, and its button can't be pressed.
    await expect.element(page.getByRole("button", { name: "Connect Microsoft" })).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "Connect Google" }));
    expect(host.started).toEqual([{ orgId: "org-1", service: "google", returnTo: "web" }]);
    await userEvent.type(
      page.getByRole("textbox"),
      "https://kin.invented/oauth/return?state=w.x&code=y",
    );
    await userEvent.click(page.getByRole("button", { name: "Finish" }));
    await expect
      .element(page.getByText("Connected as meera@ambermill.example", { exact: false }))
      .toBeVisible();
    expect(host.finished).toHaveLength(1);
    await userEvent.click(page.getByRole("button", { name: "Disconnect" }));
    await expect.element(page.getByRole("button", { name: "Connect Google" })).toBeVisible();
    expect(host.removed).toBe(1);
  });

  it("asks for a sign-in again when the mailbox needs one", async () => {
    setup({ account: "meera@ambermill.example", state: "needs_sign_in" });
    await using _screen = await render(screen());
    await expect.element(page.getByText("needs signing in again", { exact: false })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Sign in again" }).last());
    expect(host.started).toEqual([{ orgId: "org-1", service: "google", returnTo: "web" }]);
  });
});
