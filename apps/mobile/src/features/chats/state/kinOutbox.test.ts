import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  KinChatError,
  type EnvironmentId,
  type KinMessage,
  type KinMessageId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { KIN_FIXTURE_CHAT_ID, makeKinFixtureMessages } from "./kinChatFixtures";
import {
  classifyKinSendFailure,
  createKinOutbox,
  KIN_MESSAGE_MAX_LENGTH,
  splitKinOutbox,
  type KinOutboxRecord,
  type KinOutboxStorage,
  type KinSendOutcome,
} from "./kinOutbox";

const ENV = "env-kin" as EnvironmentId;
const CHAT = KIN_FIXTURE_CHAT_ID;
const ownTemplate = makeKinFixtureMessages(1)[0]!;

/** The host's dedupe: one row per `clientMessageId`, and a repeat returns the first row. */
function makeHost() {
  const rows = new Map<string, KinMessage>();
  let online = false;
  let dropReplies = false;
  let refuse: string | null = null;
  const calls: string[] = [];
  const send = async (record: KinOutboxRecord): Promise<KinSendOutcome> => {
    calls.push(record.clientMessageId);
    if (!online) return { _tag: "offline" };
    if (refuse !== null) return { _tag: "rejected", message: refuse };
    let row = rows.get(record.clientMessageId);
    if (row === undefined) {
      row = {
        ...ownTemplate,
        messageId: `m${rows.size + 1}` as KinMessageId,
        seq: rows.size + 1,
        body: record.body,
        clientMessageId: record.clientMessageId,
      };
      rows.set(record.clientMessageId, row);
    }
    // The row committed but the reply never made it back.
    return dropReplies ? { _tag: "offline" } : { _tag: "sent", message: row };
  };
  return {
    rows,
    calls,
    send,
    setOnline: (value: boolean) => void (online = value),
    setDropReplies: (value: boolean) => void (dropReplies = value),
    setRefuse: (value: string | null) => void (refuse = value),
  };
}

function makeStorage(initial: string | null = null) {
  let payload: string | null = initial;
  const storage: KinOutboxStorage = {
    load: async () => payload,
    save: async (next) => void (payload = next),
  };
  return { storage, saved: () => (payload === null ? [] : JSON.parse(payload).entries) };
}

function setup(
  host = makeHost(),
  disk = makeStorage(),
  send: (record: KinOutboxRecord) => Promise<KinSendOutcome> = host.send,
  extra: { readonly maxEntries?: number; readonly warn?: (message: string) => void } = {},
) {
  let id = 0;
  const registry = AtomRegistry.make();
  const outbox = createKinOutbox({
    registry,
    storage: disk.storage,
    send,
    makeId: () => `client-${++id}`,
    now: () => new Date("2026-11-08T09:00:00.000Z"),
    ...extra,
  });
  const chat = () => registry.get(outbox.chatAtom(ENV, CHAT));
  const full = () => registry.get(outbox.fullAtom(ENV));
  return { host, disk, outbox, chat, full };
}

