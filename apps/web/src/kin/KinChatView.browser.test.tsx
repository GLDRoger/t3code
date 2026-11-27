import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The host: what Send was sent, and a refusal it answers with when set.
const host = vi.hoisted(() => ({
  sends: [] as Array<Record<string, unknown>>,
  refuse: null as string | null,
}));

vi.mock(import("./useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinHostAt: (() => ({
    _tag: "host",
    environmentId: "env-1",
    connected: true,
    probe: { _tag: "ready", orgs: { orgs: [], me: [] } },
  })) as never,
  kinHostConnected: () => true,
}));
// The outbox sends to the environments this browser is connected to.
vi.mock(import("../state/presentation"), async (importOriginal) => {
  const real = await importOriginal();
  const { Atom } = await import("effect/reactivity");
  const connected = Atom.make(new Map([["env-1", { connection: { phase: "connected" } }]]));
  return {
    ...real,
    environmentPresentations: { ...real.environmentPresentations, presentationsAtom: connected },
  } as never;
});
// Files take their own upload path; this message carries words only.
vi.mock(import("./KinComposerAttachments"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinComposerAttachmentStrip: () => null,
  useKinComposerAttachments: (() => ({
    count: 0,
    refusal: null,
    blockReason: null,
    canAttach: false,
    add: async () => false,
    settle: async () => ({ _tag: "ready", attachments: [], images: [] }),
    clear: () => {},
  })) as never,
}));
vi.mock(import("./kinClient"), async (importOriginal) => {
  const { commandRun } = await import("../../test/commandRun");
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { KinChatError: Refused } = await import("@t3tools/contracts");
  const { emptyKinChat } = await import("@t3tools/client-runtime/kin/kinInboxModel");
  const { makeKinFixtureMessages } = await import("@t3tools/client-runtime/kin/kinChatFixtures");
  const [posted] = makeKinFixtureMessages(1);
  const allowed = Atom.make(true);
  const synced = (value: unknown) => AsyncResult.success({ value, live: true, savedAt: null });
  const chat = Atom.make(synced(emptyKinChat));
  const inbox = Atom.make(synced({ chats: [] }));
  const orgs = Atom.make(AsyncResult.success({ orgs: [], me: [] }));
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      chat: () => chat,
      inbox: () => inbox,
      orgs: () => orgs,
      send: {
        label: "test:send",
        permissionAtom: () => allowed,
        run: commandRun(
          async (_registry: unknown, { input }: { readonly input: Record<string, unknown> }) => {
            host.sends.push(input);
            return host.refuse === null
              ? AsyncResult.success({
                  ...posted,
                  messageId: `posted-${String(input.clientMessageId)}`,
                  chatId: input.chatId,
                  clientMessageId: input.clientMessageId,
                  body: input.body,
                })
              : AsyncResult.failure(
                  Cause.fail(new Refused({ reason: "not_allowed", message: host.refuse })),
                );
          },
        ),
      },
    } as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinChatView } from "./KinChatView";

function setup(refuse: string | null) {
  // Unsent messages survive a reload in the app; a run here starts with none.
  window.localStorage.removeItem("t3code:kin:outbox");
  host.sends = [];
  host.refuse = refuse;
}

const screen = (chatId: string) =>
  render(
    <AppAtomRegistryProvider>
      <KinChatView environmentId={EnvironmentId.make("env-1")} orgId="org-1" chatId={chatId} />
    </AppAtomRegistryProvider>,
  );

// Each test writes in its own chat: the outbox is one per page, like the app's.
describe("sending from a chat", () => {
  it("sends what was typed once, to this chat, and empties the box", async () => {
    setup(null);
    await using _screen = await screen("chat-a");
    const box = page.getByRole("textbox");
    await userEvent.type(box, "Invented: the van is booked for Saturday");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");

    await expect.element(box).toHaveValue("");
    await expect.element(page.getByText("Sending…")).not.toBeInTheDocument();
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]).toMatchObject({
      chatId: "chat-a",
      body: "Invented: the van is booked for Saturday",
    });
  });

  it("shows the host's refusal on the message, and Edit puts its words back in the box", async () => {
    setup("refused");
    await using _screen = await screen("chat-b");
    const box = page.getByRole("textbox");
    await userEvent.type(box, "Invented: the van is booked for Saturday");
    await userEvent.keyboard("{Enter}");

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Not sent: you can't post here");
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await expect.element(box).toHaveValue("Invented: the van is booked for Saturday");
    expect(host.sends).toHaveLength(1);
  });
});
