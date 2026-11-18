import {
  EnvironmentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  type KinConnectionSendEditedInput,
  type KinWidget,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinCard } from "./KinCards";

const POSTED = Date.parse("2026-11-19T09:00:00.000Z");
const state = vi.hoisted(() => ({
  canEdit: true,
  sent: [] as Array<KinConnectionSendEditedInput>,
  /** How each send is answered, in order: a message refuses it in the host's words. */
  answers: [] as Array<string | null>,
}));

vi.mock(import("~/state/use-atom-command"), async () => {
  const { Cause } = await import("effect");
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomCommand: ((command: { readonly label: string }) =>
      async (value: { readonly input: KinConnectionSendEditedInput }) => {
        if (command.label !== "kin:connection:sendEdited")
          return AsyncResult.failure(Cause.fail("unused"));
        state.sent.push(value.input);
        const refusal = state.answers.shift() ?? null;
        return refusal === null
          ? AsyncResult.success({ widgetId: "choice:m2" })
          : AsyncResult.failure(
              Cause.fail(new KinChatError({ reason: "invalid_state", message: refusal })),
            );
      }) as never,
  };
});
vi.mock(import("./kinClient"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    kinClient: {
      widgetAction: { permissionAtom: () => allowed },
      connectionSetSendFrom: { permissionAtom: () => allowed },
      connectionSendEdited: { permissionAtom: () => (state.canEdit ? allowed : denied) },
    },
  } as never;
});
vi.mock(import("../connection/catalog"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: { catalogValueAtom: Atom.make({ isReady: false, entries: new Map() }) },
  } as never;
});
vi.mock(import("./useKinOwnerLevel"), () => ({ useKinOwnerLevelKnown: () => true }) as never);
vi.mock(import("./useKinClock"), () => ({ useNowMinuteMs: () => POSTED + 60_000 }) as never);

function setup(canEdit = true) {
  state.canEdit = canEdit;
  state.sent.length = 0;
  state.answers.length = 0;
}

// Ambermill's Chief of staff drafted this mail to an invented client.
const card: KinWidget = {
  orgId: KinOrgId.make("org-1"),
  chatId: "cos-rhea",
  widgetId: "choice:m1",
  messageId: "m1",
  widgetClass: "native",
  type: "choice",
  revision: 2,
  state: {
    question: "Send this email from Gmail?",
    detail: null,
    options: [
      { optionId: "option-1", label: "Confirm", kind: "yes" },
      { optionId: "option-2", label: "Cancel", kind: "no" },
    ],
    send: {
      service: "Gmail",
      action: "email",
      from: "rhea@ambermill.example",
      account: "rhea@ambermill.example",
      to: ["anita@orbitdental.example"],
      cc: [],
      subject: "Invoice",
      body: "Hi Anita,\nThe invoice is attached.\nRhea",
      attachments: [{ name: "INV-26-27-004.pdf", label: null, bytes: 20_480 }],
      outcome: null,
    },
    answer: null,
  },
  source: null,
  feed: null,
  awaiting: [KinPersonId.make("rhea")],
  pinnedAt: null,
  closedAt: null,
  updatedAt: "2026-11-19T09:00:00.000Z",
} as never;

const view = () => (
  <AppAtomRegistryProvider>
    <KinCard
      widget={card}
      environmentId={EnvironmentId.make("env-1")}
      orgId="org-1"
      viewerPersonId={KinPersonId.make("rhea")}
      heldFor={null}
    />
  </AppAtomRegistryProvider>
);

describe("a mail card's Edit", () => {
  it("edits the mail in place, says what the host refused, and sends the edited mail", async () => {
    setup();
    state.answers.push("anita at orbit in To isn't a plain address such as ana@example.com.", null);
    await using screen = await render(view());
    await userEvent.click(page.getByRole("button", { name: "Edit" }));

    const to = page.getByLabelText("To");
    await expect.element(to).toHaveValue("anita@orbitdental.example");
    await expect
      .element(page.getByLabelText("Message"))
      .toHaveValue("Hi Anita,\nThe invoice is attached.\nRhea");
    // The file goes as drawn: it is shown, not editable.
    await expect.element(screen.getByText("INV-26-27-004.pdf")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Confirm" })).not.toBeInTheDocument();

    await userEvent.clear(to);
    await userEvent.type(to, "anita at orbit");
    await userEvent.click(page.getByRole("button", { name: "Send edited mail" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("anita at orbit in To isn't a plain address such as ana@example.com.");
    await expect.element(to).toHaveValue("anita at orbit");

    await userEvent.clear(to);
    await userEvent.type(to, "anita@orbitdental.example, dev@orbitdental.example");
    await userEvent.type(page.getByLabelText("Message"), "{Enter}PS: GST is on page 2.");
    await userEvent.click(page.getByRole("button", { name: "Send edited mail" }));

    await expect.element(page.getByLabelText("To")).not.toBeInTheDocument();
    expect(state.sent).toHaveLength(2);
    expect(state.sent[1]).toMatchObject({
      orgId: "org-1",
      widgetId: "choice:m1",
      revision: 2,
      to: ["anita@orbitdental.example", "dev@orbitdental.example"],
      cc: [],
      subject: "Invoice",
      body: "Hi Anita,\nThe invoice is attached.\nRhea\nPS: GST is on page 2.",
    });
    // Each press is its own; a retry of one would carry its id.
    expect(state.sent[1]!.clientActionId).not.toBe(state.sent[0]!.clientActionId);
  });

  it("discards edits back to the card, and isn't offered to one who can't send", async () => {
    setup();
    await using screen = await render(view());
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await userEvent.type(page.getByLabelText("Subject"), " for November");
    await userEvent.click(page.getByRole("button", { name: "Discard edits" }));
    await expect.element(page.getByRole("button", { name: "Confirm" })).toBeVisible();
    await expect.element(screen.getByText("Invoice", { exact: true })).toBeVisible();
    expect(state.sent).toHaveLength(0);

    setup(false);
    await screen.rerender(view());
    await expect.element(page.getByRole("button", { name: "Confirm" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });
});
