import {
  EnvironmentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  type KinConnectionSaveEditedInput,
  type KinConnectionSendEditedInput,
  type KinWaitingItem,
  type KinWidget,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import {
  kinSendEditHeldKey,
  kinSendEditHold,
} from "@t3tools/client-runtime/kin/kinChoicePresentation";

import { render } from "../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { KinCard } from "./KinCards";

const POSTED = Date.parse("2026-11-19T09:00:00.000Z");
const state = vi.hoisted(() => ({
  /** Whether this session may send an edited mail; the card reads it as it would a grant. */
  canEdit: null as Atom.Writable<boolean> | null,
  sent: [] as Array<KinConnectionSendEditedInput>,
  saved: [] as Array<KinConnectionSaveEditedInput>,
  /** Each tap on a card's option, as posted. */
  acted: [] as Array<KinWidgetsActInput>,
  /** How each send is answered, in order: a refusal in the host's words, or null for done. */
  answers: [] as Array<{ reason: "invalid_state" | "widget_changed"; message: string } | null>,
  /** How each save is answered, in the same way. */
  saveAnswers: [] as Array<{ reason: "widget_changed"; message: string } | null>,
  /** What the open list says waits on the reader. */
  waiting: null as ReadonlyArray<KinWaitingItem> | null,
}));

vi.mock(import("~/state/use-atom-command"), async () => {
  const { Cause } = await import("effect");
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomCommand: ((command: { readonly label: string }) =>
      async (value: {
        readonly input:
          | KinConnectionSendEditedInput
          | KinConnectionSaveEditedInput
          | KinWidgetsActInput;
      }) => {
        if (command.label === "kin:widget:act" && "actionId" in value.input) {
          state.acted.push(value.input);
          return AsyncResult.success({});
        }
        if ("edit" in value.input) {
          state.saved.push(value.input);
          const refused = state.saveAnswers.shift() ?? null;
          return refused === null
            ? AsyncResult.success({ revision: value.input.revision + 1 })
            : AsyncResult.failure(Cause.fail(new KinChatError(refused)));
        }
        if (command.label !== "kin:connection:sendEdited")
          return AsyncResult.failure(Cause.fail("unused"));
        state.sent.push(value.input as KinConnectionSendEditedInput);
        const refusal = state.answers.shift() ?? null;
        return refusal === null
          ? AsyncResult.success({ widgetId: "choice:m2" })
          : AsyncResult.failure(Cause.fail(new KinChatError(refusal)));
      }) as never,
  };
});
vi.mock(import("./kinClient"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  state.canEdit = Atom.make(true).pipe(Atom.keepAlive);
  const canEdit = state.canEdit;
  return {
    kinClient: {
      widgetAction: { label: "kin:widget:act", permissionAtom: () => allowed },
      connectionSetSendFrom: { label: "kin:connection:setSendFrom", permissionAtom: () => allowed },
      connectionSendEdited: { label: "kin:connection:sendEdited", permissionAtom: () => canEdit },
      connectionSaveEdited: { label: "kin:connection:saveEdited", permissionAtom: () => canEdit },
    },
    // Imported by the pages a card can open; no test here reaches them.
    refreshKinAgents: () => {},
    retryKinAccess: () => {},
    kinReads: {},
  } as never;
});
vi.mock(import("../connection/catalog"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: { catalogValueAtom: Atom.make({ isReady: false, entries: new Map() }) },
  } as never;
});
vi.mock(import("./useKinOpen"), () => ({ useKinOpenWaiting: () => state.waiting }) as never);
vi.mock(import("./useKinOwnerLevel"), () => ({ useKinOwnerLevelKnown: () => true }) as never);
vi.mock(import("./useKinClock"), () => ({ useNowMinuteMs: () => POSTED + 60_000 }) as never);

function setup() {
  appAtomRegistry.set(state.canEdit!, true);
  state.sent.length = 0;
  state.saved.length = 0;
  state.acted.length = 0;
  state.answers.length = 0;
  state.saveAnswers.length = 0;
  state.waiting = null;
  kinSendEditHold(kinSendEditHeldKey("env-1", KinPersonId.make("rhea"), "choice:m1"), null);
}

/** The tab goes to the background, as when a person switches to another. */
function hideTab() {
  const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  return hidden;
}

const RHEA = "rhea@ambermill.example";
const BILLING = "billing@ambermill.example";

