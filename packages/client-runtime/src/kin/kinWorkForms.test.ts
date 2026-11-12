// @effect-diagnostics globalDate:off - The target hint is read against a fixed local day.
import { KinChatError, type KinRecordKey } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import {
  KIN_WORK_FORM_CHANGED,
  createKinWorkForm,
  createKinWorkPageWatch,
  kinClientDraftCheck,
  kinClientDraftOf,
  kinClientUpdateInput,
  kinContactDraftCheck,
  kinContactDraftOf,
  kinProjectDraftCheck,
  kinProjectDraftOf,
  kinProjectTargetHint,
  kinWorkFormMoved,
  kinWorkSend,
  type KinClientDraft,
  type KinWorkFormState,
} from "./kinWorkForms.ts";

const refused = (reason: KinChatError["reason"], message: string) =>
  AsyncResult.failure(Cause.fail(new KinChatError({ reason, message }))) as AtomCommandResult<
    string,
    unknown
  >;
const saved = (value: string): AtomCommandResult<string, unknown> => AsyncResult.success(value);

function clientForm(answers: Array<AtomCommandResult<string, unknown>>, online = true) {
  const sent: Array<unknown> = [];
  let rereads = 0;
  let state: KinWorkFormState<KinClientDraft> | null = null;
  const form = createKinWorkForm<KinClientDraft, string>({
    noun: "client",
    start: { ...kinClientDraftOf(), name: "Invented Foods", notes: "Invented notes" },
    editing: { key: "C-1", rev: 4 },
    nameOf: (draft) => draft.name,
    check: kinClientDraftCheck,
    send: (change) => {
      sent.push(
        change.type === "update"
          ? { rev: change.rev, ...kinClientUpdateInput(change.changed) }
          : change,
      );
      return Promise.resolve(answers.shift() ?? saved("ok"));
    },
    online: () => online,
    reread: () => {
      rereads += 1;
    },
    onChange: (next) => {
      state = next;
    },
  });
  return { form, sent, rereads: () => rereads, state: () => state ?? form.getState() };
}

describe("createKinWorkForm", () => {
  it("keeps what was typed through a conflict, and saves it again over the latest", async () => {
    const { form, sent, rereads, state } = clientForm([
      refused("conflict", "C-1 changed since you read it; it is at revision 5 now. Read it again."),
    ]);
    form.edit({ terms: "Invented net 30" });
    expect(await form.save()).toEqual({ saved: false });
    expect(state().problem).toEqual({ kind: "conflict", text: KIN_WORK_FORM_CHANGED });
    expect(state().draft.terms).toBe("Invented net 30");
    expect(rereads()).toBe(1);

    // Someone else renamed it meanwhile: shown beside the form, never typed over it.
    form.latest({ ...state().from, name: "Invented Foods Ltd" }, 5);
    expect(kinWorkFormMoved(state())).toEqual({ name: "Invented Foods Ltd" });
    expect(state().draft.name).toBe("Invented Foods");

    expect(await form.save()).toEqual({ saved: true, value: "ok" });
    // Only the retyped field goes, so the other person's rename stays.
    expect(sent).toEqual([
      { rev: 4, terms: "Invented net 30" },
      { rev: 5, terms: "Invented net 30" },
    ]);
    // A billing address typed away clears it, rather than keeping blank lines.
    expect(kinClientUpdateInput({ address: " \n " })).toEqual({ address: null });
  });

  it("offers the one already there when the name is taken, and keeps the form", async () => {
    const { form, state } = clientForm([
      refused("conflict", "There is already a client named Invented Juniper: C-7."),
    ]);
    form.edit({ name: "Invented Juniper" });
    expect(await form.save()).toEqual({ saved: false });
    expect(state().problem).toEqual({
      kind: "duplicate",
      text: "There's already a client called Invented Juniper.",
      existing: "C-7",
    });
    expect(state().draft.name).toBe("Invented Juniper");
  });

  it("sends nothing while offline, or when nothing was retyped", async () => {
    const offline = clientForm([], false);
    offline.form.edit({ notes: "Invented other notes" });
    expect(await offline.form.save()).toEqual({ saved: false });
    expect(offline.state().problem?.kind).toBe("offline");
    expect(offline.sent).toEqual([]);

    const untouched = clientForm([]);
    expect(await untouched.form.save()).toEqual({ saved: true, value: null });
    expect(untouched.sent).toEqual([]);
  });
});