describe("kinOutbox", () => {
  it("sends a message written offline once the host reconnects, and only once", async () => {
    const { host, disk, outbox, chat } = setup();
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "Ship it" });
    await outbox.deliver(ENV);
    expect(chat().map((entry) => entry.state)).toEqual(["waiting"]);
    expect(disk.saved()).toHaveLength(1);

    host.setOnline(true);
    await outbox.deliver(ENV);
    await outbox.deliver(ENV);
    expect([...host.rows.values()].map((row) => row.body)).toEqual(["Ship it"]);
    expect(chat().map((entry) => [entry.state, entry.sent?.messageId])).toEqual([["sent", "m1"]]);
    expect(disk.saved()).toEqual([]);
  });

  it("resends a send whose reply was lost under the same id, so the host keeps one row", async () => {
    const { host, outbox, chat } = setup();
    host.setOnline(true);
    host.setDropReplies(true);
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "Hello" });
    await outbox.deliver(ENV);
    expect(chat()[0]?.state).toBe("waiting");

    host.setDropReplies(false);
    await outbox.deliver(ENV);
    expect(host.calls).toEqual(["client-1", "client-1"]);
    expect(host.rows.size).toBe(1);
    expect(chat()[0]?.sent?.messageId).toBe("m1");
  });

  it("resends after an app restart mid-send, and the host still keeps one row", async () => {
    const host = makeHost();
    const disk = makeStorage();
    host.setOnline(true);
    // The first app commits the row on the host, then dies before the reply lands.
    const first = setup(host, disk, (record) => {
      void host.send(record);
      return new Promise(() => {});
    });
    await first.outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "Before restart" });
    void first.outbox.deliver(ENV);
    await Promise.resolve();
    expect(first.chat()[0]?.state).toBe("sending");
    expect(disk.saved()).toHaveLength(1);

    const second = setup(host, disk);
    await second.outbox.load();
    expect(second.chat().map((entry) => [entry.clientMessageId, entry.state])).toEqual([
      ["client-1", "waiting"],
    ]);
    await second.outbox.deliver(ENV);
    expect(host.rows.size).toBe(1);
    expect(second.chat()[0]?.state).toBe("sent");
    expect(disk.saved()).toEqual([]);
  });

  it("shows a duplicate ack and the stream's echo as one message", async () => {
    const { host, outbox, chat } = setup();
    host.setOnline(true);
    host.setDropReplies(true);
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "Once" });
    await outbox.deliver(ENV);
    const echoed = [...host.rows.values()];

    // Two reconnect triggers at once: the second waits behind the first, nothing is sent twice.
    host.setDropReplies(false);
    await Promise.all([outbox.deliver(ENV), outbox.deliver(ENV)]);
    expect(host.calls).toEqual(["client-1", "client-1"]);
    const ack = chat()[0]!.sent!;
    expect(ack).toEqual(echoed[0]);

    // Settled entries are never sent again.
    await outbox.deliver(ENV);
    expect(host.calls).toHaveLength(2);

    expect(splitKinOutbox(chat(), [])).toEqual({ acked: [ack], pending: [], echoed: [] });
    expect(splitKinOutbox(chat(), echoed)).toEqual({
      acked: [],
      pending: [],
      echoed: ["client-1"],
    });
  });

  it("settles a send the stream carries by clientMessageId, even with its reply lost", async () => {
    const { host, disk, outbox, chat } = setup();
    host.setOnline(true);
    host.setDropReplies(true);
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "Once" });
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "Twice" });
    await outbox.deliver(ENV);
    expect(chat().map((entry) => entry.state)).toEqual(["waiting", "waiting"]);

    // The host holds only the first; the second is still pending.
    const streamed = [host.rows.get("client-1")!];
    const split = splitKinOutbox(chat(), streamed);
    expect(split).toMatchObject({ acked: [], echoed: ["client-1"] });
    expect(split.pending.map((entry) => entry.clientMessageId)).toEqual(["client-2"]);

    outbox.forgetEchoed(new Set(split.echoed));
    await outbox.flushWrites();
    expect(chat().map((entry) => entry.clientMessageId)).toEqual(["client-2"]);
    expect(disk.saved().map((entry: KinOutboxRecord) => entry.clientMessageId)).toEqual([
      "client-2",
    ]);
    host.setDropReplies(false);
    host.calls.length = 0;
    await outbox.deliver(ENV);
    expect(host.calls).toEqual(["client-2"]);
  });

  it("fails a refused send for good: kept across a restart, never resent, editable", async () => {
    const host = makeHost();
    const disk = makeStorage();
    host.setOnline(true);
    host.setRefuse("over the limit");
    const first = setup(host, disk);
    await first.outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "Nope" });
    await first.outbox.deliver(ENV);
    expect(first.chat().map((entry) => [entry.state, entry.error])).toEqual([
      ["failed", "over the limit"],
    ]);

    const second = setup(host, disk);
    await second.outbox.load();
    host.setRefuse(null);
    await second.outbox.deliver(ENV);
    expect(second.chat()[0]?.state).toBe("failed");
    expect(host.calls).toEqual(["client-1"]);

    // Edit takes the body back and drops the entry, so the same id never goes out again.
    expect(await second.outbox.discard("client-1")).toBe("Nope");
    expect(second.chat()).toEqual([]);
    expect(disk.saved()).toEqual([]);
  });

  it("waits, not fails, when a send gets no reply, then resends under the same id", async () => {
    vi.useFakeTimers();
    try {
      const host = makeHost();
      host.setOnline(true);
      let hang = true;
      const { outbox, chat } = setup(host, makeStorage(), (record) =>
        hang ? new Promise(() => {}) : host.send(record),
      );
      await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "Hello?" });
      const delivery = outbox.deliver(ENV);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(chat()[0]?.state).toBe("sending");
      await vi.advanceTimersByTimeAsync(1);
      await delivery;
      expect(chat()[0]?.state).toBe("waiting");

      hang = false;
      await outbox.deliver(ENV);
      expect(chat()[0]?.state).toBe("sent");
      expect(host.calls).toEqual(["client-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the readable entries of a damaged file and warns", async () => {
    const good = {
      environmentId: ENV,
      chatId: CHAT,
      clientMessageId: "client-7",
      body: "Survivor",
      createdAt: "2026-11-08T09:00:00.000Z",
      error: null,
    };
    const warnings: string[] = [];
    const disk = makeStorage(
      JSON.stringify({ version: 1, entries: [{ clientMessageId: 3 }, good, "junk"] }),
    );
    const { outbox, chat } = setup(makeHost(), disk, undefined, {
      warn: (message) => void warnings.push(message),
    });
    await outbox.load();
    expect(chat().map((entry) => [entry.clientMessageId, entry.state])).toEqual([
      ["client-7", "waiting"],
    ]);
    expect(warnings).toEqual(["[kin-outbox] skipped corrupt entries"]);
  });

  it("refuses a body over the limit and a send past the cap, queuing neither", async () => {
    const { host, outbox, chat, full } = setup(makeHost(), makeStorage(), undefined, {
      maxEntries: 2,
    });
    const long = "x".repeat(KIN_MESSAGE_MAX_LENGTH + 1);
    expect(await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: long })).toEqual({
      _tag: "too_long",
    });
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "one" });
    expect(full()).toBe(false);
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "two" });
    // Full before the next send is tried, so the composer can disable Send up front.
    expect(full()).toBe(true);
    expect(await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "three" })).toEqual({
      _tag: "full",
    });
    expect(chat().map((entry) => entry.body)).toEqual(["one", "two"]);
    await outbox.discard(chat()[0]!.clientMessageId);
    expect(full()).toBe(false);
    // A sent message waiting for its echo no longer counts toward the cap.
    host.setOnline(true);
    await outbox.deliver(ENV);
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "three" });
    expect(chat().map((entry) => entry.state)).toEqual(["sent", "waiting"]);
    expect(full()).toBe(false);
  });

  it("forgets acked entries the stream holds, and a removed environment's entries", async () => {
    const { host, disk, outbox, chat } = setup();
    host.setOnline(true);
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "acked" });
    await outbox.deliver(ENV);
    outbox.forgetEchoed(new Set(["client-1"]));
    expect(chat()).toEqual([]);

    host.setOnline(false);
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "unsent" });
    await outbox.clearEnvironment(ENV);
    expect(chat()).toEqual([]);
    expect(disk.saved()).toEqual([]);
  });

  it("drops a discarded send from memory and disk", async () => {
    const { disk, outbox, chat } = setup();
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "Never mind" });
    await outbox.discard("client-1");
    expect(chat()).toEqual([]);
    expect(disk.saved()).toEqual([]);
  });

  it("delivers in the order written and keeps pending bubbles in that order", async () => {
    const { host, outbox, chat } = setup();
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "one" });
    await outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "two" });
    expect(splitKinOutbox(chat(), []).pending.map((entry) => entry.body)).toEqual(["one", "two"]);
    host.setOnline(true);
    await outbox.deliver(ENV);
    expect([...host.rows.values()].map((row) => [row.seq, row.body])).toEqual([
      [1, "one"],
      [2, "two"],
    ]);
  });
});

describe("classifyKinSendFailure", () => {
  it("fails only a typed refusal; a Kin outage or any other error waits to resend", () => {
    const refused = (reason: KinChatError["reason"]) =>
      classifyKinSendFailure(new KinChatError({ reason, message: "Cannot do that" }));
    expect(refused("limit")).toEqual({ _tag: "rejected", message: "over the limit" });
    expect(refused("invalid_state")._tag).toBe("rejected");
    expect(refused("not_allowed")._tag).toBe("rejected");
    expect(refused("disabled")).toEqual({
      _tag: "rejected",
      message: "Kin is turned off on this server",
    });
    expect(
      classifyKinSendFailure(
        new EnvironmentAuthorizationError({
          message: "no scope",
          requiredScope: AuthOrchestrationOperateScope,
        }),
      )._tag,
    ).toBe("rejected");
    expect(refused("unavailable")._tag).toBe("offline");
    expect(classifyKinSendFailure({ _tag: "ConnectionTransientError" })._tag).toBe("offline");
    // A reply that fails to decode, or anything unknown, may hide a committed send.
    expect(classifyKinSendFailure(new Error("Expected KinMessage"))._tag).toBe("offline");
  });
});
