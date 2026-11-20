import { assert, describe, it } from "@effect/vitest";
import { KinAgentId, KinChatError, KinPersonId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinConnectionSecrets } from "../connections/ConnectionSecrets.ts";
import { KinDocRenderer } from "../gendocs/render.ts";
import { fixture, orgId, otherOrg, seed } from "../triggers/routines.testkit.ts";
import { FAKE_PNG, makeFakeImageVendor } from "./FakeImageVendor.ts";
import {
  KinPictures,
  makeLayer,
  nearestSize,
  GENERATE_SENTENCES,
  PICTURE_TIMEOUT,
  type GenerateRequest,
} from "./KinPictures.ts";
import { KinPictureSize, pictureOutput } from "./sizes.ts";

// Ambermill, on a fake picture service in memory: nothing leaves the process, time is the TestClock.
const NOW = Date.parse("2026-11-20T09:00:00.000Z");
const KEY = "sk-invented-ambermill-key-0001";
const owner = KinPersonId.make(`owner-${orgId}`);
const growth = KinAgentId.make(`lead-${orgId}`);
const person = (personId: string) => [
  { _tag: "person" as const, orgId, personId: KinPersonId.make(personId) },
];
const asOwner = person(owner);
const isKinError = Schema.is(KinChatError);

const harness = () => {
  const fake = makeFakeImageVendor();
  const keys = new Map<string, Redacted.Redacted<string>>();
  const stored: Array<{ readonly orgId: string; readonly sha256: string; readonly bytes: number }> =
    [];
  const logs: Array<string> = [];
  const secrets = Layer.mock(KinConnectionSecrets)({
    getPicturesKey: (vendor) => Effect.succeed(Option.fromNullishOr(keys.get(vendor))),
    setPicturesKey: (vendor, key) => Effect.sync(() => void keys.set(vendor, key)),
    removePicturesKey: (vendor) => Effect.sync(() => void keys.delete(vendor)),
  });
  const storage = { fails: false };
  const renderer = Layer.mock(KinDocRenderer)({
    store: (org, _job, file) =>
      storage.fails
        ? Effect.fail(new KinChatError({ reason: "unavailable", message: "The disk is full." }))
        : Effect.sync(() => {
            stored.push({ orgId: org, sha256: file.sha256, bytes: file.bytes.byteLength });
            return `kin-${file.sha256.slice(0, 12)}-${file.extension}`;
          }),
  });
  const identity = Layer.mock(KinIdentity)({
    owner: { _tag: "person", orgId, personId: owner },
    isAgentThread: () => true,
    isLeadThread: () => true,
    resolveAgent: () =>
      Effect.succeed({
        _tag: "agent" as const,
        orgId,
        agentId: growth,
        ownerPersonId: owner,
        threadId: ThreadId.make("growth-thread"),
      }),
  });
  // The fake answers without HTTP; any request that did go out would fail here.
  const http = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, () =>
        Promise.reject(new Error("No request leaves a pictures test.")),
      ),
    ),
  );
  const logger = Logger.make(({ message, cause }) => {
    logs.push(`${JSON.stringify(message)} ${Cause.pretty(cause)}`);
  });
  const layer = makeLayer(fake.vendor).pipe(
    Layer.provideMerge(Layer.mergeAll(secrets, renderer, identity, http)),
    Layer.provideMerge(fixture()),
    Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
  );
  const run = <A, E>(body: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* body.pipe(Effect.provide(layer));
    });
  return { fake, keys, stored, storage, logs, run };
};

/** The seeded org with a teammate and a co-owner, and the company in India's zone. */
const setUp = Effect.gen(function* () {
  yield* seed();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES ('meera', ${orgId}, 'meera', 'Meera', '2026-11-01T00:00:00.000Z', 'member'),
      ('dev', ${orgId}, 'dev', 'Dev', '2026-11-01T00:00:00.000Z', 'co_owner')`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:30', '18:00', '02:00', 0, 1, '09:00', '{"from":"22:00","to":"07:00"}')`;
  return sql;
});
const connect = (monthlyLimit?: number | null) =>
  Effect.gen(function* () {
    const pictures = yield* KinPictures;
    return yield* pictures.set(asOwner, {
      orgId,
      key: Redacted.make(KEY),
      ...(monthlyLimit === undefined ? {} : { monthlyLimit }),
    });
  });
