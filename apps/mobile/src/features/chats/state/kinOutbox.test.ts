import {
  KinChatError,
  type EnvironmentId,
  type KinMessage,
  type KinMessageId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { KIN_FIXTURE_CHAT_ID, makeKinFixtureMessages } from "./kinChatFixtures";
import {
  classifyKinSendFailure,
  createKinOutbox,
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

function makeStorage() {
  let payload: string | null = null;
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
) {
  let id = 0;
  const registry = AtomRegistry.make();
  const outbox = createKinOutbox({
    registry,
    storage: disk.storage,
    send,
    makeId: () => `client-${++id}`,
    now: () => new Date("2026-11-08T09:00:00.000Z"),
  });
  const chat = () => registry.get(outbox.chatAtom(ENV, CHAT));
  return { host, disk, outbox, chat };
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
    await outbox.retry("client-1");
    await outbox.deliver(ENV);
    expect(host.calls).toHaveLength(2);

    expect(splitKinOutbox(chat(), [])).toEqual({ acked: [ack], pending: [] });
    expect(splitKinOutbox(chat(), echoed)).toEqual({ acked: [], pending: [] });
  });

  it("fails a refused send, keeps it failed across a restart, and sends it on retry", async () => {
    const host = makeHost();
    const disk = makeStorage();
    host.setOnline(true);
    host.setRefuse("Message too long");
    const first = setup(host, disk);
    await first.outbox.enqueue({ environmentId: ENV, chatId: CHAT, body: "Nope" });
    await first.outbox.deliver(ENV);
    expect(first.chat().map((entry) => [entry.state, entry.error])).toEqual([
      ["failed", "Message too long"],
    ]);

    const second = setup(host, disk);
    await second.outbox.load();
    await second.outbox.deliver(ENV);
    expect(second.chat()[0]?.state).toBe("failed");
    expect(host.calls).toEqual(["client-1"]);

    host.setRefuse(null);
    await second.outbox.retry("client-1");
    expect(second.chat()[0]?.state).toBe("sent");
    expect(host.calls).toEqual(["client-1", "client-1"]);
    expect(host.rows.size).toBe(1);
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
  it("waits on a dropped connection and fails a refusal", () => {
    expect(classifyKinSendFailure({ _tag: "ConnectionTransientError" })._tag).toBe("offline");
    expect(
      classifyKinSendFailure(new KinChatError({ reason: "limit", message: "Too long" })),
    ).toEqual({ _tag: "rejected", message: "Too long" });
    expect(classifyKinSendFailure(new Error("boom"))._tag).toBe("rejected");
  });
});