// Ambermill's Chief of staff drafted this mail to an invented client.
const mail = (change: { revision?: number; send?: Record<string, unknown> } = {}): KinWidget =>
  ({
    orgId: KinOrgId.make("org-1"),
    chatId: "cos-rhea",
    widgetId: "choice:m1",
    messageId: "m1",
    widgetClass: "native",
    type: "choice",
    revision: change.revision ?? 2,
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
        from: RHEA,
        account: RHEA,
        to: ["anita@orbitdental.example"],
        cc: [],
        subject: "Invoice",
        body: "Hi Anita,\nThe invoice is attached.\nRhea",
        attachments: [{ name: "INV-26-27-004.pdf", label: null, bytes: 20_480 }],
        outcome: null,
        ...change.send,
      },
      answer: null,
    },
    source: null,
    feed: null,
    awaiting: [KinPersonId.make("rhea")],
    pinnedAt: null,
    closedAt: null,
    updatedAt: "2026-11-19T09:00:00.000Z",
  }) as never;

const view = (widget: KinWidget = mail()) => (
  <AppAtomRegistryProvider>
    <KinCard
      widget={widget}
      environmentId={EnvironmentId.make("env-1")}
      orgId="org-1"
      viewerPersonId={KinPersonId.make("rhea")}
      heldFor={null}
    />
  </AppAtomRegistryProvider>
);

/** The From line, as the card's term and its value. */
const fromLine = () => page.getByRole("definition").filter({ hasText: "ambermill.example" });

