// @effect-diagnostics globalDate:off - The target hint is read against a fixed local day.
import { type KinContact, KinChatError, KinRecordId, KinRecordKey } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import {
  KIN_WORK_FORM_CHANGED,
  KIN_WORK_FORM_COPY,
  createKinWorkForm,
  createKinWorkPageWatch,
  kinClientCreateInput,
  kinClientDraftCheck,
  kinClientDraftOf,
  kinClientDraftWithGstin,
  kinClientGstinNote,
  kinClientUpdateInput,
  kinContactCreateInput,
  kinContactDetailAdd,
  kinContactDetailCanAdd,
  kinContactDetailRemove,
  kinContactDetailSet,
  kinContactDraftCheck,
  kinContactDraftOf,
  kinContactUpdateInput,
  kinProjectCreateInput,
  kinProjectDraftCheck,
  kinProjectDraftOf,
  kinProjectUpdateInput,
  kinProjectTargetHint,
  kinTaskProjectMenu,
  kinWorkFormMoved,
  kinWorkReadState,
  kinWorkReadUnreachable,
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

  it("takes a newer read while the owner types, keeps the typing and saves against the newer one", async () => {
    const { form, sent, state } = clientForm([]);
    form.edit({ terms: "Invented net 45" });
    // Every render hands the form the record as read; only a newer revision counts.
    form.latest({ ...state().from, name: "Invented Foods Pvt" }, 4);
    expect(state().latest).toBeNull();
    form.latest({ ...state().from, name: "Invented Foods Ltd" }, 6);
    form.latest({ ...state().from, name: "Invented Foods Old" }, 5);
    expect(state().draft).toMatchObject({ name: "Invented Foods", terms: "Invented net 45" });
    expect(kinWorkFormMoved(state())).toEqual({ name: "Invented Foods Ltd" });
    expect(await form.save()).toEqual({ saved: true, value: "ok" });
    expect(sent).toEqual([{ rev: 6, terms: "Invented net 45" }]);
  });

  it("sends a prospect, where it came from and its tags, and switches prospect and client", () => {
    const draft = {
      ...kinClientDraftOf(undefined, "prospect"),
      name: "Fennick & Daughters",
      source: " Harbour trade fair ",
      tags: "clinics, north,, clinics ",
    };
    expect(kinClientCreateInput(draft)).toEqual({
      name: "Fennick & Daughters",
      prospect: true,
      source: "Harbour trade fair",
      tags: ["clinics", "north"],
    });
    expect(kinClientDraftCheck({ ...draft, tags: "x".repeat(61) })).toMatch(/each tag/);
    expect(kinClientUpdateInput({ kind: "client" })).toEqual({ kind: "client", prospect: false });
    expect(kinClientUpdateInput({ kind: "prospect" })).toEqual({ kind: "client", prospect: true });
    expect(kinClientUpdateInput({ kind: "vendor" })).toEqual({ kind: "vendor" });
    // Typed away, both clear.
    expect(kinClientUpdateInput({ source: " ", tags: "" })).toEqual({ source: null, tags: [] });
    const stored = kinClientDraftOf({
      name: "Fennick & Daughters",
      kind: "client",
      prospect: true,
      source: "Harbour trade fair",
      tags: ["clinics", "north"],
      terms: null,
      address: null,
      gstin: null,
      placeOfSupply: null,
      notes: "",
      sensitive: false,
    });
    expect([stored.kind, stored.source, stored.tags]).toEqual([
      "prospect",
      "Harbour trade fair",
      "clinics, north",
    ]);
  });

  it("takes a client's GSTIN and state, the state from the GSTIN, saying when they disagree", () => {
    const blank = { ...kinClientDraftOf(), name: "Invented Foods" };
    const typed = kinClientDraftWithGstin(blank, " 27bbbbb2222b1z5 ");
    expect([typed.placeOfSupply, kinClientGstinNote(typed), kinClientDraftCheck(typed)]).toEqual([
      "Maharashtra",
      null,
      null,
    ]);
    expect(kinClientCreateInput(typed)).toMatchObject({
      gstin: "27BBBBB2222B1Z5",
      placeOfSupply: "Maharashtra",
    });
    // A state already chosen stays, and the mismatch is said, not refused.
    const elsewhere = kinClientDraftWithGstin(
      { ...blank, placeOfSupply: "Karnataka" },
      "27BBBBB2222B1Z5",
    );
    expect([elsewhere.placeOfSupply, kinClientDraftCheck(elsewhere)]).toEqual(["Karnataka", null]);
    expect(kinClientGstinNote(elsewhere)).toMatch(/registered in Maharashtra, not Karnataka/);
    expect(kinClientDraftCheck({ ...blank, gstin: "27BBBBB" })).toMatch(/GSTIN isn't right/);
    // A stored code reads as its state; anything else is a country, an export.
    const stored = (placeOfSupply: string) =>
      kinClientDraftOf({
        name: "Invented Foods",
        kind: "client",
        terms: null,
        address: null,
        gstin: null,
        placeOfSupply,
        notes: "",
        sensitive: false,
      });
    expect(
      [stored("29"), stored("United States")].map((one) => [one.placeOfSupply, one.abroad]),
    ).toEqual([
      ["Karnataka", false],
      ["United States", true],
    ]);
    expect(kinClientUpdateInput({ gstin: " ", placeOfSupply: "" })).toEqual({
      gstin: null,
      placeOfSupply: null,
    });
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

  it("reads a campaign's page for any client, contact or deal, which its counts read", () => {
    let rereads = 0;
    const watch = createKinWorkPageWatch({
      own: "P-3" as KinRecordKey,
      reread: () => {
        rereads += 1;
      },
      newest: () => Promise.resolve(null),
    });
    const page = { seq: 10, held: new Set(["P-3", "C-*", "CT-*", "DL-*"]) };
    watch.changed({ changed: { "P-9": 11 }, unnamed: 0 }, page);
    expect(rereads).toBe(0);
    watch.changed({ changed: { "CT-40": 12 }, unnamed: 0 }, page);
    watch.changed({ changed: { "CT-40": 12, "DL-2": 13 }, unnamed: 0 }, page);
    expect(rereads).toBe(2);
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

    // A lead or member can't read the history: their page is read again rather than left behind.
    const teammate = watching(null);
    teammate.watch.changed({ changed: { "W-77": 11 }, unnamed: 0 }, teammate.page);
    await Promise.resolve();
    expect([teammate.rereads(), teammate.asked()]).toEqual([1, 1]);
  });
});

describe("kinWorkReadState", () => {
  // A deal page or Deals tab read again after the Clients switch went off.
  it("shows nothing it held once a read again is refused; any other failure keeps it, stale", () => {
    const previousSuccess = Option.some(AsyncResult.success("DL-1 Invented pilot"));
    const after = (reason: KinChatError["reason"]) =>
      kinWorkReadState(
        AsyncResult.failure(Cause.fail(new KinChatError({ reason, message: "Invented" })), {
          previousSuccess,
        }),
      );
    expect(after("not_allowed")).toEqual({ _tag: "refused" });
    expect(after("not_found")).toEqual({ _tag: "gone" });
    expect(after("unavailable")).toEqual({
      _tag: "ready",
      value: "DL-1 Invented pilot",
      stale: true,
    });
  });

  // Money's Cash in the bank and Next 30 days offline: no "Loading…" under the page's offline line.
  it("says nothing of a read it can't reach and holds nothing of, and shows what it holds", () => {
    const waiting = kinWorkReadState(AsyncResult.initial(true));
    const failed = kinWorkReadState(AsyncResult.failure(Cause.fail("down")));
    const held = kinWorkReadState(AsyncResult.success("Cash 1,200"));
    expect(kinWorkReadUnreachable(waiting, "offline")).toBe(true);
    expect(kinWorkReadUnreachable(failed, "offline")).toBe(true);
    expect(kinWorkReadUnreachable(held, "offline")).toBe(false);
    expect(kinWorkReadUnreachable(waiting, "connecting")).toBe(false);
    expect(kinWorkReadUnreachable(failed, "connected")).toBe(false);
  });
});

describe("kinTaskProjectMenu", () => {
  const ref = (key: string, title: string) => ({ key: KinRecordKey.make(key), title });
  it("a done project is offered in the menu", () => {
    const menu = kinTaskProjectMenu({
      projects: [ref("P-1", "Shopfront")],
      doneProjects: [ref("P-2", "Spring launch")],
    });
    expect(menu).toEqual([
      { label: null, choices: [ref("P-1", "Shopfront")] },
      { label: "Done", choices: [ref("P-2", "Spring launch")] },
    ]);
  });

  it("leaves out an empty group", () => {
    expect(kinTaskProjectMenu({ projects: [ref("P-1", "Shopfront")], doneProjects: [] })).toEqual([
      { label: null, choices: [ref("P-1", "Shopfront")] },
    ]);
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

  it("says how to leave the target out while it is out, and nothing once a day is picked", () => {
    expect(kinProjectTargetHint(null)).toBe("Leave it empty for no target date.");
    expect(kinProjectTargetHint("2026-12-03")).toBeNull();
    expect(kinProjectTargetHint("2026-02-30")).toBe("Enter a real date.");
  });
});

describe("a new client's first contact", () => {
  const draft = { ...kinClientDraftOf(undefined, "prospect"), name: "Tallmoor Freight" };
  const blank = { contactName: "", contactRole: "", contactEmails: [""], contactPhones: [""] };
  it.each([
    ["nothing typed", {}, null, undefined],
    ["spaces only", { contactName: " ", contactPhones: ["  ", " "] }, null, undefined],
    ["a name", { contactName: " Ingrid Holm " }, null, { name: "Ingrid Holm" }],
    [
      "everything",
      {
        contactName: "Ingrid Holm",
        contactRole: " Head of buying ",
        contactEmails: [" ingrid@example.com "],
        contactPhones: ["+47 912 34 567"],
      },
      null,
      {
        name: "Ingrid Holm",
        role: "Head of buying",
        email: "ingrid@example.com",
        phone: "+47 912 34 567",
      },
    ],
    [
      "two of each",
      {
        contactName: "Ingrid Holm",
        contactEmails: ["ingrid@example.com", "", "ingrid.home@example.com"],
        contactPhones: ["+47 912 34 567", "+47 912 34 568"],
      },
      null,
      {
        name: "Ingrid Holm",
        email: "ingrid@example.com",
        emails: ["ingrid@example.com", "ingrid.home@example.com"],
        phone: "+47 912 34 567",
        phones: ["+47 912 34 567", "+47 912 34 568"],
      },
    ],
    [
      "a phone only",
      { contactPhones: ["+47 912 34 567"] },
      KIN_WORK_FORM_COPY.party.contactNameMissing,
      undefined,
    ],
    [
      "an email only",
      { contactEmails: ["", "ingrid@example.com"] },
      KIN_WORK_FORM_COPY.party.contactNameMissing,
      undefined,
    ],
    [
      "a role only",
      { contactRole: "Buyer" },
      KIN_WORK_FORM_COPY.party.contactNameMissing,
      undefined,
    ],
    [
      "a bad email",
      { contactName: "Ingrid", contactEmails: ["ingrid@example.com", "ingrid at tallmoor"] },
      "Enter an email like name@example.com.",
      undefined,
    ],
    [
      "a phone with no digits",
      { contactName: "Ingrid", contactPhones: ["ask reception"] },
      "Enter a phone number with digits in it.",
      undefined,
    ],
  ] as const)("%s", (_, typed, problem, contact) => {
    const filled = { ...draft, ...blank, ...typed };
    expect(kinClientDraftCheck(filled)).toBe(problem);
    if (problem === null) expect(kinClientCreateInput(filled).contact).toEqual(contact);
  });
  it("starts empty, for a new one and one being edited, and an edit never sends it", () => {
    expect(kinClientDraftOf(undefined, "client")).toMatchObject(blank);
    expect(kinClientUpdateInput({ name: "Tallmoor" })).toEqual({ name: "Tallmoor" });
  });
});

describe("kinContactDraftCheck", () => {
  const contact = { ...kinContactDraftOf(), name: "Ravi" };
  it.each([
    [{ emails: ["not-an-email"] }, "Enter an email like name@example.com."],
    [{ emails: ["ravi@example.com", "not-an-email"] }, "Enter an email like name@example.com."],
    [{ phones: ["call reception"] }, "Enter a phone number with digits in it."],
    [{ phones: ["+91 98450 12345", "call reception"] }, "Enter a phone number with digits in it."],
    [{ phones: ["x12"] }, null],
    [{ phones: ["+1 (555) 010-0199 ext. 4"] }, null],
    [{ emails: ["ravi@example.com"], phones: ["+91 98450 12345"] }, null],
    [{ emails: ["ravi@example.com", ""] }, null],
    [{}, null],
  ])("%o", (details, problem) => {
    expect(kinContactDraftCheck({ ...contact, ...details })).toBe(problem);
  });

  it("lets an old email or phone stay as saved, and checks it once retyped", () => {
    const saved = { ...contact, emails: ["front desk"], phones: ["ask Mira"] };
    expect(kinContactDraftCheck({ ...saved, name: "Ravi Rao" }, saved)).toBeNull();
    expect(
      kinContactDraftCheck({ ...saved, emails: ["ravi@example.com", "front desk"] }, saved),
    ).toBeNull();
    expect(kinContactDraftCheck({ ...saved, emails: ["front desk 2"] }, saved)).toBe(
      "Enter an email like name@example.com.",
    );
    expect(kinContactDraftCheck({ ...saved, phones: ["ask Ravi"] }, saved)).toBe(
      "Enter a phone number with digits in it.",
    );
  });
});

describe("a contact's several emails and phones", () => {
  const read: KinContact = {
    recordId: KinRecordId.make("r-CT-1"),
    key: KinRecordKey.make("CT-1"),
    party: { recordId: KinRecordId.make("r-C-1"), key: KinRecordKey.make("C-1"), title: "Lumen" },
    name: "Ravi",
    role: null,
    email: "ravi@example.com",
    phone: "+91 98450 12345",
    emails: ["ravi@example.com", "ravi.home@example.com"],
    // An older host sends no list.
    phones: [],
    notes: "",
    active: true,
    sensitive: false,
    sensitiveFields: [],
    rev: 1,
    updatedAt: "2026-11-20T00:00:00.000Z",
  };

  it("adds one empty field at a time up to eight, and takes off any but the last one left", () => {
    let list: ReadonlyArray<string> = [""];
    for (let at = 0; at < 10; at++) list = kinContactDetailAdd(list);
    expect(list).toHaveLength(8);
    expect(kinContactDetailCanAdd(list)).toBe(false);
    expect(kinContactDetailCanAdd(["a"])).toBe(true);
    expect(kinContactDetailRemove(["a", "b", "c"], 1)).toEqual(["a", "c"]);
    expect(kinContactDetailRemove(["a", "b"], 0)).toEqual(["b"]);
    expect(kinContactDetailRemove(["a"], 0)).toEqual([""]);
    expect(kinContactDetailSet(["a", "b"], 1, "c")).toEqual(["a", "c"]);
  });

  it("reads every one, main first, and from an older host that sends only the main one", () => {
    expect(kinContactDraftOf(read)).toMatchObject({
      emails: ["ravi@example.com", "ravi.home@example.com"],
      phones: ["+91 98450 12345"],
    });
    expect(kinContactDraftOf()).toMatchObject({ emails: [""], phones: [""] });
  });

  it("sends one of each as before, several beside the main one, and an edit the whole list", () => {
    const draft = kinContactDraftOf(read);
    expect(
      kinContactCreateInput({ ...draft, emails: [" ravi@example.com "], phones: [""] }),
    ).toEqual({
      name: "Ravi",
      email: "ravi@example.com",
    });
    expect(kinContactCreateInput(draft)).toEqual({
      name: "Ravi",
      email: "ravi@example.com",
      emails: ["ravi@example.com", "ravi.home@example.com"],
      phone: "+91 98450 12345",
    });
    // Emptying the main one makes the next one main; emptying them all clears them.
    expect(kinContactUpdateInput({ emails: ["", "ravi.home@example.com"] })).toEqual({
      email: "ravi.home@example.com",
      emails: ["ravi.home@example.com"],
    });
    expect(kinContactUpdateInput({ phones: [""] })).toEqual({ phone: null, phones: [] });
    expect(kinContactUpdateInput({ emails: ["Ravi@example.com", "ravi@EXAMPLE.com"] })).toEqual({
      email: "Ravi@example.com",
      emails: ["Ravi@example.com"],
    });
    expect(kinContactUpdateInput({ name: "Ravi Rao" })).toEqual({ name: "Ravi Rao" });
  });

  it("sends a contact's tags whole on an edit, empty to clear them, and none when it has none", () => {
    expect(kinContactDraftOf({ ...read, tags: ["harbour"] }).tags).toEqual(["harbour"]);
    expect(kinContactCreateInput({ ...kinContactDraftOf(read), tags: [] })).not.toHaveProperty(
      "tags",
    );
    expect(kinContactCreateInput({ ...kinContactDraftOf(read), tags: ["harbour"] })).toMatchObject({
      tags: ["harbour"],
    });
    expect(kinContactUpdateInput({ tags: ["harbour", "clinics"] })).toEqual({
      tags: ["harbour", "clinics"],
    });
    expect(kinContactUpdateInput({ tags: [] })).toEqual({ tags: [] });
  });
});

describe("a campaign", () => {
  const draft = kinProjectDraftOf();
  it("is sent with its audience only when it is one, and turned back into a project", () => {
    expect(kinProjectCreateInput({ ...draft, name: "Fair", audience: "harbour" })).toEqual({
      name: "Fair",
    });
    expect(
      kinProjectCreateInput({ ...draft, name: "Fair", campaign: true, audience: " harbour " }),
    ).toEqual({ name: "Fair", campaign: true, audience: "harbour" });
    expect(kinProjectUpdateInput({ campaign: false }, "EUR")).toEqual({ campaign: false });
    expect(kinProjectUpdateInput({ audience: " " }, "EUR")).toEqual({ audience: null });
  });
});
