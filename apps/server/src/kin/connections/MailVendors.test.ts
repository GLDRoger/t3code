import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import { type FakeMail, makeFakeMail } from "./FakeMail.ts";
import { MAIL_TOOL, type MailActivity, type Mailbox, type MailProvider } from "./MailProvider.ts";
import type { KinGatewayError } from "./McpGateway.ts";
import { MAIL_PROVIDERS } from "./mailProviders.ts";

/**
 * One table of cases, run through the fake mailbox against every mail vendor's mapping. A new
 * vendor passes this table before Kin offers it.
 */
const OWNER = "owner@invented-co.example";
const BILLING = "billing@invented-co.example";
const CLIENT = "Ana Client <ana@client.example>";
const NOW = Date.parse("2026-11-16T09:00:00Z");
const HOUR = 60 * 60 * 1000;
const mailbox: Mailbox = { account: OWNER, addresses: [OWNER, BILLING] };

type Run = {
  readonly provider: MailProvider;
  readonly fake: FakeMail;
  readonly http: HttpClient.HttpClient;
  readonly token: string;
  readonly call: (
    tool: string,
    args?: Record<string, unknown>,
  ) => Effect.Effect<any, KinGatewayError>;
};

const harness = (provider: MailProvider) => {
  const fake = makeFakeMail();
  fake.addAccount({
    provider: provider.preset as "google" | "microsoft",
    address: OWNER,
    name: "Invented Co",
    aliases: [BILLING],
  });
  const fetch = fake.handle(() => Promise.reject(new Error("Nothing outside the fake.")));
  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return { fake, layer };
};

const run = (provider: MailProvider, body: (run: Run) => Effect.Effect<void, KinGatewayError>) => {
  const { fake, layer } = harness(provider);
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const token = `fake-at.1.${OWNER}`;
    const call = (tool: string, args: Record<string, unknown> = {}) =>
      provider
        .call(http, token, mailbox, tool, args, NOW)
        .pipe(
          Effect.map((result) => JSON.parse((result.content[0] as { readonly text: string }).text)),
        );
    yield* body({ provider, fake, http, token, call });
  }).pipe(Effect.provide(layer));
};

const reply = (to: string, inReplyTo: string | null, body: string) =>
  [
    `From: ${BILLING}`,
    `To: ${to}`,
    "Subject: Re: Quote Q-7",
    ...(inReplyTo === null ? [] : [`In-Reply-To: ${inReplyTo}`]),
    "",
    body,
  ].join("\r\n");
const failureOf = <A>(effect: Effect.Effect<A, KinGatewayError>) =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: Effect.succeed,
      onSuccess: () => Effect.die("It should have failed."),
    }),
  );
const sameInstant = (a: string | null, b: number) => assert.strictEqual(Date.parse(a ?? ""), b);