describe("a mail card's Edit", () => {
  it("edits the mail in place, says what the host refused, and sends the edited mail", async () => {
    setup();
    state.answers.push(
      {
        reason: "invalid_state",
        message: "anita at orbit in To isn't a plain address such as ana@example.com.",
      },
      null,
    );
    await using screen = await render(view());
    await userEvent.click(page.getByRole("button", { name: "Edit" }));

    const to = page.getByLabelText("To");
    await expect.element(to).toHaveValue("anita@orbitdental.example");
    await expect
      .element(page.getByLabelText("Message"))
      .toHaveValue("Hi Anita,\nThe invoice is attached.\nRhea");
    // The account it goes from and the file are shown, not editable.
    await expect.element(fromLine()).toHaveTextContent(RHEA);
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
    await userEvent.fill(
      page.getByLabelText("Message"),
      "Hi Anita,\nThe invoice is attached.\nRhea\nPS: GST is on page 2.",
    );
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

  it("saves or discards edits without sending, and isn't offered to one who can't send", async () => {
    setup();
    await using screen = await render(view());
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await userEvent.type(page.getByLabelText("Subject"), " for November");
    await userEvent.click(page.getByRole("button", { name: "Discard edits" }));
    await expect.element(page.getByRole("button", { name: "Confirm" })).toBeVisible();
    await expect.element(screen.getByText("Invoice", { exact: true })).toBeVisible();
    expect(state.sent).toHaveLength(0);
    expect(state.saved).toHaveLength(0);

    // Save keeps the words on the card for its Confirm; nothing is sent.
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await userEvent.type(page.getByLabelText("Subject"), " for November");
    await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
    await expect.element(page.getByLabelText("Subject")).not.toBeInTheDocument();
    expect(state.saved).toEqual([
      {
        orgId: "org-1",
        widgetId: "choice:m1",
        revision: 2,
        edit: {
          to: ["anita@orbitdental.example"],
          cc: [],
          subject: "Invoice for November",
          body: "Hi Anita,\nThe invoice is attached.\nRhea",
        },
      },
    ]);
    expect(state.sent).toHaveLength(0);
    // Edit again before the saved card's update arrives: the saved words open, and Discard edits
    // resets the card the save made, however late that update is.
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await expect.element(page.getByLabelText("Subject")).toHaveValue("Invoice for November");
    await userEvent.click(page.getByRole("button", { name: "Discard edits" }));
    await expect.element(page.getByLabelText("Subject")).not.toBeInTheDocument();
    expect(state.saved[1]).toEqual({
      orgId: "org-1",
      widgetId: "choice:m1",
      revision: 3,
      edit: null,
    });

    // The saved card shows the person's words as theirs; Discard edits puts the draft back.
    const edited = { personId: "rhea", name: "Rhea" };
    await screen.rerender(
      view(mail({ revision: 5, send: { subject: "Invoice for November", edited } })),
    );
    await expect.element(screen.getByText("Edited by you")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await expect.element(page.getByLabelText("Subject")).toHaveValue("Invoice for November");
    await userEvent.click(page.getByRole("button", { name: "Discard edits" }));
    await expect.element(page.getByLabelText("Subject")).not.toBeInTheDocument();
    expect(state.saved[2]).toEqual({
      orgId: "org-1",
      widgetId: "choice:m1",
      revision: 5,
      edit: null,
    });

    // Hiding the tab saves the words and the editor stays. The save's answer lands before the
    // card's update does, and Discard edits still puts the draft back on the saved card.
    await screen.rerender(view(mail({ revision: 6 })));
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await userEvent.type(page.getByLabelText("Subject"), ", again");
    {
      using _hidden = hideTab();
      await vi.waitFor(() => expect(state.saved).toHaveLength(4));
    }
    expect(state.saved[3]).toMatchObject({ revision: 6, edit: { subject: "Invoice, again" } });
    await expect.element(page.getByLabelText("Subject")).toHaveValue("Invoice, again");
    await userEvent.click(page.getByRole("button", { name: "Discard edits" }));
    await expect.element(page.getByLabelText("Subject")).not.toBeInTheDocument();
    expect(state.saved[4]).toEqual({
      orgId: "org-1",
      widgetId: "choice:m1",
      revision: 7,
      edit: null,
    });

    // The grant goes, as a session's scopes change, and the open card follows.
    appAtomRegistry.set(state.canEdit!, false);
    await expect.element(page.getByRole("button", { name: "Confirm" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("holds Confirm and Send edited for the tick while an earlier try may have gone, then carries it", async () => {
    setup();
    await using screen = await render(
      view(mail({ send: { mayHaveGone: { at: "2026-11-19T08:30:00.000Z" } } })),
    );
    await expect.element(screen.getByText(/may already have gone/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await expect.element(page.getByRole("button", { name: "Send edited mail" })).toBeDisabled();
    const tick = page.getByRole("checkbox", { name: "I've checked the sent mail" });
    await userEvent.click(tick);
    await expect.element(tick).toBeChecked();
    await userEvent.fill(page.getByLabelText("Message"), "Hi Anita,\nResending the invoice.\nRhea");
    await userEvent.click(page.getByRole("button", { name: "Send edited mail" }));
    await expect.element(page.getByLabelText("To")).not.toBeInTheDocument();
    expect(state.sent[0]).toMatchObject({ widgetId: "choice:m1", checkedSent: true });
    // The plain Confirm carries the same tick.
    await userEvent.click(page.getByRole("button", { name: "Confirm" }));
    await vi.waitFor(() => expect(state.acted).toHaveLength(1));
    expect(state.acted[0]).toMatchObject({ value: "option-1", checkedSent: true });
  });

  it("shows a reply's From and the quote that goes with it, and Enter in a field sends nothing", async () => {
    setup();
    const quoted = "On Mon, Anita wrote:\n> Could you resend the invoice?";
    await using screen = await render(
      view(
        mail({ send: { action: "reply", from: BILLING, fromName: "Ambermill Billing", quoted } }),
      ),
    );
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await expect.element(fromLine().first()).toHaveTextContent(`Ambermill Billing <${BILLING}>`);
    await expect.element(screen.getByText("Account", { exact: true })).toBeVisible();
    await expect
      .element(page.getByLabelText("Quoted message"))
      .toHaveTextContent("On Mon, Anita wrote: > Could you resend the invoice?");

    const subject = page.getByLabelText("Subject");
    await userEvent.fill(subject, "Invoice for November");
    await userEvent.type(subject, "{Enter}");
    expect(state.sent).toHaveLength(0);
    await userEvent.type(page.getByLabelText("To"), "{Enter}");
    expect(state.sent).toHaveLength(0);
    await expect.element(subject).toHaveValue("Invoice for November");
  });

  it("keeps the words when the card changed underneath, shows its new From, and sends that card", async () => {
    setup();
    state.answers.push(
      {
        reason: "widget_changed",
        message: "This card changed or was answered. Look at it again.",
      },
      null,
    );
    await using screen = await render(view());
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await userEvent.fill(
      page.getByLabelText("Message"),
      "Hi Anita,\nThe invoice is attached.\nRhea\nPS: GST is on page 2.",
    );

    // From changed on another device. The host knows first: its refusal lands before the card's
    // update does, so there is no newer card to send yet.
    const send = page.getByRole("button", { name: "Send edited mail" });
    await userEvent.click(send);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This card changed or was answered. Look at it again.");
    const words = "Hi Anita,\nThe invoice is attached.\nRhea\nPS: GST is on page 2.";
    await expect.element(page.getByLabelText("Message")).toHaveValue(words);
    expect(state.sent[0]).toMatchObject({ revision: 2, body: words });
    await expect.element(send).toBeDisabled();

    // The card arrives: who it goes from now is beside Send, and Send carries that card.
    await screen.rerender(view(mail({ revision: 3, send: { from: BILLING, account: BILLING } })));
    await expect.element(fromLine().last()).toHaveTextContent(BILLING);
    expect(fromLine().elements()).toHaveLength(2);
    await expect.element(send).toBeEnabled();
    await userEvent.click(send);
    await expect.element(page.getByLabelText("Subject")).not.toBeInTheDocument();
    expect(state.sent).toHaveLength(2);
    expect(state.sent[1]).toMatchObject({ revision: 3, body: words });
  });

  it("keeps words a save on leaving couldn't keep, and shows them with the change next time", async () => {
    setup();
    state.saveAnswers.push({
      reason: "widget_changed",
      message: "This card changed or was answered. Look at it again.",
    });
    {
      await using _left = await render(view());
      await userEvent.click(page.getByRole("button", { name: "Edit" }));
      await userEvent.type(page.getByLabelText("Subject"), " for November");
    }
    expect(state.saved).toEqual([
      expect.objectContaining({
        revision: 2,
        edit: expect.objectContaining({ subject: "Invoice for November" }),
      }),
    ]);

    // Back on the chat, the card changed meanwhile: the words are there with why they weren't
    // kept, and Save carries the card on screen only when pressed again.
    await using _back = await render(
      view(mail({ revision: 3, send: { from: BILLING, account: BILLING } })),
    );
    await expect.element(page.getByLabelText("Subject")).toHaveValue("Invoice for November");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This card changed or was answered. Look at it again.");
    await expect.element(fromLine().last()).toHaveTextContent(BILLING);
    expect(state.saved).toHaveLength(1);
    await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
    await expect.element(page.getByLabelText("Subject")).not.toBeInTheDocument();
    expect(state.saved[1]).toMatchObject({
      revision: 3,
      edit: { subject: "Invoice for November" },
    });
  });
});

// Chief of staff asked Rhea whether to close a task, and marks it done if nobody answers.
const asked = (change: Record<string, unknown> = {}): KinWidget =>
  ({
    ...mail(),
    widgetId: "choice:q1",
    messageId: "q1",
    revision: 1,
    state: {
      question: "Can we close Design the booking flow screens?",
      detail: null,
      options: [
        { optionId: "option-1", label: "Keep open" },
        { optionId: "option-2", label: "Mark W-1 done" },
      ],
      untilAnswered: true,
      answer: null,
    },
    ...change,
  }) as never;
const waitingOn = (fallback: string | null): KinWaitingItem =>
  ({
    waitingId: "w-1",
    orgId: "org-1",
    personId: "rhea",
    chatId: "cos-rhea",
    messageId: "q1",
    widgetId: "choice:q1",
    reason: "question",
    createdAt: "2026-11-19T09:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    ask: {
      agent: "Chief of staff",
      default: fallback,
      by: "2026-11-20T14:00:00.000Z",
      revision: 1,
      options: [
        { optionId: "option-1", label: "Keep open" },
        { optionId: "option-2", label: "Mark W-1 done" },
      ],
    },
  }) as never;

describe("an agent's open question", () => {
  it("names under the question what Kin takes, and when, if nobody answers", async () => {
    setup();
    state.waiting = [waitingOn("Mark W-1 done")];
    await using screen = await render(view(asked()));
    await expect
      .element(page.getByText(/^If nobody answers by .+ at .+: Mark W-1 done\.$/))
      .toBeVisible();
    // Kin won't take it on its own: the card says nothing more than it did.
    state.waiting = [waitingOn(null)];
    await screen.rerender(view(asked({ revision: 2 })));
    await expect.element(page.getByText(/If nobody answers/)).not.toBeInTheDocument();
  });

  it("marks a taken default's note Undone, with who and when, once it is put back", async () => {
    setup();
    const note = (personId: string, name: string) =>
      asked({
        closedAt: "2026-11-19T09:00:30.000Z",
        state: {
          question: "Nobody answered, so I went with “Mark W-1 done” for W-1 Design the screens.",
          detail: null,
          options: [
            { optionId: "option-1", label: "Undo" },
            { optionId: "option-2", label: "Keep it" },
          ],
          untilAnswered: true,
          outcome: {
            title: "Undone",
            text: "Put W-1 “Design the screens” back as it was.",
            undone: { personId, name, at: "2026-11-19T09:00:30.000Z" },
          },
          answer: null,
        },
      });
    await using screen = await render(view(note("rhea", "Rhea Kapoor")));
    await expect.element(page.getByText(/^Undone by you at .+\.$/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    await screen.rerender(view(note("zoya", "Zoya Sheikh")));
    await expect.element(page.getByText(/^Undone by Zoya Sheikh at .+\.$/)).toBeVisible();
  });
});
