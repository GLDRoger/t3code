import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { verifyWebhookSignature } from "../../scheduledTasks/webhookVerification.ts";
import { KinServer } from "../KinServer.ts";
import { KIN_GITHUB_HOOK_ROUTE, KinGitHubHook } from "./appHook.ts";

/**
 * The App's webhook: public, so nothing is read before GitHub's signature over the exact bytes
 * checks out, and then only the event's name, the repo and up to three thread numbers. A good
 * delivery is answered at once; the look it asks for runs later, off this request.
 */

const HOOK_MAX_BODY_BYTES = 1024 * 1024;
const NUMBERS_MAX = 3;
const SIGNATURE = { header: "x-hub-signature-256", prefix: "sha256=", encoding: "hex" } as const;

const answer = (status: number, body: string) =>
  HttpServerResponse.text(body, { status, headers: { "cache-control": "no-store" } });
const unauthorized = () => answer(401, "Unauthorized");

const Numbered = Schema.Struct({ number: Schema.Int });
const Delivery = Schema.Struct({
  repository: Schema.optional(Schema.Struct({ full_name: Schema.String })),
  pull_request: Schema.optional(Numbered),
  issue: Schema.optional(Numbered),
  check_suite: Schema.optional(Schema.Struct({ pull_requests: Schema.Array(Numbered) })),
  check_run: Schema.optional(Schema.Struct({ pull_requests: Schema.Array(Numbered) })),
});
const decodeDelivery = Schema.decodeUnknownOption(Schema.fromJsonString(Delivery));

/** The repo and threads a verified delivery names; nothing else of it is kept. */
const threadsOf = (body: Uint8Array) =>
  Option.map(decodeDelivery(new TextDecoder().decode(body)), (delivery) => ({
    repo: delivery.repository?.full_name ?? "",
    numbers: [
      ...new Set(
        [
          delivery.pull_request?.number,
          delivery.issue?.number,
          ...(delivery.check_suite?.pull_requests ?? []).map((pull) => pull.number),
          ...(delivery.check_run?.pull_requests ?? []).map((pull) => pull.number),
        ].filter((number): number is number => number !== undefined && number > 0),
      ),
    ].slice(0, NUMBERS_MAX),
  }));

export const receive = Effect.fn("KinGitHubHook.receive")(function* (
  mac: Mac.Mac["Service"],
  hook: Option.Option<KinGitHubHook["Service"]>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method !== "POST")
    return HttpServerResponse.text("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  const length = Number(request.headers["content-length"] ?? "0");
  if (!Number.isFinite(length) || length > HOOK_MAX_BODY_BYTES) return answer(413, "Too Large");
  // A chunked body has no length: the reader itself is capped.
  const body = yield* request.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(HOOK_MAX_BODY_BYTES)),
    Effect.option,
  );
  if (Option.isNone(body) || body.value.byteLength > HOOK_MAX_BODY_BYTES)
    return answer(413, "Too Large");
  if (Option.isNone(hook)) return unauthorized();
  const secret = yield* hook.value.secret();
  if (Option.isNone(secret)) return unauthorized();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers))
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  const verified = yield* verifyWebhookSignature({
    signature: SIGNATURE,
    secret: Redacted.value(secret.value),
    headers,
    body: body.value,
  }).pipe(Effect.provideService(Mac.Mac, mac));
  if (!verified) return unauthorized();
  if (headers["x-github-event"] === "ping") return answer(200, "OK");
  const threads = threadsOf(body.value);
  if (Option.isNone(threads)) return answer(400, "Bad Request");
  if (/^[\w.-]+\/[\w.-]+$/.test(threads.value.repo) && threads.value.numbers.length > 0)
    yield* hook.value.deliver(threads.value.repo, threads.value.numbers);
  return answer(202, "Accepted");
});

/** `/kin/github/hook`, every method, so anything but a POST hears 405. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const mac = yield* Mac.Mac;
    yield* router.add(
      "*",
      KIN_GITHUB_HOOK_ROUTE,
      KinServer.pipe(
        Effect.flatMap((kin) =>
          receive(
            mac,
            Option.flatMap(kin.services, (services) => Context.getOption(services, KinGitHubHook)),
          ),
        ),
        // Nothing of the request in the log: it is outside text until verified.
        Effect.catchCause(() =>
          Effect.logWarning("Kin's GitHub webhook couldn't answer a delivery").pipe(
            Effect.as(answer(500, "Error")),
          ),
        ),
      ),
    );
  }),
);