const CASES: ReadonlyArray<readonly [string, (run: Run) => Effect.Effect<void, KinGatewayError>]> =
  [
    [
      "lists inbox threads newest first, once each, by the address that received them",
      ({ fake, call }) =>
        Effect.gen(function* () {
          const quote = fake.deliver({
            to: BILLING,
            from: CLIENT,
            subject: "Quote Q-7",
            body: "Can you send the quote?",
            at: NOW - 3 * HOUR,
          });
          fake.deliver({
            to: BILLING,
            from: CLIENT,
            subject: "Re: Quote Q-7",
            body: "Any news?",
            threadId: quote.threadId,
            at: NOW - 2 * HOUR,
          });
          fake.deliver({
            to: OWNER,
            from: CLIENT,
            subject: "Lunch",
            body: "Friday?",
            at: NOW - HOUR,
          });
          const listed = yield* call(MAIL_TOOL.list, { max: 5 });
          assert.strictEqual(listed.account, OWNER);
          assert.deepStrictEqual(
            listed.threads.map((one: any) => [
              one.subject,
              one.receivedBy,
              one.messages,
              one.unread,
            ]),
            [
              ["Lunch", OWNER, 1, true],
              ["Quote Q-7", BILLING, 2, true],
            ],
          );
          assert.strictEqual(listed.threads[1].preview, "Any news?");
          assert.include(listed.threads[1].from, "ana@client.example");
        }),
    ],
    [
      "searches by sender and words",
      ({ fake, call }) =>
        Effect.gen(function* () {
          fake.deliver({
            to: OWNER,
            from: CLIENT,
            subject: "Invoice",
            body: "Paid.",
            at: NOW - HOUR,
          });
          fake.deliver({
            to: OWNER,
            from: "bo@other.example",
            subject: "Invoice",
            body: "Not yet.",
            at: NOW - HOUR,
          });
          const found = yield* call(MAIL_TOOL.search, { query: "from:ana@client.example" });
          assert.deepStrictEqual(
            found.threads.map((one: any) => one.preview),
            ["Paid."],
          );
        }),
    ],
    [
      "reads a thread oldest first, with each file's name, type and size",
      ({ fake, call }) =>
        Effect.gen(function* () {
          const first = fake.deliver({
            to: BILLING,
            from: CLIENT,
            subject: "Quote Q-7",
            body: "Here is the brief.",
            at: NOW - 2 * HOUR,
            files: [
              {
                name: "brief.pdf",
                mimeType: "application/pdf",
                data: Buffer.from("%PDF-1.7 invented").toString("base64"),
              },
            ],
          });
          fake.deliver({
            to: BILLING,
            from: CLIENT,
            subject: "Re: Quote Q-7",
            body: "And a question.",
            threadId: first.threadId,
            at: NOW - HOUR,
          });
          const thread = yield* call(MAIL_TOOL.read, { threadId: first.threadId });
          assert.strictEqual(thread.account, OWNER);
          assert.strictEqual(thread.receivedBy, BILLING);
          assert.deepStrictEqual(
            thread.messages.map((one: any) => one.text),
            ["Here is the brief.", "And a question."],
          );
          assert.deepStrictEqual(thread.messages[0].attachments, [
            { name: "brief.pdf", type: "application/pdf", bytes: 17 },
          ]);
          assert.include(thread.messages[0].to, BILLING);
        }),
    ],
    [
      "cuts a long message with a marker and withholds sign-in mail",
      ({ fake, call }) =>
        Effect.gen(function* () {
          const long = fake.deliver({
            to: OWNER,
            from: CLIENT,
            subject: "Contract",
            body: "x".repeat(13_000),
            at: NOW - 2 * HOUR,
          });
          const code = fake.deliver({
            to: OWNER,
            from: "no-reply@service.example",
            subject: "Your sign-in code",
            body: "Your verification code is 123456",
            at: NOW - HOUR,
          });
          const read = yield* call(MAIL_TOOL.read, { threadId: long.threadId });
          assert.isTrue(read.messages[0].text.endsWith("\n[cut: 1000 more characters]"));
          assert.lengthOf(read.messages[0].text, 12_000 + "\n[cut: 1000 more characters]".length);
          const secret = yield* call(MAIL_TOOL.read, { threadId: code.threadId });
          assert.notInclude(JSON.stringify(secret), "123456");
          const listed = yield* call(MAIL_TOOL.list);
          assert.notInclude(JSON.stringify(listed), "123456");
        }),
    ],
    [
      "drafts a reply to whoever wrote last, from the address it reached, quoting it",
      ({ provider, fake, http, token }) =>
        Effect.gen(function* () {
          const asked = fake.deliver({
            to: BILLING,
            from: CLIENT,
            subject: "Quote Q-7",
            body: "Can you send the quote?",
            at: NOW - HOUR,
          });
          const target = yield* provider.replyTarget(http, token, mailbox, asked.threadId);
          assert.deepStrictEqual(target.to, ["ana@client.example"]);
          assert.strictEqual(target.subject, "Re: Quote Q-7");
          assert.strictEqual(target.receivedAt, BILLING);
          assert.strictEqual(target.inReplyTo, asked.messageId);
          assert.strictEqual(target.thread.lines, "Can you send the quote?");
          assert.include(target.quoted ?? "", "> Can you send the quote?");
        }),
    ],
    [
      "sends what the card showed: a reply in its thread and a new mail in a new one",
      ({ provider, fake, http, token }) =>
        Effect.gen(function* () {
          const asked = fake.deliver({
            to: BILLING,
            from: CLIENT,
            subject: "Quote Q-7",
            body: "Can you send the quote?",
            at: NOW - HOUR,
          });
          const target = yield* provider.replyTarget(http, token, mailbox, asked.threadId);
          const sent = yield* provider.sendMessage(http, token, {
            raw: reply("ana@client.example", target.inReplyTo, "Attached."),
            threadId: asked.threadId,
          });
          assert.strictEqual(sent.threadId, asked.threadId);
          const fresh = yield* provider.sendMessage(http, token, {
            raw: reply("ana@client.example", null, "A new one."),
            threadId: null,
          });
          assert.notStrictEqual(fresh.threadId, asked.threadId);
          assert.deepStrictEqual(
            fake.sent().map((one) => [one.threadId === asked.threadId, one.body]),
            [
              [true, "Attached."],
              [false, "A new one."],
            ],
          );
        }),
    ],
    [
      "answers a follow-up to its own mail to at most ten people",
      ({ provider, fake, http, token }) =>
        Effect.gen(function* () {
          const many = Array.from({ length: 12 }, (_, at) => `guest${at}@client.example`);
          const sent = yield* provider.sendMessage(http, token, {
            raw: reply(many.join(", "), null, "Hello all."),
            threadId: null,
          });
          assert.lengthOf(fake.sent(), 1);
          const target = yield* provider.replyTarget(http, token, mailbox, sent.threadId!);
          assert.deepStrictEqual(target.to, many.slice(0, 10));
          assert.strictEqual(target.receivedAt, BILLING);
        }),
    ],
    [
      "saves an event and invites its guests",
      ({ provider, fake, http, token }) =>
        Effect.gen(function* () {
          const saved = yield* provider.saveEvent(http, token, {
            calendarId: "primary",
            eventId: null,
            title: "Board prep",
            start: "2026-11-20T10:00:00Z",
            end: "2026-11-20T10:30:00Z",
            timeZone: null,
            location: null,
            notes: null,
            invitees: ["ana@client.example"],
          });
          assert.isString(saved.eventId);
          assert.include(JSON.stringify(fake.load().events), "ana@client.example");
        }),
    ],
    [
      "lists and reads calendar events, each week of a series as its own",
      ({ fake, call }) =>
        Effect.gen(function* () {
          fake.putEvent({
            account: OWNER,
            id: "ev1",
            title: "Board prep",
            start: NOW + 24 * HOUR,
            end: NOW + 25 * HOUR,
            updated: NOW - HOUR,
          });
          fake.putEvent({
            account: OWNER,
            id: "standup",
            title: "Standup",
            start: NOW + 2 * HOUR,
            end: NOW + 3 * HOUR,
            updated: NOW - HOUR,
            repeats: 3,
          });
          fake.putEvent({
            account: OWNER,
            id: "gone",
            title: "Gone",
            start: NOW + 4 * HOUR,
            end: NOW + 5 * HOUR,
            updated: NOW - HOUR,
            state: "deleted",
          });
          const listed = yield* call(MAIL_TOOL.events, {
            timeMin: DateTime.formatIso(DateTime.makeUnsafe(NOW)),
            timeMax: DateTime.formatIso(DateTime.makeUnsafe(NOW + 30 * 24 * HOUR)),
          });
          assert.deepStrictEqual(listed.events.map((one: any) => one.summary).toSorted(), [
            "Board prep",
            "Standup",
            "Standup",
            "Standup",
          ]);
          const one = yield* call(MAIL_TOOL.event, { eventId: "ev1" });
          assert.strictEqual(one.summary, "Board prep");
          sameInstant(one.start, NOW + 24 * HOUR);
          assert.strictEqual(one.status, "confirmed");
        }),
    ],
    [
      "reports new mail and changed, cancelled, deleted and recurring events since a time",
      ({ provider, fake, http, token }) =>
        Effect.gen(function* () {
          fake.deliver({
            to: BILLING,
            from: CLIENT,
            subject: "Old",
            body: "Old.",
            at: NOW - 5 * HOUR,
          });
          const event = (id: string, title: string, extra: object = {}) =>
            fake.putEvent({
              account: OWNER,
              id,
              title,
              start: NOW + 24 * HOUR,
              end: NOW + 25 * HOUR,
              updated: NOW - 5 * HOUR,
              ...extra,
            });
          event("review", "Design review");
          event("lunch", "Client lunch");
          event("standup", "Standup", { repeats: 2 });
          const first = yield* provider.activity(http, token, mailbox, NOW - 6 * HOUR, null, NOW);
          assert.includeMembers(
            first.calendar.map((one) => one.summary),
            ["Design review", "Client lunch", "Standup", "Standup"],
          );

          // Later: mail arrives, one meeting is cancelled, one deleted, one series moved.
          fake.deliver({ to: BILLING, from: CLIENT, subject: "New", body: "New.", at: NOW - HOUR });
          event("review", "Design review", { state: "cancelled", updated: NOW - HOUR });
          event("lunch", "Client lunch", { state: "deleted", updated: NOW - HOUR });
          event("standup", "Standup", { repeats: 2, updated: NOW - HOUR, start: NOW + 26 * HOUR });
          const later = yield* provider.activity(
            http,
            token,
            mailbox,
            NOW - 2 * HOUR,
            first.cursor ?? null,
            NOW,
          );
          assert.deepStrictEqual(
            later.mail.map((one) => [one.subject, one.receivedBy, one.unread]),
            [["New", BILLING, true]],
          );
          const byId = new Map(later.calendar.map((one) => [one.eventId, one]));
          assert.strictEqual(byId.get("review")?.status, "cancelled");
          assert.strictEqual(byId.get("lunch")?.status, "cancelled");
          assert.lengthOf(
            later.calendar.filter((one) => one.eventId.startsWith("standup_")),
            2,
          );
          sameInstant(byId.get("standup_0")?.start ?? null, NOW + 26 * HOUR);
        }),
    ],
    [
      "reads a busy inbox and calendar past their first page, and the next read goes on from where one stopped",
      ({ provider, fake, http, token }) =>
        Effect.gen(function* () {
          const MINUTE = 60_000;
          for (let i = 0; i < 130; i++)
            fake.deliver({
              to: BILLING,
              from: `client-${i}@client.example`,
              subject: `Mail ${i}`,
              body: "Hello.",
              at: NOW - 3 * HOUR + i * MINUTE,
            });
          for (let i = 0; i < 230; i++)
            fake.putEvent({
              account: OWNER,
              id: `meeting${i}`,
              title: `Meeting ${i}`,
              start: NOW + 24 * HOUR,
              end: NOW + 25 * HOUR,
              updated: NOW - 4 * HOUR + i * MINUTE,
            });
          const senders = new Set<string | null>();
          const events = new Set<string>();
          let since = NOW - 5 * HOUR;
          let cursor: string | null = null;
          for (let read = 0; read < 4 && since < NOW; read++) {
            const found: MailActivity = yield* provider.activity(
              http,
              token,
              mailbox,
              since,
              cursor,
              NOW,
            );
            for (const mail of found.mail) senders.add(mail.from);
            for (const event of found.calendar) events.add(event.eventId);
            since = found.until ?? NOW;
            cursor = found.cursor;
          }
          assert.strictEqual(senders.size, 130);
          assert.strictEqual(events.size, 230);
        }),
    ],
    [
      "says what went wrong, by kind, in the vendor's name",
      ({ provider, fake, http, token, call }) =>
        Effect.gen(function* () {
          const failed = (tool: string, args: Record<string, unknown>) =>
            failureOf(call(tool, args));
          assert.include((yield* failed(MAIL_TOOL.read, {})).message, "needs threadId");
          assert.include((yield* failed(MAIL_TOOL.search, { query: " " })).message, "needs query");
          assert.include(
            (yield* failed("mail_delete_everything", {})).message,
            `${provider.name} has no tool named`,
          );
          const missing = yield* failureOf(
            provider.replyTarget(http, token, mailbox, "no-such-thread"),
          );
          assert.strictEqual(missing.reason, "protocol");
          assert.include(missing.message, `${OWNER} has no thread no-such-thread`);
          for (const [status, reason, words] of [
            [401, "key_refused", `${provider.name} refused the sign-in (401).`],
            [403, "unreachable", `${provider.name} refused (403).`],
            [429, "unreachable", `${provider.name} says Kin is asking too often (429).`],
            [500, "unreachable", `${provider.name} answered with an error (HTTP 500).`],
          ] as const) {
            fake.failWith(OWNER, status);
            const error = yield* failed(MAIL_TOOL.list, {});
            assert.strictEqual(error.reason, reason, String(status));
            assert.include(error.message, words);
          }
          fake.failWith(OWNER, null);
          fake.setExpired(OWNER, true);
          assert.strictEqual((yield* failed(MAIL_TOOL.list, {})).reason, "key_refused");
        }),
    ],
  ];

describe.each(Object.values(MAIL_PROVIDERS))("$name mail, on the fake mailbox", (provider) => {
  it.effect.each(CASES)("%s", ([, body]) => run(provider, body));
});
