import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as Keychain from "./Keychain.ts";

export const memoryKeychain = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  const key = (service: string, account: string) => `${service}/${account}`;
  const layer = Layer.succeed(
    Keychain.KinKeychain,
    Keychain.KinKeychain.of({
      get: Effect.fn("fakeKeychain.get")(function* (service, account) {
        return Option.map(Option.fromNullishOr(items.get(key(service, account))), Redacted.make);
      }),
      set: Effect.fn("fakeKeychain.set")(function* (service, account, value) {
        items.set(key(service, account), Redacted.value(value));
      }),
      remove: Effect.fn("fakeKeychain.remove")(function* (service, account) {
        items.delete(key(service, account));
      }),
    }),
  );
  return { items, layer };
};

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface FakeAnswer {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** A GitHub that answers from `route`; nothing leaves the process. */
export const fakeGitHub = (route: (request: RecordedRequest) => FakeAnswer) => {
  const requests: Array<RecordedRequest> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = new URL(request.url);
      const recorded: RecordedRequest = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.authorization,
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
      };
      requests.push(recorded);
      const answer = route(recorded);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json", ...answer.headers },
          }),
        ),
      );
    }),
  );
  return { requests, layer };
};
