import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { CONNECTION_LIMITS } from "./limits.ts";

const Request = Schema.fromJsonString(Schema.Struct({ method: Schema.String }));
const Listing = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          annotations: Schema.optional(
            Schema.Struct({ openWorldHint: Schema.optional(Schema.Unknown) }),
          ),
        }),
      ),
    }),
  }),
);
const decodeRequest = Schema.decodeUnknownOption(Request);
const decodeListing = Schema.decodeUnknownOption(Listing);

const listsTools = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" &&
  Option.exists(
    decodeRequest(new TextDecoder().decode(request.body.body)),
    (body) => body.method === "tools/list",
  );

/** A body as JSON-RPC messages: itself, or each `data:` line of an event stream. */
const messages = (text: string, eventStream: boolean) =>
  eventStream
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [text];

/**
 * The MCP schema decodes a missing `openWorldHint` as `true`, the spec's default, so the hint as
 * sent is read here off `tools/list` replies: name → whether the server said `true` itself.
 * Bounded like the client: a reply past `maxMessageBytes` fails, as the client would fail it.
 */
export const capturing = (http: HttpClient.HttpClient, hints: Map<string, boolean>) =>
  http.pipe(
    HttpClient.transformResponse(
      Effect.flatMap((response) => {
        if (!listsTools(response.request)) return Effect.succeed(response);
        return response.stream.pipe(
          Stream.runFoldEffect(
            () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
            (acc, chunk) => {
              const size = acc.size + chunk.length;
              if (size > CONNECTION_LIMITS.maxMessageBytes)
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request: response.request,
                      description: "MCP message exceeds maxMessageBytes",
                    }),
                  }),
                );
              acc.chunks.push(chunk);
              return Effect.succeed({ size, chunks: acc.chunks });
            },
          ),
          Effect.map(({ size, chunks }) => {
            const body = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              body.set(chunk, offset);
              offset += chunk.length;
            }
            const text = new TextDecoder().decode(body);
            const eventStream = (response.headers["content-type"] ?? "").includes("event-stream");
            for (const message of messages(text, eventStream))
              for (const tool of Option.match(decodeListing(message), {
                onNone: () => [],
                onSome: (listing) => listing.result.tools,
              }))
                hints.set(tool.name, tool.annotations?.openWorldHint === true);
            return HttpClientResponse.fromWeb(
              response.request,
              new Response(text, { status: response.status, headers: response.headers }),
            );
          }),
        );
      }),
    ),
  );
