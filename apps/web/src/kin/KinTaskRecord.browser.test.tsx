import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinProjectNote,
  type KinRecordComment,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  posts: [] as Array<{ clientRequestId: string; body: string }>,
  /** How each post is answered, in order: false fails as a dropped connection. */
  answers: [] as Array<boolean>,
  links: [] as Array<{ readonly url: string; readonly name?: string }>,
  notes: [] as Array<string>,
}));

vi.mock(import("~/state/use-atom-command"), async () => {
  const { Cause } = await import("effect");
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomCommand: ((command: { readonly label: string }) =>
      async (value: {
        readonly input: {
          readonly clientRequestId: string;
          readonly body: string;
          readonly url: string;
          readonly name?: string;
        };
      }) => {
        if (command.label === "kin:work:linkAdd") {
          state.links.push({
            url: value.input.url,
            ...(value.input.name === undefined ? {} : { name: value.input.name }),
          });
          return AsyncResult.success({});
        }
        if (command.label === "kin:work:projectNote") {
          state.notes.push(value.input.body);
          return AsyncResult.success({ note: null });
        }
        if (command.label !== "kin:work:comment") return AsyncResult.failure(Cause.fail("unused"));
        state.posts.push({ clientRequestId: value.input.clientRequestId, body: value.input.body });
        if (state.answers.shift() === false)
          return AsyncResult.failure(Cause.fail(new Error("socket closed")));
        const comment: KinRecordComment = {
          commentId: `comment-${state.posts.length}`,
          seq: 1,
          at: "2026-11-19T09:40:00.000Z",
          by: { _tag: "person", personId: KinPersonId.make("rhea") },
          body: value.input.body,
          files: [],
          canRemove: true,
        };
        return AsyncResult.success({ comment });
      }) as never,
  };
});
vi.mock(import("./useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinHostAt: (() => ({
    _tag: "host",
    environmentId: "env-1",
    connected: true,
  })) as never,
}));
// Files take the chat's upload path, which is its own; this note carries words only.
vi.mock(import("./KinComposerAttachments"), () => ({
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

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinProjectNoteSection } from "./KinProjectNote";
import { KinTaskActivity, KinTaskNoteComposer } from "./KinTaskRecord";
import { KinWorkLinks } from "./KinWorkItemSheet";

const target = {
  environmentId: EnvironmentId.make("env-1"),
  orgId: KinOrgId.make("org-1"),
  itemKey: KinRecordKey.make("T-41"),
};
const names = {
  people: new Map([["rhea", "Rhea"]]),
  agents: new Map<string, string>(),
  me: KinPersonId.make("rhea"),
  zone: null,
};

function setup(answers: Array<boolean>) {
  state.posts = [];
  state.answers = answers;
  state.links = [];
  state.notes = [];
}

describe("a note on a task", () => {
  it("shows in Activity once added, and a failed send is retried under the same id", async () => {
    setup([false, true]);
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinTaskActivity
          {...target}
          item={{ changes: [], comments: [] }}
          names={names}
          now={new Date("2026-11-19T10:00:00.000Z")}
          note={null}
          onOpenProject={() => {}}
        />
        <KinTaskNoteComposer {...target} />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Nothing has happened here yet.")).toBeVisible();

    const box = page.getByRole("textbox", { name: "Add a note…" });
    await userEvent.type(box, "Invented: call the printer{Enter}");

    await expect.element(page.getByText("Invented: call the printer")).toBeVisible();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Your note wasn't added. Check your connection to the server and try again.",
      );
    await expect.element(box).toHaveValue("");

    await userEvent.click(page.getByRole("button", { name: "Retry" }));

    await expect.element(page.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Remove this note" })).toBeVisible();
    await expect.element(page.getByText("Invented: call the printer")).toBeVisible();
    expect(state.posts).toHaveLength(2);
    expect(state.posts[1]).toEqual(state.posts[0]);
  });
});

describe("what a coding agent did on a task", () => {
  it("reads as its person's, via the coding agent by its quoted name", async () => {
    setup([]);
    const zoya = { _tag: "person", personId: KinPersonId.make("zoya") } as const;
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinTaskActivity
          {...target}
          // Its own task: notes a test posted stay in the app's store for that task.
          itemKey={KinRecordKey.make("T-42")}
          item={{
            changes: [
              {
                seq: 2,
                at: "2026-11-19T09:00:00.000Z",
                by: zoya,
                via: "owner",
                kind: "updated",
                fields: [{ field: "state", from: "open", to: "doing" }],
                codingAgent: "Invented laptop",
              },
            ],
            comments: [
              {
                commentId: "comment-1",
                seq: 1,
                at: "2026-11-19T09:30:00.000Z",
                by: zoya,
                codingAgent: "Invented laptop",
                body: "Invented: also mark the invoice paid",
                files: [],
              },
            ],
          }}
          names={{ ...names, people: new Map([...names.people, ["zoya", "Zoya"]]) }}
          now={new Date("2026-11-19T10:00:00.000Z")}
          note={null}
          onOpenProject={() => {}}
        />
      </AppAtomRegistryProvider>,
    );
    // Each line is who did it, then what, then via the coding agent and its name, quoted.
    const lines = page.getByRole("listitem");
    await vi.waitFor(() =>
      expect(lines.elements().map((line) => line.textContent)).toEqual([
        expect.stringMatching(/^Zoya started on it, via coding agent “Invented laptop” · /),
        expect.stringMatching(
          /^Zoya via coding agent “Invented laptop” · .+Invented: also mark the invoice paid$/,
        ),
      ]),
    );
  });
});

describe("a task's links and its project's note", () => {
  it("adds a link that shows under Linked, and a project note that tops the task's Activity", async () => {
    setup([]);
    const figma = "https://figma.example/file/invented-screens";
    const linkedItem = (
      links: ReadonlyArray<{ readonly url: string; readonly name?: string }>,
    ) => ({
      key: target.itemKey,
      links: links.map((link) => ({
        kind: "url" as const,
        relation: "relates" as const,
        target: link.url,
        chatId: null,
        label: link.name ?? null,
        createdAt: "2026-11-19T09:00:00.000Z",
      })),
    });
    const linkViews = (links: ReadonlyArray<{ readonly url: string; readonly name?: string }>) =>
      links.map((link) => ({
        key: `url:${link.url}`,
        kind: "link" as const,
        label: link.name ?? link.url,
        detail: null,
        open: { type: "url" as const, href: link.url },
        thread: null,
        removeUrl: link.url,
      }));
    const onOpenProject = vi.fn();
    await using screen = await render(
      <AppAtomRegistryProvider>
        <KinWorkLinks
          {...target}
          item={linkedItem([])}
          links={[]}
          title="Linked"
          itemKey={target.itemKey}
          addLink
          onOpenKey={() => {}}
        />
      </AppAtomRegistryProvider>,
    );

    await userEvent.click(page.getByRole("button", { name: "Add a link" }));
    await userEvent.type(page.getByRole("textbox", { name: "Web address" }), "javascript:alert(1)");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("A link needs a web address that starts with https:// or http://.");
    await expect.element(page.getByRole("button", { name: "Add link" })).toBeDisabled();
    await userEvent.clear(page.getByRole("textbox", { name: "Web address" }));
    await userEvent.type(page.getByRole("textbox", { name: "Web address" }), figma);
    await userEvent.type(page.getByRole("textbox", { name: "Name (optional)" }), "Screens");
    await userEvent.click(page.getByRole("button", { name: "Add link" }));
    expect(state.links).toEqual([{ url: figma, name: "Screens" }]);

    // The host answers with the link on the task; the sheet reads it again.
    await screen.rerender(
      <AppAtomRegistryProvider>
        <KinWorkLinks
          {...target}
          item={linkedItem(state.links)}
          links={linkViews(state.links)}
          title="Linked"
          itemKey={target.itemKey}
          addLink
          onOpenKey={() => {}}
        />
        <KinProjectNoteSection
          {...target}
          projectKey={KinRecordKey.make("P-4")}
          note={null}
          canEdit
          onChanged={() => {}}
        />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "Linked" })).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: /Screens/ }))
      .toHaveAttribute("href", figma);
    await expect
      .element(page.getByRole("button", { name: "Remove the link Screens" }))
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Edit Note for every task" }));
    await userEvent.type(
      page.getByRole("textbox", { name: "Note for every task" }),
      "Invented: brand blue is #1a4f8b",
    );
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    expect(state.notes).toEqual(["Invented: brand blue is #1a4f8b"]);

    const note: KinProjectNote = {
      body: state.notes[0]!,
      at: "2026-11-19T09:30:00.000Z",
      by: { _tag: "person", personId: KinPersonId.make("rhea") },
      project: {
        recordId: KinRecordId.make("rec_P-4"),
        key: KinRecordKey.make("P-4"),
        title: "Ambermill shop",
      },
    };
    await screen.rerender(
      <AppAtomRegistryProvider>
        <KinTaskActivity
          {...target}
          item={{ changes: [], comments: [], projectNote: note }}
          names={names}
          now={new Date("2026-11-19T10:00:00.000Z")}
          note={null}
          onOpenProject={onOpenProject}
        />
      </AppAtomRegistryProvider>,
    );
    const pinned = page.getByLabelText("From the project");
    await expect.element(pinned.getByText("From the project", { exact: true })).toBeVisible();
    await expect.element(pinned.getByText(/You,/)).toBeVisible();
    await expect.element(pinned.getByText("Invented: brand blue is #1a4f8b")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Ambermill shop" }));
    expect(onOpenProject).toHaveBeenCalledWith("P-4");
  });
});