describe("kinWorkSend", () => {
  it("says what to do when closing is refused because open work points at it", async () => {
    const outcome = await kinWorkSend({
      online: () => true,
      send: () =>
        Promise.resolve(
          refused(
            "invalid_state",
            "C-1 still has 2 open entries or projects pointing at it. Close or move them first.",
          ),
        ),
      noun: "client",
      name: "Invented Foods",
      own: "C-1",
    });
    expect(outcome).toEqual({
      ok: false,
      problem: {
        kind: "open_work",
        text: "Invented Foods still has open tasks or projects. Finish them or move them to another client, then close.",
      },
    });
  });
});

describe("createKinWorkPageWatch", () => {
  function watching(newest: number | null = null) {
    let rereads = 0;
    let asked = 0;
    const watch = createKinWorkPageWatch({
      own: "C-1" as KinRecordKey,
      reread: () => {
        rereads += 1;
      },
      newest: () => {
        asked += 1;
        return Promise.resolve(newest);
      },
    });
    const page = { seq: 10, held: new Set(["C-1", "CT-2", "W-5"]) };
    return { watch, page, rereads: () => rereads, asked: () => asked };
  }

  it("reads nothing for a change the page covers or another client's", () => {
    const { watch, page, rereads, asked } = watching();
    // Its own change, already read; then another client, renamed.
    watch.changed({ changed: { "W-5": 10 }, unnamed: 0 }, page);
    watch.changed({ changed: { "W-5": 10, "C-9": 11 }, unnamed: 0 }, page);
    expect([rereads(), asked()]).toEqual([0, 0]);
  });

  it("reads once for a change to something it shows, and for one with no name", () => {
    const { watch, page, rereads, asked } = watching();
    watch.changed({ changed: { "W-5": 11 }, unnamed: 0 }, page);
    // The same state again, before the read lands, costs nothing more.
    watch.changed({ changed: { "W-5": 11 }, unnamed: 0 }, page);
    expect([rereads(), asked()]).toEqual([1, 0]);
    watch.changed({ changed: { "W-5": 11 }, unnamed: 12 }, page);
    expect(rereads()).toBe(2);
  });

  it("asks about a task it doesn't hold, and reads only when it turns out to be this client's", async () => {
    const elsewhere = watching(10);
    elsewhere.watch.changed({ changed: { "W-77": 11 }, unnamed: 0 }, elsewhere.page);
    await Promise.resolve();
    expect([elsewhere.rereads(), elsewhere.asked()]).toEqual([0, 1]);

    const here = watching(11);
    here.watch.changed({ changed: { "W-77": 11 }, unnamed: 0 }, here.page);
    await Promise.resolve();
    expect([here.rereads(), here.asked()]).toEqual([1, 1]);
  });
});

describe("kinProjectDraftCheck", () => {
  it.each([
    ["2026-02-30", "Enter a real date."],
    ["2026-13-01", "Enter a real date."],
    ["2025-02-29", "Enter a real date."],
    ["2028-02-29", null],
    ["2026-12-31", null],
  ])("target %s", (target, problem) => {
    expect(kinProjectDraftCheck({ ...kinProjectDraftOf(), name: "Relaunch", target })).toBe(
      problem,
    );
  });

  it("names the year only outside this one, and never labels an impossible day", () => {
    const now = new Date(2026, 10, 12);
    expect(kinProjectTargetHint("2026-12-03", now)).not.toMatch(/2026/);
    expect(kinProjectTargetHint("2027-03-02", now).match(/2027/g)).toHaveLength(1);
    expect(kinProjectTargetHint("2026-02-30", now)).toBe("Enter a real date.");
  });
});

describe("kinContactDraftCheck", () => {
  const contact = { ...kinContactDraftOf(), name: "Ravi" };
  it.each([
    [{ email: "not-an-email" }, "Enter an email like name@example.com."],
    [{ phone: "call reception" }, "Enter a phone number with digits in it."],
    [{ phone: "x12" }, null],
    [{ phone: "+1 (555) 010-0199 ext. 4" }, null],
    [{ email: "ravi@example.com", phone: "+91 98450 12345" }, null],
    [{}, null],
  ])("%o", (details, problem) => {
    expect(kinContactDraftCheck({ ...contact, ...details })).toBe(problem);
  });

  it("lets an old email or phone stay as saved, and checks it once retyped", () => {
    const saved = { ...contact, email: "front desk", phone: "ask Mira" };
    expect(kinContactDraftCheck({ ...saved, name: "Ravi Rao" }, saved)).toBeNull();
    expect(kinContactDraftCheck({ ...saved, email: "front desk 2" }, saved)).toBe(
      "Enter an email like name@example.com.",
    );
    expect(kinContactDraftCheck({ ...saved, phone: "ask Ravi" }, saved)).toBe(
      "Enter a phone number with digits in it.",
    );
  });
});
