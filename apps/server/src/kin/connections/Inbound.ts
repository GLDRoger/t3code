import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { CONNECTION_LIMITS } from "./limits.ts";

/** What a connection's own credential reads as wherever its server echoes it back. */
const CREDENTIAL_MARKER = "[credential removed]";

/** Each form a credential can come back in: as sent, and escaped inside a JSON string. */
export const credentialForms = (values: ReadonlyArray<string>) =>
  [
    ...new Set(
      values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]).filter(Boolean),
    ),
  ].toSorted((a, b) => b.length - a.length);

const redact = (text: string, forms: ReadonlyArray<string>) =>
  forms.reduce((out, form) => out.replaceAll(form, CREDENTIAL_MARKER), text);

/** The longest end of `text` that could still become a credential with the next chunk. */
const pending = (text: string, forms: ReadonlyArray<string>) => {
  for (
    let size = Math.min(text.length, Math.max(0, ...forms.map((f) => f.length - 1)));
    size > 0;
    size--
  ) {
    const tail = text.slice(-size);
    if (forms.some((form) => form.startsWith(tail))) return size;
  }
  return 0;
};

/** A stream's text with every credential form replaced, also where one spans two chunks. */
const redactStream = <E>(stream: Stream.Stream<Uint8Array, E>, forms: ReadonlyArray<string>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.mapAccum(
      () => "",
      (carry: string, chunk: string) => {
        const out = redact(carry + chunk, forms);
        const keep = pending(out, forms);
        return [out.slice(out.length - keep), [out.slice(0, out.length - keep)]] as const;
      },
      { onHalt: (carry) => [redact(carry, forms)] },
    ),
    Stream.encodeText,
  );

/** One `tools/list` reply as the server sent it, before any decoding fills a default. */
export type ListedPage = {
  /** Every JSON-RPC response to this request in the reply; more than one is ambiguous. */
  readonly answers: number;
  readonly tools: ReadonlyArray<unknown> | undefined;
};

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const requestOf = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") return undefined;
  const body = parse(new TextDecoder().decode(request.body.body));
  return Predicate.hasProperty(body, "method") && Predicate.hasProperty(body, "id")
    ? { method: body.method, id: body.id }
    : undefined;
};

const mediaType = (response: HttpClientResponse.HttpClientResponse) =>
  (response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();

/** The reply's messages, read the way `McpClient.http` reads them: one JSON body, or SSE events. */
const messagesOf = (text: string, type: string) => {
  if (type === "application/json") return [text];
  if (type !== "text/event-stream") return [];
  const events: Array<string> = [];
  const parser = Sse.makeParser(
    (event) => {
      if (event._tag === "Event" && event.data !== "") events.push(event.data);
    },
    { maxEventSize: CONNECTION_LIMITS.maxMessageBytes },
  );
  parser.feed(text);
  parser.feed("\n\n");
  return events;
};

const pageOf = (text: string, type: string, id: unknown): ListedPage => {
  let answers = 0;
  let tools: ReadonlyArray<unknown> | undefined;
  for (const message of messagesOf(text, type).map(parse)) {
    const isAnswer =
      Predicate.hasProperty(message, "result") || Predicate.hasProperty(message, "error");
    const mine =
      Predicate.hasProperty(message, "id") &&
      (message.id === id || (message.id == null && Predicate.hasProperty(message, "error")));
    if (!isAnswer || !mine) continue;
    answers++;
    const result = Predicate.hasProperty(message, "result") ? message.result : undefined;
    if (Predicate.hasProperty(result, "tools") && Array.isArray(result.tools)) tools = result.tools;
  }
  return { answers, tools };
};

const tooLarge = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: "MCP message exceeds maxMessageBytes",
    }),
  });

const BODILESS = new Set([204, 205, 304]);

/**
 * Every reply from a connection passes here before the MCP client reads it: the connection's
 * credential is replaced in it, so no echo reaches a span, a log, a row or a model. `pages`
 * gets each `tools/list` reply as sent, bounded as the client bounds it.
 */
export const inbound = (
  http: HttpClient.HttpClient,
  forms: ReadonlyArray<string>,
  pages?: Array<ListedPage>,
) =>
  http.pipe(
    HttpClient.transformResponse(
      Effect.flatMap((response) => {
        const request = response.request;
        const asked = pages === undefined ? undefined : requestOf(request);
        const headers = Object.fromEntries(
          Object.entries(response.headers).filter(([name]) => name !== "content-length"),
        );
        const clean = forms.length === 0 ? response.stream : redactStream(response.stream, forms);
        if (asked?.method !== "tools/list" || pages === undefined)
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              // `Response` throws when given a body for a status that has none.
              new Response(BODILESS.has(response.status) ? null : Stream.toReadableStream(clean), {
                status: response.status,
                headers,
              }),
            ),
          );
        return clean.pipe(
          Stream.runFoldEffect(
            () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
            (acc, chunk) => {
              const size = acc.size + chunk.length;
              if (size > CONNECTION_LIMITS.maxMessageBytes) return Effect.fail(tooLarge(request));
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
            pages.push(pageOf(text, mediaType(response), asked.id));
            return HttpClientResponse.fromWeb(
              request,
              new Response(text, { status: response.status, headers }),
            );
          }),
        );
      }),
    ),
  );
