import {
  EnvironmentId,
  KIN_COMPANY_CHAT_TEAM_ID,
  KinChatId,
  KinChatPinId,
  KinMemberId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  type KinChatMember,
  type KinChatPin,
  type KinChatSummary,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const host = vi.hoisted(() => ({
  supported: true,
  canPin: true,
  canUnpin: true,
  pins: [] as ReadonlyArray<KinChatPin>,
  chats: [] as ReadonlyArray<KinChatSummary>,
  pinCalls: [] as Array<{ readonly chatId: string; readonly key: string }>,
  unpinCalls: [] as Array<{ readonly chatId: string; readonly pinId: string }>,
  pinRefusal: null as {
    readonly reason: "not_allowed" | "invalid_state";
    readonly message: string;
  } | null,
  destinations: ["chats", "tasks", "money"] as ReadonlyArray<string>,
}));

vi.mock(import("./useKinPlaces"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinDestinations: (() => ({ destinations: host.destinations, known: true })) as never,
}));

vi.mock(import("./useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinHostAt: (() => ({
    _tag: "host",
    environmentId: "env-1",
    connected: true,
    probe: {
      _tag: "ready",
      orgs: {
        orgs: [{ orgId: "org-1", name: "Tidewater Freight", agents: [] }],
        me: [{ orgId: "org-1", personId: "person-rhea" }],
      },
    },
  })) as never,
}));

vi.mock(import("./kinClient"), async (importOriginal) => {
  const { commandRun } = await import("../../test/commandRun");
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { KinChatError: Refused } = await import("@t3tools/contracts");
  const zone = Atom.make(AsyncResult.success({ timeZone: "Asia/Kolkata" }));
  const profiles = Atom.make(AsyncResult.success({ profiles: [] }));
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      workZone: () => zone,
      profiles: () => profiles,
      chatPinsSupported: () => Atom.make(host.supported),
      chatPins: () => Atom.make(AsyncResult.success({ pins: host.pins })),
      inbox: () =>
        Atom.make(
          AsyncResult.success({
            value: { chats: host.chats, waiting: [] },
            live: true,
            savedAt: null,
          }),
        ),
      chatPin: {
        label: "test:chatPin",
        permissionAtom: () => Atom.make(host.canPin),
        run: commandRun(
          async (
            _registry: unknown,
            { input }: { readonly input: { readonly chatId: string; readonly key: string } },
          ) => {
            host.pinCalls.push({ chatId: input.chatId, key: input.key });
            if (host.pinRefusal !== null) {
              return AsyncResult.failure(Cause.fail(new Refused(host.pinRefusal)));
            }
            return AsyncResult.success({ pins: host.pins });
          },
        ),
      },
      chatUnpin: {
        label: "test:chatUnpin",
        permissionAtom: () => Atom.make(host.canUnpin),
        run: commandRun(
          async (
            _registry: unknown,
            { input }: { readonly input: { readonly chatId: string; readonly pinId: string } },
          ) => {
            host.unpinCalls.push({ chatId: input.chatId, pinId: input.pinId });
            host.pins = host.pins.filter((pin) => pin.pinId !== input.pinId);
            return AsyncResult.success({ pins: host.pins });
          },
        ),
      },
    } as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinChatPinsStrip } from "./KinChatPins";
import { KinPinToChatDialog } from "./KinPinToChatDialog";

const envId = EnvironmentId.make("env-1");
const orgId = KinOrgId.make("org-1");
const chatId = KinChatId.make("chat-1");
const rheaId = KinPersonId.make("person-rhea");

const member = (role: KinChatMember["role"], id = chatId): KinChatMember => ({
  orgId,
  chatId: id,
  memberId: KinMemberId.make(`mem-${id}`),
  principal: { _tag: "person", personId: rheaId },
  role,
  joinedAt: "2026-11-20T00:00:00.000Z",
  leftAt: null,
  mutedUntil: null,
});

function setup(patch: Partial<typeof host> = {}) {
  host.supported = true;
  host.canPin = true;
  host.canUnpin = true;
  host.pins = [];
  host.chats = [];
  host.pinCalls = [];
  host.unpinCalls = [];
  host.pinRefusal = null;
  host.destinations = ["chats", "tasks", "money"];
  Object.assign(host, patch);
}