const ask = (overrides: Partial<GenerateRequest> = {}) =>
  Effect.gen(function* () {
    const pictures = yield* KinPictures;
    return yield* pictures.generate({
      orgId,
      agentId: growth,
      askedBy: KinPersonId.make("meera"),
      ownerLevel: false,
      prompt: "Our team at a café, warm morning light",
      size: "square",
      count: 1,
      ...overrides,
    });
  });
const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ month: string; count: number; state: string; person: string | null }>`
    SELECT month, count, state, person_id AS person FROM kin_picture_counts
    WHERE org_id = ${orgId} ORDER BY at, count_id`;
});
/** Pictures made earlier this month, four to a row. */
const madeRows = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let row = 0; row * 4 < count; row += 1)
      yield* sql`INSERT INTO kin_picture_counts (org_id, count_id, month, agent_id, count, state, at)
        VALUES (${orgId}, ${`seed-${row}`}, '2026-11', ${growth}, ${Math.min(4, count - row * 4)},
          'made', 0)`;
  });
const notices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ chat: string; body: string }>`SELECT chat_id AS chat, body FROM kin_messages
    WHERE org_id = ${orgId} AND message_id LIKE 'kin-pictures-near:%' ORDER BY message_id`;
});

describe("KinPictures", () => {
  it("maps each named size to the service's nearest shape", () => {
    const sizes = makeFakeImageVendor().vendor.sizes;
    assert.deepStrictEqual(
      Object.fromEntries(
        KinPictureSize.literals.map((name) => {
          const near = nearestSize(sizes, pictureOutput(name));
          return [name, `${near.width}x${near.height}`];
        }),
      ),
      {
        square: "1024x1024",
        portrait: "1024x1536",
        story: "1024x1536",
        landscape: "1536x1024",
        link: "1536x1024",
        page: "1024x1536",
      },
    );
  });

  it.effect(
    "makes pictures stored by content, counted to the asker, and says the size it made",
    () => {
      const { fake, stored, run } = harness();
      return run(
        Effect.gen(function* () {
          yield* setUp;
          const first = yield* connect();
          assert.deepInclude(first, {
            connected: true,
            savedAt: "2026-11-20T09:00:00.000Z",
            monthlyLimit: 50,
            usedThisMonth: 0,
            resetsOn: "2026-12-01",
            model: "gpt-image-2.5-flare",
          });
          const made = yield* ask({ size: "portrait", count: 2 });
          assert.strictEqual(made._tag, "made");
          if (made._tag !== "made") return;
          assert.deepStrictEqual(
            made.files.map((file) => [file.type, file.mimeType, file.name, file.sizeBytes]),
            [
              ["image", "image/png", "portrait-1.png", FAKE_PNG.byteLength],
              ["image", "image/png", "portrait-2.png", FAKE_PNG.byteLength],
            ],
          );
          // The same bytes are the same file, as a document's are.
          assert.strictEqual(made.files[0]!.id, made.files[1]!.id);
          assert.lengthOf(stored, 2);
          assert.deepStrictEqual(made.size, { width: 1024, height: 1536 });
          assert.strictEqual(
            made.note,
            "Made at 1024×1536, the picture service's nearest size to portrait (1080×1350).",
          );
          assert.deepStrictEqual(
            fake.calls.map((call) => [call.size, call.count, call.model]),
            [[{ width: 1024, height: 1536 }, 2, "gpt-image-2.5-flare"]],
          );
          assert.deepStrictEqual(yield* counts, [
            { month: "2026-11", count: 2, state: "made", person: "meera" },
          ]);
          assert.strictEqual(
            (yield* (yield* KinPictures).get(asOwner, { orgId })).usedThisMonth,
            2,
          );
        }),
      );
    },
  );

  it.effect(
    "frees the count only when nothing left or the service settled it, and keeps it once a picture may be made",
    () => {
      const { fake, storage, run } = harness();
      return run(
        Effect.gen(function* () {
          yield* setUp;
          assert.deepStrictEqual(yield* ask(), {
            _tag: "refused",
            reason: "no_key",
            sentence: GENERATE_SENTENCES.no_key,
          });
          assert.lengthOf(fake.calls, 0);
          yield* connect();
          const used = Effect.map(
            Effect.flatMap(KinPictures, (pictures) => pictures.get(asOwner, { orgId })),
            (view) => view.usedThisMonth,
          );
          // Never sent, or settled by the service with nothing made: nothing is counted.
          for (const [mode, ownerLevel, reason, sentence] of [
            ["refuse", false, "refused", GENERATE_SENTENCES.refused],
            ["reject", true, "key_rejected", GENERATE_SENTENCES.key_rejected],
            ["reject", false, "key_rejected", GENERATE_SENTENCES.not_working],
            ["decline", false, "unavailable", GENERATE_SENTENCES.unavailable],
            ["unsent", false, "unavailable", GENERATE_SENTENCES.unavailable],
          ] as const) {
            fake.control.mode = mode;
            assert.deepStrictEqual(yield* ask({ ownerLevel }), {
              _tag: "refused",
              reason,
              sentence,
            });
          }
          assert.deepStrictEqual(yield* counts, []);
          assert.strictEqual(yield* used, 0);
          // Sent, and nothing usable came back: it may be made, so it is counted.
          const lost = { _tag: "refused", reason: "lost", sentence: GENERATE_SENTENCES.lost };
          fake.control.mode = "lost";
          assert.deepStrictEqual(yield* ask(), lost);
          fake.control.mode = "garbage";
          assert.deepStrictEqual(yield* ask({ count: 2 }), lost);
          fake.control.mode = "silent";
          const waiting = yield* Effect.forkChild(ask());
          yield* TestClock.adjust(PICTURE_TIMEOUT);
          assert.deepStrictEqual(yield* Fiber.join(waiting), lost);
          fake.control.mode = "ok";
          storage.fails = true;
          assert.deepStrictEqual(yield* ask(), lost);
          storage.fails = false;
          assert.strictEqual(yield* used, 5);
          // A turn stopped while the service has it keeps its count too.
          fake.control.mode = "silent";
          const sent = yield* Deferred.make<void>();
          fake.control.before = Deferred.succeed(sent, undefined);
          const stopped = yield* Effect.forkChild(ask());
          yield* Deferred.await(sent);
          yield* Fiber.interrupt(stopped);
          fake.control.before = Effect.void;
          assert.strictEqual(yield* used, 6);
          assert.deepStrictEqual(
            (yield* counts).map((row) => `${row.count} ${row.state}`).toSorted(),
            ["1 made", "1 made", "1 made", "1 reserved", "2 made"],
          );
          // An agent or a person from another org looks unknown, and nothing is asked or counted.
          const calls = fake.calls.length;
          fake.control.mode = "ok";
          for (const request of [
            { agentId: KinAgentId.make(`lead-${otherOrg}`) },
            { askedBy: KinPersonId.make(`owner-${otherOrg}`) },
          ]) {
            const exit = yield* ask(request).pipe(Effect.flip);
            assert.isTrue(isKinError(exit) && exit.reason === "not_found");
          }
          assert.strictEqual(fake.calls.length, calls);
          assert.strictEqual(yield* used, 6);
        }),
      );
    },
  );

  it.effect("keeps counting a reservation a crash left, however old", () => {
    const { fake, run } = harness();
    return run(
      Effect.gen(function* () {
        const sql = yield* setUp;
        yield* connect(2);
        yield* sql`INSERT INTO kin_picture_counts (org_id, count_id, month, agent_id, count, state, at)
          VALUES (${orgId}, 'crashed', '2026-11', ${growth}, 2, 'reserved', ${NOW - 86_400_000})`;
        assert.deepInclude(yield* ask(), { reason: "limit" });
        assert.lengthOf(fake.calls, 0);
        assert.strictEqual((yield* (yield* KinPictures).get(asOwner, { orgId })).usedThisMonth, 2);
      }),
    );
  });

  it.effect("two requests at the limit less one give one picture and one limit sentence", () => {
    const { fake, run } = harness();
    return run(
      Effect.gen(function* () {
        yield* setUp;
        yield* connect(3);
        yield* madeRows(2);
        const inCall = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        fake.control.before = Deferred.succeed(inCall, undefined).pipe(
          Effect.andThen(Deferred.await(answer)),
        );
        const first = yield* Effect.forkChild(ask());
        yield* Deferred.await(inCall);
        assert.deepStrictEqual(yield* ask(), {
          _tag: "refused",
          reason: "limit",
          sentence:
            "This month's 3 generated pictures are used. An owner or co-owner can raise the limit in Settings → Connections → Pictures; it resets on 1 Dec.",
        });
        yield* Deferred.succeed(answer, undefined);
        assert.strictEqual((yield* Fiber.join(first))._tag, "made");
        assert.lengthOf(fake.calls, 1);
        assert.strictEqual((yield* (yield* KinPictures).get(asOwner, { orgId })).usedThisMonth, 3);
      }),
    );
  });

  it.effect("a retried request with the same key makes and counts nothing twice", () => {
    const { fake, run } = harness();
    return run(
      Effect.gen(function* () {
        yield* setUp;
        yield* connect();
        const retryKey = "kin-picture:wake-1:cafe";
        // A call that never left frees its key: the retry makes the picture.
        fake.control.mode = "unsent";
        assert.deepInclude(yield* ask({ retryKey }), { reason: "unavailable" });
        fake.control.mode = "ok";
        const inCall = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        fake.control.before = Deferred.succeed(inCall, undefined).pipe(
          Effect.andThen(Deferred.await(answer)),
        );
        const first = yield* Effect.forkChild(ask({ retryKey }));
        yield* Deferred.await(inCall);
        // The same call while the first is still with the service waits for it.
        const meanwhile = yield* Effect.flip(ask({ retryKey }));
        assert.include(meanwhile, { reason: "unavailable" });
        assert.match(meanwhile.message, /^Kin is still making this picture/);
        yield* Deferred.succeed(answer, undefined);
        const made = yield* Fiber.join(first);
        assert.strictEqual(made._tag, "made");
        assert.deepStrictEqual(yield* ask({ retryKey }), made);
        assert.lengthOf(fake.calls, 2);
        assert.deepStrictEqual(yield* counts, [
          { month: "2026-11", count: 1, state: "made", person: "meera" },
        ]);
        // The key is one asker's: anyone else's call under it is refused.
        assert.include(yield* Effect.flip(ask({ retryKey, askedBy: KinPersonId.make("dev") })), {
          reason: "not_allowed",
        });
        assert.lengthOf(fake.calls, 2);
      }),
    );
  });

  it.effect("makes only what is left of the limit, and says so", () => {
    const { run } = harness();
    return run(
      Effect.gen(function* () {
        yield* setUp;
        yield* connect(5);
        yield* madeRows(3);
        const made = yield* ask({ count: 4, size: "landscape" });
        assert.strictEqual(made._tag === "made" ? made.files.length : 0, 2);
        assert.strictEqual(
          made._tag === "made" ? made.note : null,
          "Made at 1536×1024, the picture service's nearest size to landscape (1920×1080). Only 2 of this month's 5 pictures were left, so Kin made 2.",
        );
      }),
    );
  });

  it.effect("with No limit refuses nothing for count and warns no one, and still counts", () => {
    const { run } = harness();
    return run(
      Effect.gen(function* () {
        yield* setUp;
        const view = yield* connect(null);
        assert.isNull(view.monthlyLimit);
        yield* madeRows(1000);
        assert.strictEqual((yield* ask({ count: 4 }))._tag, "made");
        assert.deepStrictEqual(yield* notices, []);
        assert.strictEqual(
          (yield* (yield* KinPictures).get(asOwner, { orgId })).usedThisMonth,
          1004,
        );
      }),
    );
  });

  it.effect("tells the owner once a month when 80% of a set limit is used", () => {
    const { run } = harness();
    return run(
      Effect.gen(function* () {
        yield* setUp;
        yield* connect(5);
        yield* ask({ count: 3 });
        assert.deepStrictEqual(yield* notices, []);
        yield* ask();
        yield* ask();
        assert.deepStrictEqual(yield* notices, [
          {
            chat: `chat-${orgId}`,
            body: "Kin has made 4 of this month's 5 generated pictures. At 5, new ones stop until 1 Dec. You can raise the limit or choose No limit in Settings → Connections → Pictures.",
          },
        ]);
      }),
    );
  });

  it.effect("turns the month in the company's zone, not the server's", () => {
    const { run } = harness();
    return run(
      Effect.gen(function* () {
        yield* setUp;
        yield* connect(2);
        // 23:59 on 30 November in Kolkata, whatever zone this process runs in.
        yield* TestClock.setTime(Date.parse("2026-11-30T18:29:00.000Z"));
        yield* ask({ count: 2 });
        assert.strictEqual((yield* ask())._tag, "refused");
        yield* TestClock.setTime(Date.parse("2026-11-30T18:30:00.000Z"));
        const view = yield* (yield* KinPictures).get(asOwner, { orgId });
        assert.deepInclude(view, { usedThisMonth: 0, resetsOn: "2027-01-01" });
        assert.strictEqual((yield* ask())._tag, "made");
        assert.deepStrictEqual(
          (yield* counts).map((row) => [row.month, row.count]),
          [
            ["2026-11", 2],
            ["2026-12", 1],
          ],
        );
      }),
    );
  });

  it.effect("lets the owner level, never a teammate, read or change it, and disconnect it", () => {
    const { keys, run } = harness();
    return run(
      Effect.gen(function* () {
        yield* setUp;
        const pictures = yield* KinPictures;
        for (const call of [
          pictures.get(person("meera"), { orgId }),
          pictures.set(person("meera"), { orgId, key: Redacted.make(KEY) }),
          pictures.set(person("meera"), { orgId, monthlyLimit: null }),
          pictures.set(person("meera"), { orgId, disconnect: true }),
        ]) {
          const error = yield* call.pipe(Effect.flip);
          assert.strictEqual(error.reason, "not_allowed");
        }
        assert.strictEqual(keys.size, 0);
        assert.deepInclude(yield* pictures.get(person("dev"), { orgId }), {
          connected: false,
          savedAt: null,
          monthlyLimit: 50,
        });
        yield* pictures.set(person("dev"), { orgId, key: Redacted.make(KEY), monthlyLimit: 20 });
        const off = yield* pictures.set(asOwner, { orgId, disconnect: true });
        assert.deepInclude(off, { connected: false, savedAt: null, monthlyLimit: 20 });
        assert.strictEqual(keys.size, 0);
        assert.deepInclude(yield* ask(), { sentence: GENERATE_SENTENCES.no_key });
        // Back again, the limit chosen before stands.
        assert.deepInclude(yield* connect(), { connected: true, monthlyLimit: 20 });
      }),
    );
  });

  it.effect("never puts the key in a result, a view, a row, a notice or a log line", () => {
    const { fake, logs, run } = harness();
    return run(
      Effect.gen(function* () {
        const sql = yield* setUp;
        const pictures = yield* KinPictures;
        const said: Array<unknown> = [yield* connect(5)];
        for (const mode of ["ok", "refuse", "reject", "unsent", "lost", "ok", "ok"] as const) {
          fake.control.mode = mode;
          said.push(yield* ask());
        }
        said.push(yield* pictures.get(asOwner, { orgId }));
        said.push(yield* pictures.set(asOwner, { orgId, disconnect: true }));
        const rows = yield* Effect.all([
          sql`SELECT * FROM kin_picture_settings`,
          sql`SELECT * FROM kin_picture_counts`,
          sql`SELECT * FROM kin_messages`,
        ]);
        assert.isNotEmpty(yield* notices);
        assert.isTrue(fake.calls.every((call) => call.key === KEY));
        const everything = JSON.stringify([said, rows, logs]);
        assert.notInclude(everything, KEY);
        assert.notInclude(everything, "ambermill-key");
      }),
    );
  });
});
