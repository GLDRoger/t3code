import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  type KinRecordComment,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  posts: [] as Array<{ clientRequestId: string; body: string }>,
  /** How each post is answered, in order: false fails as a dropped connection. */
  answers: [] as Array<boolean>,
}));

vi.mock(import("~/state/use-atom-command"), async () => {
  const { Cause } = await import("effect");
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomCommand: ((command: { readonly label: string }) =>
      async (value: {
        readonly input: { readonly clientRequestId: string; readonly body: string };
      }) => {
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
import { KinTaskActivity, KinTaskNoteComposer } from "./KinTaskRecord";

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