describe("pinned live cards on web", () => {
  it("draws nothing when no pins exist or the host has no pins topic", async () => {
    setup({ supported: true, pins: [] });
    await using empty = await render(
      <AppAtomRegistryProvider>
        <KinChatPinsStrip
          environmentId={envId}
          orgId={orgId}
          chatId={chatId}
          personId={rheaId}
          members={[member("owner")]}
        />
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(page.getByRole("region", { name: "Pinned in this chat" }))
      .not.toBeInTheDocument();
    await empty.unmount();

    setup({
      supported: false,
      pins: [{ _tag: "hidden", pinId: KinChatPinId.make("pin-1") }],
    });
    await using _unsupported = await render(
      <AppAtomRegistryProvider>
        <KinChatPinsStrip
          environmentId={envId}
          orgId={orgId}
          chatId={chatId}
          personId={rheaId}
          members={[member("owner")]}
        />
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(page.getByRole("region", { name: "Pinned in this chat" }))
      .not.toBeInTheDocument();
  });

  it("shows task, gone and hidden pins, hides unpin on hidden, and unpins gone without confirm", async () => {
    const pins: ReadonlyArray<KinChatPin> = [
      {
        _tag: "task",
        pinId: KinChatPinId.make("pin-task"),
        pinnedAt: "2026-11-26T00:00:00.000Z",
        pinnedBy: "Rhea",
        key: KinRecordKey.make("W-142"),
        title: "Check the cold room",
        state: "open",
        dueAt: null,
        dueAllDay: false,
        late: false,
      },
      {
        _tag: "gone",
        pinId: KinChatPinId.make("pin-gone"),
        pinnedAt: "2026-11-25T00:00:00.000Z",
        pinnedBy: "Rhea",
      },
      {
        _tag: "hidden",
        pinId: KinChatPinId.make("pin-hidden"),
      },
    ];
    setup({ pins });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinChatPinsStrip
          environmentId={envId}
          orgId={orgId}
          chatId={chatId}
          personId={rheaId}
          members={[member("owner")]}
        />
      </AppAtomRegistryProvider>,
    );

    const region = page.getByRole("region", { name: "Pinned in this chat" });
    await expect.element(region).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Show all 3 pinned items" }));

    const list = page.getByRole("list");
    await expect.element(list.getByText("A pin you can't open")).toBeVisible();
    await expect.element(list.getByText("No longer in Kin")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Unpin A pin you can't open from chat" }))
      .not.toBeInTheDocument();

    const unpinGone = page.getByRole("button", { name: "Unpin No longer in Kin from chat" });
    await expect.element(unpinGone).toBeVisible();
    await userEvent.click(unpinGone);
    expect(host.unpinCalls).toEqual([{ chatId: "chat-1", pinId: "pin-gone" }]);
  });

  it("opens a goal pin only for a reader who has Money, where Goals live", async () => {
    const goal: KinChatPin = {
      _tag: "goal",
      pinId: KinChatPinId.make("pin-goal"),
      pinnedAt: "2026-11-26T00:00:00.000Z",
      pinnedBy: "Rhea",
      key: KinRecordKey.make("G-1"),
      title: "Sign two new clinics",
      state: "open",
      measure: "manual",
      current: 1,
      target: 2,
      dueOn: null,
      behind: false,
    };
    setup({ pins: [goal], destinations: ["chats", "tasks"] });
    await using teammate = await render(
      <AppAtomRegistryProvider>
        <KinChatPinsStrip
          environmentId={envId}
          orgId={orgId}
          chatId={chatId}
          personId={rheaId}
          members={[member("member")]}
        />
      </AppAtomRegistryProvider>,
    );
    const region = page.getByRole("region", { name: "Pinned in this chat" });
    await expect.element(region.getByText("Sign two new clinics").first()).toBeInTheDocument();
    await expect
      .element(region.getByRole("button", { name: /Sign two new clinics/ }).first())
      .not.toBeInTheDocument();
    await teammate.unmount();

    setup({ pins: [goal] });
    await using _owner = await render(
      <AppAtomRegistryProvider>
        <KinChatPinsStrip
          environmentId={envId}
          orgId={orgId}
          chatId={chatId}
          personId={rheaId}
          members={[member("owner")]}
        />
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(
        page
          .getByRole("region", { name: "Pinned in this chat" })
          .getByRole("button", { name: /Sign two new clinics/ })
          .first(),
      )
      .toBeInTheDocument();
  });

  it("lists only writable chats in the picker and shows the server refusal verbatim", async () => {
    const companyChatId = KinChatId.make("chat-company");
    const guestChatId = KinChatId.make("chat-guest");
    setup({
      chats: [
        {
          chatId: guestChatId,
          orgId,
          kind: "team_group",
          title: "Guests only",
          teamId: null,
          createdAt: "2026-11-20T00:00:00.000Z",
          archivedAt: null,
          members: [member("guest", guestChatId)],
          lastSeq: 0,
          lastMessageAt: null,
          lastMessage: null,
          unread: 0,
        },
        {
          chatId: companyChatId,
          orgId,
          kind: "team_group",
          title: "Tidewater Freight",
          teamId: KIN_COMPANY_CHAT_TEAM_ID,
          createdAt: "2026-11-20T00:00:00.000Z",
          archivedAt: null,
          members: [member("owner", companyChatId)],
          lastSeq: 0,
          lastMessageAt: null,
          lastMessage: null,
          unread: 0,
        },
      ],
      pinRefusal: {
        reason: "not_allowed",
        message: "Not everyone in this chat can see this, so it can't be pinned here.",
      },
    });
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinPinToChatDialog
          open
          onOpenChange={onOpenChange}
          environmentId={envId}
          orgId={orgId}
          recordKey={KinRecordKey.make("W-142")}
          recordTitle="Check the cold room"
        />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Guests only")).not.toBeInTheDocument();
    const companyButton = page.getByRole("button", { name: "Tidewater Freight" });
    await expect.element(companyButton).toBeVisible();
    await userEvent.click(companyButton);

    await expect
      .element(
        page.getByText("Not everyone in this chat can see this, so it can't be pinned here."),
      )
      .toBeVisible();
    expect(host.pinCalls).toEqual([{ chatId: "chat-company", key: "W-142" }]);
    expect(onOpenChange).not.toHaveBeenCalled();

    host.pinRefusal = {
      reason: "invalid_state",
      message: "This chat has three pins. Unpin one first.",
    };
    await userEvent.click(companyButton);
    await expect
      .element(page.getByText("This chat has three pins. Unpin one first."))
      .toBeVisible();

    host.pinRefusal = null;
    await userEvent.click(companyButton);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
